"""Secure per-user FoxAPI credentials and runtime model catalogs."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any, Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken

from core.config import settings
from core.pool import acquire
from core.user_context import get_current_billing_mode, get_current_user_id
from services.compute_billing import GROK_BILLING_MODE, FOXAPI_BILLING_MODE, PLATFORM_BILLING_MODE, is_external_billing_mode


BILLING_MODE = FOXAPI_BILLING_MODE
PROVIDER = "foxapi"
RUNTIME_PREFIX = "foxapi"

_EXCLUDED_RUNTIME_MODEL_IDS = frozenset({
    "gpt-5.6",
    "gpt-5.3-codex-spark",
    "codex-auto-review",
    "gpt-5.2",
    "gpt-image-1",
    "gpt-image-1.5",
    "grok-imagine-image",
    "grok-imagine-image-quality",
    "grok-imagine-video",
    "grok-imagine-video-1.5",
})
_DEFAULT_RUNTIME_MODEL_BY_CATEGORY = {
    "llm": "gpt-5.5",
    "vision": "gpt-5.5",
    "generate": "gpt-image-2",
}

_BEARER_SECRET_PATTERN = re.compile(r"(?i)(bearer\s+)([^\s,;\"']+)")
_NAMED_SECRET_PATTERN = re.compile(
    r"(?i)((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[\"']?)([^\s,;\"']+)",
)
_BILLING_ERROR_MARKERS = (
    "insufficient balance",
    "billing_error",
    "insufficient_quota",
    "quota_exceeded",
    "account balance",
    "payment required",
    "余额不足",
)
_AUTH_FAILURE_MARKERS = (
    "401",
    "403",
    "invalid_api_key",
    "invalid api key",
    "incorrect api key",
    "unauthorized",
    "authentication",
    "api key invalid",
    "invalid token",
)


class InvalidFoxApiKey(ValueError):
    pass


class FoxApiUnavailable(RuntimeError):
    pass


class FoxApiCredentialConflict(RuntimeError):
    pass


def api_key_fingerprint(api_key: str) -> str:
    return hashlib.sha256(api_key.strip().encode("utf-8")).hexdigest()


def redact_credential_error(error: object, api_key: str = "") -> str:
    message = str(error or "").strip()
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    message = _BEARER_SECRET_PATTERN.sub(r"\1[REDACTED]", message)
    message = _NAMED_SECRET_PATTERN.sub(r"\1[REDACTED]", message)
    return message[:500]


def _is_billing_error(message: str) -> bool:
    lowered = str(message or "").lower()
    return any(marker in lowered for marker in _BILLING_ERROR_MARKERS)


def _is_auth_failure(message: str) -> bool:
    lowered = str(message or "").lower()
    if _is_billing_error(lowered):
        return False
    return any(marker in lowered for marker in _AUTH_FAILURE_MARKERS)


def _fernet_key() -> bytes:
    configured = str(getattr(settings, "FOXAPI_CREDENTIAL_ENCRYPTION_KEY", "") or "").strip()
    if configured:
        try:
            decoded = base64.urlsafe_b64decode(configured.encode("ascii"))
            if len(decoded) == 32:
                return configured.encode("ascii")
        except Exception:
            pass
        material = configured
    else:
        material = str(settings.SECRET_KEY or "").strip()
    if not material:
        raise RuntimeError("SECRET_KEY or FOXAPI_CREDENTIAL_ENCRYPTION_KEY is required")
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_api_key(api_key: str) -> str:
    value = api_key.strip()
    if not value:
        raise InvalidFoxApiKey("API Key cannot be empty")
    return Fernet(_fernet_key()).encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_api_key(encrypted_api_key: str) -> str:
    try:
        return Fernet(_fernet_key()).decrypt(encrypted_api_key.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Stored FoxAPI credential cannot be decrypted") from exc


def foxapi_base_url() -> str:
    return str(settings.FOXAPI_BASE_URL or "https://foxapi.cn/v1").strip().rstrip("/")


def _sanitize_catalog(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        return []
    catalog: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id or model_id.lower() in _EXCLUDED_RUNTIME_MODEL_IDS or model_id in seen:
            continue
        seen.add(model_id)
        catalog.append({
            "id": model_id,
            "object": str(item.get("object") or "model"),
            "created": item.get("created"),
            "owned_by": str(item.get("owned_by") or ""),
            "type": str(item.get("type") or "model"),
            "display_name": str(item.get("display_name") or model_id),
        })
    return catalog


async def validate_api_key(api_key: str, *, api_base: Optional[str] = None) -> list[dict]:
    """Validate a FoxAPI key and return its current, browser-safe catalog.

    ``api_base`` is optional because a previously connected key must keep using
    the endpoint it was verified against when its catalog is refreshed.  New
    connections continue to use the configured FoxAPI base URL.
    """
    key = api_key.strip()
    if not key:
        raise InvalidFoxApiKey("请输入 FoxAPI API Key")
    if len(key) < 8 or len(key) > 500:
        raise InvalidFoxApiKey("FoxAPI API Key 长度无效")
    normalized_base = str(api_base or foxapi_base_url()).strip().rstrip("/")
    endpoint = f"{normalized_base}/models"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(endpoint, headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError as exc:
        raise FoxApiUnavailable("FoxAPI 暂时无法连接，请稍后重试") from exc

    if response.status_code in {401, 403}:
        raise InvalidFoxApiKey("FoxAPI API Key 无效或已失效")
    if not response.is_success:
        raise FoxApiUnavailable(f"FoxAPI 模型校验失败（HTTP {response.status_code}）")
    try:
        payload = response.json()
    except Exception as exc:
        raise FoxApiUnavailable("FoxAPI 返回了无法识别的模型列表") from exc
    catalog = _sanitize_catalog(payload.get("data") if isinstance(payload, dict) else None)
    if not catalog:
        raise InvalidFoxApiKey("该 API Key 没有可用模型")
    return catalog


async def prepare_api_key(api_key: str) -> dict[str, Any]:
    key = api_key.strip()
    fingerprint = api_key_fingerprint(key)
    try:
        catalog = await validate_api_key(key)
    except InvalidFoxApiKey:
        await mark_validation_failure(fingerprint)
        raise
    return {
        "api_base": foxapi_base_url(),
        "encrypted_api_key": encrypt_api_key(key),
        "key_fingerprint": fingerprint,
        "model_catalog": catalog,
    }


_IMAGE_MODEL_ID_MARKERS = (
    "gpt-image-",
    "grok-imagine-image",
    "dall-e",
    "imagen",
    "flux",
    "stable-diffusion",
    "sdxl",
    "recraft",
    "ideogram",
    "seedream",
    "qwen-image",
    "hunyuan-image",
    "kolors",
    "cogview",
    "wanx",
)


def _is_image_model(model_id: str) -> bool:
    normalized = model_id.lower().strip()
    return any(marker in normalized for marker in _IMAGE_MODEL_ID_MARKERS)


def _runtime_id(category: str, model_id: str) -> str:
    return f"{RUNTIME_PREFIX}:{category}:{model_id}"


def _parse_runtime_id(runtime_model_id: str) -> tuple[str, str] | None:
    parts = str(runtime_model_id or "").split(":", 2)
    if len(parts) != 3 or parts[0] != RUNTIME_PREFIX:
        return None
    category, model_id = parts[1], parts[2]
    if category not in {"llm", "vision", "generate"} or not model_id:
        return None
    return category, model_id


def _catalog_value(value: Any) -> list[dict]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = []
    return _sanitize_catalog(value)


def _public_runtime_model(item: dict, category: str, api_base: str, key_fingerprint: str) -> dict:
    model_id = item["id"]
    display_name = item.get("display_name") or model_id
    category_label = {"llm": "文本", "vision": "视觉", "generate": "生图"}[category]
    is_default = _DEFAULT_RUNTIME_MODEL_BY_CATEGORY.get(category) == model_id
    # The Responses request must carry the model the user selected.  Using a
    # fixed text model here made all image choices silently call the same
    # upstream model, including newly discovered GPT Image 2.5 variants.
    responses_model = model_id
    return {
        "id": _runtime_id(category, model_id),
        "name": display_name,
        "category": category,
        "tags": ["FoxAPI", "FoxAPI密钥", category_label],
        "description": f"通过当前用户自己的 FoxAPI Key 调用 {display_name}",
        "cover_url": "",
        "endpoint": api_base.rstrip("/"),
        "provider": "FoxAPI",
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
            "responses_model": responses_model,
            "api_mode": "responses",
            "use_openai_responses_image_generation": category == "generate",
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
        categories = ["generate"] if _is_image_model(item["id"]) else ["llm", "vision"]
        for model_category in categories:
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
        if _is_image_model(requested_model_id) != (category == "generate"):
            return None
        model = _public_runtime_model(item, category, api_base, key_fingerprint)
        if api_key is not None:
            model["api_key"] = api_key
            model["credential_user_id"] = user_id
        return model
    return None


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
        raise FoxApiCredentialConflict("该 FoxAPI API Key 已绑定到其他账号或通道")

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


async def refresh_api_key_catalog(user_id: str) -> int:
    """Refresh a connected user's catalog without asking for or changing its key.

    Refreshing deliberately does *not* change ``users.billing_mode``.  A user
    can keep a FoxAPI key connected while temporarily using platform credits;
    pressing the refresh button must never switch their billing source.
    """
    credential = await get_runtime_credential(user_id, include_secret=True)
    if not credential:
        raise InvalidFoxApiKey("请先配置 FoxAPI密钥，再刷新模型目录")

    api_key = str(credential.get("api_key") or "").strip()
    fingerprint = str(credential.get("key_fingerprint") or "").strip()
    if not api_key or not fingerprint:
        raise InvalidFoxApiKey("FoxAPI密钥不可用，请重新配置")

    try:
        catalog = await validate_api_key(
            api_key,
            api_base=str(credential.get("api_base") or "").strip() or None,
        )
    except InvalidFoxApiKey:
        await mark_validation_failure(fingerprint)
        raise

    async with acquire() as conn:
        result = await conn.execute(
            """
            UPDATE user_api_credentials
            SET model_catalog = $3::jsonb,
                status = 'active',
                failed_count = 0,
                last_verified_at = NOW(),
                last_error = NULL,
                updated_at = NOW()
            WHERE user_id = $1::uuid
              AND provider = $2
              AND key_fingerprint = $4
            """,
            user_id,
            PROVIDER,
            json.dumps(catalog, ensure_ascii=False),
            fingerprint,
        )

    if not str(result).endswith("1"):
        # Never overwrite a just-replaced key with a stale refresh response.
        raise FoxApiCredentialConflict("密钥已变更，请重新打开页面后刷新模型目录")
    return len(catalog)


async def mark_validation_failure(fingerprint: str) -> None:
    try:
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE user_api_credentials SET
                    status = 'invalid',
                    last_error = 'API Key validation failed', updated_at = NOW()
                WHERE key_fingerprint = $1
                """,
                fingerprint,
            )
    except Exception:
        pass


async def get_billing_mode(user_id: str) -> Optional[str]:
    async with acquire() as conn:
        value = await conn.fetchval("SELECT billing_mode FROM users WHERE id = $1::uuid", user_id)
    return str(value) if value else None


async def _has_active_provider_credential(user_id: str, provider: str) -> bool:
    async with acquire() as conn:
        status = await conn.fetchval(
            """
            SELECT status
            FROM user_api_credentials
            WHERE user_id = $1::uuid AND provider = $2
            """,
            user_id,
            provider,
        )
    return status == "active"


async def uses_external_billing(user_id: str, *, model_id: Optional[str] = None) -> bool:
    """Return whether this user/model call uses a stored external key.

    The legacy user-level mode remains the fallback for non-model operations.
    Runtime model IDs are authoritative because a user may have both channels
    configured while ``users.billing_mode`` can only represent one preference.
    """
    runtime_prefix = str(model_id or "").split(":", 1)[0].strip().lower()
    if runtime_prefix == RUNTIME_PREFIX:
        return await _has_active_provider_credential(user_id, PROVIDER)
    if runtime_prefix == "grok":
        from services.grok_availability import is_grok_enabled

        if not await is_grok_enabled():
            return False
        return await _has_active_provider_credential(user_id, "grok")
    if model_id:
        # A non-runtime ID resolves to the platform model catalog and must not
        # inherit the user's preferred external channel.
        return False

    if get_current_user_id() == str(user_id):
        context_mode = get_current_billing_mode()
        if context_mode is not None:
            mode = context_mode
        else:
            mode = await get_billing_mode(user_id)
    else:
        mode = await get_billing_mode(user_id)

    if not is_external_billing_mode(mode):
        return False

    # Billing mode is user state, while credentials can be removed or marked
    # invalid independently. Never skip platform credits for a stale mode.
    provider = "grok" if str(mode) == "grok_api_key" else PROVIDER
    return await _has_active_provider_credential(user_id, provider)


def compute_source_from_user(user: dict) -> dict:
    fingerprint = str(user.get("key_fingerprint") or "")
    configured = bool(fingerprint)
    active = configured and user.get("api_key_status") == "active"
    return {
        "provider": PROVIDER,
        "billing_mode": BILLING_MODE if active else PLATFORM_BILLING_MODE,
        "active": active,
        "configured": configured,
        "status": user.get("api_key_status") or "not_configured",
        "key_fingerprint": fingerprint[-12:] if fingerprint else "",
        "model_count": int(user.get("foxapi_model_count") or 0),
        "last_verified_at": str(user.get("last_verified_at") or "") or None,
        "last_used_at": str(user.get("last_used_at") or "") or None,
        "last_model_id": user.get("last_model_id"),
        "last_error": user.get("last_error"),
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
                    raise InvalidFoxApiKey("请先绑定并验证 FoxAPI密钥，再启用密钥算力")
            await conn.execute(
                "UPDATE users SET billing_mode = $2, updated_at = NOW() WHERE id = $1::uuid",
                user_id,
                normalized,
            )


async def disconnect_api_key(user_id: str) -> None:
    from services.grok_availability import is_grok_enabled

    async with acquire() as conn:
        async with conn.transaction():
            grok_status = await conn.fetchval(
                """
                SELECT status FROM user_api_credentials
                WHERE user_id = $1::uuid AND provider = 'grok'
                """,
                user_id,
            )
            fallback = (
                GROK_BILLING_MODE
                if grok_status == "active" and await is_grok_enabled()
                else PLATFORM_BILLING_MODE
            )
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
