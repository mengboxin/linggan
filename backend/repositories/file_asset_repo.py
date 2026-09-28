"""Generic file asset metadata repository."""
from __future__ import annotations

from typing import Any, Optional

from core.pool import acquire
from repositories import asset_mirror_repo

_ensured = False
_REQUIRED_COLUMNS = {
    "id",
    "user_id",
    "task_id",
    "category",
    "filename",
    "mime_type",
    "size_bytes",
    "sha256",
    "storage_key",
    "storage_url",
    "retention_class",
    "source_client",
    "expires_at",
    "expires_notice_sent_at",
    "storage_provider",
    "created_at",
    "updated_at",
}


async def _assert_required_columns(conn, table_name: str, required_columns: set[str]) -> None:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        """,
        table_name,
    )
    existing = {str(row["column_name"]) for row in rows}
    if not existing:
        raise RuntimeError(
            f"{table_name} table is missing; run python backend/scripts/run_migrate.py"
        )
    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            f"{table_name} is missing columns: {', '.join(missing)}; "
            "run python backend/scripts/run_migrate.py"
        )


async def ensure_table() -> None:
    global _ensured
    if _ensured:
        return
    async with acquire() as conn:
        await _assert_required_columns(conn, "file_assets", _REQUIRED_COLUMNS)
    _ensured = True


async def _enqueue_replaced_object_deletions(
    conn: Any,
    keys: list[str],
    *,
    user_id: str,
) -> None:
    if not keys:
        return
    rows = await conn.fetch(
        """
        INSERT INTO asset_object_deletion_queue (
            object_key, user_id, reason, status, last_error, next_attempt_at, updated_at
        )
        SELECT key, $2::uuid, 'file-asset-replace', 'pending', '', NOW(), NOW()
        FROM unnest($1::text[]) AS key
        ON CONFLICT (object_key) DO UPDATE
        SET user_id = COALESCE(EXCLUDED.user_id, asset_object_deletion_queue.user_id),
            reason = EXCLUDED.reason,
            status = 'pending',
            next_attempt_at = LEAST(asset_object_deletion_queue.next_attempt_at, NOW()),
            updated_at = NOW()
        RETURNING object_key
        """,
        keys,
        user_id,
    )
    if len(rows) != len(keys):
        raise RuntimeError(f"persisted {len(rows)} of {len(keys)} replaced object deletions")


async def create_file_asset(
    *,
    user_id: str,
    task_id: str = "",
    category: str = "files",
    filename: str = "",
    mime_type: str = "application/octet-stream",
    size_bytes: int = 0,
    sha256: str = "",
    storage_key: str = "",
    storage_url: str = "",
    retention_class: str = "web_history",
    source_client: str = "web",
    expires_at: Optional[str] = None,
    storage_provider: str = "s3",
    mirror_keys: list[str] | None = None,
) -> dict[str, Any]:
    await ensure_table()
    async with acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
            INSERT INTO file_assets (
                user_id, task_id, category, filename, mime_type, size_bytes, sha256,
                storage_key, storage_url, retention_class, source_client, expires_at, storage_provider
            )
            VALUES (
                $1::uuid, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, NULLIF($12, '')::timestamptz, $13
            )
            ON CONFLICT (storage_key) WHERE storage_key <> ''
            DO UPDATE SET
                user_id = EXCLUDED.user_id,
                task_id = EXCLUDED.task_id,
                category = EXCLUDED.category,
                filename = EXCLUDED.filename,
                mime_type = EXCLUDED.mime_type,
                size_bytes = EXCLUDED.size_bytes,
                sha256 = EXCLUDED.sha256,
                storage_url = EXCLUDED.storage_url,
                retention_class = EXCLUDED.retention_class,
                source_client = EXCLUDED.source_client,
                expires_at = EXCLUDED.expires_at,
                storage_provider = EXCLUDED.storage_provider,
                updated_at = NOW()
            RETURNING id::text, user_id::text, task_id, category, filename, mime_type,
                      size_bytes, sha256, storage_key, storage_url, retention_class,
                      source_client, expires_at::text, storage_provider,
                      created_at::text, updated_at::text
                """,
                user_id,
                task_id,
                category,
                filename,
                mime_type,
                int(size_bytes or 0),
                sha256,
                storage_key,
                storage_url,
                retention_class,
                source_client,
                expires_at or "",
                storage_provider,
            )
            if mirror_keys:
                await asset_mirror_repo.enqueue_copies(mirror_keys, connection=conn)
        return dict(row)


async def replace_task_file_asset(
    *,
    user_id: str,
    task_id: str,
    category: str,
    filename: str,
    mime_type: str,
    size_bytes: int,
    sha256: str,
    storage_key: str,
    storage_url: str,
    retention_class: str = "web_history",
    source_client: str = "web",
    expires_at: Optional[str] = None,
    storage_provider: str = "s3",
    mirror_keys: list[str] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Upsert the single latest file asset for a task/category pair."""
    await ensure_table()
    normalized_category = (category or "files").strip() or "files"
    normalized_task_id = (task_id or "").strip()
    async with acquire() as conn:
        async with conn.transaction():
            await conn.fetchval(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                f"pixelscribe:file-asset-replace:{user_id}:{normalized_task_id}:{normalized_category}",
            )
            old_rows = await conn.fetch(
                """
                SELECT storage_key
                FROM file_assets
                WHERE user_id = $1::uuid
                  AND task_id = $2
                  AND category = $3
                  AND storage_key <> $4
                """,
                user_id,
                normalized_task_id,
                normalized_category,
                storage_key,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO file_assets (
                    user_id, task_id, category, filename, mime_type, size_bytes, sha256,
                    storage_key, storage_url, retention_class, source_client, expires_at, storage_provider
                )
                VALUES (
                    $1::uuid, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, NULLIF($12, '')::timestamptz, $13
                )
                ON CONFLICT (storage_key) WHERE storage_key <> ''
                DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    task_id = EXCLUDED.task_id,
                    category = EXCLUDED.category,
                    filename = EXCLUDED.filename,
                    mime_type = EXCLUDED.mime_type,
                    size_bytes = EXCLUDED.size_bytes,
                    sha256 = EXCLUDED.sha256,
                    storage_url = EXCLUDED.storage_url,
                    retention_class = EXCLUDED.retention_class,
                    source_client = EXCLUDED.source_client,
                    expires_at = EXCLUDED.expires_at,
                    storage_provider = EXCLUDED.storage_provider,
                    updated_at = NOW()
                RETURNING id::text, user_id::text, task_id, category, filename, mime_type,
                          size_bytes, sha256, storage_key, storage_url, retention_class,
                          source_client, expires_at::text, storage_provider,
                          created_at::text, updated_at::text
                """,
                user_id,
                normalized_task_id,
                normalized_category,
                filename,
                mime_type,
                int(size_bytes or 0),
                sha256,
                storage_key,
                storage_url,
                retention_class,
                source_client,
                expires_at or "",
                storage_provider,
            )
            if mirror_keys:
                await asset_mirror_repo.enqueue_copies(mirror_keys, connection=conn)
            old_keys = sorted({
                str(old_row["storage_key"]).strip().lstrip("/")
                for old_row in old_rows
                if str(old_row["storage_key"] or "").strip()
            })
            await _enqueue_replaced_object_deletions(conn, old_keys, user_id=user_id)
            await conn.execute(
                """
                DELETE FROM file_assets
                WHERE user_id = $1::uuid
                  AND task_id = $2
                  AND category = $3
                  AND storage_key <> $4
                """,
                user_id,
                normalized_task_id,
                normalized_category,
                storage_key,
            )
    return dict(row), old_keys


async def storage_key_exists(storage_key: str) -> bool:
    normalized_key = str(storage_key or "").strip().lstrip("/")
    if not normalized_key:
        return False
    await ensure_table()
    async with acquire() as conn:
        return bool(await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM file_assets WHERE storage_key = $1)",
            normalized_key,
        ))


async def task_file_assets_size(
    *,
    user_id: str,
    task_id: str,
    category: str,
) -> int:
    await ensure_table()
    async with acquire() as conn:
        value = await conn.fetchval(
            """
            SELECT COALESCE(SUM(size_bytes), 0)::bigint
            FROM file_assets
            WHERE user_id = $1::uuid
              AND task_id = $2
              AND category = $3
            """,
            user_id,
            task_id,
            category,
        )
    return int(value or 0)


async def update_latest_task_file_filename(
    *,
    user_id: str,
    task_id: str,
    category: str,
    filename: str,
    storage_url: str,
) -> dict[str, Any] | None:
    await ensure_table()
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE file_assets
            SET filename = $4,
                storage_url = COALESCE(NULLIF($5, ''), storage_url),
                updated_at = NOW()
            WHERE id = (
                SELECT id
                FROM file_assets
                WHERE user_id = $1::uuid
                  AND task_id = $2
                  AND category = $3
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
            )
            RETURNING id::text, user_id::text, task_id, category, filename, mime_type,
                      size_bytes, sha256, storage_key, storage_url, retention_class,
                      source_client, expires_at::text, storage_provider,
                      created_at::text, updated_at::text
            """,
            user_id,
            task_id,
            category,
            filename,
            storage_url,
        )
    return dict(row) if row else None


async def update_task_file_filename_by_key(
    *,
    user_id: str,
    task_id: str,
    category: str,
    storage_key: str,
    filename: str,
    storage_url: str,
) -> dict[str, Any] | None:
    await ensure_table()
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE file_assets
            SET filename = $5,
                storage_url = COALESCE(NULLIF($6, ''), storage_url),
                updated_at = NOW()
            WHERE user_id = $1::uuid
              AND task_id = $2
              AND category = $3
              AND storage_key = $4
            RETURNING id::text, user_id::text, task_id, category, filename, mime_type,
                      size_bytes, sha256, storage_key, storage_url, retention_class,
                      source_client, expires_at::text, storage_provider,
                      created_at::text, updated_at::text
            """,
            user_id,
            task_id,
            category,
            storage_key,
            filename,
            storage_url,
        )
    return dict(row) if row else None


async def prune_task_file_assets(
    *,
    user_id: str,
    task_id: str,
    category: str,
    keep_storage_key: str,
) -> list[str]:
    await ensure_table()
    normalized_keep_key = keep_storage_key.strip().lstrip("/")
    if not normalized_keep_key:
        return []
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            DELETE FROM file_assets
            WHERE user_id = $1::uuid
              AND task_id = $2
              AND category = $3
              AND storage_key <> $4
            RETURNING storage_key
            """,
            user_id,
            task_id,
            category,
            normalized_keep_key,
        )
    return sorted({
        str(row["storage_key"]).strip().lstrip("/")
        for row in rows
        if str(row["storage_key"] or "").strip()
    })


async def list_file_assets_by_ids(asset_ids: list[str], user_id: str | None = None) -> list[dict[str, Any]]:
    if not asset_ids:
        return []
    await ensure_table()
    async with acquire() as conn:
        if user_id:
            rows = await conn.fetch(
                """
                SELECT id::text, user_id::text, task_id, category, filename, mime_type,
                       size_bytes, sha256, storage_key, storage_url, retention_class,
                       source_client, expires_at::text, expires_notice_sent_at::text,
                       storage_provider, created_at::text, updated_at::text
                FROM file_assets
                WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
                """,
                user_id,
                asset_ids,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id::text, user_id::text, task_id, category, filename, mime_type,
                       size_bytes, sha256, storage_key, storage_url, retention_class,
                       source_client, expires_at::text, expires_notice_sent_at::text,
                       storage_provider, created_at::text, updated_at::text
                FROM file_assets
                WHERE id = ANY($1::uuid[])
                """,
                asset_ids,
            )
    return [dict(row) for row in rows]


async def delete_file_assets_by_ids(asset_ids: list[str], user_id: str) -> list[str]:
    if not asset_ids:
        return []
    await ensure_table()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            DELETE FROM file_assets fa
            WHERE fa.user_id = $1::uuid
              AND fa.id = ANY($2::uuid[])
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = $1::uuid
                  AND (
                    COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM sessions s
                WHERE s.user_id = $1::uuid
                  AND COALESCE(s.status, 'active') != 'deleted'
                  AND (
                    COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM project_tasks pt
                JOIN projects p ON p.id = pt.project_id
                WHERE p.user_id = $1::uuid
                  AND (
                    COALESCE(pt.snapshot, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(pt.snapshot, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM ppt_presentation_uploads pu
                WHERE pu.user_id = $1::uuid
                  AND (
                    pu.source_key = fa.storage_key
                    OR COALESCE(pu.slides, '[]'::jsonb)::text LIKE '%' || fa.storage_key || '%'
                  )
              )
            RETURNING fa.id::text
            """,
            user_id,
            asset_ids,
        )
    return [row["id"] for row in rows]


async def delete_file_assets_by_keys(keys: list[str], user_id: str) -> list[str]:
    normalized = [str(key).strip().lstrip("/") for key in keys if str(key).strip()]
    if not normalized:
        return []
    await ensure_table()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            DELETE FROM file_assets fa
            WHERE fa.user_id = $1::uuid
              AND fa.storage_key = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = $1::uuid
                  AND (
                    COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM sessions s
                WHERE s.user_id = $1::uuid
                  AND COALESCE(s.status, 'active') != 'deleted'
                  AND (
                    COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM project_tasks pt
                JOIN projects p ON p.id = pt.project_id
                WHERE p.user_id = $1::uuid
                  AND (
                    COALESCE(pt.snapshot, '{}'::jsonb)::text LIKE '%' || fa.id::text || '%'
                    OR (NULLIF(fa.storage_key, '') IS NOT NULL AND COALESCE(pt.snapshot, '{}'::jsonb)::text LIKE '%' || fa.storage_key || '%')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM ppt_presentation_uploads pu
                WHERE pu.user_id = $1::uuid
                  AND (
                    pu.source_key = fa.storage_key
                    OR COALESCE(pu.slides, '[]'::jsonb)::text LIKE '%' || fa.storage_key || '%'
                  )
              )
            RETURNING fa.id::text
            """,
            user_id,
            normalized,
        )
    return [row["id"] for row in rows]


async def mark_expiry_notices_sent(asset_ids: list[str]) -> None:
    if not asset_ids:
        return
    await ensure_table()
    async with acquire() as conn:
        await conn.execute(
            "UPDATE file_assets SET expires_notice_sent_at = NOW() WHERE id = ANY($1::uuid[])",
            asset_ids,
        )
