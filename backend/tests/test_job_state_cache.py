import asyncio
import json
import sys
import types
from importlib import import_module
from unittest.mock import AsyncMock

import pytest


class FakeRedis:
    def __init__(self, payload: dict):
        self.payload = payload

    async def get(self, key: str):
        return json.dumps(self.payload, ensure_ascii=False)


class FailingQueueRedis:
    async def eval(self, *args, **kwargs):
        raise RuntimeError("redis unavailable")

    async def xadd(self, *args, **kwargs):
        raise RuntimeError("redis unavailable")


class FailingStateRedis:
    async def get(self, *args, **kwargs):
        raise RuntimeError("redis unavailable")

    async def set(self, *args, **kwargs):
        raise RuntimeError("redis unavailable")


class HealthyStateRedis:
    async def get(self, *args, **kwargs):
        return None

    async def set(self, *args, **kwargs):
        return True


def install_fake_redis(monkeypatch, redis_client):
    module = types.ModuleType("core.redis")
    module.get_redis = lambda: redis_client
    monkeypatch.setitem(sys.modules, "core.redis", module)


@pytest.mark.asyncio
async def test_sci_fig_load_state_prefers_redis_over_process_memory(monkeypatch):
    from services.agents import sci_fig_agent

    job_id = "job-state-sci"
    sci_fig_agent._mem_store[job_id] = {"job_id": job_id, "status": "generating"}

    install_fake_redis(
        monkeypatch,
        FakeRedis({"job_id": job_id, "status": "preview", "rendered_b64": "done"}),
    )

    state = await sci_fig_agent._load_state(job_id)

    assert state["status"] == "preview"
    assert job_id not in sci_fig_agent._mem_store


@pytest.mark.asyncio
async def test_ppt_load_state_prefers_redis_over_process_memory(monkeypatch):
    from services.agents import ppt_agent

    job_id = "job-state-ppt"
    ppt_agent._mem_store[job_id] = {"job_id": job_id, "status": "generating_images"}

    install_fake_redis(
        monkeypatch,
        FakeRedis({"job_id": job_id, "status": "checkpoint", "slide_images_b64": ["done"]}),
    )

    state = await ppt_agent._load_state(job_id)

    assert state["status"] == "checkpoint"
    assert job_id not in ppt_agent._mem_store


@pytest.mark.asyncio
async def test_ppt_direct_slide_batches_share_one_materialized_workspace(monkeypatch):
    from services.agents import ppt_agent

    job_id = "ppt-direct-batch-cache"
    ppt_agent._discard_direct_slide_cache(job_id)
    state = {
        "job_id": job_id,
        "status": "checkpoint",
        "conversion_mode": "ppt_master_direct",
        "direct_slide_decks": [
            {"id": "direct-1", "versions": ["svg-1"]},
            {"id": "direct-2", "versions": ["svg-2"]},
            {"id": "direct-3", "versions": ["svg-3"]},
        ],
    }
    load_state = AsyncMock(return_value=state)
    monkeypatch.setattr(ppt_agent, "_load_state", load_state)

    batches = await asyncio.gather(
        *(
            ppt_agent.PPTAgent().get_ppt_master_direct_slide_batch(job_id, offset, 1)
            for offset in range(3)
        ),
    )

    assert load_state.await_count == 1
    assert [batch[0][0]["id"] for batch in batches] == ["direct-1", "direct-2", "direct-3"]
    assert all(batch[1] == 3 for batch in batches)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module_path", "sync_function"),
    [
        ("routers.poster", "sync_specialist_run"),
        ("services.agents.ppt_agent", "sync_ppt_run"),
        ("services.agents.sci_fig_agent", "sync_specialist_run"),
    ],
)
async def test_job_state_memory_is_only_an_outage_fallback(monkeypatch, module_path, sync_function):
    module = import_module(module_path)
    job_id = f"fallback-{module_path.rsplit('.', 1)[-1]}"
    state = {"job_id": job_id, "status": "running"}
    module._mem_store.clear()
    monkeypatch.setattr(module, "publish_job_update", AsyncMock())
    monkeypatch.setattr(module, sync_function, AsyncMock())

    install_fake_redis(monkeypatch, FailingStateRedis())
    await module._save_state(job_id, state)
    assert module._mem_store[job_id] is state
    assert await module._load_state(job_id) is state

    install_fake_redis(monkeypatch, HealthyStateRedis())
    await module._save_state(job_id, state)
    assert job_id not in module._mem_store


def test_bounded_job_state_cache_evicts_by_lru_ttl_and_byte_budget():
    from core.job_state_cache import BoundedJobStateCache

    now = [0.0]
    cache = BoundedJobStateCache(
        max_entries=2,
        ttl_seconds=10,
        max_bytes=1024,
        clock=lambda: now[0],
    )
    cache["first"] = {"status": "first"}
    cache["second"] = {"status": "second"}
    assert cache["first"]["status"] == "first"

    cache["third"] = {"status": "third"}
    assert "second" not in cache
    assert "first" in cache
    assert "third" in cache

    now[0] = 10.0
    assert cache.get("first") is None
    assert len(cache) == 0

    byte_limited = BoundedJobStateCache(
        max_entries=2,
        ttl_seconds=10,
        max_bytes=32,
    )
    assert not byte_limited.set("too-large", {"payload": "x" * 128})
    assert len(byte_limited) == 0


@pytest.mark.asyncio
async def test_enqueue_releases_user_slot_when_xadd_fails(monkeypatch):
    sys.modules.pop("core.queue", None)
    install_fake_redis(monkeypatch, FailingQueueRedis())

    from core import queue

    reserve = AsyncMock()
    release = AsyncMock()
    monkeypatch.setattr(queue, "reserve_user_slot", reserve)
    monkeypatch.setattr(queue, "release_user_slot", release)
    monkeypatch.setattr(queue, "get_redis", lambda: FailingQueueRedis())

    try:
        with pytest.raises(RuntimeError, match="redis unavailable"):
            await queue.enqueue(
                task_type="generate",
                task_id="task-rollback",
                payload={},
                user_id="user-1",
            )

        reserve.assert_awaited_once_with("user-1", "task-rollback")
        release.assert_awaited_once_with("user-1", "task-rollback")
    finally:
        sys.modules.pop("core.queue", None)
