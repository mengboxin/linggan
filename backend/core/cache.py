"""Small Redis-backed cache helpers for UI metadata.

This layer is intentionally best-effort: Redis outages must not break product
flows, and large media payloads should stay in object storage instead of Redis.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from core.redis import get_redis

logger = logging.getLogger(__name__)

KEY_PREFIX = "ui-cache"
MAX_JSON_CACHE_BYTES = 512 * 1024


def _normalize_part(value: object) -> str:
    text = str(value if value is not None else "none").strip()
    if not text:
        return "none"
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in text)[:160]


def user_cache_key(user_id: str, scope: str, version: int | str, *parts: object) -> str:
    suffix = ":".join(_normalize_part(part) for part in parts)
    base = f"{KEY_PREFIX}:user:{_normalize_part(user_id)}:{_normalize_part(scope)}:v{_normalize_part(version)}"
    return f"{base}:{suffix}" if suffix else base


def global_cache_key(scope: str, version: int | str, *parts: object) -> str:
    suffix = ":".join(_normalize_part(part) for part in parts)
    base = f"{KEY_PREFIX}:global:{_normalize_part(scope)}:v{_normalize_part(version)}"
    return f"{base}:{suffix}" if suffix else base


def _user_version_key(user_id: str, scope: str) -> str:
    return f"{KEY_PREFIX}:version:user:{_normalize_part(user_id)}:{_normalize_part(scope)}"


def _global_version_key(scope: str) -> str:
    return f"{KEY_PREFIX}:version:global:{_normalize_part(scope)}"


async def get_user_cache_version(user_id: str, scope: str) -> int:
    try:
        raw = await get_redis().get(_user_version_key(user_id, scope))
        return int(raw or 0)
    except Exception as exc:
        logger.debug("user cache version read failed scope=%s user=%s error=%s", scope, user_id, exc)
        return 0


async def get_global_cache_version(scope: str) -> int:
    try:
        raw = await get_redis().get(_global_version_key(scope))
        return int(raw or 0)
    except Exception as exc:
        logger.debug("global cache version read failed scope=%s error=%s", scope, exc)
        return 0


async def bump_user_cache_version(user_id: str, *scopes: str) -> None:
    if not user_id or not scopes:
        return
    try:
        r = get_redis()
        for scope in scopes:
            if not scope:
                continue
            await r.incr(_user_version_key(user_id, scope))
            if scope == "storage":
                await r.incr(_global_version_key("storage"))
    except Exception as exc:
        logger.debug("user cache version bump failed user=%s scopes=%s error=%s", user_id, scopes, exc)


async def bump_global_cache_version(*scopes: str) -> None:
    if not scopes:
        return
    try:
        r = get_redis()
        for scope in scopes:
            if scope:
                await r.incr(_global_version_key(scope))
    except Exception as exc:
        logger.debug("global cache version bump failed scopes=%s error=%s", scopes, exc)


async def get_json(key: str) -> Any | None:
    try:
        raw = await get_redis().get(key)
        if not raw:
            return None
        return json.loads(raw)
    except Exception as exc:
        logger.debug("cache read failed key=%s error=%s", key, exc)
        return None


async def set_json(key: str, value: Any, ttl_seconds: int) -> None:
    if ttl_seconds <= 0:
        return
    try:
        payload = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_JSON_CACHE_BYTES:
            logger.debug("cache write skipped key=%s reason=payload-too-large", key)
            return
        await get_redis().set(key, payload, ex=ttl_seconds)
    except Exception as exc:
        logger.debug("cache write failed key=%s error=%s", key, exc)
