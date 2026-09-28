"""Backfill compact poster version projections into existing history summaries.

Run this after deploying the history projection format. It never touches the
full message ``meta`` document and is safe to rerun: only poster summaries
that are not the compact projection version 2 are updated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import asyncpg

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.config import settings  # noqa: E402
from core.history_artifacts import message_history_summary  # noqa: E402


def database_url() -> str:
    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


async def backfill(*, batch_size: int, max_batches: int, dry_run: bool) -> int:
    changed = 0
    batches = 0
    conn = await asyncpg.connect(database_url(), command_timeout=settings.DB_COMMAND_TIMEOUT_SECONDS)
    try:
        if dry_run:
            total = await conn.fetchval(
                """
                SELECT count(*)
                FROM conversation_messages
                WHERE meta->>'type' = 'poster_artifact'
                  AND COALESCE(history_summary->>'poster_projection_version', '') <> '2'
                """
            )
            changed = int(total or 0)
            print(f"complete=would_update total={changed}")
            return changed

        while max_batches <= 0 or batches < max_batches:
            async with conn.transaction():
                rows = await conn.fetch(
                    """
                    SELECT id::text, meta
                    FROM conversation_messages
                    WHERE meta->>'type' = 'poster_artifact'
                      AND COALESCE(history_summary->>'poster_projection_version', '') <> '2'
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT $1
                    """,
                    batch_size,
                )
                if not rows:
                    break
                updates = []
                for row in rows:
                    meta = row["meta"]
                    if isinstance(meta, str):
                        meta = json.loads(meta)
                    summary = message_history_summary(meta if isinstance(meta, dict) else {})
                    updates.append((json.dumps(summary, ensure_ascii=False), row["id"]))
                await conn.executemany(
                    "UPDATE conversation_messages SET history_summary = $1::jsonb WHERE id = $2::uuid",
                    updates,
                )
                changed += len(updates)
            batches += 1
            print(f"batch={batches} updated={len(rows)} total={changed}")
    finally:
        await conn.close()
    return changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill compact poster history projections")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--max-batches", type=int, default=0, help="0 processes all eligible rows")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    batch_size = max(1, min(args.batch_size, 500))
    changed = await backfill(
        batch_size=batch_size,
        max_batches=max(0, args.max_batches),
        dry_run=args.dry_run,
    )
    print(f"complete={'would_update' if args.dry_run else 'updated'} total={changed}")


if __name__ == "__main__":
    asyncio.run(main())
