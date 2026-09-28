import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'maintenance' / 'backfill_poster_history_projection.py'
SPEC = importlib.util.spec_from_file_location('backfill_poster_history_projection', SCRIPT_PATH)
assert SPEC and SPEC.loader
backfill_script = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backfill_script)


class FakeConnection:
    def __init__(self):
        self.fetchval = AsyncMock(return_value=34)
        self.fetch = AsyncMock()
        self.executemany = AsyncMock()
        self.close = AsyncMock()


@pytest.mark.asyncio
async def test_dry_run_counts_eligible_rows_once_without_locking_or_looping(monkeypatch):
    conn = FakeConnection()
    monkeypatch.setattr(backfill_script.asyncpg, 'connect', AsyncMock(return_value=conn))

    changed = await backfill_script.backfill(batch_size=100, max_batches=0, dry_run=True)

    assert changed == 34
    conn.fetchval.assert_awaited_once()
    conn.fetch.assert_not_awaited()
    conn.executemany.assert_not_awaited()
    conn.close.assert_awaited_once()
