"""Unified AI client with exactly three runtime call paths.

- llm: Responses API
- vision: Responses API with input_image content
- generate: Responses API with the image_generation tool
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Awaitable, Callable, Optional, TypeVar
from urllib.parse import urljoin, urlparse
import httpx

from core.config import settings
from core.user_context import get_current_billing_mode, get_current_user_id
from repositories import model_call_log_repo
from repositories.model_repo import get_model_internal, list_models
from services import foxapi_credentials, grok_credentials
from services.compute_billing import FOXAPI_BILLING_MODE, GROK_BILLING_MODE, PLATFORM_BILLING_MODE
from services.grok_availability import GROK_DISABLED_MESSAGE, is_grok_enabled
from services.grok_output import grok_image_aspect_ratio, grok_image_resolution
from services.image_output import (
    infer_image_aspect_ratio,
    infer_output_resolution_from_size,
    resolve_image_output_options,
)

logger = logging.getLogger(__name__)
_image_generation_call_sem = asyncio.Semaphore(max(1, settings.IMAGE_GENERATION_CALL_CONCURRENCY))
_T = TypeVar("_T")


class _ResponsesGatewayError(RuntimeError):
    """Responses request reached a proxy/gateway error page instead of the API."""


class ImageSafetyBlockedError(RuntimeError):
    """Image generation was blocked by the upstream safety system."""


class ExternalBillingError(RuntimeError):
    """The external compute provider rejected the request for billing reasons."""


IMAGE_SAFETY_BLOCKED_MESSAGE = (
    "提示词被图像安全系统拦截。请弱化暴力、灾难、伤害、血腥、破坏、"
    "真实人物或 IP 复刻等描述后重试。"
)
EXTERNAL_BILLING_ERROR_MESSAGE = "算力 API 余额不足，请先充值后重试，或切换为平台积分算力。"

_UPSTREAM_SAFETY_CODES = (
    "content_policy_violation",
    "content_policy",
    "content_filter",
    "policy_violation",
)
_EXTERNAL_BILLING_MARKERS = (
    "insufficient balance",
    "billing_error",
    "insufficient_quota",
    "quota_exceeded",
    "account balance",
    "payment required",
    "余额不足",
)


def _error_detail_text(value: object) -> str:
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            pass
    return str(value or "")


def _is_image_safety_block(*values: object) -> bool:
    return any(_has_explicit_upstream_safety_code(value) for value in values)


def _has_explicit_upstream_safety_code(value: object) -> bool:
    if isinstance(value, dict):
        for key in ("code", "type"):
            code = str(value.get(key) or "").strip().lower()
            if code in _UPSTREAM_SAFETY_CODES:
                return True
        return any(
            _has_explicit_upstream_safety_code(value.get(key))
            for key in ("error", "details", "incomplete_details")
            if value.get(key) is not None
        )
    if isinstance(value, list):
        return any(_has_explicit_upstream_safety_code(item) for item in value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return any(code in value.lower() for code in _UPSTREAM_SAFETY_CODES)
        return _has_explicit_upstream_safety_code(parsed)
    return False


def _raise_image_safety_block(*values: object) -> None:
    if _is_image_safety_block(*values):
        raise ImageSafetyBlockedError(IMAGE_SAFETY_BLOCKED_MESSAGE)


def _is_external_billing_error(*values: object) -> bool:
    details = " ".join(_error_detail_text(value) for value in values).lower()
    return any(marker in details for marker in _EXTERNAL_BILLING_MARKERS)


def _raise_external_billing_error(*values: object) -> None:
    if _is_external_billing_error(*values):
        raise ExternalBillingError(EXTERNAL_BILLING_ERROR_MESSAGE)


def _parse_meta(model: dict) -> dict:
    meta = model.get("meta") or {}
    if isinstance(meta, str):
        try:
            return json.loads(meta)
        except Exception:
            return {}
    return meta if isinstance(meta, dict) else {}


def _model_name(model: dict) -> str:
    meta = _parse_meta(model)
    return str(meta.get("model_name") or model.get("id") or "").strip()


def _looks_like_image_model_name(value: object) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return False
    return text.startswith("gpt-image") or text in {"image2", "image-2"} or "gpt-image" in text


def _image_responses_model_name(model: dict, meta: dict) -> str:
    configured = str(meta.get("responses_model") or "").strip()
    if configured and not _looks_like_image_model_name(configured):
        return configured

    model_name = str(meta.get("model_name") or "").strip()
    if model_name and not _looks_like_image_model_name(model_name):
        return model_name

    # Responses image generation is routed by a text-capable model plus the
    # image_generation tool. Guard against DB rows that still store gpt-image-*.
    return str(meta.get("responses_fallback_model") or "gpt-5.5").strip()


def _endpoint(model: dict) -> str:
    return str(model.get("endpoint") or "").rstrip("/")


def _headers(model: dict) -> dict:
    api_key = str(model.get("api_key") or "").strip()
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _tracked_model_call(model: dict, call: Awaitable[_T]) -> _T:
    credential_user_id = str(model.get("credential_user_id") or "").strip()
    user_id = credential_user_id or get_current_user_id()
    # Billing-source monitoring is meaningful only for user-scoped calls.
    # This also keeps startup and isolated maintenance calls out of user usage.
    if not user_id:
        return await call
    credential_provider = str(model.get("credential_provider") or "").strip().lower()
    if credential_user_id:
        billing_mode = GROK_BILLING_MODE if credential_provider == grok_credentials.PROVIDER else FOXAPI_BILLING_MODE
    else:
        billing_mode = get_current_billing_mode() or PLATFORM_BILLING_MODE
    model_id = _model_name(model)
    api_key = str(model.get("api_key") or "")
    started_at = time.perf_counter()

    async def record(success: bool, error: object = "") -> None:
        try:
            await model_call_log_repo.record_model_call(
                user_id=user_id,
                billing_mode=billing_mode,
                model_id=model_id,
                model_name=str(model.get("name") or model_id),
                model_category=str(model.get("category") or "other"),
                provider=str(model.get("provider") or ""),
                success=success,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                error_message=foxapi_credentials.redact_credential_error(error, api_key),
            )
        except Exception:
            # Monitoring must never turn a successful model response into a failure.
            logger.exception("Failed to persist model-call monitoring record")

    try:
        result = await call
    except Exception as exc:
        await record(False, exc)
        if credential_user_id:
            try:
                recorder = grok_credentials if credential_provider == grok_credentials.PROVIDER else foxapi_credentials
                await recorder.record_usage(
                    credential_user_id,
                    model_id,
                    success=False,
                    error=str(exc),
                    api_key=api_key,
                )
            except Exception:
                logger.exception("Failed to record credential usage failure")
        raise
    await record(True)
    if credential_user_id:
        try:
            recorder = grok_credentials if credential_provider == grok_credentials.PROVIDER else foxapi_credentials
            await recorder.record_usage(
                credential_user_id,
                model_id,
                success=True,
                error="",
                api_key=api_key,
            )
        except Exception:
            logger.exception("Failed to record credential usage success")
    return result


def _looks_like_html(text: str) -> bool:
    snippet = (text or "").lstrip().lower()
    return snippet.startswith("<!doctype html") or snippet.startswith("<html")


def _is_gateway_error(status_code: int, body: str) -> bool:
    return status_code in {502, 503, 504, 524} or _looks_like_html(body)


def _format_upstream_error(prefix: str, status_code: int, body: str) -> str:
    text = " ".join((body or "").strip().split())
    if _looks_like_html(text):
        return f"{prefix}: upstream returned an HTML error page ({status_code}). Check that the gateway forwards /v1/responses correctly."
    if text:
        return f"{prefix} ({status_code}): {text[:300]}"
    return f"{prefix} ({status_code})"


def _responses_endpoint(model: dict, meta: dict) -> str:
    configured = str(meta.get("responses_endpoint") or "").strip()
    ep = (configured or _endpoint(model)).rstrip("/")
    for suffix in ("/images/generations", "/images/edits", "/chat/completions"):
        if ep.endswith(suffix):
            ep = ep[: -len(suffix)]
            break
    return ep if ep.endswith("/responses") else f"{ep}/responses"


def _images_generations_endpoint(model: dict, meta: dict) -> str:
    configured = str(meta.get("images_endpoint") or "").strip()
    ep = (configured or _endpoint(model)).rstrip("/")
    for suffix in ("/responses", "/chat/completions", "/images/edits", "/videos/generations"):
        if ep.endswith(suffix):
            ep = ep[: -len(suffix)]
            break
    return ep if ep.endswith("/images/generations") else f"{ep}/images/generations"


def _videos_generations_endpoint(model: dict, meta: dict) -> str:
    configured = str(meta.get("videos_endpoint") or "").strip()
    ep = (configured or _endpoint(model)).rstrip("/")
    for suffix in ("/responses", "/chat/completions", "/images/generations", "/images/edits"):
        if ep.endswith(suffix):
            ep = ep[: -len(suffix)]
            break
    return ep if ep.endswith("/videos/generations") else f"{ep}/videos/generations"


def _chat_completions_endpoint(model: dict, meta: dict) -> str:
    configured = str(meta.get("chat_completions_endpoint") or meta.get("completions_endpoint") or "").strip()
    ep = (configured or _endpoint(model)).rstrip("/")
    for suffix in ("/responses", "/images/generations", "/images/edits"):
        if ep.endswith(suffix):
            ep = ep[: -len(suffix)]
            break
    return ep if ep.endswith("/chat/completions") else f"{ep}/chat/completions"


def _supports_chat_completions_fallback(model: dict, meta: dict) -> bool:
    provider = str(model.get("provider") or "").lower()
    endpoint = _endpoint(model).lower()
    return bool(
        meta.get("chat_completions_fallback")
        or meta.get("external_api_key")
        or provider in {"foxapi", "grok", "xai"}
        or "foxapi" in endpoint
        or _is_grok_runtime(model, meta)
    )


def _is_grok_runtime(model: dict, meta: dict | None = None) -> bool:
    parsed = meta if isinstance(meta, dict) else _parse_meta(model)
    provider = str(model.get("provider") or "").lower()
    api_mode = str(parsed.get("api_mode") or "").strip().lower()
    model_name = _model_name(model).lower()
    return (
        api_mode.startswith("grok_")
        or provider in {"grok", "xai"}
        or model_name.startswith("grok")
        or str(model.get("id") or "").startswith("grok:")
    )


def _normalize_responses_image_size(size: str, meta: dict, prefer_requested_size: bool = False) -> str | None:
    configured = str(meta.get("responses_image_size") or "").strip()
    selected_size = size if prefer_requested_size else (configured or size or "")
    requested = selected_size.strip().lower().replace("*", "x")
    if requested == "auto":
        return requested

    try:
        width_raw, height_raw = requested.split("x", 1)
        width = int(width_raw)
        height = int(height_raw)
    except Exception:
        return None
    if (
        width <= 0
        or height <= 0
        or width % 16
        or height % 16
        or max(width, height) > 3840
        or max(width, height) / min(width, height) > 3
        or width * height < 655_360
        or width * height > 8_294_400
    ):
        return None
    return f"{width}x{height}"


def _uses_sub2api_responses_image_compatibility(model: dict, meta: dict) -> bool:
    """Identify FoxAPI runtime models, which are served through SUB2API."""
    return bool(meta.get("external_api_key")) and str(model.get("provider") or "").lower() == "foxapi"


def _sub2api_responses_image_tool_size(size: str) -> str | None:
    """Map UI output dimensions to the Responses image tool's native sizes."""
    aspect_ratio = infer_image_aspect_ratio(size)
    if aspect_ratio == "1:1":
        return "1024x1024"
    if aspect_ratio in {"5:4", "4:3", "3:2", "16:9"}:
        return "1536x1024"
    if aspect_ratio in {"4:5", "3:4", "2:3", "9:16"}:
        return "1024x1536"
    return None


def _image_quality_for_output_resolution(quality: Optional[str], size: str) -> Optional[str]:
    requested = str(quality or "").strip().lower()
    if requested and requested != "auto":
        return requested
    resolution = infer_output_resolution_from_size(size)
    if resolution == "4k":
        return "high"
    if resolution == "2k":
        return "medium"
    return None


def _with_image_output_contract(prompt: str, size: str) -> str:
    aspect_ratio = infer_image_aspect_ratio(size)
    output_resolution = infer_output_resolution_from_size(size).upper()
    aspect_instruction = (
        f"render the final delivered canvas at exactly {aspect_ratio} aspect ratio. "
        "Do not return a square or differently oriented canvas."
        if aspect_ratio
        else "preserve the requested canvas aspect ratio."
    )
    return (
        f"{prompt.rstrip()}\n\n"
        f"Output contract: {aspect_instruction} "
        f"Target output clarity: {output_resolution}. "
        "Prioritize the highest available detail and resolution for this target."
    )


def _normalize_responses_image_quality(quality: Optional[str], meta: dict) -> str | None:
    requested = str(quality or "").strip().lower()
    configured = str(meta.get("image_generation_quality") or "").strip().lower()
    candidate = requested if requested and requested != "auto" else configured
    if candidate in {"low", "medium", "high"}:
        return candidate
    return None


async def _resolve_model(model_ref: str, category: str | None = None) -> Optional[dict]:
    model = await get_model_internal(model_ref)
    if model:
        return model

    models = await list_models(enabled_only=True, category=category)
    for candidate in models:
        meta = _parse_meta(candidate)
        if candidate.get("id") == model_ref or meta.get("model_name") == model_ref:
            return await get_model_internal(candidate["id"])
    return None


def _ensure_category(model: dict, expected: str, model_id: str) -> None:
    category = model.get("category")
    if category and category != expected:
        raise RuntimeError(f"Model {model_id!r} is category {category!r}, expected {expected!r}")


def _message_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
        return "\n".join(parts)
    return str(content or "")


def _responses_input_from_messages(messages: list[dict]) -> tuple[str | None, list[dict]]:
    instructions: list[str] = []
    input_items: list[dict] = []
    for message in messages:
        role = str(message.get("role") or "user").strip().lower()
        content = message.get("content", "")
        if role in {"system", "developer"}:
            text = _message_text(content).strip()
            if text:
                instructions.append(text)
            continue

        response_role = "assistant" if role == "assistant" else "user"
        if isinstance(content, list):
            response_content: list[dict] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = item.get("type")
                if item_type == "image_url":
                    image_url = item.get("image_url")
                    if isinstance(image_url, dict):
                        url = image_url.get("url")
                    else:
                        url = image_url
                    if url:
                        response_content.append({"type": "input_image", "image_url": url})
                elif item_type == "input_image" and item.get("image_url"):
                    response_content.append({"type": "input_image", "image_url": item["image_url"]})
                else:
                    text = item.get("text") or item.get("input_text") or ""
                    if text:
                        response_content.append({"type": "input_text", "text": str(text)})
            if response_content:
                input_items.append({"role": response_role, "content": response_content})
            continue

        text = str(content or "")
        if text:
            input_items.append({"role": response_role, "content": [{"type": "input_text", "text": text}]})

    return ("\n\n".join(instructions) if instructions else None), input_items


def _chat_completions_messages_from_messages(messages: list[dict]) -> list[dict]:
    chat_messages: list[dict] = []
    for message in messages:
        role = str(message.get("role") or "user").strip().lower()
        if role == "developer":
            role = "system"
        elif role not in {"system", "user", "assistant"}:
            role = "user"
        text = _message_text(message.get("content", "")).strip()
        if text:
            chat_messages.append({"role": role, "content": text})
    if not chat_messages:
        raise RuntimeError("Chat completions text request has no input")
    return chat_messages


def _extract_responses_text(data: dict) -> str:
    status = data.get("status")
    _raise_external_billing_error(
        data.get("error"),
        data.get("incomplete_details"),
        data.get("output_text"),
        data.get("_stream_text"),
        data.get("output"),
    )
    if status and status not in {"completed", "succeeded"}:
        detail = data.get("error") or data.get("incomplete_details") or ""
        raise RuntimeError(f"Responses text ended with status={status}: {str(detail)[:300]}")

    direct = data.get("output_text") or data.get("_stream_text")
    if isinstance(direct, str) and direct.strip():
        return direct

    chunks: list[str] = []
    for item in data.get("output", []) or []:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("text"), str):
            chunks.append(item["text"])
        for content in item.get("content", []) or []:
            if not isinstance(content, dict):
                continue
            text = content.get("text") or content.get("output_text") or content.get("input_text")
            if isinstance(text, str):
                chunks.append(text)
    result = "".join(chunks).strip()
    if not result:
        output_types = [item.get("type", "unknown") for item in data.get("output", []) if isinstance(item, dict)]
        raise RuntimeError(f"Responses text returned empty content, output types: {output_types}")
    return result


def _extract_chat_completions_text(data: dict) -> str:
    _raise_external_billing_error(data)
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
            content = message.get("content") or choice.get("text")
            if isinstance(content, str) and content.strip():
                return content
    direct = data.get("output_text") if isinstance(data, dict) else None
    if isinstance(direct, str) and direct.strip():
        return direct
    raise RuntimeError("Chat completions text returned empty content")


async def _call_openai_chat_completions_text(
    model: dict,
    messages: list[dict],
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str:
    meta = _parse_meta(model)
    model_name = str(
        meta.get("chat_completions_model")
        or meta.get("model_name")
        or meta.get("responses_model")
        or model.get("id")
        or ""
    ).strip()
    endpoint = _chat_completions_endpoint(model, meta)
    if not model_name:
        raise RuntimeError(f"Model {model.get('id')!r} is missing chat completions model name")
    if not endpoint:
        raise RuntimeError(f"Model {model.get('id')!r} is missing chat completions endpoint")

    payload = {
        "model": model_name,
        "messages": _chat_completions_messages_from_messages(messages),
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    headers = {
        **_headers(model),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    timeout = httpx.Timeout(connect=30.0, read=60.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint, headers=headers, json=payload)
    body = resp.text
    if not resp.is_success:
        _raise_external_billing_error(body)
        raise RuntimeError(_format_upstream_error("Chat completions text failed", resp.status_code, body))
    try:
        data = resp.json()
    except Exception as exc:
        raise RuntimeError(
            "Chat completions text returned invalid JSON "
            f"(content-type={resp.headers.get('content-type', '') or 'missing'}): {body[:200]}"
        ) from exc
    return _extract_chat_completions_text(data)


async def _call_openai_responses_text(
    model: dict,
    messages: list[dict],
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str:
    meta = _parse_meta(model)
    model_name = str(meta.get("responses_model") or meta.get("model_name") or model.get("id") or "").strip()
    endpoint = _responses_endpoint(model, meta)
    if not model_name:
        raise RuntimeError(f"Model {model.get('id')!r} is missing Responses model name")
    if not endpoint:
        raise RuntimeError(f"Model {model.get('id')!r} is missing Responses endpoint")

    instructions, input_items = _responses_input_from_messages(messages)
    if not input_items:
        raise RuntimeError("Responses text request has no input")

    payload: dict = {
        "model": model_name,
        "input": input_items,
        "max_output_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }
    if instructions:
        payload["instructions"] = instructions

    headers = {
        **_headers(model),
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    timeout = httpx.Timeout(connect=30.0, read=None, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(1, 4):
            try:
                async with client.stream("POST", endpoint, headers=headers, json=payload) as resp:
                    content_type = resp.headers.get("content-type", "")
                    if not resp.is_success:
                        body = (await resp.aread()).decode(errors="replace")
                        _raise_external_billing_error(body)
                        error = _format_upstream_error("Responses text failed", resp.status_code, body)
                        if _is_gateway_error(resp.status_code, body) or resp.status_code in {408, 429, 500}:
                            raise _ResponsesGatewayError(error)
                        raise RuntimeError(error)

                    if "text/event-stream" not in content_type.lower():
                        body = (await resp.aread()).decode(errors="replace")
                        raise RuntimeError(
                            "Responses text requires an SSE response "
                            f"(content-type={content_type or 'missing'}): {body[:200]}"
                        )
                    data = await _parse_responses_stream(resp)
                    break
            except (_ResponsesGatewayError, httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt >= 3:
                    if isinstance(exc, _ResponsesGatewayError):
                        raise
                    raise _ResponsesGatewayError(f"Responses text transport failed after {attempt} attempts: {exc}") from exc
                await asyncio.sleep(min(4.0, 0.75 * (2 ** (attempt - 1))))

    return _extract_responses_text(data)


def _is_responses_text_fallback_error(exc: Exception) -> bool:
    text = str(exc)
    return isinstance(exc, _ResponsesGatewayError) or "Responses text requires an SSE response" in text


async def _call_text_messages_with_optional_fallback(
    model: dict,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    allow_chat_completions_fallback: bool,
    prefer_chat_completions: bool = False,
) -> str:
    meta = _parse_meta(model)
    if prefer_chat_completions:
        return await _call_openai_chat_completions_text(
            model,
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    try:
        return await _call_openai_responses_text(
            model,
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    except Exception as exc:
        if (
            allow_chat_completions_fallback
            and _is_responses_text_fallback_error(exc)
            and _supports_chat_completions_fallback(model, meta)
        ):
            logger.warning(
                "[ai_client] Responses text failed for %s; using chat completions compatibility fallback: %s",
                model.get("id") or _model_name(model),
                exc,
            )
            return await _call_openai_chat_completions_text(
                model,
                messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        raise


def _merge_response_output(preferred_items: list[dict], accumulated_items: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for item in [*(preferred_items or []), *(accumulated_items or [])]:
        if not isinstance(item, dict):
            continue
        key = json.dumps(item, sort_keys=True, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


async def _parse_responses_stream(resp: httpx.Response) -> dict:
    last_completed: dict | None = None
    raw_output: list[dict] = []
    accumulated_output: list[dict] = []
    text_chunks: list[str] = []
    last_status: str | None = None
    response_id: str | None = None
    partial_images: dict[str, str] = {}
    all_event_types: list[str] = []  # 记录所有事件类型用于调试

    def append_output(items) -> None:
        nonlocal raw_output
        if not isinstance(items, list):
            return
        raw_output = items
        for item in items:
            if isinstance(item, dict):
                accumulated_output.append(item)

    async for line in resp.aiter_lines():
        if not line or not line.startswith("data:"):
            continue
        data_str = line[5:].strip()
        if data_str == "[DONE]":
            break
        try:
            event = json.loads(data_str)
        except Exception:
            continue

        # 记录事件类型用于调试
        event_type = event.get("type")
        if event_type:
            all_event_types.append(event_type)

        if isinstance(event.get("id"), str):
            response_id = event["id"]
        if isinstance(event.get("status"), str):
            last_status = event["status"]

        response = event.get("response") if isinstance(event.get("response"), dict) else None
        if response:
            if isinstance(response.get("id"), str):
                response_id = response["id"]
            if isinstance(response.get("status"), str):
                last_status = response["status"]
            append_output(response.get("output"))
            if response.get("status") in {"completed", "succeeded", "failed", "incomplete"}:
                last_completed = dict(response)

        if event_type == "response.output_item.done" and isinstance(event.get("item"), dict):
            accumulated_output.append(event["item"])
        elif event_type == "response.output_item.added" and isinstance(event.get("item"), dict):
            accumulated_output.append(event["item"])
        elif event_type == "response.image_generation_call.partial_image":
            partial = (
                event.get("partial_image_b64")
                or event.get("image_b64")
                or event.get("b64_json")
                or event.get("result")
            )
            if isinstance(partial, dict):
                partial = partial.get("b64_json") or partial.get("result") or partial.get("data")
            item_id = str(event.get("item_id") or event.get("output_item_id") or event.get("id") or "")
            if isinstance(partial, str) and partial and item_id:
                previous = partial_images.get(item_id, "")
                if len(partial) >= len(previous):
                    partial_images[item_id] = partial
        elif event_type == "response.output_text.delta":
            delta = event.get("delta") or event.get("text") or ""
            if delta:
                text_chunks.append(str(delta))

        append_output(event.get("output"))
        if event.get("status") in {"completed", "succeeded", "failed", "incomplete"}:
            last_completed = dict(event)

    # 详细日志：记录所有事件类型和输出结构
    logger.info(
        "[ai_client] Stream parsed: event_types=%s, raw_output_count=%d, accumulated_count=%d, last_status=%s",
        all_event_types[:20],  # 只记录前 20 个事件类型
        len(raw_output),
        len(accumulated_output),
        last_status,
    )
    if raw_output:
        logger.info("[ai_client] raw_output_types=%s", [item.get("type") for item in raw_output if isinstance(item, dict)])
    if accumulated_output:
        logger.info("[ai_client] accumulated_output_types=%s", [item.get("type") for item in accumulated_output if isinstance(item, dict)])

    if last_completed:
        data = dict(last_completed)
        data["output"] = _merge_response_output(data.get("output") or raw_output, accumulated_output)
    else:
        data = {
            "id": response_id,
            "status": last_status or "unknown",
            "output": _merge_response_output(raw_output, accumulated_output),
        }

    if text_chunks and not data.get("_stream_text"):
        data["_stream_text"] = "".join(text_chunks)
    if partial_images:
        output = data.get("output") if isinstance(data.get("output"), list) else []
        fallback = next(iter(partial_images.values())) if len(partial_images) == 1 else ""
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "image_generation_call":
                continue
            if item.get("result") or item.get("b64_json"):
                continue
            item_id = str(item.get("id") or item.get("item_id") or "")
            encoded = partial_images.get(item_id) or fallback
            if encoded:
                item["result"] = encoded
    return data


def _extract_responses_image_bytes(data: dict) -> bytes:
    status = data.get("status")
    _raise_external_billing_error(
        data.get("error"),
        data.get("incomplete_details"),
        data.get("output_text"),
        data.get("_stream_text"),
        data.get("output"),
    )
    _raise_image_safety_block(
        data.get("error"),
        data.get("incomplete_details"),
    )
    if status and status not in {"completed", "succeeded"}:
        detail = data.get("error") or data.get("incomplete_details") or ""
        raise RuntimeError(f"Responses image_generation ended with status={status}: {str(detail)[:300]}")

    output = data.get("output", [])
    image_call_details: list[str] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "image_generation_call":
            continue
        encoded = item.get("result") or item.get("b64_json")
        if encoded:
            logger.info("[ai_client] Found image_generation_call with result length=%d", len(encoded))
            return base64.b64decode(encoded)
        detail = item.get("error") or item.get("details") or ""
        if not detail and str(item.get("status") or "").lower() in {"failed", "error", "cancelled"}:
            detail = item.get("status")
        if detail:
            image_call_details.append(str(detail))

    output_types = [item.get("type", "unknown") for item in output if isinstance(item, dict)]
    output_text = data.get("output_text") or data.get("_stream_text") or ""
    message = "Responses image_generation did not return image data"
    if output_types:
        message += f", output types: {output_types}"
    if image_call_details:
        message += f", image_call_details: {'; '.join(image_call_details)[:200]}"
    if output_text:
        message += f", output_text: {str(output_text)[:200]}"

    failed_image_call = any(
        isinstance(item, dict)
        and item.get("type") == "image_generation_call"
        and str(item.get("status") or "").lower() in {"failed", "error", "cancelled"}
        for item in output
    )
    # Streamed assistant text is not a structured provider rejection. It can
    # mention policy or safety when the image tool merely returned no bytes.
    if failed_image_call:
        raise RuntimeError(
            "上游图像服务未返回可用图片数据。任务和已完成结果会保留，可稍后重试或切换模型。"
        )

    # 记录完整的 output 结构用于调试（只记录类型，不记录内容）
    output_structure = []
    for item in output:
        if isinstance(item, dict):
            output_structure.append({
                "type": item.get("type"),
                "has_result": bool(item.get("result")),
                "has_b64_json": bool(item.get("b64_json")),
                "has_error": bool(item.get("error")),
            })
    logger.error("[ai_client] Image extraction failed. output_structure=%s", output_structure)

    raise RuntimeError(message)


async def _call_openai_responses_image_generation(
    model: dict,
    prompt: str,
    images: list[bytes],
    size: str,
    quality: Optional[str] = None,
    force_size: bool = False,
) -> bytes:
    meta = _parse_meta(model)
    model_name = _image_responses_model_name(model, meta)
    endpoint = _responses_endpoint(model, meta)
    if not model_name:
        raise RuntimeError(f"Image model {model.get('id')!r} is missing Responses model name")
    if not endpoint:
        raise RuntimeError(f"Image model {model.get('id')!r} is missing Responses endpoint")

    tool: dict = {"type": "image_generation"}
    action = meta.get("image_generation_action") or meta.get("responses_image_action")
    tool["action"] = str(action or ("edit" if images else "generate"))
    # Keep the default payload identical to the official Responses image sample:
    # tools=[{"type":"image_generation"}]. Some gateways route image billing
    # differently when optional tool fields are present.
    configured_tool_size = str(meta.get("responses_image_size") or "").strip()
    tool_size = _normalize_responses_image_size(size, meta, prefer_requested_size=force_size)
    use_sub2api_size_compatibility = _uses_sub2api_responses_image_compatibility(model, meta)
    if tool_size and use_sub2api_size_compatibility:
        tool_size = _sub2api_responses_image_tool_size(tool_size)
    if tool_size and (
        configured_tool_size
        or force_size
        or use_sub2api_size_compatibility
        or tool_size not in {"1024x1024", "1024x1536", "1536x1024"}
    ):
        tool["size"] = tool_size
    tool_quality = _normalize_responses_image_quality(quality, meta)
    if tool_quality:
        tool["quality"] = tool_quality

    if images:
        content: list[dict] = [{"type": "input_text", "text": prompt}]
        for image in images[:8]:
            content.append({
                "type": "input_image",
                "image_url": f"data:image/png;base64,{base64.b64encode(image).decode()}",
            })
        input_payload: str | list[dict] = [{"role": "user", "content": content}]
    else:
        input_payload = prompt

    payload: dict = {
        "model": model_name,
        "input": input_payload,
        "tools": [tool],
        "tool_choice": {"type": "image_generation"},
        "stream": True,
    }
    reasoning_effort = meta.get("responses_reasoning_effort") or meta.get("reasoning_effort")
    reasoning_summary = meta.get("responses_reasoning_summary")
    if reasoning_effort or reasoning_summary:
        payload["reasoning"] = {}
        if reasoning_effort:
            payload["reasoning"]["effort"] = str(reasoning_effort)
        if reasoning_summary:
            payload["reasoning"]["summary"] = str(reasoning_summary)
    headers = {
        **_headers(model),
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "node",
    }
    logger.info(
        "Responses image_generation stream request model=%s endpoint=%s tool_keys=%s",
        model_name,
        endpoint,
        sorted(tool.keys()),
    )
    timeout = httpx.Timeout(connect=30.0, read=None, write=60.0, pool=20.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", endpoint, headers=headers, json=payload) as resp:
            content_type = resp.headers.get("content-type", "")
            if not resp.is_success:
                body = (await resp.aread()).decode(errors="replace")
                _raise_image_safety_block(body)
                _raise_external_billing_error(body)
                if _is_gateway_error(resp.status_code, body):
                    raise _ResponsesGatewayError(_format_upstream_error("Responses image_generation failed", resp.status_code, body))
                raise RuntimeError(_format_upstream_error("Responses image_generation failed", resp.status_code, body))

            if "text/event-stream" not in content_type.lower():
                body = (await resp.aread()).decode(errors="replace")
                _raise_image_safety_block(body)
                _raise_external_billing_error(body)
                raise RuntimeError(
                    "Responses image_generation requires an SSE response "
                    f"(content-type={content_type or 'missing'}): {body[:200]}"
                )
            data = await _parse_responses_stream(resp)
            return _extract_responses_image_bytes(data)


def _extract_grok_image_bytes(data: dict) -> bytes:
    _raise_image_safety_block(data)
    _raise_external_billing_error(data)
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        items = [data] if isinstance(data, dict) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json") or item.get("b64")
        if isinstance(b64, str) and b64.strip():
            return base64.b64decode(b64)
        url = item.get("url")
        if isinstance(url, str) and url.startswith("data:image") and "," in url:
            return base64.b64decode(url.split(",", 1)[1])
    raise RuntimeError("Grok image generation returned no image data")


async def _call_grok_images(
    model: dict,
    prompt: str,
    ref_images: list[bytes],
    size: str,
    quality: Optional[str] = None,
    aspect_ratio: Optional[str] = None,
    output_resolution: Optional[str] = None,
) -> bytes:
    meta = _parse_meta(model)
    model_name = _model_name(model)
    endpoint = _images_generations_endpoint(model, meta)
    aspect_ratio = grok_image_aspect_ratio(aspect_ratio, size=size)
    resolution = grok_image_resolution(output_resolution, size=size)
    payload: dict = {
        "model": model_name,
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
        "n": 1,
        "response_format": "b64_json",
    }
    if quality and quality != "auto":
        payload["quality"] = quality
    if ref_images:
        payload["image"] = [
            f"data:image/png;base64,{base64.b64encode(image).decode()}"
            for image in ref_images[:8]
        ]
    headers = {
        **_headers(model),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    timeout = httpx.Timeout(connect=30.0, read=180.0, write=60.0, pool=20.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint, headers=headers, json=payload)
    body = resp.text
    if not resp.is_success:
        _raise_image_safety_block(body)
        _raise_external_billing_error(body)
        raise RuntimeError(_format_upstream_error("Grok image generation failed", resp.status_code, body))
    try:
        data = resp.json()
    except Exception as exc:
        raise RuntimeError(f"Grok image generation returned invalid JSON: {body[:200]}") from exc
    return _extract_grok_image_bytes(data)


async def call_image(
    model_id: str,
    prompt: str,
    ref_images: Optional[list[bytes]] = None,
    size: str = "1024x1024",
    n: int = 1,
    quality: Optional[str] = None,
    force_size: bool = False,
    aspect_ratio: Optional[str] = None,
    output_resolution: Optional[str] = None,
) -> bytes:
    resolved_output = resolve_image_output_options(
        prompt=prompt,
        requested_size=size,
        output_resolution=infer_output_resolution_from_size(size),
    )
    output_was_explicit = force_size or resolved_output.prompt_resolution or resolved_output.prompt_aspect_ratio
    if resolved_output.prompt_resolution or resolved_output.prompt_aspect_ratio:
        size = resolved_output.size
    quality = _image_quality_for_output_resolution(quality, size)
    generation_prompt = _with_image_output_contract(prompt, size) if output_was_explicit else prompt

    model = await _resolve_model(model_id, "generate")
    if not model:
        raise RuntimeError(f"Image model {model_id!r} is missing or disabled")
    _ensure_category(model, "generate", model_id)

    if _is_grok_runtime(model) and not await is_grok_enabled():
        raise RuntimeError(GROK_DISABLED_MESSAGE)

    try:
        async with _image_generation_call_sem:
            if _is_grok_runtime(model):
                call = _call_grok_images(
                    model,
                    generation_prompt,
                    ref_images or [],
                    size,
                    quality=quality,
                    aspect_ratio=aspect_ratio,
                    output_resolution=output_resolution,
                )
            else:
                call = _call_openai_responses_image_generation(
                    model,
                    generation_prompt,
                    ref_images or [],
                    size,
                    quality=quality,
                    force_size=force_size,
                )
            return await _tracked_model_call(model, call)
    except httpx.TimeoutException as extra:
        raise _ResponsesGatewayError(
            "Image generation request timed out."
        ) from extra


async def call_vision(
    model_id: str,
    prompt: str,
    image_bytes: bytes,
    system: Optional[str] = None,
    max_tokens: int = 2000,
) -> str:
    model = await _resolve_model(model_id, "vision")
    if not model:
        raise RuntimeError(f"Vision model {model_id!r} is missing or disabled")
    _ensure_category(model, "vision", model_id)

    img_b64 = base64.b64encode(image_bytes).decode()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}", "detail": "high"}},
            {"type": "text", "text": prompt},
        ],
    })
    text_call = (
        _call_openai_chat_completions_text(model, messages, max_tokens=max_tokens, temperature=0.1)
        if _is_grok_runtime(model)
        else _call_openai_responses_text(model, messages, max_tokens=max_tokens, temperature=0.1)
    )
    return await _tracked_model_call(model, text_call)


async def call_chat(
    model_id: str,
    user: str,
    system: Optional[str] = None,
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str:
    model = await _resolve_model(model_id, "llm")
    if not model:
        raise RuntimeError(f"LLM model {model_id!r} is missing or disabled")
    _ensure_category(model, "llm", model_id)

    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    text_call = (
        _call_openai_chat_completions_text(model, messages, max_tokens=max_tokens, temperature=temperature)
        if _is_grok_runtime(model)
        else _call_openai_responses_text(model, messages, max_tokens=max_tokens, temperature=temperature)
    )
    return await _tracked_model_call(model, text_call)


async def call_chat_with_images(
    model_id: str,
    user: str,
    images: list[bytes],
    system: Optional[str] = None,
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str:
    """Run one multimodal planning call with the ordered reference images."""
    model = await _resolve_model(model_id, "llm")
    if not model:
        raise RuntimeError(f"LLM model {model_id!r} is missing or disabled")
    _ensure_category(model, "llm", model_id)

    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    content: list[dict] = [{"type": "input_text", "text": user}]
    for image in images[:8]:
        content.append({
            "type": "input_image",
            "image_url": f"data:image/png;base64,{base64.b64encode(image).decode()}",
        })
    messages.append({"role": "user", "content": content})
    text_call = (
        _call_openai_chat_completions_text(model, messages, max_tokens=max_tokens, temperature=temperature)
        if _is_grok_runtime(model)
        else _call_openai_responses_text(model, messages, max_tokens=max_tokens, temperature=temperature)
    )
    return await _tracked_model_call(model, text_call)


async def call_chat_messages(
    model_id: str,
    messages: list[dict],
    max_tokens: int = 2000,
    temperature: float = 0.7,
) -> str:
    model = await _resolve_model(model_id, "llm")
    if not model:
        raise RuntimeError(f"LLM model {model_id!r} is missing or disabled")
    _ensure_category(model, "llm", model_id)
    text_call = (
        _call_openai_chat_completions_text(model, messages, max_tokens=max_tokens, temperature=temperature)
        if _is_grok_runtime(model)
        else _call_openai_responses_text(model, messages, max_tokens=max_tokens, temperature=temperature)
    )
    return await _tracked_model_call(model, text_call)


async def call_text_messages(
    model_id: str,
    messages: list[dict],
    max_tokens: int = 2000,
    temperature: float = 0.7,
    allowed_categories: tuple[str, ...] = ("llm", "vision"),
    allow_chat_completions_fallback: bool = False,
    prefer_chat_completions: bool = False,
) -> str:
    model = await _resolve_model(model_id)
    if not model:
        raise RuntimeError(f"Text model {model_id!r} is missing or disabled")
    category = model.get("category")
    if allowed_categories and category not in allowed_categories:
        raise RuntimeError(f"Model {model_id!r} is category {category!r}, expected one of {allowed_categories!r}")
    return await _tracked_model_call(
        model,
        _call_text_messages_with_optional_fallback(
            model,
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            allow_chat_completions_fallback=allow_chat_completions_fallback,
            prefer_chat_completions=prefer_chat_completions or _is_grok_runtime(model),
        ),
    )


def _iter_grok_video_nodes(value: object, depth: int = 0):
    if depth > 4:
        return
    if isinstance(value, dict):
        yield value
        for key in ("video", "result", "output", "data", "media", "file"):
            child = value.get(key)
            if isinstance(child, (dict, list)):
                yield from _iter_grok_video_nodes(child, depth + 1)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_grok_video_nodes(item, depth + 1)


def _extract_grok_video_url(data: object) -> str:
    _raise_image_safety_block(data)
    _raise_external_billing_error(data)
    if isinstance(data, str) and data.startswith("http"):
        return data
    for node in _iter_grok_video_nodes(data):
        for key in (
            "video",
            "result",
            "output",
            "data",
            "media",
            "file",
            "video_url",
            "download_url",
            "media_url",
            "content_url",
            "file_url",
            "output_url",
            "url",
        ):
            value = node.get(key)
            if isinstance(value, str) and (
                value.startswith("http://")
                or value.startswith("https://")
                or value.startswith("/")
            ):
                return value
    return ""


def _resolve_grok_video_url(model: dict, value: str) -> str:
    """Resolve FoxAPI's relative media path while keeping absolute URLs intact."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    if not raw.startswith("/"):
        return ""
    resolved = urljoin(f"{_endpoint(model).rstrip('/')}/", raw)
    parsed = urlparse(resolved)
    return resolved if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _extract_grok_video_status(data: dict) -> str:
    for node in _iter_grok_video_nodes(data):
        for key in ("status", "state", "processing_status"):
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower().replace("-", "_")
    return ""


def _extract_grok_video_error(data: dict) -> str:
    for node in _iter_grok_video_nodes(data):
        for key in ("error", "message", "detail"):
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                nested = value.get("message") or value.get("detail") or value.get("code")
                if nested:
                    return str(nested).strip()
    return ""


def _extract_grok_video_request_id(data: dict) -> str:
    """Accept the async identifiers returned by FoxAPI/xAI video creation."""
    candidates: list[object] = [
        data.get("request_id"),
        data.get("id"),
        data.get("video_id"),
        data.get("task_id"),
    ]
    for container_name in ("data", "video"):
        container = data.get(container_name)
        if isinstance(container, dict):
            candidates.extend(
                container.get(key)
                for key in ("request_id", "id", "video_id", "task_id")
            )
    for candidate in candidates:
        value = str(candidate or "").strip()
        if value:
            return value
    return ""


async def _download_bytes(url: str, headers: dict) -> bytes:
    timeout = httpx.Timeout(connect=30.0, read=180.0, write=30.0, pool=20.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url, headers=headers)
    if not resp.is_success:
        raise RuntimeError(_format_upstream_error("Video download failed", resp.status_code, resp.text))
    return resp.content


async def _call_grok_video(
    model: dict,
    prompt: str,
    *,
    duration: int,
    reference_image_url: str,
    provider_request_id: str = "",
    on_provider_request_id: Callable[[str], Awaitable[object]] | None = None,
) -> bytes:
    from services.grok_output import grok_video_duration

    meta = _parse_meta(model)
    model_name = _model_name(model)
    endpoint = _videos_generations_endpoint(model, meta)
    provider_request_id = str(provider_request_id or "").strip()
    payload: dict = {
        "model": model_name,
        "prompt": prompt,
        "duration": grok_video_duration(duration),
        "image": {"url": reference_image_url},
    }
    headers = {
        **_headers(model),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    timeout = httpx.Timeout(connect=30.0, read=60.0, write=60.0, pool=20.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        video_id = provider_request_id
        if not video_id:
            resp = await client.post(endpoint, headers=headers, json=payload)
            body = resp.text
            if not resp.is_success:
                _raise_image_safety_block(body)
                _raise_external_billing_error(body)
                raise RuntimeError(_format_upstream_error("Grok video generation failed", resp.status_code, body))
            try:
                data = resp.json()
            except Exception as extra:
                raise RuntimeError(f"Grok video generation returned invalid JSON: {body[:200]}") from extra

            video_url = _resolve_grok_video_url(model, _extract_grok_video_url(data))
            if video_url:
                return await _download_bytes(video_url, _headers(model))

            video_id = _extract_grok_video_request_id(data)
            if not video_id:
                raise RuntimeError("Grok video generation did not return a request id")
            if on_provider_request_id is not None:
                persisted = await on_provider_request_id(video_id)
                if persisted is False:
                    raise RuntimeError("Grok video provider request id could not be persisted")

        status_url = f"{_endpoint(model).rstrip('/')}/videos/{video_id}"
        poll_timeout = httpx.Timeout(connect=15.0, read=30.0, write=15.0, pool=15.0)
        deadline = time.monotonic() + 540
        while time.monotonic() < deadline:
            await asyncio.sleep(3)
            status_resp = await client.get(status_url, headers=_headers(model), timeout=poll_timeout)
            status_body = status_resp.text
            if not status_resp.is_success:
                _raise_image_safety_block(status_body)
                _raise_external_billing_error(status_body)
                raise RuntimeError(_format_upstream_error("Grok video poll failed", status_resp.status_code, status_body))
            if status_resp.status_code == 202 and not status_body.strip():
                continue
            try:
                status_data = status_resp.json()
            except Exception as extra:
                raise RuntimeError(f"Grok video poll returned invalid JSON: {status_body[:200]}") from extra
            video_url = _resolve_grok_video_url(model, _extract_grok_video_url(status_data))
            if video_url:
                return await _download_bytes(video_url, _headers(model))
            status = _extract_grok_video_status(status_data)
            if status in {"completed", "succeeded", "ready", "done", "complete", "finished", "success", "available"}:
                raise RuntimeError(
                    "Grok video completed without a download URL"
                    + (f": {_extract_grok_video_error(status_data)[:300]}" if _extract_grok_video_error(status_data) else "")
                )
            if status in {"failed", "error", "cancelled", "canceled", "rejected", "expired"}:
                detail = _extract_grok_video_error(status_data)
                raise RuntimeError(f"Grok video generation {status}: {detail[:300]}")
        raise RuntimeError("Grok video generation timed out while polling")


async def call_video(
    model_id: str,
    prompt: str,
    *,
    duration: int = 6,
    reference_image_url: str = "",
    provider_request_id: str = "",
    on_provider_request_id: Callable[[str], Awaitable[object]] | None = None,
) -> bytes:
    model = await _resolve_model(model_id, "video")
    if not model:
        raise RuntimeError(f"Video model {model_id!r} is missing or disabled")
    _ensure_category(model, "video", model_id)
    if not _is_grok_runtime(model):
        raise RuntimeError(f"Video model {model_id!r} is not a Grok video model")
    if not await is_grok_enabled():
        raise RuntimeError(GROK_DISABLED_MESSAGE)
    if not reference_image_url:
        raise RuntimeError("Grok Imagine Video requires a reference image URL")
    async with _image_generation_call_sem:
        return await _tracked_model_call(
            model,
            _call_grok_video(
                model,
                prompt,
                duration=duration,
                reference_image_url=reference_image_url,
                provider_request_id=provider_request_id,
                on_provider_request_id=on_provider_request_id,
            ),
        )


def _is_gpt_image_2_model(model: dict) -> bool:
    model_id = str(model.get("id") or "").lower()
    name = str(model.get("name") or model.get("display_name") or "").lower()
    return "gpt-image-2" in model_id or "gpt image 2" in name


async def get_default_model_id(category: str) -> Optional[str]:
    models = await list_models(enabled_only=True)
    matched = [model for model in models if model.get("category") == category]
    if category == "generate":
        preferred = next((model for model in matched if _is_gpt_image_2_model(model)), None)
        if preferred:
            return preferred["id"]
    return matched[0]["id"] if matched else None
