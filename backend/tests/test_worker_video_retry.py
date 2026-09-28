import json
from unittest.mock import AsyncMock, patch

import pytest


def _fields():
    return {
        "task_id": "task-video-1",
        "task_type": "generate-video",
        "payload": json.dumps({"model_id": "grok-imagine-video", "prompt": "draw"}),
        "retries": "0",
    }


@pytest.mark.asyncio
async def test_video_failure_without_provider_request_is_terminal():
    import core.worker as worker_mod

    worker = worker_mod.Worker("test-worker", concurrency=1)
    handler = AsyncMock(side_effect=RuntimeError("provider transport failed"))
    failed = AsyncMock()
    acknowledged = AsyncMock(return_value=True)
    retried = AsyncMock()

    with patch.dict(worker_mod._handlers, {"generate-video": handler}, clear=True), patch(
        "core.worker.task_repo.get",
        new=AsyncMock(return_value={"status": "processing", "_provider_request_id": ""}),
    ), patch("core.worker.task_repo.set_failed", new=failed), patch(
        "core.worker.ack_message", new=acknowledged
    ), patch("core.worker.nack_message", new=retried):
        await worker._process_message("queue:normal", "1-0", _fields())

    failed.assert_awaited_once()
    acknowledged.assert_awaited_once_with("queue:normal", "1-0")
    retried.assert_not_awaited()


@pytest.mark.asyncio
async def test_video_failure_with_provider_request_requeues_for_poll_resume():
    import core.worker as worker_mod

    worker = worker_mod.Worker("test-worker", concurrency=1)
    handler = AsyncMock(side_effect=RuntimeError("provider poll interrupted"))
    failed = AsyncMock()
    acknowledged = AsyncMock()
    retried = AsyncMock(return_value=True)

    with patch.dict(worker_mod._handlers, {"generate-video": handler}, clear=True), patch(
        "core.worker.task_repo.get",
        new=AsyncMock(return_value={"status": "processing", "_provider_request_id": "provider-1"}),
    ), patch("core.worker.task_repo.set_failed", new=failed), patch(
        "core.worker.ack_message", new=acknowledged
    ), patch("core.worker.nack_message", new=retried):
        await worker._process_message("queue:low", "2-0", _fields())

    failed.assert_not_awaited()
    acknowledged.assert_not_awaited()
    retried.assert_awaited_once_with(
        "queue:low",
        "2-0",
        _fields(),
        "provider poll interrupted",
    )
