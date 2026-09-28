import json
from unittest.mock import AsyncMock, patch

import pytest

from core import queue, worker as worker_module


@pytest.mark.asyncio
async def test_cleanup_idle_consumer_removes_metadata_from_each_worker_stream():
    redis = AsyncMock()
    redis.xpending_range.return_value = []

    with patch.object(queue, "get_redis", return_value=redis):
        await queue.cleanup_idle_consumer("worker-test-consumer")

    assert redis.xpending_range.await_count == 3
    assert redis.xgroup_delconsumer.await_count == 3
    for stream in (queue.STREAM_HIGH, queue.STREAM_NORMAL, queue.STREAM_LOW):
        redis.xgroup_delconsumer.assert_any_await(
            stream,
            queue.CONSUMER_GROUP,
            "worker-test-consumer",
        )


@pytest.mark.asyncio
async def test_cleanup_idle_consumer_preserves_metadata_with_pending_work():
    redis = AsyncMock()
    redis.xpending_range.side_effect = [[], [{"message_id": "1-0"}], []]

    with patch.object(queue, "get_redis", return_value=redis):
        await queue.cleanup_idle_consumer("worker-test-consumer")

    assert redis.xgroup_delconsumer.await_count == 2
    redis.xgroup_delconsumer.assert_any_await(
        queue.STREAM_HIGH,
        queue.CONSUMER_GROUP,
        "worker-test-consumer",
    )
    redis.xgroup_delconsumer.assert_any_await(
        queue.STREAM_LOW,
        queue.CONSUMER_GROUP,
        "worker-test-consumer",
    )


@pytest.mark.asyncio
async def test_ack_message_deletes_stream_entry_after_successful_ack():
    redis = AsyncMock()
    redis.eval.return_value = 1

    with patch.object(queue, "get_redis", return_value=redis):
        acknowledged = await queue.ack_message(queue.STREAM_NORMAL, "1-0")

    assert acknowledged is True
    redis.eval.assert_awaited_once_with(
        queue._ACK_DELETE_STREAM_MESSAGE_SCRIPT,
        1,
        queue.STREAM_NORMAL,
        queue.CONSUMER_GROUP,
        "1-0",
    )


@pytest.mark.asyncio
async def test_ack_message_does_not_delete_when_ack_returns_zero():
    redis = AsyncMock()
    redis.eval.return_value = 0

    with patch.object(queue, "get_redis", return_value=redis):
        acknowledged = await queue.ack_message(queue.STREAM_NORMAL, "missing-0")

    assert acknowledged is False
    redis.xdel.assert_not_awaited()


@pytest.mark.asyncio
async def test_ack_message_does_not_delete_when_ack_raises():
    redis = AsyncMock()
    redis.eval.side_effect = RuntimeError("redis unavailable")

    with patch.object(queue, "get_redis", return_value=redis):
        acknowledged = await queue.ack_message(queue.STREAM_NORMAL, "1-0")

    assert acknowledged is False
    redis.xdel.assert_not_awaited()


@pytest.mark.asyncio
async def test_nack_message_atomically_moves_retry_and_removes_original():
    redis = AsyncMock()
    redis.eval.return_value = [1, "2-0"]
    fields = {
        "task_id": "task-1",
        "task_type": "segmentation",
        "payload": "{}",
        "retries": "0",
    }

    with patch.object(queue, "get_redis", return_value=redis):
        moved = await queue.nack_message(queue.STREAM_NORMAL, "1-0", fields, "temporary")

    assert moved is True
    redis.eval.assert_awaited_once()
    _, key_count, source_stream, destination_stream, group, message_id, *values = redis.eval.await_args.args
    assert key_count == 2
    assert (source_stream, destination_stream, group, message_id) == (
        queue.STREAM_NORMAL,
        queue.STREAM_LOW,
        queue.CONSUMER_GROUP,
        "1-0",
    )
    assert "retries" in values
    assert "1" in values
    redis.xadd.assert_not_awaited()
    redis.xack.assert_not_awaited()


@pytest.mark.asyncio
async def test_enqueue_rejects_global_capacity_and_releases_user_slot(monkeypatch):
    redis = AsyncMock()
    redis.eval.return_value = [0, "3"]
    reserve = AsyncMock()
    release = AsyncMock()
    monkeypatch.setattr(queue, "QUEUE_GLOBAL_MAX_ENTRIES", 3)
    monkeypatch.setattr(queue, "reserve_user_slot", reserve)
    monkeypatch.setattr(queue, "release_user_slot", release)
    monkeypatch.setattr(queue, "_should_use_go_control_plane", lambda _task_type: False)
    monkeypatch.setattr(queue, "_should_use_go_image2_worker", lambda _task_type, _payload: False)

    with patch.object(queue, "get_redis", return_value=redis):
        with pytest.raises(queue.QueueCapacityExceeded) as error:
            await queue.enqueue(
                task_type="segmentation",
                task_id="task-full",
                payload={},
                user_id="user-1",
            )

    assert error.value.current == 3
    assert error.value.limit == 3
    reserve.assert_awaited_once_with("user-1", "task-full")
    release.assert_awaited_once_with("user-1", "task-full")
    redis.xadd.assert_not_awaited()


@pytest.mark.asyncio
async def test_enqueue_uses_atomic_capacity_gate_without_stream_trimming(monkeypatch):
    redis = AsyncMock()
    redis.eval.return_value = [1, "10-0"]
    monkeypatch.setattr(queue, "_should_use_go_control_plane", lambda _task_type: False)
    monkeypatch.setattr(queue, "_should_use_go_image2_worker", lambda _task_type, _payload: False)

    with patch.object(queue, "get_redis", return_value=redis):
        message_id = await queue.enqueue(
            task_type="segmentation",
            task_id="task-accepted",
            payload={},
        )

    assert message_id == "10-0"
    redis.eval.assert_awaited_once()
    redis.xadd.assert_not_awaited()
    assert "MAXLEN" not in redis.eval.await_args.args[0]


@pytest.mark.asyncio
async def test_user_active_slot_uses_task_state_lifetime(monkeypatch):
    redis = AsyncMock()
    monkeypatch.setattr(queue, "TASK_ACTIVE_SLOT_TTL_SECONDS", 86_400)
    monkeypatch.setattr(queue, "_prune_user_active_slots", AsyncMock(return_value=0))

    with patch.object(queue, "get_redis", return_value=redis):
        await queue.reserve_user_slot("user-1", "task-1")

    redis.set.assert_awaited_once_with("task:active_slot:task-1", "user-1", ex=86_400)
    redis.expire.assert_awaited_once_with("task:user:user-1:active", 86_400)


@pytest.mark.asyncio
async def test_nack_message_atomically_moves_terminal_failure_to_dlq(monkeypatch):
    redis = AsyncMock()
    redis.eval.return_value = [1, "9-0"]
    failed = AsyncMock()
    release = AsyncMock()
    release_inputs = AsyncMock()
    monkeypatch.setattr(queue, "release_user_slot", release)
    fields = {
        "task_id": "task-final",
        "task_type": "segmentation",
        "user_id": "user-1",
        "payload": json.dumps({
            "image_asset": {
                "file_asset_id": "file-1",
                "key": "assets/users/user/queue-inputs/task/image.png",
            },
        }),
        "retries": str(queue.MAX_RETRIES),
    }

    with patch.object(queue, "get_redis", return_value=redis), patch(
        "repositories.task_repo.set_failed", new=failed
    ), patch(
        "services.queue_assets.release_consumed_queue_inputs", new=release_inputs
    ):
        moved = await queue.nack_message(queue.STREAM_LOW, "8-0", fields, "permanent")

    assert moved is True
    _, key_count, source_stream, destination_stream, group, message_id, *_ = redis.eval.await_args.args
    assert key_count == 2
    assert (source_stream, destination_stream, group, message_id) == (
        queue.STREAM_LOW,
        queue.STREAM_DLQ,
        queue.CONSUMER_GROUP,
        "8-0",
    )
    failed.assert_awaited_once()
    release.assert_awaited_once_with("user-1", "task-final")
    release_inputs.assert_awaited_once_with(
        user_id="user-1",
        payload={
            "image_asset": {
                "file_asset_id": "file-1",
                "key": "assets/users/user/queue-inputs/task/image.png",
            },
        },
    )


@pytest.mark.asyncio
async def test_worker_releases_queue_inputs_only_after_successful_ack():
    handler = AsyncMock()
    release_inputs = AsyncMock(return_value={"deleted_file_ids": ["file-1"]})
    release_slot = AsyncMock()
    fields = {
        "task_id": "task-success",
        "task_type": "touch-replace",
        "user_id": "user-1",
        "billing_mode": "platform_credits",
        "payload": json.dumps({
            "image_asset": {
                "file_asset_id": "file-1",
                "key": "assets/users/user/queue-inputs/task/files/image.png",
            },
        }),
        "retries": "0",
    }
    worker = worker_module.Worker("queue-cleanup-worker", concurrency=1)

    with patch.dict(worker_module._handlers, {"touch-replace": handler}, clear=True), patch(
        "core.worker.ack_message", new=AsyncMock(return_value=True)
    ), patch("core.worker.release_user_slot", new=release_slot), patch(
        "core.worker.queue_assets.release_consumed_queue_inputs", new=release_inputs
    ):
        await worker._process_message("queue:normal", "1-0", fields)

    release_inputs.assert_awaited_once_with(
        user_id="user-1",
        payload={
            "image_asset": {
                "file_asset_id": "file-1",
                "key": "assets/users/user/queue-inputs/task/files/image.png",
            },
            "_queue_user_id": "user-1",
        },
    )
    release_slot.assert_awaited_once_with("user-1", "task-success")
