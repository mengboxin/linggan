"""Platform-wide Grok kill switch.

Grok is a temporary compute channel. When the admin disables it, users should
not see Grok models, Grok Key billing, or video generation — without deleting
the stored credentials or model rows.
"""
from __future__ import annotations

from core.pool import acquire
from core.settings_parsers import parse_bool_setting
from services.compute_billing import GROK_BILLING_MODE, PLATFORM_BILLING_MODE


GROK_ENABLED_SETTING_KEY = "grok_enabled"
GROK_DISABLED_MESSAGE = "Grok 通道已临时下线，请改用平台模型或其他算力。"


async def is_grok_enabled() -> bool:
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = $1",
                GROK_ENABLED_SETTING_KEY,
            )
    except Exception:
        return True
    return parse_bool_setting(row["value"] if row else None, default=True)


def is_grok_model_row(model: dict | None) -> bool:
    if not model:
        return False
    provider = str(model.get("provider") or "").strip().lower()
    model_id = str(model.get("id") or "").strip().lower()
    meta = model.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {}
    api_mode = str(meta.get("api_mode") or "").strip().lower()
    model_name = str(meta.get("model_name") or "").strip().lower()
    billing_mode = str(model.get("billing_mode") or meta.get("billing_mode") or "").strip()
    return (
        billing_mode == GROK_BILLING_MODE
        or api_mode.startswith("grok_")
        or provider in {"grok", "xai"}
        or model_id.startswith("grok")
        or model_name.startswith("grok")
        or "imagine-image" in model_id
        or "imagine-video" in model_id
        or "imagine-image" in model_name
        or "imagine-video" in model_name
    )


def is_video_model_row(model: dict | None) -> bool:
    if not model:
        return False
    return str(model.get("category") or "").strip().lower() == "video"


def filter_models_for_grok_availability(models: list[dict], grok_enabled: bool) -> list[dict]:
    if grok_enabled:
        return models
    return [
        model
        for model in models
        if not is_grok_model_row(model) and not is_video_model_row(model)
    ]


async def filter_public_models(models: list[dict]) -> list[dict]:
    return filter_models_for_grok_availability(models, await is_grok_enabled())


async def reject_if_grok_disabled(model: dict | None = None) -> None:
    if await is_grok_enabled():
        return
    if model is None or is_grok_model_row(model):
        from fastapi import HTTPException
        raise HTTPException(503, GROK_DISABLED_MESSAGE)


async def suspend_grok_billing_if_disabled(user: dict | None) -> dict | None:
    if not user:
        return user
    if str(user.get("billing_mode") or "") != GROK_BILLING_MODE:
        return user
    if await is_grok_enabled():
        return user
    user_id = str(user.get("id") or "")
    if user_id:
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE users SET billing_mode = $2, updated_at = NOW()
                WHERE id = $1::uuid AND billing_mode = $3
                """,
                user_id,
                PLATFORM_BILLING_MODE,
                GROK_BILLING_MODE,
            )
    return {**user, "billing_mode": PLATFORM_BILLING_MODE}
