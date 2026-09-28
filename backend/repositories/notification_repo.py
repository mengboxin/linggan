"""User notification and global announcement repository."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from core.pool import acquire

GLOBAL_ANNOUNCEMENT_KEY = "global_announcement"

DEFAULT_ANNOUNCEMENT = {
    "enabled": False,
    "show_popup": True,
    "title": "平台公告",
    "body_markdown": "",
    "version": "",
    "updated_at": "",
}


def _coerce_meta(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return dict(parsed) if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


async def _ensure_notifications_table(conn) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'system',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            action_url TEXT NOT NULL DEFAULT '',
            meta JSONB NOT NULL DEFAULT '{}',
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
        ON user_notifications (user_id, read_at, created_at DESC)
        """
    )
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
        ON user_notifications (user_id, created_at DESC)
        """
    )


async def _ensure_system_settings(conn) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )


async def _system_setting_value_expr(conn, param: str = "$2") -> str:
    value_type = await conn.fetchval(
        """
        SELECT data_type
        FROM information_schema.columns
        WHERE table_name = 'system_settings' AND column_name = 'value'
        """
    )
    return f"{param}::jsonb" if value_type == "jsonb" else param


def _normalize_announcement(value: Any) -> dict[str, Any]:
    payload = _coerce_meta(value)
    result = dict(DEFAULT_ANNOUNCEMENT)
    result.update({
        "enabled": bool(payload.get("enabled")),
        "show_popup": bool(payload.get("show_popup", True)),
        "title": str(payload.get("title") or DEFAULT_ANNOUNCEMENT["title"])[:200],
        "body_markdown": str(payload.get("body_markdown") or payload.get("body") or ""),
        "version": str(payload.get("version") or ""),
        "updated_at": str(payload.get("updated_at") or ""),
    })
    if not result["body_markdown"].strip():
        result["enabled"] = False
    return result


def _normalize_notification(row: Any) -> dict[str, Any]:
    payload = dict(row)
    payload["meta"] = _coerce_meta(payload.get("meta"))
    payload["read"] = bool(payload.get("read_at"))
    return payload


async def create_notification_with_conn(
    conn,
    *,
    user_id: str,
    type: str = "system",
    title: str,
    body: str,
    action_url: str = "",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    clean_user_id = (user_id or "").strip()
    if not clean_user_id:
        return None
    await _ensure_notifications_table(conn)
    row = await conn.fetchrow(
        """
        INSERT INTO user_notifications (user_id, type, title, body, action_url, meta)
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
        RETURNING id::text, type, title, body, action_url, meta, read_at::text, created_at::text
        """,
        clean_user_id,
        (type or "system")[:60],
        (title or "")[:200],
        body or "",
        (action_url or "")[:500],
        json.dumps(meta or {}, ensure_ascii=False),
    )
    return _normalize_notification(row) if row else None


async def create_notification(
    *,
    user_id: str,
    type: str = "system",
    title: str,
    body: str,
    action_url: str = "",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    async with acquire() as conn:
        return await create_notification_with_conn(
            conn,
            user_id=user_id,
            type=type,
            title=title,
            body=body,
            action_url=action_url,
            meta=meta,
        )


async def list_notifications(*, user_id: str, limit: int = 30) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit or 30), 80))
    async with acquire() as conn:
        await _ensure_notifications_table(conn)
        rows = await conn.fetch(
            """
            SELECT id::text, type, title, body, action_url, meta, read_at::text, created_at::text
            FROM user_notifications
            WHERE user_id = $1::uuid
            ORDER BY created_at DESC, id DESC
            LIMIT $2
            """,
            user_id,
            safe_limit,
        )
        unread_count = await conn.fetchval(
            """
            SELECT COUNT(*)::int
            FROM user_notifications
            WHERE user_id = $1::uuid AND read_at IS NULL
            """,
            user_id,
        )
    return {
        "items": [_normalize_notification(row) for row in rows],
        "unread_count": int(unread_count or 0),
    }


async def mark_notification_read(*, user_id: str, notification_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        await _ensure_notifications_table(conn)
        row = await conn.fetchrow(
            """
            UPDATE user_notifications
            SET read_at = COALESCE(read_at, NOW())
            WHERE id = $1::uuid AND user_id = $2::uuid
            RETURNING id::text, type, title, body, action_url, meta, read_at::text, created_at::text
            """,
            notification_id,
            user_id,
        )
    return _normalize_notification(row) if row else None


async def mark_all_notifications_read(*, user_id: str) -> int:
    async with acquire() as conn:
        await _ensure_notifications_table(conn)
        result = await conn.execute(
            """
            UPDATE user_notifications
            SET read_at = COALESCE(read_at, NOW())
            WHERE user_id = $1::uuid AND read_at IS NULL
            """,
            user_id,
        )
    try:
        return int(str(result).split()[-1])
    except Exception:
        return 0


async def get_global_announcement() -> dict[str, Any]:
    async with acquire() as conn:
        await _ensure_system_settings(conn)
        row = await conn.fetchrow(
            "SELECT value, updated_at::text FROM system_settings WHERE key = $1",
            GLOBAL_ANNOUNCEMENT_KEY,
        )
    if not row:
        return dict(DEFAULT_ANNOUNCEMENT)
    announcement = _normalize_announcement(row["value"])
    if not announcement.get("updated_at"):
        announcement["updated_at"] = str(row["updated_at"] or "")
    return announcement


async def update_global_announcement(
    *,
    enabled: bool,
    show_popup: bool,
    title: str,
    body_markdown: str,
    version: str = "",
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    clean_body = body_markdown or ""
    clean_version = (version or "").strip() or f"announcement-{int(now.timestamp())}"
    payload = {
        "enabled": bool(enabled) and bool(clean_body.strip()),
        "show_popup": bool(show_popup),
        "title": (title or "平台公告").strip()[:200],
        "body_markdown": clean_body,
        "version": clean_version[:120],
        "updated_at": now.isoformat(),
    }
    async with acquire() as conn:
        await _ensure_system_settings(conn)
        value_expr = await _system_setting_value_expr(conn)
        await conn.execute(
            f"""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, {value_expr}, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            GLOBAL_ANNOUNCEMENT_KEY,
            json.dumps(payload, ensure_ascii=False),
        )
    return _normalize_announcement(payload)
