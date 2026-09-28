"""Compatibility entry point for the versioned migration runner.

New databases still use ``scripts/init_db.sql`` for the baseline schema. This
Python command is kept for older deployment notes and now applies the same
versioned migrations as ``scripts/run_migrate.py``.
"""
from __future__ import annotations

import asyncio
import os
import sys


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.schema_migrations import run_schema_migrations


async def run_migration(dsn: str | None = None) -> None:
    result = await run_schema_migrations(dsn)
    print(
        "Database migrations complete: "
        f"applied={len(result.applied)}, skipped={len(result.skipped)}"
    )


if __name__ == "__main__":
    asyncio.run(run_migration())
