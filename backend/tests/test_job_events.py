import json
import sys
from types import ModuleType
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_publishes_each_non_terminal_job_state_change(monkeypatch):
    from services.job_events import publish_job_update

    redis = AsyncMock()
    redis_module = ModuleType("core.redis")
    redis_module.get_redis = lambda: redis
    monkeypatch.setitem(sys.modules, "core.redis", redis_module)
    state = {
        "user_id": "user-1",
        "job_id": "poster-job-1",
        "status": "generating",
        "progress": 42,
        "message": "正在生成海报",
    }

    await publish_job_update(
        state,
        job_type="poster",
    )

    redis.publish.assert_awaited_once()
    channel, raw_payload = redis.publish.await_args.args
    payload = json.loads(raw_payload)
    assert channel == "user_event:user-1"
    assert payload == {
        "type": "job_update",
        "job_type": "poster",
        "job_id": "poster-job-1",
        "status": "generating",
        "progress": 42,
        "message": "正在生成海报",
        "error": "",
    }

    state["message"] = "正在生成下一版海报"
    await publish_job_update(
        state,
        job_type="poster",
    )

    assert redis.publish.await_count == 2
    latest_payload = json.loads(redis.publish.await_args.args[1])
    assert latest_payload["message"] == "正在生成下一版海报"


@pytest.mark.asyncio
async def test_task_repo_does_not_publish_progress_for_terminal_state(monkeypatch):
    import repositories.task_repo as task_repo

    redis = AsyncMock()
    redis.get.return_value = json.dumps({
        "_user_id": "user-1",
        "status": "processing",
        "progress": 80,
    })
    monkeypatch.setattr(task_repo, "get_redis", lambda: redis)
    publish_progress = AsyncMock()
    monkeypatch.setattr(task_repo, "publish_task_progress", publish_progress)

    await task_repo._update("task-1", {"status": "completed", "progress": 100})

    publish_progress.assert_not_awaited()


@pytest.mark.asyncio
async def test_publishes_queue_task_progress():
    from services.job_events import publish_task_progress

    redis = AsyncMock()
    await publish_task_progress(redis, "task-1", {
        "_user_id": "user-1",
        "status": "processing",
        "progress": 35,
        "message": "正在生成图片",
    })

    channel, raw_payload = redis.publish.await_args.args
    assert channel == "user_event:user-1"
    assert json.loads(raw_payload) == {
        "type": "task_progress",
        "task_id": "task-1",
        "status": "processing",
        "progress": 35,
        "message": "正在生成图片",
    }
