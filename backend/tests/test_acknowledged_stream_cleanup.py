from unittest.mock import AsyncMock

import pytest

from scripts.cleanup_acknowledged_stream_entries import cleanup_acknowledged_entries


@pytest.mark.asyncio
async def test_acknowledged_stream_cleanup_is_dry_run_by_default():
    redis = AsyncMock()
    redis.xinfo_groups.return_value = [{"name": "workers", "last-delivered-id": "2-0"}]
    redis.xrange.side_effect = [
        [("1-0", {"task_id": "old"}), ("2-0", {"task_id": "new"})],
    ]

    summary = await cleanup_acknowledged_entries(redis, ["queue:normal"])

    assert summary["queue:normal"] == {"groups": 1, "candidates": 2, "deleted": 0}
    redis.eval.assert_not_awaited()


@pytest.mark.asyncio
async def test_acknowledged_stream_cleanup_uses_atomic_recheck_before_delete():
    redis = AsyncMock()
    redis.xinfo_groups.return_value = [{"name": "workers", "last-delivered-id": "1-0"}]
    redis.xrange.return_value = [("1-0", {"task_id": "old"})]
    redis.eval.return_value = 1

    summary = await cleanup_acknowledged_entries(redis, ["queue:normal"], apply=True)

    assert summary["queue:normal"]["deleted"] == 1
    script, key_count, stream, entry_id = redis.eval.await_args.args
    assert key_count == 1
    assert stream == "queue:normal"
    assert entry_id == "1-0"
    assert "XPENDING" in script
    assert "XDEL" in script
