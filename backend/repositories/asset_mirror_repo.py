"""Durable state and retry operations for object-storage mirrors."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from core.config import settings
from core.pool import acquire


MIRROR_WORKER_LOCK_ID = 7_301_204_529


def _normalize_keys(keys: list[str] | set[str]) -> list[str]:
    return sorted({
        str(key).strip().lstrip("/")
        for key in keys or []
        if str(key).strip()
    })


def _current_target() -> tuple[str, str, str, str]:
    return (
        settings.STORAGE_MIRROR_PROVIDER or "mirror",
        settings.STORAGE_MIRROR_ENDPOINT,
        settings.STORAGE_MIRROR_BUCKET,
        settings.STORAGE_MIRROR_REGION,
    )


async def _enqueue_current_target(
    conn: Any,
    keys: list[str],
    operation: str,
) -> list[dict[str, Any]]:
    provider, endpoint, bucket, region = _current_target()
    if not endpoint or not bucket:
        return []
    rows = await conn.fetch(
        """
        INSERT INTO asset_object_mirror_queue (
            target_provider, target_endpoint, target_bucket, target_region,
            object_key, operation, revision, status, attempts, last_error,
            next_attempt_at, updated_at
        )
        SELECT $3, $4, $5, $6, key, $2, 1, 'pending', 0, '', NOW(), NOW()
        FROM unnest($1::text[]) AS key
        ON CONFLICT (target_provider, target_bucket, object_key) DO UPDATE
        SET operation = EXCLUDED.operation,
            target_endpoint = EXCLUDED.target_endpoint,
            target_region = EXCLUDED.target_region,
            revision = asset_object_mirror_queue.revision + 1,
            status = 'pending',
            attempts = 0,
            last_error = '',
            next_attempt_at = NOW(),
            updated_at = NOW()
        RETURNING target_provider, target_endpoint, target_bucket, target_region,
                  object_key, operation, revision, status
        """,
        keys,
        operation,
        provider,
        endpoint,
        bucket,
        region,
    )
    return [dict(row) for row in rows]


async def enqueue_copies(
    keys: list[str] | set[str],
    *,
    connection: Any | None = None,
) -> list[dict[str, Any]]:
    normalized_keys = _normalize_keys(keys)
    if not normalized_keys:
        return []

    async def execute(conn: Any) -> list[dict[str, Any]]:
        return await _enqueue_current_target(conn, normalized_keys, "copy")

    if connection is not None:
        return await execute(connection)
    async with acquire() as conn:
        async with conn.transaction():
            return await execute(conn)


async def enqueue_deletions(
    keys: list[str] | set[str],
    *,
    include_current_target: bool = True,
    connection: Any | None = None,
) -> list[dict[str, Any]]:
    normalized_keys = _normalize_keys(keys)
    if not normalized_keys:
        return []

    async def execute(conn: Any) -> list[dict[str, Any]]:
        rows = await conn.fetch(
            """
            UPDATE asset_object_mirror_queue
            SET operation = 'delete',
                revision = revision + 1,
                status = 'pending',
                attempts = 0,
                last_error = '',
                next_attempt_at = NOW(),
                updated_at = NOW()
            WHERE object_key = ANY($1::text[])
            RETURNING target_provider, target_endpoint, target_bucket, target_region,
                      object_key, operation, revision, status
            """,
            normalized_keys,
        )
        result = [dict(row) for row in rows]
        if include_current_target:
            current_rows = await _enqueue_current_target(conn, normalized_keys, "delete")
            indexed = {
                (row["target_provider"], row["target_bucket"], row["object_key"]): row
                for row in result
            }
            for row in current_rows:
                indexed[(row["target_provider"], row["target_bucket"], row["object_key"])] = row
            result = list(indexed.values())
        return result

    if connection is not None:
        return await execute(connection)
    async with acquire() as conn:
        async with conn.transaction():
            return await execute(conn)


@asynccontextmanager
async def claim_pending_job(*, include_copies: bool = True):
    """Serialize remote effects so copy/delete order matches queue revisions."""
    async with acquire() as conn:
        async with conn.transaction():
            locked = await conn.fetchval(
                "SELECT pg_try_advisory_xact_lock($1)",
                MIRROR_WORKER_LOCK_ID,
            )
            if not locked:
                yield None, None
                return
            row = await conn.fetchrow(
                """
                WITH candidate AS (
                    SELECT target_provider, target_bucket, object_key
                    FROM asset_object_mirror_queue
                    WHERE status = 'pending'
                      AND next_attempt_at <= NOW()
                      AND ($1::boolean OR operation = 'delete')
                    ORDER BY updated_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE asset_object_mirror_queue q
                SET status = 'processing',
                    updated_at = NOW()
                FROM candidate
                WHERE q.target_provider = candidate.target_provider
                  AND q.target_bucket = candidate.target_bucket
                  AND q.object_key = candidate.object_key
                RETURNING q.target_provider, q.target_endpoint, q.target_bucket,
                          q.target_region, q.object_key, q.operation, q.revision,
                          q.attempts
                """,
                include_copies,
            )
            yield conn, (dict(row) if row else None)


async def complete_claimed_job(connection: Any, job: dict[str, Any]) -> bool:
    identity = (
        str(job.get("target_provider") or ""),
        str(job.get("target_bucket") or ""),
        str(job.get("object_key") or ""),
        int(job.get("revision") or 0),
    )
    if job.get("operation") == "copy":
        result = await connection.execute(
            """
            UPDATE asset_object_mirror_queue
            SET status = 'ready', attempts = 0, last_error = '', updated_at = NOW()
            WHERE target_provider = $1 AND target_bucket = $2
              AND object_key = $3 AND revision = $4 AND status = 'processing'
            """,
            *identity,
        )
        return result == "UPDATE 1"
    result = await connection.execute(
        """
        DELETE FROM asset_object_mirror_queue
        WHERE target_provider = $1 AND target_bucket = $2
          AND object_key = $3 AND revision = $4 AND status = 'processing'
        """,
        *identity,
    )
    return result == "DELETE 1"


async def fail_claimed_job(connection: Any, job: dict[str, Any], error: str) -> bool:
    result = await connection.execute(
        """
        UPDATE asset_object_mirror_queue
        SET status = 'pending',
            attempts = attempts + 1,
            last_error = $5,
            next_attempt_at = NOW()
                + (LEAST(86400, 60 * POWER(2, LEAST(attempts, 10))) * INTERVAL '1 second'),
            updated_at = NOW()
        WHERE target_provider = $1 AND target_bucket = $2
          AND object_key = $3 AND revision = $4 AND status = 'processing'
        """,
        str(job.get("target_provider") or ""),
        str(job.get("target_bucket") or ""),
        str(job.get("object_key") or ""),
        int(job.get("revision") or 0),
        str(error or "mirror operation failed")[:1000],
    )
    return result == "UPDATE 1"


async def is_read_ready(key: str) -> bool:
    normalized_key = str(key or "").strip().lstrip("/")
    if not normalized_key:
        return False
    provider, _endpoint, bucket, _region = _current_target()
    async with acquire() as conn:
        ready = await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1
                FROM asset_object_mirror_queue
                WHERE target_provider = $1 AND target_bucket = $2
                  AND object_key = $3 AND operation = 'copy' AND status = 'ready'
            )
            """,
            provider,
            bucket,
            normalized_key,
        )
    return bool(ready)
