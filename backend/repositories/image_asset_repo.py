"""Image asset metadata repository."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from core.pool import acquire, get_pool
from repositories import asset_mirror_repo


# The local guard keeps callers in the same Python process from consuming an
# extra database connection while they wait. PostgreSQL's advisory lock is the
# cross-process authority once the application pool is running.
_local_write_locks: dict[str, asyncio.Lock] = {}
_local_write_locks_guard = asyncio.Lock()


async def _local_write_lock(asset_id: str) -> asyncio.Lock:
    async with _local_write_locks_guard:
        lock = _local_write_locks.get(asset_id)
        if lock is None:
            lock = asyncio.Lock()
            _local_write_locks[asset_id] = lock
        return lock


def _advisory_lock_key(asset_id: str) -> str:
    return f"pixelscribe:image-asset-write:{asset_id}"


@asynccontextmanager
async def image_asset_write_lock(asset_id: str) -> AsyncIterator[Any | None]:
    """Serialize one explicit asset-id write inside this process.

    Object storage upload must not hold a Postgres connection. Cross-process
    uniqueness is enforced later by `image_asset_metadata_lock`.
    """
    normalized_id = str(asset_id or "").strip()
    if not normalized_id:
        yield None
        return

    local_lock = await _local_write_lock(normalized_id)
    try:
        async with local_lock:
            yield None
    finally:
        # Lock objects are keyed by one-shot completion ids. Retaining an idle
        # object per output would turn a long-running API process into an
        # unbounded dictionary. Existing waiters keep their shared lock entry.
        async with _local_write_locks_guard:
            waiters = getattr(local_lock, "_waiters", None)
            if (
                _local_write_locks.get(normalized_id) is local_lock
                and not local_lock.locked()
                and not waiters
            ):
                _local_write_locks.pop(normalized_id, None)


@asynccontextmanager
async def image_asset_metadata_lock(asset_id: str) -> AsyncIterator[Any | None]:
    """Hold a database connection only for the short metadata write.

    Production takes a transaction-scoped advisory lock. Tests and offline
    tools without a pool still get the in-process guard from the caller.
    """
    normalized_id = str(asset_id or "").strip()
    if not normalized_id:
        yield None
        return

    try:
        get_pool()
    except RuntimeError:
        yield None
        return

    async with acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                _advisory_lock_key(normalized_id),
            )
            yield conn


async def create_image_asset(
    *,
    asset_id: Optional[str] = None,
    user_id: str,
    conversation_id: Optional[str] = None,
    message_id: Optional[str] = None,
    task_id: str = "",
    prompt: str = "",
    model_id: str = "",
    mime_type: str = "image/png",
    width: Optional[int] = None,
    height: Optional[int] = None,
    size_bytes: int = 0,
    sha256: str = "",
    original_key: str = "",
    original_url: str = "",
    preview_key: str = "",
    preview_url: str = "",
    thumb_key: str = "",
    thumb_url: str = "",
    asset_scope: str = "history",
    retention_class: str = "web_history",
    source_client: str = "web",
    expires_at: Optional[str] = None,
    storage_provider: str = "s3",
    object_count: int = 3,
    mirror_keys: list[str] | None = None,
    connection: Any | None = None,
) -> dict[str, Any]:
    async def insert(conn: Any) -> dict[str, Any]:
        row = await conn.fetchrow(
            """
            INSERT INTO image_assets (
                id, user_id, conversation_id, message_id, task_id, prompt, model_id,
                mime_type, width, height, size_bytes, sha256,
                original_key, original_url, preview_key, preview_url, thumb_key, thumb_url,
                asset_scope, retention_class, source_client, expires_at, storage_provider, object_count
            )
            VALUES (
                COALESCE(NULLIF($1, '')::uuid, gen_random_uuid()),
                $2::uuid, NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, $5, $6, $7,
                $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18,
                $19, $20, $21, NULLIF($22, '')::timestamptz, $23, $24
            )
            ON CONFLICT (id) DO UPDATE
            SET id = image_assets.id
            RETURNING id::text, user_id::text, conversation_id::text, message_id::text,
                      task_id, prompt, model_id, mime_type, width, height, size_bytes,
                      sha256, original_key, original_url, preview_key, preview_url,
                      thumb_key, thumb_url, asset_scope, retention_class, source_client,
                      expires_at::text, storage_provider, object_count, created_at::text
            """,
            asset_id or "",
            user_id,
            conversation_id or "",
            message_id or "",
            task_id,
            prompt,
            model_id,
            mime_type,
            width,
            height,
            size_bytes,
            sha256,
            original_key,
            original_url,
            preview_key,
            preview_url,
            thumb_key,
            thumb_url,
            asset_scope,
            retention_class,
            source_client,
            expires_at or "",
            storage_provider,
            object_count,
        )
        if mirror_keys:
            await asset_mirror_repo.enqueue_copies(mirror_keys, connection=conn)
        return dict(row)

    if connection is not None:
        return await insert(connection)
    async with acquire() as conn:
        async with conn.transaction():
            return await insert(conn)


async def find_workspace_asset_by_sha(
    *,
    user_id: str,
    task_id: str,
    sha256: str,
) -> Optional[dict[str, Any]]:
    if not task_id or not sha256:
        return None
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, asset_scope, retention_class, source_client,
                   expires_at::text, storage_provider, object_count,
                   created_at::text, updated_at::text
            FROM image_assets
            WHERE user_id = $1::uuid
              AND task_id = $2
              AND sha256 = $3
              AND asset_scope = 'workspace'
            ORDER BY created_at ASC
            LIMIT 1
            """,
            user_id,
            task_id,
            sha256,
        )
        return dict(row) if row else None


async def attach_message(asset_id: str, message_id: str) -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE image_assets
            SET message_id = $2::uuid, updated_at = NOW()
            WHERE id = $1::uuid
            """,
            asset_id,
            message_id,
        )


async def get_image_asset(
    asset_id: str,
    user_id: str,
    *,
    connection: Any | None = None,
) -> Optional[dict[str, Any]]:
    async def select(conn: Any) -> Optional[dict[str, Any]]:
        row = await conn.fetchrow(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE id = $1::uuid AND user_id = $2::uuid
            """,
            asset_id,
            user_id,
        )
        return dict(row) if row else None

    if connection is not None:
        return await select(connection)
    async with acquire() as conn:
        return await select(conn)


async def list_assets_by_message_ids(
    message_ids: list[str],
    user_id: str,
) -> list[dict[str, Any]]:
    if not message_ids:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE message_id = ANY($1::uuid[])
              AND user_id = $2::uuid
            """,
            message_ids,
            user_id,
        )
        return [dict(row) for row in rows]


async def list_assets_by_ids(
    asset_ids: list[str],
    user_id: str,
) -> list[dict[str, Any]]:
    if not asset_ids:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE id = ANY($1::uuid[])
              AND user_id = $2::uuid
            """,
            asset_ids,
            user_id,
        )
        return [dict(row) for row in rows]


async def list_assets_by_object_keys(
    object_keys: list[str],
    user_id: str,
) -> list[dict[str, Any]]:
    if not object_keys:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE user_id = $2::uuid
              AND (
                original_key = ANY($1::text[])
                OR preview_key = ANY($1::text[])
                OR thumb_key = ANY($1::text[])
              )
            """,
            object_keys,
            user_id,
        )
        return [dict(row) for row in rows]


async def list_assets_by_task_ids(
    task_ids: list[str],
    user_id: str,
) -> list[dict[str, Any]]:
    if not task_ids:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE task_id = ANY($1::text[])
              AND user_id = $2::uuid
            """,
            task_ids,
            user_id,
        )
        return [dict(row) for row in rows]


async def list_assets_by_conversation_id(
    conversation_id: str,
    user_id: str,
) -> list[dict[str, Any]]:
    if not conversation_id:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, conversation_id::text, message_id::text,
                   task_id, prompt, model_id, mime_type, width, height, size_bytes,
                   sha256, original_key, original_url, preview_key, preview_url,
                   thumb_key, thumb_url, created_at::text, updated_at::text
            FROM image_assets
            WHERE conversation_id = $1::uuid
              AND user_id = $2::uuid
            """,
            conversation_id,
            user_id,
        )
        return [dict(row) for row in rows]


async def delete_assets_by_ids(asset_ids: list[str], user_id: str) -> int:
    if not asset_ids:
        return 0
    async with acquire() as conn:
        result = await conn.execute(
            """
            DELETE FROM image_assets
            WHERE id = ANY($1::uuid[])
              AND user_id = $2::uuid
            """,
            asset_ids,
            user_id,
        )
    try:
        return int(result.split()[-1])
    except Exception:
        return 0
