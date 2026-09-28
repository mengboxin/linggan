"""Enable the three staged feature flags for local development."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


async def main() -> None:
    import asyncpg

    from core.config import settings

    dsn = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(dsn)
    try:
        for key in (
            "feature.touch_edit.enabled",
            "feature.agent_orchestrator.enabled",
            "feature.ppt_canvas.enabled",
        ):
            await conn.execute(
                """
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ($1, 'true'::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
                """,
                key,
            )
            print(f"[ON] {key}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
