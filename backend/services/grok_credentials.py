"""Secure per-user Grok credentials and runtime model catalogs.

Grok keys are stored independently from FoxAPI/OpenAI keys. Switching to
Grok compute never overwrites the FoxAPI credential row.
"""
from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from core.config import settings
from core.pool import acquire
from services.compute_billing import FOXAPI_BILLING_MODE, GROK_BILLING_MODE, PLATFORM_BILLING_MODE
from services.grok_output import grok_video_requires_reference_image
from services.foxapi_credentials import (
    _is_auth_failure,
    decrypt_api_key,
    encrypt_api_key,
    foxapi_base_url,
    redact_credential_error,
)


BILLING_MODE = GROK_BILLING_MODE
PROVIDER = "grok"
RUNTIME_PREFIX = "grok"

_EXCLUDED_RUNTIME_MODEL_IDS = frozenset({
    # The upstream alias is retained only as the outbound model name for the
    # public Grok Image 2.0 catalog entry, never as a selectable model.
    "grok-imagine-image",
    "grok-imagine-image-quality",
    "grok-imagine-video",
    "grok-imagine-video-1.5",
})
_DEFAULT_RUNTIME_MODEL_BY_CATEGORY = {
    "llm": "grok-4.3",
    "vision": "grok-4.3",
    "generate": "grok-imagine-image-2.0",
    "video": "grok-video-1.5",
}


class InvalidGrokApiKey(ValueError):
    pass


class GrokApiUnavailable(RuntimeError):
    pass


class GrokCredentialConflict(RuntimeError):
    pass


def grok_base_url() -> str:
    return str(getattr(settings, "GROK_BASE_URL", "") or foxapi_base_url()).strip().rstrip("/")


def _is_grok_model(model_id: str) -> bool:
    return str(model_id or "").strip().lower().startswith("grok")


def _is_image_model(model_id: str) -> bool:
    lowered = model_id.lower()
    return "imagine-image" in lowered or lowered.startswith(("grok-image", "grok/grok-image"))


def _is_video_model(model_id: str) -> bool:
    lowered = model_id.lower()
    return "imagine-video" in lowered or lowered.startswith(("grok-video", "grok/grok-video"))


def _sanitize_catalog(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        return []
    catalog: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if (
            not model_id
            or not _is_grok_model(model_id)
            or model_id.lower() in _EXCLUDED_RUNTIME_MODEL_IDS
            or model_id in seen
        ):
            continue
        seen.add(model_id)
        catalog.append({
            "id": model_id,
            "object": str(item.get("object") or "model"),
            "created": item.get("created"),
            "owned_by": str(item.get("owned_by") or "xai"),
            "type": str(item.get("type") or "model"),
            "display_name": str(item.get("display_name") or model_id),
        })
    return catalog


def _catalog_value(value: Any) -> list[dict]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = []
    return _sanitize_catalog(value)


def _runtime_id(category: str, model_id: str) -> str:
    return f"{RUNTIME_PREFIX}:{category}:{model_id}"


def _parse_runtime_id(runtime_model_id: str) -> tuple[str, str] | None:
    parts = str(runtime_model_id or "").split(":", 2)
    if len(parts) != 3 or parts[0] != RUNTIME_PREFIX:
        return None
    category, model_id = parts[1], parts[2]
    if category not in {"llm", "vision", "generate", "video"} or not model_id:
        return None
    return category, model_id


def _categories_for_model(model_id: str) -> list[str]:
    if _is_image_model(model_id):
        return ["generate"]
    if _is_video_model(model_id):
        return ["video"]
    return ["llm", "vision"]


def _public_runtime_model(item: dict, category: str, api_base: str, key_fingerprint: str) -> dict:
    model_id = item["id"]
    display_name = item.get("display_name") or model_id
    category_label = {
        "llm": "文本",
        "vision": "视觉",
        "generate": "生图",
        "video": "生视频",
    }[category]
    is_default = _DEFAULT_RUNTIME_MODEL_BY_CATEGORY.get(category) == model_id
    api_mode = {
        "generate": "grok_images",
        "video": "grok_video",
        "llm": "grok_chat",
        "vision": "grok_chat",
    }[category]
    return {
        "id": _runtime_id(category, model_id),
        "name": display_name,
        "category": category,
        "tags": ["Grok", "Grok通道", category_label],
        "description": f"通过当前用户自己的 Grok Key 调用 {display_name}",
        "cover_url": "",
        "endpoint": api_base.rstrip("/"),
        "provider": "Grok",
        "provider_logo": "",
        "price_type": "free",
        "price_credits": 0,
        "billing_mode": BILLING_MODE,
        "enabled": True,
        "is_featured": is_default,
        "sort_order": 0 if is_default else 100,
        "total_calls": 0,
        "avg_duration_ms": 0,
        "meta": {
            "model_name": model_id,
            "api_mode": api_mode,
            "requires_reference_image": category == "video" and grok_video_requires_reference_image(model_id),
            "external_api_key": True,
            "billing_mode": BILLING_MODE,
            "key_fingerprint": key_fingerprint[-12:],
        },
        "created_at": "",
        "updated_at": "",
    }


def build_runtime_models(
    catalog: Any,
    *,
    api_base: str,
    key_fingerprint: str,
    category: Optional[str] = None,
) -> list[dict]:
    models: list[dict] = []
    for item in _catalog_value(catalog):
        for model_category in _categories_for_model(item["id"]):
            if category and model_category != category:
                continue
            models.append(_public_runtime_model(item, model_category, api_base, key_fingerprint))
    models.sort(key=lambda model: model["sort_order"])
    return models


def build_runtime_model(
    catalog: Any,
    *,
    runtime_model_id: str,
    api_base: str,
    key_fingerprint: str,
    api_key: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[dict]:
    parsed = _parse_runtime_id(runtime_model_id)
    if not parsed:
        return None
    category, requested_model_id = parsed
    for item in _catalog_value(catalog):
        if item["id"] != requested_model_id:
            continue
        if category not in _categories_for_model(requested_model_id):
            return None
        model = _public_runtime_model(item, category, api_base, key_fingerprint)
        if api_key is not None:
            model["api_key"] = api_key
            model["credential_user_id"] = user_id
            model["credential_provider"] = PROVIDER
        return model
    return None


async def validate_api_key(api_key: str) -> list[dict]:
    key = api_key.strip()
    if not key:
        raise InvalidGrokApiKey("请输入 Grok API Key")
    if len(key) < 8 or len(key) > 500:
        raise InvalidGrokApiKey("Grok API Key 长度无效")
    endpoint = f"{grok_base_url()}/models"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(endpoint, headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError as exc:
        raise GrokApiUnavailable("Grok 暂时无法连接，请稍后重试") from exc

    if response.status_code in {401, 403}:
        raise InvalidGrokApiKey("Grok API Key 无效或已失效")
    if not response.is_success:
        raise GrokApiUnavailable(f"Grok 模型校验失败（HTTP {response.status_code}）")
    try:
        payload = response.json()
    except Exception as exc:
        raise GrokApiUnavailable("Grok 返回了无法识别的模型列表") from exc
    catalog = _sanitize_catalog(payload.get("data") if isinstance(payload, dict) else None)
    if not catalog:
        raise InvalidGrokApiKey("该 API Key 没有可用的 Grok 模型")
    return catalog


async def prepare_api_key(api_key: str) -> dict[str, Any]:
    from services.foxapi_credentials import api_key_fingerprint, mark_validation_failure

    key = api_key.strip()
    fingerprint = api_key_fingerprint(key)
    try:
        catalog = await validate_api_key(key)
    except InvalidGrokApiKey:
        await mark_validation_failure(fingerprint)
        raise
    return {
        "api_base": grok_base_url(),
        "encrypted_api_key": encrypt_api_key(key),
        "key_fingerprint": fingerprint,
        "model_catalog": catalog,
    }


async def store_prepared_credential(
    conn,
    user_id: str,
    prepared: dict[str, Any],
    *,
    activate: bool,
) -> None:
    fingerprint = str(prepared["key_fingerprint"])
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", fingerprint)
    owner = await conn.fetchrow(
        """
        SELECT user_id::text AS user_id, provider
        FROM user_api_credentials
        WHERE key_fingerprint = $1
        """,
        fingerprint,
    )
    if owner and (str(owner["user_id"]) != str(user_id) or str(owner["provider"]) != PROVIDER):
        raise GrokCredentialConflict("该 Grok API Key 已绑定到其他账号或通道")

    await conn.execute(
        """
        INSERT INTO user_api_credentials
            (user_id, provider, api_base, encrypted_api_key, key_fingerprint,
             model_catalog, status, last_verified_at)
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'active', NOW())
        ON CONFLICT (user_id, provider) DO UPDATE SET
            api_base = EXCLUDED.api_base,
            encrypted_api_key = EXCLUDED.encrypted_api_key,
            key_fingerprint = EXCLUDED.key_fingerprint,
            model_catalog = EXCLUDED.model_catalog,
            status = 'active',
            failed_count = 0,
            last_verified_at = NOW(),
            last_model_id = NULL,
            last_error = NULL,
            updated_at = NOW()
        """,
        user_id,
        PROVIDER,
        prepared["api_base"],
        prepared["encrypted_api_key"],
        fingerprint,
        json.dumps(prepared["model_catalog"], ensure_ascii=False),
    )
    if activate:
        current_mode = await conn.fetchval(
            "SELECT billing_mode FROM users WHERE id = $1::uuid",
            user_id,
        )
        fox_status = await conn.fetchval(
            """
            SELECT status FROM user_api_credentials
            WHERE user_id = $1::uuid AND provider = 'foxapi'
            """,
            user_id,
        )
        if str(current_mode or "") != FOXAPI_BILLING_MODE or fox_status != "active":
            await conn.execute(
                "UPDATE users SET billing_mode = $2, updated_at = NOW() WHERE id = $1::uuid",
                user_id,
                BILLING_MODE,
            )


async def connect_api_key(user_id: str, api_key: str, *, activate: bool = True) -> None:
    prepared = await prepare_api_key(api_key)
    async with acquire() as conn:
        async with conn.transaction():
            await store_prepared_credential(conn, user_id, prepared, activate=activate)


async def uses_grok_billing(user_id: str) -> bool:
    from services.foxapi_credentials import uses_external_billing

    return await uses_external_billing(user_id, model_id="grok:")


def compute_source_from_user(user: dict) -> dict:
    fingerprint = str(user.get("grok_key_fingerprint") or "")
    configured = bool(fingerprint)
    active = configured and user.get("grok_api_key_status") == "active"
    return {
        "provider": PROVIDER,
        "billing_mode": BILLING_MODE if active else PLATFORM_BILLING_MODE,
        "active": active,
        "configured": configured,
        "status": user.get("grok_api_key_status") or "not_configured",
        "key_fingerprint": fingerprint[-12:] if fingerprint else "",
        "model_count": int(user.get("grok_model_count") or 0),
        "last_verified_at": str(user.get("grok_last_verified_at") or "") or None,
        "last_used_at": str(user.get("grok_last_used_at") or "") or None,
        "last_model_id": user.get("grok_last_model_id"),
        "last_error": user.get("grok_last_error"),
    }


async def set_billing_mode(user_id: str, mode: str) -> None:
    normalized = str(mode or "").strip()
    if normalized not in {PLATFORM_BILLING_MODE, BILLING_MODE}:
        raise ValueError("Unsupported billing mode")
    async with acquire() as conn:
        async with conn.transaction():
            if normalized == BILLING_MODE:
                status = await conn.fetchval(
                    """
                    SELECT status FROM user_api_credentials
                    WHERE user_id = $1::uuid AND provider = $2
                    """,
                    user_id,
                    PROVIDER,
                )
                if status != "active":
                    raise InvalidGrokApiKey("请先绑定并验证 Grok API Key，再启用 Grok 算力")
            await conn.execute(
                "UPDATE users SET billing_mode = $2, updated_at = NOW() WHERE id = $1::uuid",
                user_id,
                normalized,
            )


async def disconnect_api_key(user_id: str) -> None:
    async with acquire() as conn:
        async with conn.transaction():
            fox_status = await conn.fetchval(
                """
                SELECT status FROM user_api_credentials
                WHERE user_id = $1::uuid AND provider = 'foxapi'
                """,
                user_id,
            )
            fallback = FOXAPI_BILLING_MODE if fox_status == "active" else PLATFORM_BILLING_MODE
            await conn.execute(
                """
                UPDATE users SET billing_mode = $2, updated_at = NOW()
                WHERE id = $1::uuid AND billing_mode = $3
                """,
                user_id,
                fallback,
                BILLING_MODE,
            )
            await conn.execute(
                "DELETE FROM user_api_credentials WHERE user_id = $1::uuid AND provider = $2",
                user_id,
                PROVIDER,
            )


async def get_runtime_credential(user_id: str, *, include_secret: bool = True) -> Optional[dict]:
    columns = "api_base, key_fingerprint, model_catalog, status"
    if include_secret:
        columns += ", encrypted_api_key"
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"""
            SELECT {columns}
            FROM user_api_credentials
            WHERE user_id = $1::uuid AND provider = $2
            """,
            user_id,
            PROVIDER,
        )
    if not row or row["status"] != "active":
        return None
    result = dict(row)
    if include_secret:
        result["api_key"] = decrypt_api_key(result.pop("encrypted_api_key"))
    result["model_catalog"] = _catalog_value(result.get("model_catalog"))
    return result


async def list_runtime_models_for_user(user_id: str, category: Optional[str] = None) -> list[dict]:
    credential = await get_runtime_credential(user_id, include_secret=False)
    if not credential:
        return []
    return build_runtime_models(
        credential["model_catalog"],
        api_base=credential["api_base"],
        key_fingerprint=credential["key_fingerprint"],
        category=category,
    )


async def get_runtime_model_for_user(user_id: str, model_id: str, *, internal: bool) -> Optional[dict]:
    credential = await get_runtime_credential(user_id, include_secret=internal)
    if not credential:
        return None
    return build_runtime_model(
        credential["model_catalog"],
        runtime_model_id=model_id,
        api_base=credential["api_base"],
        key_fingerprint=credential["key_fingerprint"],
        api_key=credential["api_key"] if internal else None,
        user_id=user_id if internal else None,
    )


async def record_usage(
    user_id: str,
    model_id: str,
    *,
    success: bool,
    error: str = "",
    api_key: str = "",
) -> None:
    message = redact_credential_error(error, api_key)
    auth_failure = _is_auth_failure(message)
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE user_api_credentials SET
                request_count = request_count + 1,
                failed_count = failed_count + CASE WHEN $3 THEN 0 ELSE 1 END,
                last_used_at = NOW(),
                last_model_id = $2,
                last_error = CASE WHEN $3 THEN NULL ELSE $4 END,
                status = CASE WHEN $3 THEN 'active' WHEN $5 THEN 'invalid' ELSE status END,
                updated_at = NOW()
            WHERE user_id = $1::uuid AND provider = $6
            """,
            user_id,
            model_id,
            success,
            message or None,
            auth_failure,
            PROVIDER,
        )
