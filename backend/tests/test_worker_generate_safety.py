import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def test_worker_skips_duplicate_generate_execution():
    async def _run():
        import core.worker as worker_mod

        handler = AsyncMock()
        worker = worker_mod.Worker("test-worker", concurrency=1)
        fields = {
            "task_id": "task-1",
            "task_type": "generate",
            "payload": json.dumps({"model_id": "image-model", "prompt": "draw"}),
            "retries": "0",
        }

        with patch.dict(worker_mod._handlers, {"generate": handler}, clear=True), patch(
            "core.worker._claim_generate_execution_once", new=AsyncMock(return_value=False)
        ), patch("core.worker.ack_message", new=AsyncMock()) as ack_mock, patch(
            "core.worker.task_repo.set_failed", new=AsyncMock()
        ) as failed_mock:
            await worker._process_message("queue:normal", "1-0", fields)

        handler.assert_not_awaited()
        failed_mock.assert_not_awaited()
        ack_mock.assert_awaited_once_with("queue:normal", "1-0")

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_reclaim_idle_messages_does_not_reclaim_generate_task():
    import core.queue as queue_mod

    redis = MagicMock()
    redis.xpending_range = AsyncMock(return_value=[{
        "message_id": "1-0",
        "time_since_delivered": queue_mod.CLAIM_IDLE_MS + 1,
        "times_delivered": 1,
    }])
    redis.xrange = AsyncMock(return_value=[("1-0", {
        "task_id": "task-1",
        "task_type": "generate",
        "payload": "{}",
        "retries": "0",
    })])
    redis.get = AsyncMock(return_value=json.dumps({"status": "processing"}))
    redis.xclaim = AsyncMock()

    with patch("core.queue.get_redis", return_value=redis), patch("core.queue.ack_message", new=AsyncMock()) as ack_mock:
        result = await queue_mod.reclaim_idle_messages("consumer-1")

    assert result == []
    redis.xclaim.assert_not_awaited()
    ack_mock.assert_not_awaited()
