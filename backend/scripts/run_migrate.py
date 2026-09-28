"""Apply every pending versioned database migration."""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.schema_migrations import run_schema_migrations


async def migrate() -> None:
    result = await run_schema_migrations()
    print(
        "Database migrations complete: "
        f"applied={len(result.applied)}, skipped={len(result.skipped)}"
    )
    for version in result.applied:
        print(f"  applied {version}")


if __name__ == "__main__":
    asyncio.run(migrate())
