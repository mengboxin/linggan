from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_enqueue_snapshots_submission_compute_source(monkeypatch):
    from core import queue
    from core.user_context import bind_user_context

    redis = AsyncMock()
    redis.eval.return_value = [1, "message-1"]
    monkeypatch.setattr(queue, "get_redis", MagicMock(return_value=redis))
    monkeypatch.setattr(queue, "reserve_user_slot", AsyncMock())

    with bind_user_context("user-1", "external_api_key"):
        await queue.enqueue(
            "generate",
            "task-1",
            {"prompt": "test"},
            user_id="user-1",
        )

    args = redis.eval.await_args.args
    message_start = 2 + len(queue._CAPACITY_STREAMS) + 2
    message_values = args[message_start:]
    message = dict(zip(message_values[::2], message_values[1::2]))
    assert message["user_id"] == "user-1"
    assert message["billing_mode"] == "external_api_key"


@pytest.mark.asyncio
async def test_worker_prefers_task_compute_source_over_queue_and_current_mode(monkeypatch):
    from core import worker
    from core.user_context import get_current_billing_mode, get_current_user_id

    observed: list[tuple[str | None, str | None]] = []

    async def handler(_task_id: str, _payload: dict):
        observed.append((get_current_user_id(), get_current_billing_mode()))

    task_type = "test-queued-compute-source"
    worker._handlers[task_type] = handler
    monkeypatch.setattr(worker, "ack_message", AsyncMock())
    monkeypatch.setattr(worker, "release_user_slot", AsyncMock())
    monkeypatch.setattr(
        worker.task_repo,
        "get",
        AsyncMock(return_value={"_billing_mode": "platform_credits"}),
    )
    get_billing_mode = AsyncMock(return_value="platform_credits")
    monkeypatch.setattr(worker.foxapi_credentials, "get_billing_mode", get_billing_mode)

    try:
        await worker.Worker("test-worker")._process_message(
            "queue:test",
            "message-1",
            {
                "task_id": "task-1",
                "task_type": task_type,
                "user_id": "user-1",
                "billing_mode": "external_api_key",
                "payload": "{}",
                "retries": "0",
            },
        )
    finally:
        worker._handlers.pop(task_type, None)

    assert observed == [("user-1", "platform_credits")]
    get_billing_mode.assert_not_awaited()
    assert get_current_user_id() is None
    assert get_current_billing_mode() is None
