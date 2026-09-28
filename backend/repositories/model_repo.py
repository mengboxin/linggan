"""AI 模型广场数据仓库 —— 使用全局 asyncpg 连接池"""
import asyncio
import json
from typing import Optional
from core.pool import acquire
from core.user_context import get_current_billing_mode, get_current_user_id
from services import foxapi_credentials, grok_credentials
from services.compute_billing import FOXAPI_BILLING_MODE, GROK_BILLING_MODE, is_external_billing_mode
from services.grok_availability import (
    filter_models_for_grok_availability,
    is_grok_enabled,
    is_grok_model_row,
)


async def _runtime_models_for_user(
    user_id: str,
    category: Optional[str],
    grok_enabled: bool,
) -> list[dict]:
    """Return every active user channel catalog, preserving the default order.

    ``users.billing_mode`` is still the user's preferred default channel, but it
    is not an activation switch for the other credential.  Both runtime
    catalogs must therefore be available to model pickers at the same time.
    """
    preferred_mode = get_current_billing_mode()
    if preferred_mode is None:
        preferred_mode = await foxapi_credentials.get_billing_mode(user_id)

    providers = (
        [(GROK_BILLING_MODE, grok_credentials), (FOXAPI_BILLING_MODE, foxapi_credentials)]
        if preferred_mode == GROK_BILLING_MODE
        else [(FOXAPI_BILLING_MODE, foxapi_credentials), (GROK_BILLING_MODE, grok_credentials)]
    )
    tasks = []
    for mode, provider in providers:
        if mode == GROK_BILLING_MODE and not grok_enabled:
            tasks.append(asyncio.sleep(0, result=[]))
        else:
            tasks.append(provider.list_runtime_models_for_user(user_id, category))

    catalogs = await asyncio.gather(*tasks)
    models: list[dict] = []
    for catalog in catalogs:
        models.extend(catalog)
    return models


async def _platform_models_for_key_mode(
    user_id: str,
    models: list[dict],
    grok_enabled: bool,
) -> list[dict]:
    """Key mode hides the credits catalog except for an unconfigured channel.

    FoxAPI and Grok keys coexist. A missing GPT key still surfaces non-Grok
    credits models; a missing Grok key still surfaces Grok credits models.
    """
    billing_mode = get_current_billing_mode()
    if billing_mode is None:
        billing_mode = await foxapi_credentials.get_billing_mode(user_id)
    if not is_external_billing_mode(billing_mode):
        return models

    fox_credential, grok_credential = await asyncio.gather(
        foxapi_credentials.get_runtime_credential(user_id, include_secret=False),
        grok_credentials.get_runtime_credential(user_id, include_secret=False)
        if grok_enabled
        else asyncio.sleep(0, result=None),
    )
    fox_configured = fox_credential is not None
    grok_configured = grok_enabled and grok_credential is not None
    if fox_configured and grok_configured:
        return []

    visible: list[dict] = []
    for model in models:
        grok_row = is_grok_model_row(model)
        if grok_row:
            if grok_enabled and not grok_configured:
                visible.append(model)
        elif not fox_configured:
            visible.append(model)
    return visible


def _runtime_provider(model_id: str):
    prefix = str(model_id or "").split(":", 1)[0]
    if prefix == foxapi_credentials.RUNTIME_PREFIX:
        return foxapi_credentials
    if prefix == grok_credentials.RUNTIME_PREFIX:
        return grok_credentials
    return None


async def list_models(
    enabled_only: bool = False,
    category: Optional[str] = None,
    *,
    hide_unavailable_grok: bool = True,
) -> list[dict]:
    user_id = get_current_user_id()
    grok_enabled = await is_grok_enabled() if hide_unavailable_grok else True
    runtime_models = (
        await _runtime_models_for_user(user_id, category, grok_enabled)
        if user_id
        else []
    )
    if hide_unavailable_grok:
        runtime_models = filter_models_for_grok_availability(runtime_models, grok_enabled)

    conditions, args = [], []
    if enabled_only:
        conditions.append("enabled = TRUE")
    if category:
        args.append(category)
        conditions.append(f"category = ${len(args)}")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, name, category, tags, description, cover_url, endpoint,
                   provider, provider_logo, price_type, price_credits,
                   enabled, is_featured, sort_order, total_calls, avg_duration_ms, meta,
                   created_at::text, updated_at::text
            FROM ai_models {where}
            ORDER BY sort_order ASC, created_at ASC
            """,
            *args,
        )
        models = [dict(r) for r in rows]
        if hide_unavailable_grok:
            models = filter_models_for_grok_availability(models, grok_enabled)
            if user_id:
                models = await _platform_models_for_key_mode(user_id, models, grok_enabled)
        return runtime_models + models


async def get_model(model_id: str, *, hide_unavailable_grok: bool = True) -> Optional[dict]:
    """Return a public model row without credentials."""
    user_id = get_current_user_id()
    grok_enabled = await is_grok_enabled() if hide_unavailable_grok else True
    provider = _runtime_provider(model_id)
    if user_id and provider is not None:
        model = await provider.get_runtime_model_for_user(user_id, model_id, internal=False)
        if hide_unavailable_grok and not filter_models_for_grok_availability([model] if model else [], grok_enabled):
            return None
        return model

    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, category, tags, description, cover_url, endpoint,
                   provider, provider_logo, price_type, price_credits,
                   enabled, is_featured, sort_order, total_calls, avg_duration_ms, meta,
                   created_at::text, updated_at::text
            FROM ai_models WHERE id = $1
            """,
            model_id,
        )
        model = dict(row) if row else None
        if hide_unavailable_grok and model and not filter_models_for_grok_availability([model], grok_enabled):
            return None
        return model


async def get_model_internal(model_id: str) -> Optional[dict]:
    """Return an enabled model row with credentials for internal calls."""
    user_id = get_current_user_id()
    grok_enabled = await is_grok_enabled()
    provider = _runtime_provider(model_id)
    if user_id and provider is not None:
        model = await provider.get_runtime_model_for_user(user_id, model_id, internal=True)
        if not filter_models_for_grok_availability([model] if model else [], grok_enabled):
            return None
        return model

    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, category, endpoint, api_key,
                   price_type, price_credits, enabled, meta
            FROM ai_models WHERE id = $1 AND enabled = TRUE
            """,
            model_id,
        )
        if not row:
            return None
        d = dict(row)
        meta = d.get("meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        d["meta"] = meta
        if not filter_models_for_grok_availability([d], grok_enabled):
            return None
        return d


async def get_free_platform_llm_model() -> Optional[dict]:
    """Return the enabled, zero-credit platform LLM used by built-in assistants.

    This deliberately bypasses runtime user credentials: director planning is a
    platform feature and must not inherit a paid or user-supplied model.
    """
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, category, endpoint, api_key,
                   price_type, price_credits, enabled, meta
            FROM ai_models
            WHERE enabled = TRUE
              AND category = 'llm'
              AND price_type = 'free'
              AND COALESCE(price_credits, 0) = 0
            ORDER BY sort_order ASC, created_at ASC
            LIMIT 1
            """
        )
        if not row:
            return None
        model = dict(row)
        meta = model.get("meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        model["meta"] = meta
        return model


async def create_model(data: dict) -> dict:
    meta_val = data.get("meta", {})
    if isinstance(meta_val, dict):
        meta_val = json.dumps(meta_val, ensure_ascii=False)

    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ai_models
                (id, name, category, tags, description, cover_url, endpoint,
                 provider, provider_logo, price_type, price_credits,
                 enabled, is_featured, sort_order, meta, api_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
            RETURNING id, name, category, tags, description, cover_url, endpoint,
                      provider, provider_logo, price_type, price_credits,
                      enabled, is_featured, sort_order, total_calls, avg_duration_ms, meta,
                      created_at::text, updated_at::text
            """,
            data["id"], data["name"], data["category"],
            data.get("tags", []), data.get("description", ""),
            data.get("cover_url", ""), data.get("endpoint", ""),
            data.get("provider", ""), data.get("provider_logo", ""),
            data.get("price_type", "free"), float(data.get("price_credits", 0)),
            data.get("enabled", True), data.get("is_featured", False),
            data.get("sort_order", 0), meta_val, data.get("api_key", ""),
        )
        return dict(row)


async def update_model(model_id: str, data: dict) -> Optional[dict]:
    meta_val = data.get("meta")
    if isinstance(meta_val, dict):
        meta_val = json.dumps(meta_val, ensure_ascii=False)

    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE ai_models SET
                id            = COALESCE($2, id),
                name          = COALESCE($3, name),
                category      = COALESCE($4, category),
                tags          = COALESCE($5, tags),
                description   = COALESCE($6, description),
                cover_url     = COALESCE($7, cover_url),
                endpoint      = COALESCE($8, endpoint),
                provider      = COALESCE($9, provider),
                provider_logo = COALESCE($10, provider_logo),
                price_type    = COALESCE($11, price_type),
                price_credits = COALESCE($12, price_credits),
                enabled       = COALESCE($13, enabled),
                is_featured   = COALESCE($14, is_featured),
                sort_order    = COALESCE($15, sort_order),
                meta          = COALESCE($16::jsonb, meta),
                api_key       = COALESCE($17, api_key)
            WHERE id = $1
            RETURNING id, name, category, tags, description, cover_url, endpoint,
                      provider, provider_logo, price_type, price_credits,
                      enabled, is_featured, sort_order, total_calls, avg_duration_ms, meta,
                      created_at::text, updated_at::text
            """,
            model_id,
            data.get("id"), data.get("name"), data.get("category"),
            data.get("tags"), data.get("description"),
            data.get("cover_url"), data.get("endpoint"),
            data.get("provider"), data.get("provider_logo"),
            data.get("price_type"),
            float(data["price_credits"]) if "price_credits" in data else None,
            data.get("enabled"), data.get("is_featured"),
            data.get("sort_order"), meta_val,
            data.get("api_key") or None,
        )
        return dict(row) if row else None


async def delete_model(model_id: str) -> bool:
    async with acquire() as conn:
        result = await conn.execute("DELETE FROM ai_models WHERE id = $1", model_id)
        return result == "DELETE 1"


async def increment_calls(model_id: str, duration_ms: int):
    user_id = get_current_user_id()
    if user_id and await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE ai_models SET
                total_calls     = total_calls + 1,
                avg_duration_ms = (avg_duration_ms * total_calls + $2) / (total_calls + 1)
            WHERE id = $1
            """,
            model_id, duration_ms,
        )
