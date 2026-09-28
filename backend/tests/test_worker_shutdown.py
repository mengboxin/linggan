import asyncio
import json
from unittest.mock import AsyncMock, call, patch

import pytest

from core import worker as worker_module


@pytest.mark.asyncio
async def test_stop_halts_intake_and_does_not_cancel_generate_during_claim():
    worker = worker_module.Worker("shutdown-worker", concurrency=1, drain_grace_seconds=0.01)
    worker._running = True
    worker._semaphore = asyncio.Semaphore(1)

    intake_cancelled = asyncio.Event()

    async def intake_loop():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            intake_cancelled.set()
            raise

    intake_task = asyncio.create_task(intake_loop())
    worker._tasks = [intake_task]

    claim_started = asyncio.Event()
    release_claim = asyncio.Event()

    async def claim(_task_id: str) -> bool:
        claim_started.set()
        await release_claim.wait()
        return True

    handler = AsyncMock()
    fields = {
        "task_id": "task-generate",
        "task_type": "generate",
        "payload": json.dumps({"model_id": "image2", "prompt": "draw"}),
        "retries": "0",
    }

    with patch.dict(worker_module._handlers, {"generate": handler}, clear=True), patch(
        "core.worker._claim_generate_execution_once", side_effect=claim
    ), patch("core.worker.ack_message", new=AsyncMock()) as ack, patch(
        "core.worker.cleanup_idle_consumer", new=AsyncMock()
    ) as cleanup_consumer:
        processing = asyncio.create_task(worker._process_message("queue:normal", "1-0", fields))
        worker._processing.add(processing)
        processing.add_done_callback(worker._processing.discard)
        await asyncio.wait_for(claim_started.wait(), timeout=1)

        stopping = asyncio.create_task(worker.stop())
        await asyncio.wait_for(intake_cancelled.wait(), timeout=1)
        await asyncio.sleep(0.03)

        assert not processing.cancelled()
        assert not stopping.done()

        release_claim.set()
        await asyncio.wait_for(stopping, timeout=1)

    handler.assert_awaited_once()
    ack.assert_awaited_once_with("queue:normal", "1-0")
    assert cleanup_consumer.await_args_list == [
        call("shutdown-worker-consumer"),
        call("shutdown-worker-reclaim"),
    ]


@pytest.mark.asyncio
async def test_stop_cancels_unprotected_work_after_drain_grace():
    worker = worker_module.Worker("shutdown-worker", concurrency=1, drain_grace_seconds=0.01)
    worker._running = True
    cancelled = asyncio.Event()

    async def unprotected_work():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    processing = asyncio.create_task(unprotected_work())
    worker._processing.add(processing)
    processing.add_done_callback(worker._processing.discard)
    await asyncio.sleep(0)

    with patch("core.worker.cleanup_idle_consumer", new=AsyncMock()) as cleanup_consumer:
        await asyncio.wait_for(worker.stop(), timeout=1)

    assert cancelled.is_set()
    assert processing.cancelled()
    assert cleanup_consumer.await_args_list == [
        call("shutdown-worker-consumer"),
        call("shutdown-worker-reclaim"),
    ]
