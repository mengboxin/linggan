"""
科研绘图路由 /api/sci-fig

两种生成模式：
1. 代码渲染：LLM 生成 Python/Mermaid → 沙箱执行 → 输出图表
2. AI 直接生成：图像模型直接生成科研风格图
"""
import asyncio
import base64
from datetime import datetime
import json
import logging
import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

import repositories.conversation_repo as conversation_repo
from repositories import creative_style_repo
from core import history_artifacts
from core.credit_reserve import (
    get_available_balance,
    get_task_reservation,
    release_task_reservation,
    reserve_for_task,
)
from core.generation_execution import (
    claim_submit_key,
    forget_submit_key,
    module_submit_idempotency_key,
    remember_submit_key,
)
from core.queue import enqueue
from routers.auth import get_current_user
from services.attachment_parser import build_attachment_context, merge_attachment_state
from services.ai_client import call_chat, call_vision
from services.agents.workflow_agent import set_agent_step
from services.billing_operation import model_billing_operation_key
from services.model_billing import check_model_call, execute_billed_model_call
from services import asset_storage, provider_policy
from services.image_asset_contract import (
    ImageAssetReference,
    ImageAssetReferenceError,
    canonicalize_image_asset_references,
    load_original_reference_bytes,
)
from services.agents.creative_runtime import create_module_run
from services.agents.creative_contract import build_delivery_contract
from services.agents.specialist_graph import run_specialist_graph
from services.image_output import image_output_size, normalize_image_quality, normalize_output_resolution
from services.creative_skill_resolver import CreativeSkillResolutionError, resolve_creative_skill_submission
from services.job_events import compact_image_versions
from services.agents.sci_fig_agent import (
    CATEGORY_LABELS,
    STYLE_PRESETS,
    _load_state,
    _save_state,
    convert_to_pdf,
    enhance_with_img2img,
    execute_code,
    fix_code,
    generate_code,
    get_result_bytes,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sci-fig", tags=["scientific figure"])

# Per-user 渲染信号量
_user_render_sems: dict[str, asyncio.Semaphore] = {}


def _sci_generation_reservation_amount(
    *,
    gen_mode: str,
    llm_call_cost: float,
    image_call_cost: float,
    vision_call_cost: float,
    has_reviewer: bool,
) -> float:
    if gen_mode == "image2":
        llm_calls = 1
        image_calls = 2 if has_reviewer else 1
    else:
        # Planning + code generation, plus one possible code repair after QA.
        llm_calls = 3 if has_reviewer else 2
        image_calls = 0
    vision_calls = 2 if has_reviewer else 0
    return round(
        max(0.0, llm_call_cost) * llm_calls
        + max(0.0, image_call_cost) * image_calls
        + max(0.0, vision_call_cost) * vision_calls,
        2,
    )


async def _release_sci_generation_reservation(job_id: str) -> None:
    try:
        await release_task_reservation(job_id)
    except Exception as exc:
        logger.warning("[SciFig] failed to release credit reservation job_id=%s error=%s", job_id, exc)
MAX_PER_USER_RENDERS = 2


async def _execute_sci_model_call(
    *,
    state: dict,
    model_id: str,
    category: str,
    description: str,
    operation: str,
    material: Any,
    invoke,
    attempt: int = 1,
):
    job_id = str(state.get("job_id") or "")
    user_id = str(state["user_id"])
    reservation = await get_task_reservation(job_id) if job_id else None
    if reservation is not None and reservation.user_id != user_id:
        raise HTTPException(409, "Scientific figure billing reservation owner mismatch")
    return await execute_billed_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=category,
        description=description,
        # Scientific-figure jobs have their own state store, not a task row.
        related_task_id=None,
        reservation_task_id=job_id if reservation is not None else None,
        idempotency_key=model_billing_operation_key(
            namespace="sci-fig",
            user_id=str(state["user_id"]),
            operation_scope=(
                f"{job_id}:{operation}:attempt:{max(1, int(attempt))}"
                if job_id else ""
            ),
            material={
                "model_id": model_id,
                "category": category,
                "request": material,
            },
        ),
        invoke=invoke,
    )


def _get_user_sem(user_id: str) -> asyncio.Semaphore:
    if user_id not in _user_render_sems:
        _user_render_sems[user_id] = asyncio.Semaphore(MAX_PER_USER_RENDERS)
    return _user_render_sems[user_id]


async def _refresh_running_lock(job_id: str):
    try:
        from core.redis import get_redis

        await get_redis().set(f"sci_fig_job:{job_id}:running", "1", ex=120)
    except Exception as exc:
        logger.warning("[SciFig] running lock refresh failed: job_id=%s error=%s", job_id, exc)


async def _clear_running_lock(job_id: str):
    try:
        from core.redis import get_redis

        await get_redis().delete(f"sci_fig_job:{job_id}:running")
    except Exception as exc:
        logger.warning("[SciFig] running lock clear failed: job_id=%s error=%s", job_id, exc)


async def _run_with_running_lock(job_id: str, runner):
    async def heartbeat():
        while True:
            await _refresh_running_lock(job_id)
            await asyncio.sleep(30)

    await _refresh_running_lock(job_id)
    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        return await runner()
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        await _clear_running_lock(job_id)


async def _auth(
    token: Optional[str] = Query(default=None),
    user: Optional[dict] = Depends(get_current_user),
) -> dict:
    if user:
        return user
    if token:
        from core.security import decode_token
        import repositories.user_repo as user_repo

        payload = decode_token(token)
        if payload and payload.get("type") == "access":
            u = await user_repo.get_by_id(payload["sub"])
            if u:
                from routers.auth import _require_current_legal_acceptance
                await _require_current_legal_acceptance(u, payload)
                return u
    raise HTTPException(401, "未登录")


# ─── 请求模型 ──────────────────────────────────────────────────────────────────

class SciFigStartRequest(BaseModel):
    description: str
    category: str = "data_chart"  # data_chart | flow_diagram | network_diagram | schematic
    gen_mode: str = "image2"  # image2 | svg
    style_preset: str = "custom"
    output_format: str = "png"  # png | svg | pdf
    output_resolution: str = "1k"
    image_quality: str = "auto"
    chart_params: Optional[dict] = None
    reference_assets: list[ImageAssetReference] = Field(default_factory=list)
    # Compatibility only; the value is archived before it reaches worker state.
    ref_image_b64: Optional[str] = None
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""
    llm_model_id: Optional[str] = None
    image_model_id: Optional[str] = None
    vision_model_id: Optional[str] = None
    conversation_id: Optional[str] = None
    client_request_id: str = ""
    skill_id: str = ""
    skill_revision: int = 0


class SciFigRefineRequest(BaseModel):
    description: Optional[str] = None
    chart_params: Optional[dict] = None
    code_feedback: Optional[str] = None
    style_preset: Optional[str] = None
    image_model_id: Optional[str] = None
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""


class SciFigEnhanceRequest(BaseModel):
    image_model_id: str
    prompt: str = "学术风格，高对比度，清晰的线条，Nature 期刊风格"
    strength: float = 0.3


class SciFigSelectVersionRequest(BaseModel):
    version_index: int


def _normalize_gen_mode(mode: str) -> str:
    """Accept legacy mode names while exposing only svg/image2 to the UI."""
    if mode == "code_render":
        return "svg"
    if mode == "ai_generate":
        return "image2"
    return mode if mode in {"svg", "image2"} else "image2"


def _public_sci_fig_status_message(state: dict) -> str:
    """Do not expose legacy auto-repair prompts as a task-card status."""
    message = str(state.get("message") or "").strip()
    if re.match(r"^正在按检查建议(?:修正科研图|生成修订版|生成修正版)\s*[：:]", message):
        return "正在根据检查建议生成修订版。"
    return message


def _strip_data_url(b64: str) -> str:
    if b64.startswith("data:"):
        return b64.split(",", 1)[1]
    return b64


def _artifact_version_from_state(state: dict, prompt: str) -> dict:
    asset_meta = state.get("rendered_asset") if isinstance(state.get("rendered_asset"), dict) else {}
    return {
        "id": str(uuid.uuid4()),
        "mode": _normalize_gen_mode(state.get("gen_mode", "image2")),
        "renderedB64": state.get("rendered_b64", ""),
        "renderedUrl": asset_meta.get("preview_url") or asset_meta.get("image_url") or "",
        "imageUrl": asset_meta.get("image_url") or "",
        "previewUrl": asset_meta.get("preview_url") or "",
        "thumbnailUrl": asset_meta.get("thumbnail_url") or "",
        "assetId": asset_meta.get("asset_id") or "",
        "assetOriginalKey": asset_meta.get("asset_original_key") or "",
        "assetPreviewKey": asset_meta.get("asset_preview_key") or "",
        "assetThumbKey": asset_meta.get("asset_thumb_key") or "",
        "codePreview": state.get("code", ""),
        "svgData": state.get("svg_data", ""),
        "outputFormats": _get_output_formats(state),
        "prompt": prompt,
        "createdAt": datetime.utcnow().isoformat() + "Z",
    }


def _append_artifact_version(state: dict, prompt: str):
    versions = state.setdefault("artifact_versions", [])
    versions.append(_artifact_version_from_state(state, prompt))
    state["selected_version_index"] = len(versions) - 1


def _selected_artifact_version(state: dict) -> dict:
    versions = state.get("artifact_versions") or []
    if not versions:
        return {}
    idx = int(state.get("selected_version_index", len(versions) - 1) or 0)
    idx = min(max(idx, 0), len(versions) - 1)
    version = versions[idx]
    return version if isinstance(version, dict) else {}


async def _store_sci_rendered_asset(state: dict, *, job_id: str, prompt: str, model_id: str = "") -> Optional[dict]:
    rendered = state.get("rendered_b64") or ""
    if not rendered:
        return None
    asset = await asset_storage.store_generated_image_best_effort(
        image_base64=rendered,
        user_id=state["user_id"],
        conversation_id=state.get("conversation_id") or None,
        task_id=job_id,
        prompt=prompt or state.get("description", ""),
        model_id=model_id or state.get("image_model_id") or state.get("llm_model_id") or "",
        category="sci-fig",
        item_id=f"v{len(state.get('artifact_versions', [])) + 1}",
    )
    if not asset:
        return None
    meta = asset.to_meta()
    state["rendered_asset"] = meta
    return meta


async def _record_message(state: dict, role: str, content: str, meta: dict | None = None):
    conv_id = state.get("conversation_id")
    if not conv_id:
        return None
    try:
        return await conversation_repo.add_message(conv_id, role, content, meta or {})
    except Exception as exc:
        logger.warning("[SciFig] conversation message write failed: %s", exc)
        return None


def _sci_request_meta(state: dict) -> dict:
    return {
        "type": "sci_fig_request",
        "job_id": state.get("job_id"),
        "gen_mode": _normalize_gen_mode(state.get("gen_mode", "image2")),
        "category": state.get("category"),
        "style_preset": state.get("style_preset"),
        "output_format": state.get("output_format"),
        "creative_skill": state.get("creative_skill"),
        "user_description": state.get("user_description", ""),
        "attachments": [
            {"filename": item.get("filename"), "kind": item.get("kind"), "size": item.get("size")}
            for item in state.get("attachments", [])
            if isinstance(item, dict)
        ],
    }


async def _ensure_request_message(state: dict):
    conv_id = state.get("conversation_id")
    user_id = state.get("user_id")
    job_id = state.get("job_id")
    if not conv_id or not user_id or not job_id or state.get("request_message_id"):
        return
    try:
        messages = await conversation_repo.get_conversation_messages(conv_id, user_id, light=True)
        for message in messages:
            meta = message.get("meta") or {}
            if meta.get("job_id") == job_id and meta.get("type") in {"sci_fig_request", "sci_fig_artifact"}:
                state["request_message_id"] = message.get("id") or ""
                return
    except Exception as exc:
        logger.warning("[SciFig] request message check failed: %s", exc)

    message = await _record_message(
        state,
        "user",
        state.get("description", ""),
        _sci_request_meta(state),
    )
    if message:
        state["request_message_id"] = message.get("id") or ""


async def _ensure_conversation(state: dict):
    if state.get("conversation_id"):
        try:
            if await conversation_repo.conversation_belongs_to_user(state["conversation_id"], state["user_id"]):
                await _ensure_request_message(state)
                return
            logger.warning("[SciFig] conversation %s is unavailable, creating a replacement", state.get("conversation_id"))
            state["conversation_id"] = ""
        except Exception as exc:
            logger.warning("[SciFig] conversation ownership check failed: %s", exc)
            state["conversation_id"] = ""
    try:
        conv = await conversation_repo.create_conversation(
            user_id=state["user_id"],
            conv_type="sci-fig",
            title=(state.get("description") or "科研绘图")[:80],
            creation_key=(f"sci-fig:{state.get('client_request_id')}" if state.get("client_request_id") else None),
        )
        state["conversation_id"] = conv["id"]
        await _ensure_request_message(state)
        await _save_state(state["job_id"], state)
    except Exception as exc:
        logger.warning("[SciFig] conversation create failed: %s", exc)


def _sci_version_asset_id(version: dict) -> str:
    if not isinstance(version, dict):
        return ""
    return version.get("assetId") or version.get("asset_id") or ""


async def _selected_sci_image_bytes(state: dict, user_id: str) -> bytes:
    selected_version = _selected_artifact_version(state)
    version_b64 = ""
    if selected_version:
        version_b64 = selected_version.get("renderedB64") or selected_version.get("rendered_b64") or ""
    if version_b64:
        return base64.b64decode(_strip_data_url(version_b64))

    selected_asset_id = _sci_version_asset_id(selected_version)
    if selected_asset_id:
        data, _ = await asset_storage.fetch_image_asset_variant(selected_asset_id, user_id, "original")
        return data

    rendered_b64 = state.get("rendered_b64") or ""
    if rendered_b64:
        return base64.b64decode(_strip_data_url(rendered_b64))

    rendered_asset = state.get("rendered_asset") if isinstance(state.get("rendered_asset"), dict) else {}
    rendered_asset_id = rendered_asset.get("asset_id") or ""
    if rendered_asset_id:
        data, _ = await asset_storage.fetch_image_asset_variant(rendered_asset_id, user_id, "original")
        return data

    for key in ("imageUrl", "image_url", "renderedUrl", "rendered_url", "previewUrl", "preview_url"):
        url = selected_version.get(key) if selected_version else ""
        if url:
            return await asset_storage.fetch_asset_bytes(str(url))
    for key in ("image_url", "preview_url", "thumbnail_url"):
        url = rendered_asset.get(key) or ""
        if url:
            return await asset_storage.fetch_asset_bytes(str(url))

    raise RuntimeError("图表尚未生成完成，请等待渲染结束")


def _sci_download_state_from_meta(meta: dict, job_id: str, user_id: str) -> dict | None:
    if not isinstance(meta, dict):
        return None
    versions = meta.get("artifact_versions")
    rendered_asset = meta.get("rendered_asset")
    has_artifact = bool(
        meta.get("rendered_b64")
        or meta.get("svg_data")
        or (isinstance(rendered_asset, dict) and rendered_asset)
        or (isinstance(versions, list) and versions)
    )
    if meta.get("type") != "sci_fig_artifact" and not has_artifact:
        return None
    versions = versions if isinstance(versions, list) else []
    try:
        selected_index = int(meta.get("selected_version_index"))
    except Exception:
        selected_index = len(versions) - 1
    if selected_index < 0 and versions:
        selected_index = len(versions) - 1
    payload = {
        "job_id": job_id,
        "user_id": user_id,
        "status": meta.get("status") or "done",
        "rendered_b64": meta.get("rendered_b64") or "",
        "rendered_asset": rendered_asset if isinstance(rendered_asset, dict) else {},
        "svg_data": meta.get("svg_data") or meta.get("svgData") or "",
        "code": meta.get("code_preview") or meta.get("code") or "",
        "artifact_versions": versions,
        "selected_version_index": selected_index,
    }
    return payload


async def _recover_sci_download_state(job_id: str, user_id: str) -> dict | None:
    messages = await conversation_repo.find_messages_by_job_id(job_id, user_id, conv_type="sci-fig")
    for message in reversed(messages):
        state = _sci_download_state_from_meta(message.get("meta") or {}, job_id, user_id)
        if state:
            return state
    return None


async def _load_sci_download_state(job_id: str, user_id: str) -> dict | None:
    state = await _load_state(job_id)
    if state:
        return state
    return await _recover_sci_download_state(job_id, user_id)


async def _attach_sci_assets_to_message(state: dict, message_id: str):
    if not message_id:
        return
    asset_ids: set[str] = set()
    rendered_asset = state.get("rendered_asset") if isinstance(state.get("rendered_asset"), dict) else {}
    if rendered_asset.get("asset_id"):
        asset_ids.add(rendered_asset["asset_id"])
    for version in state.get("artifact_versions", []):
        asset_id = _sci_version_asset_id(version)
        if asset_id:
            asset_ids.add(asset_id)
    for asset_id in asset_ids:
        try:
            await asset_storage.attach_message(asset_id, message_id)
        except Exception as exc:
            logger.warning(
                "[SciFig] asset message attach failed: asset_id=%s message_id=%s error=%s",
                asset_id,
                message_id,
                exc,
            )


def _has_remote_sci_asset(state: dict) -> bool:
    rendered_asset = state.get("rendered_asset") if isinstance(state.get("rendered_asset"), dict) else {}
    if rendered_asset.get("asset_id") or rendered_asset.get("image_url") or rendered_asset.get("preview_url"):
        return True
    return any(_sci_version_asset_id(version) for version in state.get("artifact_versions", []))


async def _save_artifact_message(state: dict, content: str | None = None):
    if not state.get("rendered_b64") and not state.get("rendered_asset") and not state.get("artifact_versions"):
        return
    await _ensure_conversation(state)
    has_remote_asset = _has_remote_sci_asset(state)
    artifact_versions = state.get("artifact_versions", [])
    versions_meta = compact_image_versions(artifact_versions) if has_remote_asset else artifact_versions
    signature = json.dumps(
        {
            "status": state.get("status"),
            "rendered_asset_id": (state.get("rendered_asset") or {}).get("asset_id") if isinstance(state.get("rendered_asset"), dict) else "",
            "version_ids": [version.get("id") for version in artifact_versions if isinstance(version, dict)],
            "selected_version_index": state.get("selected_version_index", -1),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    if state.get("artifact_message_signature") == signature:
        return
    saved = await _record_message(
        state,
        "assistant",
        content or ("科研图已确认，可继续编辑或下载。" if state.get("status") == "done" else "科研图已生成，可继续编辑或下载。"),
        {
            "type": "sci_fig_artifact",
            "job_id": state.get("job_id"),
            "status": state.get("status", "preview"),
            "gen_mode": _normalize_gen_mode(state.get("gen_mode", "image2")),
            "rendered_b64": "" if has_remote_asset else state.get("rendered_b64", ""),
            "rendered_asset": state.get("rendered_asset"),
            "code_preview": state.get("code", ""),
            "output_formats": _get_output_formats(state),
            "agent_plan": state.get("agent_plan"),
            "agent_steps": state.get("agent_steps", []),
            "artifact_versions": versions_meta,
            "selected_version_index": state.get("selected_version_index", -1),
        },
    )
    if not saved:
        state["artifact_persist_error"] = "sci_fig_artifact message write failed"
        return
    state["artifact_message_signature"] = signature
    state["artifact_message_id"] = saved.get("id") or ""
    state.pop("artifact_persist_error", None)
    await _attach_sci_assets_to_message(state, state["artifact_message_id"])
    await _save_state(state["job_id"], state)


SCI_FIG_PLAN_SYSTEM = """You are a senior scientific visualization agent.
Return JSON only:
{
  "intent_summary": "short Chinese summary",
  "figure_goal": "what the figure must communicate",
  "recommended_category": "auto|data_chart|flow_diagram|network_diagram|schematic",
  "recommended_style": "auto|nature|ieee|science|cell|minimal|mono|medical|custom",
  "source_findings": ["facts, metrics, entities, claims extracted from uploaded materials"],
  "data_constraints": ["constraint"],
  "content_outline": ["panel or section"],
  "asset_plan": ["uploaded figures/assets/data to reuse or respect"],
  "visual_plan": "layout, encodings, labels, panels, style",
  "generation_prompt": "prompt/code brief to execute",
  "quality_checks": ["check"]
}
Deeply read uploaded data/source materials before planning. If category/style are auto, choose the best one and explain it in the JSON fields. Do not invent unsupported values."""


SCI_FIG_QA_SYSTEM = """You are a strict scientific figure reviewer.
Return JSON only:
{"pass": true, "score": 0.0, "issues": [], "repair_prompt": ""}
Check scientific correctness, readability, publication quality, label clarity, data faithfulness, and whether the figure matches the requested category and style."""


def _parse_json_object(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end <= start:
        raise ValueError("AI response is not JSON")
    return json.loads(raw[start:end])


def _coerce_category(category: str | None) -> str:
    return category if category in CATEGORY_LABELS and category != "auto" else "data_chart"


def _coerce_style(style: str | None) -> str:
    return style if style in STYLE_PRESETS and style != "auto" else "custom"


def _resolve_plan_choices(state: dict, plan: dict) -> None:
    requested_category = state.get("category", "auto")
    requested_style = state.get("style_preset", "auto")
    plan_category = plan.get("recommended_category") or plan.get("category")
    plan_style = plan.get("recommended_style") or plan.get("style")

    resolved_category = _coerce_category(plan_category if requested_category == "auto" else requested_category)
    resolved_style = _coerce_style(plan_style if requested_style == "auto" else requested_style)

    state["resolved_category"] = resolved_category
    state["resolved_style"] = resolved_style
    state["category"] = resolved_category
    state["style_preset"] = resolved_style
    plan["recommended_category"] = resolved_category
    plan["recommended_style"] = resolved_style


async def _sci_save_step(
    state: dict,
    *,
    name: str,
    status: str,
    message: str,
    progress: int,
    attempt: int = 1,
    result: dict | None = None,
    error: str = "",
):
    await set_agent_step(
        state,
        lambda s: _save_state(s["job_id"], s),
        name=name,
        status=status,
        message=message,
        progress=progress,
        attempt=attempt,
        result=result,
        error=error,
    )


async def _plan_sci_figure(state: dict) -> dict:
    model_id = await provider_policy.choose_llm_model_id(state.get("llm_model_id"))
    if not model_id:
        return {
            "intent_summary": state.get("description", "")[:160],
            "figure_goal": state.get("description", ""),
            "data_constraints": [],
            "visual_plan": state.get("description", ""),
            "generation_prompt": state.get("description", ""),
            "quality_checks": ["matches request", "readable labels", "publication quality"],
        }
    user_msg = (
        f"Description:\n{state.get('description', '')}\n\n"
        f"Category: {state.get('category')}\n"
        f"Mode: {state.get('gen_mode')}\n"
        f"Style: {state.get('style_preset')}\n"
        f"Chart params:\n{json.dumps(state.get('chart_params') or {}, ensure_ascii=False)[:12000]}\n"
    )
    if state.get("attachment_context"):
        user_msg += f"\nUploaded source materials:\n{state['attachment_context'][:50000]}"
    raw = await _execute_sci_model_call(
        state=state,
        model_id=model_id,
        category="llm",
        description="科研绘图智能体意图理解与规划",
        operation="figure-plan",
        material={
            "system": SCI_FIG_PLAN_SYSTEM,
            "user": user_msg,
            "max_tokens": 1600,
            "temperature": 0.25,
        },
        invoke=lambda: call_chat(
            model_id=model_id,
            system=SCI_FIG_PLAN_SYSTEM,
            user=user_msg,
            max_tokens=1600,
            temperature=0.25,
        ),
    )
    parsed = _parse_json_object(raw)
    parsed["generation_prompt"] = parsed.get("generation_prompt") or state.get("description", "")
    parsed.setdefault("source_findings", [])
    parsed.setdefault("content_outline", [])
    parsed.setdefault("asset_plan", [])
    parsed.setdefault("quality_checks", [])
    return parsed

async def _qa_sci_figure(state: dict, image_b64: str, prompt: str) -> dict:
    model_id = await provider_policy.choose_vision_model_id(state.get("vision_model_id"))
    if not model_id or not image_b64:
        return {"pass": True, "score": 0.8, "issues": [], "repair_prompt": ""}
    raw_b64 = _strip_data_url(image_b64)
    image_bytes = base64.b64decode(raw_b64)
    review_prompt = (
        f"Original request:\n{state.get('description', '')}\n\n"
        f"Execution prompt/plan:\n{prompt[:6000]}\n\n"
        f"Category: {state.get('category')}; style: {state.get('style_preset')}"
    )
    try:
        review_index = int(state.get("visual_review_count") or 0) + 1
        result = await _execute_sci_model_call(
            state=state,
            model_id=model_id,
            category="vision",
            description="科研绘图视觉质量检查",
            operation=f"visual-review-{review_index}",
            material={
                "system": SCI_FIG_QA_SYSTEM,
                "prompt": review_prompt,
                "image": image_bytes,
                "max_tokens": 1200,
            },
            invoke=lambda: call_vision(
                model_id=model_id,
                system=SCI_FIG_QA_SYSTEM,
                prompt=review_prompt,
                image_bytes=image_bytes,
                max_tokens=1200,
            ),
        )
        state["visual_review_count"] = review_index
        parsed = _parse_json_object(result)
        parsed["pass"] = parsed.get("pass", False) is True
        return parsed
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[SciFig] vision QA failed, allowing result: {e}")
        return {"pass": True, "score": 0.7, "issues": [], "repair_prompt": ""}


def _sci_quality_review(qa: dict, *, prefix: str = "当前科研图已经生成") -> dict:
    issues = [str(item)[:240] for item in (qa.get("issues") or []) if str(item).strip()][:4]
    repair_prompt = str(qa.get("repair_prompt") or "优化科学标注、图例层级和可读性。").strip()
    return {
        "kind": "quality_review",
        "message": f"{prefix}。检查建议：{'；'.join(issues) or '可进一步优化科学表达'}。",
        "current_result_available": True,
        "score": qa.get("score"),
        "issues": issues,
        "repair_prompt": repair_prompt,
        "actions": ["keep_current", "create_revision"],
    }


# ─── API 端点 ──────────────────────────────────────────────────────────────────

@router.get("/categories")
async def get_categories():
    """获取支持的图表类别"""
    return {"categories": CATEGORY_LABELS}


@router.get("/styles")
async def get_styles():
    """获取支持的风格预设"""
    return {"styles": {k: v["label"] for k, v in STYLE_PRESETS.items()}}


@router.post("/start")
async def start_generation(body: SciFigStartRequest, user: dict = Depends(_auth)):
    submit_key = module_submit_idempotency_key(
        module="sci_fig",
        user_id=user["id"],
        client_request_id=body.client_request_id,
    )
    if not submit_key:
        return await _start_generation(body, user)

    duplicate = await claim_submit_key(submit_key)
    if duplicate:
        return duplicate
    try:
        result = await _start_generation(body, user)
    except Exception:
        await forget_submit_key(submit_key)
        raise
    await remember_submit_key(submit_key, result)
    return result


async def _start_generation(body: SciFigStartRequest, user: dict):
    """启动生成任务"""
    user_id = user["id"]
    sem = _get_user_sem(user_id)
    if sem.locked():
        raise HTTPException(429, "当前有正在进行的生成任务，请稍候")

    user_description = body.description.strip()
    description = user_description
    category = body.category
    gen_mode = _normalize_gen_mode(body.gen_mode)
    style_preset = body.style_preset
    output_format = body.output_format
    output_resolution = normalize_output_resolution(body.output_resolution)
    image_quality = normalize_image_quality(body.image_quality)
    llm_model_request = body.llm_model_id or ""
    image_model_request = body.image_model_id or ""
    vision_model_request = body.vision_model_id or ""
    skill_audit_meta: dict[str, object] = {}
    skill_display_name = ""

    skill_id = body.skill_id.strip()[:160]
    if skill_id:
        skill = await creative_style_repo.get_style_preset(skill_id)
        if not skill or skill.get("enabled") is False:
            raise HTTPException(404, "灵感配方不存在或已停用")
        current_revision = int(skill.get("revision") or 1)
        if body.skill_revision and body.skill_revision != current_revision:
            raise HTTPException(409, "灵感配方已更新，请重新选择后再提交")
        submitted_image_count = len(body.reference_assets) or (1 if body.ref_image_b64 else 0)
        try:
            resolved_skill = resolve_creative_skill_submission(
                skill,
                expected_module="SCI_FIG",
                user_prompt=user_description,
                image_count=submitted_image_count,
            )
        except CreativeSkillResolutionError as exc:
            status_code = 404 if exc.code == "skill_disabled" else 400
            raise HTTPException(status_code, str(exc)) from exc
        description = resolved_skill.instruction
        skill_display_name = str(skill.get("name") or skill_id)
        skill_audit_meta = {
            **resolved_skill.audit_meta(),
            "resolved_params": resolved_skill.params,
        }
        allowed_overrides = set(resolved_skill.constraints.get("user_overrides", []))
        locked_defaults = {
            key: value
            for key, value in resolved_skill.params.items()
            if key not in allowed_overrides
        }
        if "model_id" in locked_defaults:
            image_model_request = str(locked_defaults["model_id"])
        if "llm_model_id" in locked_defaults:
            llm_model_request = str(locked_defaults["llm_model_id"])
        if "vision_model_id" in locked_defaults:
            vision_model_request = str(locked_defaults["vision_model_id"])
        if "category" in locked_defaults:
            category = str(locked_defaults["category"])
        if "gen_mode" in locked_defaults:
            gen_mode = _normalize_gen_mode(str(locked_defaults["gen_mode"]))
        if "style_preset" in locked_defaults:
            style_preset = str(locked_defaults["style_preset"])
        if "output_format" in locked_defaults:
            output_format = str(locked_defaults["output_format"])
        if "output_resolution" in locked_defaults:
            output_resolution = normalize_output_resolution(str(locked_defaults["output_resolution"]))
        if "image_quality" in locked_defaults:
            image_quality = normalize_image_quality(str(locked_defaults["image_quality"]))
    elif not description:
        raise HTTPException(400, "请输入科研绘图描述，或选择一个可直接运行的灵感配方")

    llm_model_id = await provider_policy.choose_llm_model_id(llm_model_request)
    image_model_id = image_model_request
    image_call_cost = 0.0
    if gen_mode == "image2":
        image_model_id = await provider_policy.choose_image_model_id(image_model_id)
        if not image_model_id:
            raise HTTPException(400, "未配置图像生成模型，请在管理端配置 image2/generate 模型")
        image_call_cost = await check_model_call(
            user_id=user_id,
            model_id=image_model_id,
            expected_category="generate",
            description="科研 image2 生成",
        )
    llm_call_cost = 0.0
    if llm_model_id:
        llm_call_cost = await check_model_call(
            user_id=user_id,
            model_id=llm_model_id,
            expected_category="llm",
            description="科研绘图智能体规划/代码生成",
        )
    # Both editable and image2 figures use the same post-generation review.
    # A missing reviewer is non-fatal, but an available one enables the single
    # visible automatic correction authorized for this task.
    vision_model_id = await provider_policy.choose_vision_model_id(vision_model_request)
    vision_call_cost = 0.0
    if vision_model_id:
        vision_call_cost = await check_model_call(
            user_id=user_id,
            model_id=vision_model_id,
            expected_category="vision",
            description="科研绘图视觉质检",
        )
    job_id = str(uuid.uuid4())
    try:
        reference_assets = await canonicalize_image_asset_references(
            references=body.reference_assets,
            legacy_image_base64=body.ref_image_b64 or "",
            user_id=user_id,
            category="sci-fig-reference",
            task_id=job_id,
        )
    except ImageAssetReferenceError as exc:
        raise HTTPException(422, str(exc)) from exc
    reserved_cost = _sci_generation_reservation_amount(
        gen_mode=gen_mode,
        llm_call_cost=llm_call_cost,
        image_call_cost=image_call_cost,
        vision_call_cost=vision_call_cost,
        has_reviewer=bool(vision_model_id),
    )
    attachment_context = (body.attachment_context or "").strip() or build_attachment_context(body.attachments or [])
    state = {
        "job_id": job_id,
        "user_id": user_id,
        "status": "generating",
        "progress": 0,
        "message": "正在初始化...",
        "description": description,
        "user_description": user_description,
        "category": category,
        "gen_mode": gen_mode,
        "style_preset": style_preset,
        "output_format": output_format,
        "output_resolution": output_resolution,
        "output_size": image_output_size("4:3", output_resolution),
        "image_quality": image_quality,
        "chart_params": body.chart_params or {},
        "reference_assets": [item.model_dump() for item in reference_assets],
        "attachments": body.attachments or [],
        "attachment_context": attachment_context,
        "llm_model_id": llm_model_id,
        "image_model_id": image_model_id,
        "vision_model_id": vision_model_id,
        "code": "",
        "rendered_b64": "",
        "svg_data": "",
        "error": "",
        "retry_count": 0,
        "artifact_versions": [],
        "selected_version_index": -1,
        "agent_steps": [],
        "conversation_id": body.conversation_id or "",
        "client_request_id": body.client_request_id.strip()[:128],
        "creative_skill": skill_audit_meta or None,
        "skill_name": skill_display_name,
        "reserved_cost": reserved_cost,
    }
    contract = build_delivery_contract(
        module="sci_fig",
        action="create",
        instruction=description,
        context={
            "category": category,
            "gen_mode": gen_mode,
            "output_format": output_format,
            "attachment_count": len(body.attachments or []),
            "reference_count": len(reference_assets),
            "creative_skill": skill_audit_meta or None,
        },
    )
    state["delivery_contract"] = contract.model_dump()
    if reserved_cost > 0 and not await reserve_for_task(user_id, job_id, reserved_cost):
        available = await get_available_balance(user_id)
        raise HTTPException(
            402,
            f"积分不足或计费保护服务暂不可用。本任务最多需要占用 {reserved_cost:g} 积分，当前可用 {available:.2f}。",
        )

    try:
        await _ensure_conversation(state)
        try:
            run = await create_module_run(
                user_id=user_id,
                module="sci_fig",
                action="create",
                instruction=description,
                context={
                    "category": category,
                    "gen_mode": gen_mode,
                    "output_format": output_format,
                    "attachment_count": len(body.attachments or []),
                    "reference_count": len(reference_assets),
                    "creative_skill": skill_audit_meta or None,
                },
                conversation_id=state.get("conversation_id") or "",
                contract=contract,
            )
            state["agent_run_id"] = run["run_id"]
        except Exception as exc:
            logger.warning("[SciFig] failed to create top-level agent run job_id=%s error=%s", job_id, exc)
        await _save_state(job_id, state)
        await enqueue(
            task_type="sci-fig",
            task_id=job_id,
            payload={"job_id": job_id, "user_id": user_id},
            priority="normal",
            user_id=user_id,
        )
    except HTTPException:
        await _release_sci_generation_reservation(job_id)
        raise
    except Exception as exc:
        logger.exception("[SciFig] enqueue failed: job_id=%s", job_id)
        state["status"] = "failed"
        state["error"] = "科研绘图任务提交到队列失败，请稍后重试。"
        state["message"] = state["error"]
        try:
            await _save_state(job_id, state)
        except Exception:
            logger.warning("[SciFig] failed to persist submission error job_id=%s", job_id, exc_info=True)
        await _release_sci_generation_reservation(job_id)
        raise HTTPException(503, state["error"]) from exc

    return {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id", ""),
        "status": "generating",
        "creative_skill": skill_audit_meta or None,
    }


@router.get("/history")
async def list_sci_fig_history(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(_auth),
):
    rows = await conversation_repo.list_sci_fig_history_summaries(user["id"], limit=limit, offset=offset)
    prepared_rows = await asset_storage.prepare_image_asset_payload(rows, user["id"])
    return [history_artifacts.sci_fig_history_item(row) for row in prepared_rows]


async def _run_generation(job_id: str):
    """后台生成任务"""
    state = await _load_state(job_id)
    if not state:
        return

    user_id = state["user_id"]
    sem = _get_user_sem(user_id)

    async with sem:
        try:
            category = state["category"]
            gen_mode = _normalize_gen_mode(state.get("gen_mode", "image2"))
            state["gen_mode"] = gen_mode

            if gen_mode == "image2":
                await _run_ai_generate(state)
            else:
                await _run_code_render(state)

        except Exception as e:
            import traceback
            logger.error(f"[SciFig] Job {job_id} failed: {e}\n{traceback.format_exc()}")
            state["status"] = "failed"
            state["error"] = str(e) or repr(e)
            await _save_state(job_id, state)
            await _record_message(state, "assistant", f"科研绘图生成失败：{state['error']}", {"type": "sci_fig_error", "job_id": job_id})


async def run_sci_fig_from_queue(job_id: str):
    try:
        await run_specialist_graph(
            module="sci_fig",
            job_id=job_id,
            load_state=lambda: _load_state(job_id),
            execute=lambda: _run_with_running_lock(job_id, lambda: _run_generation(job_id)),
        )
    finally:
        await _release_sci_generation_reservation(job_id)


async def run_sci_fig_refine_from_queue(
    job_id: str,
    mode: str,
    feedback: str,
    image_model_id: Optional[str] = None,
):
    async def runner():
        if mode == "image2":
            await _run_image2_refine(job_id, feedback, image_model_id)
        elif mode == "code-feedback":
            await _run_refine_with_feedback(job_id, feedback)
        else:
            await _run_generation(job_id)

    await run_specialist_graph(
        module="sci_fig",
        job_id=job_id,
        load_state=lambda: _load_state(job_id),
        execute=lambda: _run_with_running_lock(job_id, runner),
        force_execute=True,
    )


async def _run_code_render(state: dict):
    """Create one editable figure, then let the user decide on any revision."""
    job_id = state["job_id"]

    await _sci_save_step(
        state,
        name="intent_planning",
        status="running",
        message="正在阅读描述与附件，提取科研目标、数据约束和版式线索...",
        progress=10,
    )
    plan = await _plan_sci_figure(state)
    _resolve_plan_choices(state, plan)
    state["agent_plan"] = plan
    execution_description = plan.get("generation_prompt") or state["description"]
    await _sci_save_step(
        state,
        name="intent_planning",
        status="completed",
        message=f"已完成资料理解与图表规划：{CATEGORY_LABELS.get(state['category'], state['category'])} · {STYLE_PRESETS.get(state['style_preset'], STYLE_PRESETS['custom'])['label']}，开始生成可编辑图表。",
        progress=20,
        result={
            "intent_summary": plan.get("intent_summary", ""),
            "figure_goal": plan.get("figure_goal", ""),
            "recommended_category": plan.get("recommended_category", ""),
            "recommended_style": plan.get("recommended_style", ""),
            "source_findings": plan.get("source_findings", []),
            "content_outline": plan.get("content_outline", []),
            "asset_plan": plan.get("asset_plan", []),
            "quality_checks": plan.get("quality_checks", []),
        },
    )

    state["progress"] = 25
    state["message"] = "正在生成科研绘图代码..."
    await _save_state(job_id, state)

    code_model_id = await provider_policy.choose_llm_model_id(state.get("llm_model_id"))
    async def invoke_code_generation():
        return await generate_code(
            description=execution_description,
            category=state["category"],
            style_preset=state["style_preset"],
            chart_params=state.get("chart_params"),
            llm_model_id=code_model_id or None,
            attachment_context=state.get("attachment_context", ""),
        )

    if code_model_id:
        code = await _execute_sci_model_call(
            state=state,
            model_id=code_model_id,
            category="llm",
            description="科研绘图代码生成",
            operation="code-generation",
            material={
                "description": execution_description,
                "category": state["category"],
                "style_preset": state["style_preset"],
                "chart_params": state.get("chart_params"),
                "attachment_context": state.get("attachment_context", ""),
            },
            invoke=invoke_code_generation,
        )
    else:
        code = await invoke_code_generation()
    state["llm_model_id"] = code_model_id or state.get("llm_model_id", "")
    state["code"] = code
    await _sci_save_step(
        state,
        name="code_generation",
        status="completed",
        message="绘图代码已生成，开始沙箱渲染。",
        progress=45,
    )
    try:
        await _sci_save_step(
            state,
            name="render_execute",
            status="running",
            message="正在渲染科研图...",
            progress=58,
            attempt=1,
        )
        png_bytes, svg_data = await execute_code(code, state["category"])
        rendered_b64 = base64.b64encode(png_bytes).decode()
        state["rendered_b64"] = rendered_b64
        state["svg_data"] = svg_data
        await _sci_save_step(
            state,
            name="render_execute",
            status="completed",
            message="渲染成功，正在进行视觉质量检查。",
            progress=76,
            attempt=1,
        )
        await _sci_save_step(
            state,
            name="visual_qa",
            status="running",
            message="正在检查清晰度、科学一致性、标签可读性和发表质量...",
            progress=84,
            attempt=1,
        )
        qa = await _qa_sci_figure(state, rendered_b64, execution_description)
        if not qa.get("pass", True):
            first_code = code
            first_svg_data = svg_data
            first_rendered_b64 = rendered_b64
            repair_reason = str(qa.get("repair_prompt") or "优化科学标注、图例层级和可读性。").strip()
            first_review = _sci_quality_review(qa, prefix="首版科研图已生成")
            await _store_sci_rendered_asset(
                state,
                job_id=job_id,
                prompt=state.get("description", ""),
                model_id=state.get("llm_model_id", ""),
            )
            _append_artifact_version(state, state.get("description", ""))
            await _sci_save_step(
                state,
                name="visual_qa",
                status="completed",
                message="首版检查发现可优化的内容，已保留首版，等待用户决定是否修订。",
                progress=96,
                attempt=1,
                result={"score": qa.get("score"), "issues": first_review["issues"], "reason": repair_reason},
            )
            state["quality_review"] = first_review
            state["intervention"] = first_review
            state["status"] = "preview"
            state["progress"] = 100
            state["message"] = "科研图已生成，检查建议等待你决定是否创建修订版。"
            await _save_state(job_id, state)
            await _save_artifact_message(state)
            return
            await _sci_save_step(
                state,
                name="sci_figure_repair",
                status="running",
                message=f"正在按检查建议修正科研图：{repair_reason}",
                progress=80,
                attempt=2,
                result={"reason": repair_reason},
            )
            state["status"] = "generating"
            state["message"] = f"正在按检查建议修正科研图：{repair_reason}"
            await _save_state(job_id, state)
            repair_description = (
                f"{execution_description}\n\nAutomatic visual correction is authorized. "
                f"Preserve the factual constraints and correct this review finding: {repair_reason}"
            )
            try:
                async def invoke_auto_repair():
                    return await generate_code(
                        description=repair_description,
                        category=state["category"],
                        style_preset=state["style_preset"],
                        chart_params=state.get("chart_params"),
                        llm_model_id=code_model_id or None,
                        attachment_context=state.get("attachment_context", ""),
                    )

                if code_model_id:
                    repaired_code = await _execute_sci_model_call(
                        state=state,
                        model_id=code_model_id,
                        category="llm",
                        description="科研绘图自动修正",
                        operation="code-auto-repair",
                        material={
                            "description": repair_description,
                            "category": state["category"],
                            "style_preset": state["style_preset"],
                            "chart_params": state.get("chart_params"),
                            "attachment_context": state.get("attachment_context", ""),
                        },
                        invoke=invoke_auto_repair,
                    )
                else:
                    repaired_code = await invoke_auto_repair()
                repaired_png, repaired_svg = await execute_code(repaired_code, state["category"])
                repaired_b64 = base64.b64encode(repaired_png).decode()
                repaired_qa = await _qa_sci_figure(state, repaired_b64, repair_description)
                state["code"] = repaired_code
                state["svg_data"] = repaired_svg
                state["rendered_b64"] = repaired_b64
                state["rendered_asset"] = {}
                await _store_sci_rendered_asset(
                    state,
                    job_id=job_id,
                    prompt=repair_description,
                    model_id=state.get("llm_model_id", ""),
                )
                _append_artifact_version(state, state.get("description", ""))
                state["quality_review"] = {} if repaired_qa.get("pass", True) else _sci_quality_review(
                    repaired_qa,
                    prefix="自动修正后的科研图已生成",
                )
                state["intervention"] = state["quality_review"]
                state["status"] = "preview"
                state["progress"] = 100
                state["message"] = (
                    "科研图已完成自动修正并通过检查，可以预览或继续编辑。"
                    if not state["quality_review"]
                    else "自动修正已完成，两个版本都已保留；仍有可选的优化建议。"
                )
                await _sci_save_step(
                    state,
                    name="sci_figure_repair",
                    status="completed",
                    message=(
                        "已按检查建议完成自动修正，修正版已通过检查。"
                        if not state["quality_review"]
                        else "已完成一次自动修正，修正版仍保留为当前版本。"
                    ),
                    progress=96,
                    attempt=2,
                    result={
                        "reason": repair_reason,
                        "score": repaired_qa.get("score"),
                        "issues": repaired_qa.get("issues") or [],
                        "selected_version_index": state.get("selected_version_index"),
                    },
                )
            except HTTPException:
                raise
            except Exception as repair_error:
                state["code"] = first_code
                state["svg_data"] = first_svg_data
                state["rendered_b64"] = first_rendered_b64
                state["quality_review"] = first_review
                state["intervention"] = first_review
                state["status"] = "preview"
                state["progress"] = 100
                state["message"] = "自动修正未完成，首版已保留，可以继续编辑或手动创建修订版。"
                await _sci_save_step(
                    state,
                    name="sci_figure_repair",
                    status="failed",
                    message="自动修正未完成，已保留首版科研图。",
                    progress=96,
                    attempt=2,
                    result={"reason": repair_reason},
                    error=str(repair_error),
                )
            await _save_state(job_id, state)
            await _save_artifact_message(state)
            return
        issues = [str(item)[:240] for item in (qa.get("issues") or []) if str(item).strip()][:4]
        quality_review = {}
        if not qa.get("pass", True):
            repair_prompt = str(qa.get("repair_prompt") or "优化科学标注、图例层级和可读性。").strip()
            quality_review = {
                "kind": "quality_review",
                "message": f"当前科研图已经生成。检查建议：{'；'.join(issues) or '可进一步优化科学表达'}。",
                "current_result_available": True,
                "score": qa.get("score"),
                "issues": issues,
                "repair_prompt": repair_prompt,
                "actions": ["keep_current", "create_revision"],
            }
        state["quality_review"] = quality_review
        state["intervention"] = quality_review
        state["progress"] = 100
        state["status"] = "preview"
        state["message"] = (
            "科研图已生成，检查建议等待你决定是否创建修订版。"
            if quality_review else "科研图已生成并完成检查，可以预览或继续编辑。"
        )
        await _sci_save_step(
            state,
            name="visual_qa",
            status="completed",
            message=("检查已完成，当前版本已保留，等待你决定是否修订。" if quality_review else "科研图质量检查通过。"),
            progress=96,
            attempt=1,
            result={"score": qa.get("score"), "issues": issues, "quality_review": quality_review},
        )
        await _store_sci_rendered_asset(state, job_id=job_id, prompt=state.get("description", ""), model_id=state.get("llm_model_id", ""))
        _append_artifact_version(state, state.get("description", ""))
        await _save_state(job_id, state)
        await _save_artifact_message(state)
    except Exception as exc:
        error = str(exc)
        logger.warning("[SciFig] initial render failed before visual repair could begin: %s", error[:200])
        state["status"] = "failed"
        state["error"] = error
        state["message"] = "本次渲染没有返回成品，已保留绘图代码。请调整需求后由你确认再次生成。"
        state["intervention"] = {
            "kind": "render_error",
            "phase": "render",
            "message": state["message"],
            "actions": ["edit_request", "retry"],
        }
        await _sci_save_step(
            state,
            name="render_execute",
            status="failed",
            message="初次渲染未返回成品，尚无法进入视觉修正；已保留当前绘图方案。",
            progress=100,
            attempt=1,
            error=error,
        )
        await _save_state(job_id, state)


async def _run_ai_generate(state: dict):
    """image2 mode with planning and direct generation."""
    job_id = state["job_id"]

    await _sci_save_step(
        state,
        name="intent_planning",
        status="running",
        message="正在阅读描述与附件，规划 image2 视觉提示词和素材使用方式...",
        progress=10,
    )
    plan = await _plan_sci_figure(state)
    _resolve_plan_choices(state, plan)
    state["agent_plan"] = plan

    model_id = await provider_policy.choose_image_model_id(state.get("image_model_id"))
    if not model_id:
        state["status"] = "failed"
        state["error"] = "No image generation model is configured."
        state["message"] = state["error"]
        await _save_state(job_id, state)
        return
    state["image_model_id"] = model_id

    style_info = STYLE_PRESETS.get(state["style_preset"], STYLE_PRESETS["custom"])
    base_prompt = (
        f"Academic publication style: {style_info['label']}.\n"
        f"Style requirements: {style_info.get('description') or style_info.get('matplotlib_style') or 'publication-ready scientific figure'}\n"
        f"Figure goal: {plan.get('figure_goal') or state['description']}\n"
        f"Visual plan: {plan.get('visual_plan') or ''}\n"
        f"Execution prompt: {plan.get('generation_prompt') or state['description']}"
    )
    if state.get("attachment_context"):
        base_prompt += (
            "\n\nUse uploaded source materials as factual constraints. "
            "Represent actual values when possible and avoid inventing unsupported data:\n"
            f"{state['attachment_context'][:20000]}"
        )

    await _sci_save_step(
        state,
        name="intent_planning",
        status="completed",
        message=f"已完成资料理解与 image2 视觉规划：{CATEGORY_LABELS.get(state['category'], state['category'])} · {STYLE_PRESETS.get(state['style_preset'], STYLE_PRESETS['custom'])['label']}，开始生成。",
        progress=25,
        result={
            "intent_summary": plan.get("intent_summary", ""),
            "figure_goal": plan.get("figure_goal", ""),
            "recommended_category": plan.get("recommended_category", ""),
            "recommended_style": plan.get("recommended_style", ""),
            "source_findings": plan.get("source_findings", []),
            "content_outline": plan.get("content_outline", []),
            "asset_plan": plan.get("asset_plan", []),
            "quality_checks": plan.get("quality_checks", []),
        },
    )

    ref_images = await load_original_reference_bytes(
        state.get("reference_assets") or [],
        user_id=state["user_id"],
    )

    from services.ai_client import call_image

    prompt = base_prompt
    try:
        await _sci_save_step(
            state,
            name="image2_generation",
            status="running",
            message="正在用 image2 生成科研图...",
            progress=45,
            attempt=1,
        )
        result = await _execute_sci_model_call(
            state=state,
            model_id=model_id,
            category="generate",
            description="科研 image2 生成",
            operation="image2-generate",
            material={
                "prompt": prompt,
                "reference_images": ref_images,
                "size": image_output_size("4:3", state.get("output_resolution")),
                "quality": state.get("image_quality", "auto"),
                "force_size": True,
            },
            invoke=lambda: call_image(
                model_id=model_id,
                prompt=prompt,
                ref_images=ref_images,
                size=image_output_size("4:3", state.get("output_resolution")),
                quality=state.get("image_quality", "auto"),
                force_size=True,
            ),
        )
        first_rendered_b64 = base64.b64encode(result).decode()
        state["rendered_b64"] = first_rendered_b64
        state["svg_data"] = ""
        state["code"] = ""
        await _sci_save_step(
            state,
            name="image2_generation",
            status="completed",
            message="首版科研图已生成，正在检查科学表达与可读性。",
            progress=68,
            attempt=1,
        )
        await _sci_save_step(
            state,
            name="visual_qa",
            status="running",
            message="正在检查科学准确性、标注可读性和版式层级。",
            progress=74,
            attempt=1,
        )
        first_qa = await _qa_sci_figure(state, first_rendered_b64, prompt)
        if first_qa.get("pass", True):
            state["progress"] = 100
            state["status"] = "preview"
            state["message"] = "科研图已生成并完成检查，可以预览或继续编辑。"
            await _sci_save_step(
                state,
                name="visual_qa",
                status="completed",
                message="科研图质量检查通过。",
                progress=96,
                attempt=1,
                result={"score": first_qa.get("score"), "issues": first_qa.get("issues") or []},
            )
            await _store_sci_rendered_asset(state, job_id=job_id, prompt=prompt, model_id=model_id)
            _append_artifact_version(state, state.get("description", ""))
            await _save_state(job_id, state)
            await _save_artifact_message(state)
            return

        repair_reason = str(first_qa.get("repair_prompt") or "优化科学标注、图例层级和可读性。").strip()
        first_review = _sci_quality_review(first_qa, prefix="首版科研图已生成")
        await _store_sci_rendered_asset(state, job_id=job_id, prompt=prompt, model_id=model_id)
        _append_artifact_version(state, state.get("description", ""))
        await _sci_save_step(
            state,
            name="visual_qa",
            status="completed",
            message="首版检查发现可优化的内容，已保留首版，等待用户决定是否修订。",
            progress=96,
            attempt=1,
            result={"score": first_qa.get("score"), "issues": first_review["issues"], "reason": repair_reason},
        )
        state["quality_review"] = first_review
        state["intervention"] = first_review
        state["status"] = "preview"
        state["progress"] = 100
        state["message"] = "科研图已生成，检查建议等待你决定是否创建修订版。"
        await _save_state(job_id, state)
        await _save_artifact_message(state)
        return
        await _sci_save_step(
            state,
            name="image2_repair",
            status="running",
            message=f"正在按检查建议生成修正版：{repair_reason}",
            progress=80,
            attempt=2,
            result={"reason": repair_reason},
        )
        state["status"] = "generating"
        state["message"] = f"正在按检查建议修正科研图：{repair_reason}"
        await _save_state(job_id, state)

        repair_prompt = (
            f"{prompt}\n\nAutomatic visual correction is authorized. Preserve all factual constraints "
            f"from the source materials and correct this review finding: {repair_reason}"
        )
        try:
            repaired = await _execute_sci_model_call(
                state=state,
                model_id=model_id,
                category="generate",
                description="科研 image2 自动修正",
                operation="image2-auto-repair",
                material={
                    "prompt": repair_prompt,
                    "reference_images": ref_images,
                    "size": image_output_size("4:3", state.get("output_resolution")),
                    "quality": state.get("image_quality", "auto"),
                    "force_size": True,
                },
                invoke=lambda: call_image(
                    model_id=model_id,
                    prompt=repair_prompt,
                    ref_images=ref_images,
                    size=image_output_size("4:3", state.get("output_resolution")),
                    quality=state.get("image_quality", "auto"),
                    force_size=True,
                ),
            )
            repaired_b64 = base64.b64encode(repaired).decode()
            repaired_qa = await _qa_sci_figure(state, repaired_b64, repair_prompt)
            state["rendered_b64"] = repaired_b64
            state["rendered_asset"] = {}
            await _store_sci_rendered_asset(state, job_id=job_id, prompt=repair_prompt, model_id=model_id)
            _append_artifact_version(state, state.get("description", ""))
            state["quality_review"] = {} if repaired_qa.get("pass", True) else _sci_quality_review(
                repaired_qa,
                prefix="自动修正后的科研图已生成",
            )
            state["intervention"] = state["quality_review"]
            state["status"] = "preview"
            state["progress"] = 100
            state["message"] = (
                "科研图已完成自动修正并通过检查，可以预览或继续编辑。"
                if not state["quality_review"]
                else "自动修正已完成，两个版本都已保留；仍有可选的优化建议。"
            )
            await _sci_save_step(
                state,
                name="image2_repair",
                status="completed",
                message=(
                    "已按检查建议完成自动修正，修正版已通过检查。"
                    if not state["quality_review"]
                    else "已完成一次自动修正，修正版仍保留为当前版本。"
                ),
                progress=96,
                attempt=2,
                result={
                    "reason": repair_reason,
                    "score": repaired_qa.get("score"),
                    "issues": repaired_qa.get("issues") or [],
                    "selected_version_index": state.get("selected_version_index"),
                },
            )
        except HTTPException:
            # A provider-success/billing-settlement failure must remain visible.
            # Falling back to the first render would hide a charge that the
            # settlement outbox is still required to complete.
            raise
        except Exception as repair_error:
            state["rendered_b64"] = first_rendered_b64
            state["quality_review"] = first_review
            state["intervention"] = first_review
            state["status"] = "preview"
            state["progress"] = 100
            state["message"] = "自动修正未完成，首版已保留，可以继续编辑或手动创建修订版。"
            await _sci_save_step(
                state,
                name="image2_repair",
                status="failed",
                message="自动修正未完成，已保留首版科研图。",
                progress=96,
                attempt=2,
                result={"reason": repair_reason},
                error=str(repair_error),
            )
        await _save_state(job_id, state)
        await _save_artifact_message(state)
        return
    except Exception as e:
        state["status"] = "failed"
        state["progress"] = 100
        state["error"] = f"image2 generation failed: {e}"
        state["message"] = state["error"]
        await _sci_save_step(
            state,
            name="image2_generation",
            status="failed",
            message="image2 生成失败。",
            progress=60,
            attempt=1,
            error=str(e),
        )
        await _save_state(job_id, state)


@router.get("/status/{job_id}")
async def get_status(job_id: str, user: dict = Depends(_auth)):
    """轮询任务状态"""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")

    asset_meta = state.get("rendered_asset") if isinstance(state.get("rendered_asset"), dict) else {}
    has_remote_asset = bool(asset_meta.get("preview_url") or asset_meta.get("image_url"))
    artifact_versions = compact_image_versions(state.get("artifact_versions", [])) if has_remote_asset else state.get("artifact_versions", [])
    payload = {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id", ""),
        "status": state["status"],
        "progress": state["progress"],
        "message": _public_sci_fig_status_message(state),
        "error": state["error"],
        "code_preview": state.get("code", ""),
        "rendered_b64": "" if has_remote_asset else state.get("rendered_b64", ""),
        "rendered_asset": asset_meta,
        "output_formats": _get_output_formats(state),
        "gen_mode": _normalize_gen_mode(state.get("gen_mode", "image2")),
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "agent_run_id": state.get("agent_run_id", ""),
        "delivery_contract": state.get("delivery_contract", {}),
        "intervention": state.get("intervention", {}),
        "resolved_category": state.get("resolved_category", state.get("category", "data_chart")),
        "resolved_style": state.get("resolved_style", state.get("style_preset", "custom")),
        "agent_plan": state.get("agent_plan", {}),
        "artifact_versions": artifact_versions,
        "selected_version_index": state.get("selected_version_index", -1),
        "agent_steps": state.get("agent_steps", []),
    }
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


def _get_output_formats(state: dict) -> list[str]:
    """根据状态返回可用的导出格式"""
    if state["status"] not in ("preview", "done"):
        return []
    formats = ["png"]
    if state.get("svg_data"):
        formats.append("svg")
    formats.append("pdf")
    return formats


@router.get("/result/{job_id}")
async def get_result(
    job_id: str,
    format: str = Query("png"),
    user: dict = Depends(_auth),
):
    """下载渲染结果"""
    state = await _load_sci_download_state(job_id, user["id"])
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")
    # 只要有渲染结果就允许下载，不限制状态
    format = (format or "png").lower()
    if format not in {"png", "svg", "pdf"}:
        raise HTTPException(400, f"不支持的格式：{format}")

    try:
        if format == "png":
            data = await _selected_sci_image_bytes(state, user["id"])
        elif format == "pdf":
            data = await convert_to_pdf(await _selected_sci_image_bytes(state, user["id"]))
        elif format == "svg":
            selected_version = _selected_artifact_version(state)
            svg_data = selected_version.get("svgData") or selected_version.get("svg_data") or state.get("svg_data") or ""
            if svg_data:
                data = str(svg_data).encode("utf-8")
            else:
                data = await get_result_bytes(job_id, format)
        else:
            data = await get_result_bytes(job_id, format)
    except Exception as e:
        raise HTTPException(400, str(e))

    media_type = {
        "png": "image/png",
        "svg": "image/svg+xml",
        "pdf": "application/pdf",
    }.get(format, "application/octet-stream")

    filename = f"sci_fig_{job_id[:8]}.{format}"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/refine/{job_id}")
async def refine_figure(
    job_id: str,
    body: SciFigRefineRequest,
    user: dict = Depends(_auth),
):
    """修改参数重新渲染"""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")

    # 更新参数
    if body.description is not None:
        state["description"] = body.description
    if body.chart_params is not None:
        state["chart_params"] = body.chart_params
    if body.style_preset is not None:
        state["style_preset"] = body.style_preset
    if body.image_model_id is not None:
        state["image_model_id"] = body.image_model_id
    merge_attachment_state(state, body.attachments, body.attachment_context)

    state["status"] = "generating"
    state["progress"] = 0
    state["message"] = "正在重新生成..."
    state["error"] = ""
    state["quality_review"] = {}
    state["intervention"] = {}
    await _save_state(job_id, state)

    feedback = body.code_feedback or body.description or ""
    if _normalize_gen_mode(state.get("gen_mode", "image2")) == "image2":
        queue_mode = "image2"
    elif body.code_feedback and state.get("code"):
        queue_mode = "code-feedback"
    else:
        queue_mode = "generate"

    queue_task_id = f"{job_id}:sci-refine:{uuid.uuid4().hex[:8]}"
    try:
        await enqueue(
            task_type="sci-fig-refine",
            task_id=queue_task_id,
            payload={
                "job_id": job_id,
                "mode": queue_mode,
                "feedback": feedback or state.get("description", ""),
                "image_model_id": body.image_model_id,
                "user_id": user["id"],
            },
            priority="normal",
            user_id=user["id"],
        )
    except Exception as exc:
        logger.exception("[SciFig] refine enqueue failed: job_id=%s", job_id)
        state["status"] = "preview" if state.get("rendered_b64") or state.get("rendered_asset") else "failed"
        state["error"] = "科研绘图编辑任务提交到队列失败，请稍后重试。"
        state["message"] = state["error"]
        await _save_state(job_id, state)
        raise HTTPException(503, state["error"]) from exc

    return {"job_id": job_id, "status": "generating"}


async def _run_refine_with_feedback(job_id: str, feedback: str):
    """基于代码反馈重新渲染"""
    state = await _load_state(job_id)
    if not state:
        return

    sem = _get_user_sem(state["user_id"])
    async with sem:
        try:
            state["progress"] = 30
            state["message"] = "正在根据反馈修改代码..."
            await _save_state(job_id, state)

            fix_model_id = await provider_policy.choose_llm_model_id(state.get("llm_model_id"))
            attachment_context = str(state.get("attachment_context") or "").strip()
            contextual_feedback = feedback
            if attachment_context:
                contextual_feedback += (
                    "\n\nUse these uploaded source materials as factual constraints:\n"
                    f"{attachment_context[:12000]}"
                )
            async def invoke_manual_repair():
                return await fix_code(
                    original_code=state["code"],
                    error="",
                    user_feedback=contextual_feedback,
                    llm_model_id=fix_model_id or None,
                )

            if fix_model_id:
                next_version = len(state.get("artifact_versions") or []) + 1
                new_code = await _execute_sci_model_call(
                    state=state,
                    model_id=fix_model_id,
                    category="llm",
                    description="科研绘图手动修复",
                    operation=f"code-manual-repair-version-{next_version}",
                    material={
                        "original_code": state["code"],
                        "error": "",
                        "user_feedback": contextual_feedback,
                    },
                    invoke=invoke_manual_repair,
                )
            else:
                new_code = await invoke_manual_repair()
            state["llm_model_id"] = fix_model_id or state.get("llm_model_id", "")
            state["code"] = new_code
            state["progress"] = 60
            state["message"] = "代码已更新，正在渲染..."
            await _save_state(job_id, state)

            png_bytes, svg_data = await execute_code(new_code, state["category"])
            state["rendered_b64"] = base64.b64encode(png_bytes).decode()
            state["svg_data"] = svg_data
            state["progress"] = 100
            state["status"] = "preview"
            state["message"] = "重新渲染完成"
            await _store_sci_rendered_asset(state, job_id=job_id, prompt=locals().get("prompt") or feedback, model_id=locals().get("model_id") or locals().get("fix_model_id") or "")
            _append_artifact_version(state, feedback)
            await _save_state(job_id, state)
            await _save_artifact_message(state)

        except Exception as e:
            state["status"] = "failed"
            state["error"] = str(e)
            await _save_state(job_id, state)


async def _run_image2_refine(job_id: str, feedback: str, image_model_id: Optional[str] = None):
    """基于当前 image2 产物继续编辑，生成一个新版本。"""
    state = await _load_state(job_id)
    if not state:
        return

    sem = _get_user_sem(state["user_id"])
    async with sem:
        try:
            source_b64 = state.get("rendered_b64", "")
            if not source_b64:
                raise RuntimeError("当前没有可编辑的图像版本")

            model_id = await provider_policy.choose_image_model_id(image_model_id or state.get("image_model_id"))
            if not model_id:
                raise RuntimeError("未配置图像生成模型")
            state["image_model_id"] = model_id

            from services.ai_client import call_image

            style_info = STYLE_PRESETS.get(state.get("style_preset"), STYLE_PRESETS["custom"])
            base_prompt = (
                f"Edit this academic scientific figure in {style_info['label']} publication style. "
                f"Style requirements: {style_info.get('description') or style_info.get('matplotlib_style') or 'publication-ready scientific figure'}. "
                "Preserve the core scientific meaning, improve clarity and layout, keep labels readable. "
                f"User revision request: {feedback}"
            )
            if state.get("attachment_context"):
                base_prompt += (
                    "\n\nKeep the figure consistent with these uploaded source materials/data:\n"
                    f"{state['attachment_context'][:12000]}"
                )

            prompt = base_prompt
            state["progress"] = 55
            state["message"] = "正在用 image2 编辑当前科研图..."
            await _save_state(job_id, state)

            next_version = len(state.get("artifact_versions") or []) + 1
            source_image = base64.b64decode(_strip_data_url(source_b64))
            result = await _execute_sci_model_call(
                state=state,
                model_id=model_id,
                category="generate",
                description="科研 image2 编辑",
                operation=f"image2-refine-version-{next_version}",
                material={
                    "prompt": prompt,
                    "reference_images": [source_image],
                    "size": image_output_size("4:3", state.get("output_resolution")),
                    "quality": state.get("image_quality", "auto"),
                    "force_size": True,
                },
                invoke=lambda: call_image(
                    model_id=model_id,
                    prompt=prompt,
                    ref_images=[source_image],
                    size=image_output_size("4:3", state.get("output_resolution")),
                    quality=state.get("image_quality", "auto"),
                    force_size=True,
                ),
            )
            state["rendered_b64"] = base64.b64encode(result).decode()
            state["svg_data"] = ""
            state["code"] = ""
            state["progress"] = 100
            state["status"] = "preview"
            state["message"] = "image2 编辑完成，可预览或继续编辑。"
            await _sci_save_step(
                state,
                name="image2_refine",
                status="completed",
                message="image2 编辑已生成新版本。",
                progress=96,
                attempt=1,
            )
            await _store_sci_rendered_asset(state, job_id=job_id, prompt=locals().get("prompt") or feedback, model_id=locals().get("model_id") or locals().get("fix_model_id") or "")
            _append_artifact_version(state, feedback)
            await _save_state(job_id, state)
            await _save_artifact_message(state)
            return

        except Exception as e:
            state["status"] = "failed"
            state["error"] = f"image2 编辑失败：{e}"
            await _save_state(job_id, state)


@router.post("/enhance/{job_id}")
async def enhance_figure(
    job_id: str,
    body: SciFigEnhanceRequest,
    user: dict = Depends(_auth),
):
    """image2img 风格增强。"""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")
    if not state.get("rendered_b64"):
        raise HTTPException(400, "没有可增强的渲染结果")

    state["status"] = "generating"
    state["message"] = "正在进行 image2 风格增强..."
    state["progress"] = 45
    await _save_state(job_id, state)

    try:
        prompt = body.prompt
        next_version = len(state.get("artifact_versions") or []) + 1
        enhanced = await _execute_sci_model_call(
            state=state,
            model_id=body.image_model_id,
            category="generate",
            description="科研图 image2 风格增强",
            operation=f"image2-enhance-version-{next_version}",
            material={
                "image": base64.b64decode(_strip_data_url(state["rendered_b64"])),
                "prompt": prompt,
                "strength": body.strength,
            },
            invoke=lambda: enhance_with_img2img(
                image_b64=state["rendered_b64"],
                model_id=body.image_model_id,
                prompt=prompt,
                strength=body.strength,
            ),
        )
        state["rendered_b64"] = enhanced
        state["svg_data"] = ""
        state["status"] = "preview"
        state["message"] = "增强完成，可预览或继续编辑。"
        state["progress"] = 100
        await _sci_save_step(
            state,
            name="image2_enhance",
            status="completed",
            message="增强结果已生成。",
            progress=96,
            attempt=1,
        )
        await _store_sci_rendered_asset(state, job_id=job_id, prompt=body.prompt, model_id=body.image_model_id)
        _append_artifact_version(state, body.prompt)
        await _save_state(job_id, state)
        await _save_artifact_message(state)
        return {"status": "ok", "rendered_b64": enhanced}

    except HTTPException:
        raise
    except Exception as e:
        state["status"] = "failed"
        state["error"] = f"增强失败：{e}"
        await _save_state(job_id, state)
        raise HTTPException(500, str(e))


@router.post("/confirm/{job_id}")
async def confirm_figure(job_id: str, user: dict = Depends(_auth)):
    """确认生成结果，状态变为 done"""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")

    state["status"] = "done"
    state["message"] = "已确认，可导出"
    await _save_state(job_id, state)
    await _save_artifact_message(state, "科研图已确认，可继续编辑或下载。")
    return {
        "status": "done",
        "artifact_versions": state.get("artifact_versions", []),
        "selected_version_index": state.get("selected_version_index", -1),
    }


@router.post("/select-version/{job_id}")
async def select_version(
    job_id: str,
    body: SciFigSelectVersionRequest,
    user: dict = Depends(_auth),
):
    """选择一个历史版本作为当前产物，供确认与下载使用。"""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state["user_id"] != user["id"]:
        raise HTTPException(403, "无权访问")

    versions = state.get("artifact_versions") or []
    if not versions:
        raise HTTPException(400, "该任务没有可选择的版本")
    if body.version_index < 0 or body.version_index >= len(versions):
        raise HTTPException(400, "版本索引无效")

    version = versions[body.version_index]
    state["rendered_b64"] = version.get("renderedB64", "")
    state["code"] = version.get("codePreview", "")
    state["svg_data"] = version.get("svgData", "")
    state["selected_version_index"] = body.version_index
    await _save_state(job_id, state)
    await _save_artifact_message(state, "已切换科研图历史版本。")

    return {
        "status": state.get("status", "preview"),
        "rendered_b64": state.get("rendered_b64", ""),
        "code_preview": state.get("code", ""),
        "output_formats": _get_output_formats(state),
        "artifact_versions": versions,
        "selected_version_index": body.version_index,
    }


class SciFigOptimizeRequest(BaseModel):
    description: str
    category: str = "data_chart"
    llm_model_id: str = ""
    client_request_id: str = ""


@router.post("/optimize")
async def optimize_description(body: SciFigOptimizeRequest, user: dict = Depends(_auth)):
    """优化科研绘图描述"""
    model_id = await provider_policy.choose_llm_model_id(body.llm_model_id)
    if not model_id:
        raise HTTPException(500, "没有可用的 LLM 模型")

    category_label = CATEGORY_LABELS.get(body.category, "图表")

    system_prompt = (
        f"你是科研绘图专家。用户会提供简短的图表描述，你需要将其扩展为详细、专业的科研绘图描述。\n"
        f"要求：\n"
        f"- 保留用户的核心意图\n"
        f"- 补充图表类型、数据维度、视觉风格等细节\n"
        f"- 适合{category_label}场景\n"
        f"- 用中文回复，简洁专业，不超过 100 字\n"
        f"- 只输出优化后的描述，不要解释"
    )

    user_msg = body.description

    request_id = body.client_request_id.strip()[:160] or str(uuid.uuid4())
    try:
        optimized = await execute_billed_model_call(
            user_id=user["id"],
            model_id=model_id,
            expected_category="llm",
            description="科研绘图提示词优化",
            related_task_id=None,
            idempotency_key=model_billing_operation_key(
                namespace="sci-fig",
                user_id=user["id"],
                operation_scope=f"optimize:{request_id}",
                material={
                    "model_id": model_id,
                    "system": system_prompt,
                    "user": user_msg,
                    "temperature": 0.7,
                },
            ),
            invoke=lambda: call_chat(
                model_id=model_id,
                system=system_prompt,
                user=user_msg,
                temperature=0.7,
            ),
        )
        if not optimized:
            raise HTTPException(500, "优化结果为空")
        return {"optimized": optimized}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"优化失败：{e}")
