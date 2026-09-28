"""Clear legacy web-history expiration dates in short auto-commit batches.

The application now retains user web history indefinitely. Existing rows may
still have the legacy 60-day expiration. This script keeps every UPDATE to one
small statement so it can be paused or retried without holding a long-lived
transaction or waiting behind active users.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.config import settings


@dataclass(frozen=True)
class ExpiryCleanupTarget:
    name: str
    count_sql: str
    batch_sql: str


TARGETS = (
    ExpiryCleanupTarget(
        name="image_assets",
        count_sql="""
            SELECT COUNT(*)
            FROM image_assets
            WHERE user_id IS NOT NULL
              AND retention_class = 'web_history'
              AND expires_at IS NOT NULL
        """,
        batch_sql="""
            WITH candidates AS (
                SELECT id
                FROM image_assets
                WHERE user_id IS NOT NULL
                  AND retention_class = 'web_history'
                  AND expires_at IS NOT NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE image_assets AS asset
            SET expires_at = NULL
            FROM candidates
            WHERE asset.id = candidates.id
            RETURNING asset.id
        """,
    ),
    ExpiryCleanupTarget(
        name="file_assets",
        count_sql="""
            SELECT COUNT(*)
            FROM file_assets
            WHERE user_id IS NOT NULL
              AND retention_class = 'web_history'
              AND expires_at IS NOT NULL
        """,
        batch_sql="""
            WITH candidates AS (
                SELECT id
                FROM file_assets
                WHERE user_id IS NOT NULL
                  AND retention_class = 'web_history'
                  AND expires_at IS NOT NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE file_assets AS asset
            SET expires_at = NULL
            FROM candidates
            WHERE asset.id = candidates.id
            RETURNING asset.id
        """,
    ),
    ExpiryCleanupTarget(
        name="ppt_presentation_uploads",
        count_sql="""
            SELECT COUNT(*)
            FROM ppt_presentation_uploads
            WHERE user_id IS NOT NULL
              AND COALESCE(NULLIF(source_client, ''), 'web') = 'web'
              AND expires_at IS NOT NULL
        """,
        batch_sql="""
            WITH candidates AS (
                SELECT id
                FROM ppt_presentation_uploads
                WHERE user_id IS NOT NULL
                  AND COALESCE(NULLIF(source_client, ''), 'web') = 'web'
                  AND expires_at IS NOT NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE ppt_presentation_uploads AS upload
            SET expires_at = NULL
            FROM candidates
            WHERE upload.id = candidates.id
            RETURNING upload.id
        """,
    ),
)


def _database_dsn() -> str:
    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://", 1)


async def _clear_target(
    conn: Any,
    target: ExpiryCleanupTarget,
    *,
    batch_size: int,
    max_batches: int | None,
    pause_seconds: float,
) -> tuple[int, int]:
    updated = 0
    batches = 0
    while max_batches is None or batches < max_batches:
        rows = await conn.fetch(target.batch_sql, batch_size)
        count = len(rows)
        if not count:
            break
        updated += count
        batches += 1
        if pause_seconds:
            await asyncio.sleep(pause_seconds)
    return updated, batches


async def clear_legacy_web_history_expiry(
    *,
    database_url: str | None = None,
    batch_size: int = 500,
    max_batches: int | None = None,
    pause_seconds: float = 0.05,
    lock_timeout: str = "5s",
    dry_run: bool = False,
) -> dict[str, dict[str, int]]:
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    if max_batches is not None and max_batches < 1:
        raise ValueError("max_batches must be positive when provided")
    if pause_seconds < 0:
        raise ValueError("pause_seconds cannot be negative")

    import asyncpg

    dsn = database_url or _database_dsn()
    conn = await asyncpg.connect(dsn, timeout=10)
    try:
        await conn.execute("SELECT set_config('lock_timeout', $1, false)", lock_timeout)
        if dry_run:
            return {
                target.name: {"remaining": int(await conn.fetchval(target.count_sql))}
                for target in TARGETS
            }

        result: dict[str, dict[str, int]] = {}
        for target in TARGETS:
            updated, batches = await _clear_target(
                conn,
                target,
                batch_size=batch_size,
                max_batches=max_batches,
                pause_seconds=pause_seconds,
            )
            result[target.name] = {"updated": updated, "batches": batches}
        return result
    finally:
        await conn.close()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clear legacy web-history expiration timestamps in short batches."
    )
    parser.add_argument("--database-url", default=None, help="defaults to DATABASE_URL")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument(
        "--max-batches",
        type=int,
        default=None,
        help="maximum batches per table; omit to finish every table",
    )
    parser.add_argument("--pause-seconds", type=float, default=0.05)
    parser.add_argument("--lock-timeout", default="5s")
    parser.add_argument("--dry-run", action="store_true", help="count rows without updates")
    return parser.parse_args()


async def _main() -> None:
    args = _parse_args()
    result = await clear_legacy_web_history_expiry(
        database_url=args.database_url,
        batch_size=args.batch_size,
        max_batches=args.max_batches,
        pause_seconds=args.pause_seconds,
        lock_timeout=args.lock_timeout,
        dry_run=args.dry_run,
    )
    action = "remaining" if args.dry_run else "updated"
    for target, summary in result.items():
        details = f"{action}={summary[action]}"
        if not args.dry_run:
            details += f" batches={summary['batches']}"
        print(f"{target}: {details}")


if __name__ == "__main__":
    asyncio.run(_main())
