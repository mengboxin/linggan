"""Provider selection and retry policy for production generation paths."""

from __future__ import annotations

from typing import Mapping, Optional

from core.user_context import get_current_billing_mode, get_current_user_id
from services import foxapi_credentials, grok_credentials
from services.ai_client import get_default_model_id

_EXTERNAL_PROVIDER_BY_MODE = {
    foxapi_credentials.BILLING_MODE: foxapi_credentials,
    grok_credentials.BILLING_MODE: grok_credentials,
}
_EXTERNAL_PROVIDER_BY_PREFIX = {
    foxapi_credentials.RUNTIME_PREFIX: foxapi_credentials,
    grok_credentials.RUNTIME_PREFIX: grok_credentials,
}

NON_RETRYABLE_IMAGE_ERROR_MARKERS = (
    "missing responses endpoint",
    "missing responses model name",
    "requires an sse response",
    "invalid_request",
    "invalid request",
    "unsupported",
    "bad request",
    "unauthorized",
    "forbidden",
    "not found",
    "content_policy",
    "content policy",
    "content_filter",
    "policy_violation",
    "safety system",
    "blocked by safety",
    "安全系统拦截",
    "内容安全",
    "安全策略",
)

RETRYABLE_IMAGE_ERROR_MARKERS = (
    "(408)",
    "(429)",
    "(500)",
    "(502)",
    "(503)",
    "(504)",
    "(524)",
    "status=408",
    "status=429",
    "status=500",
    "status=502",
    "status=503",
    "status=504",
    "status=524",
    "bad gateway",
    "gateway error",
    "cloudflare",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "connection reset",
    "connection closed",
    "connection aborted",
    "socket reset",
    "stream disconnected",
    "stream incomplete",
)


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _int_or_default(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


async def choose_model_id(explicit_model_id: Optional[str], category: str) -> str:
    """Return the explicit model id or the configured default for a category."""
    explicit = str(explicit_model_id or "").strip()
    if explicit:
        billing_mode = get_current_billing_mode()
        provider = _EXTERNAL_PROVIDER_BY_MODE.get(billing_mode)
        runtime_prefix = explicit.split(":", 1)[0] if ":" in explicit else ""
        runtime_provider = _EXTERNAL_PROVIDER_BY_PREFIX.get(runtime_prefix)
        if runtime_provider:
            user_id = get_current_user_id()
            credential = await runtime_provider.get_runtime_credential(user_id, include_secret=False) if user_id else None
            if credential:
                return explicit
            return await get_default_model_id(category) or ""
        if provider:
            user_id = get_current_user_id()
            credential = await provider.get_runtime_credential(user_id, include_secret=False) if user_id else None
            if credential:
                return f"{provider.RUNTIME_PREFIX}:{category}:{explicit}"
        return explicit
    return await get_default_model_id(category) or ""


async def choose_image_model_id(explicit_model_id: Optional[str] = None) -> str:
    return await choose_model_id(explicit_model_id, "generate")


async def choose_llm_model_id(explicit_model_id: Optional[str] = None) -> str:
    return await choose_model_id(explicit_model_id, "llm")


async def choose_vision_model_id(explicit_model_id: Optional[str] = None) -> str:
    return await choose_model_id(explicit_model_id, "vision")


def image_generation_attempts(params: Mapping[str, object], max_allowed: int = 3) -> int:
    """Return the single paid image call allowed for one user submission.

    A generation retry can create a second billable upstream request while the
    user only asked for one image. Transport, provider, and visual-quality
    failures are therefore surfaced to the user as an explicit next action;
    a new submission is required to make another image call.  Keep the
    arguments for queue-payload compatibility with already submitted jobs.
    """
    del params, max_allowed
    return 1


def is_non_retryable_image_error(error: str) -> bool:
    lowered = (error or "").lower()
    return any(marker in lowered for marker in NON_RETRYABLE_IMAGE_ERROR_MARKERS)


def is_retryable_image_error(error: str) -> bool:
    lowered = (error or "").lower()
    if is_non_retryable_image_error(lowered):
        return False
    return any(marker in lowered for marker in RETRYABLE_IMAGE_ERROR_MARKERS)


def image_generation_retry_delay(attempt: int) -> float:
    return min(4.0, 0.75 * (2 ** max(0, attempt - 1)))
