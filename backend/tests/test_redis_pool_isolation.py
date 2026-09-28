import sys
import types
import asyncio
import json
from importlib.machinery import ModuleSpec

import pytest


redis_package = types.ModuleType("redis")
redis_asyncio = types.ModuleType("redis.asyncio")
redis_package.__spec__ = ModuleSpec("redis", loader=None, is_package=True)
redis_asyncio.__spec__ = ModuleSpec("redis.asyncio", loader=None)
redis_asyncio.Redis = object
redis_asyncio.from_url = lambda *_args, **_kwargs: object()
redis_package.asyncio = redis_asyncio
sys.modules.setdefault("redis", redis_package)
sys.modules.setdefault("redis.asyncio", redis_asyncio)

from core import redis as redis_core


def test_sse_uses_a_dedicated_redis_client(monkeypatch):
    created = []

    def fake_from_url(*args, **kwargs):
        client = object()
        created.append((client, kwargs))
        return client

    monkeypatch.setattr(redis_core.aioredis, "from_url", fake_from_url)
    monkeypatch.setattr(redis_core, "_client", None)
    monkeypatch.setattr(redis_core, "_pubsub_client", None, raising=False)

    command_client = redis_core.get_redis()
    pubsub_client = redis_core.get_redis_pubsub()

    assert command_client is not pubsub_client
    assert len(created) == 2
    assert created[0][1]["max_connections"] == 50
    assert created[1][1]["max_connections"] == 4
    assert created[0][1]["protocol"] == 2
    assert created[1][1]["protocol"] == 2
    assert created[1][1]["socket_timeout"] is None


@pytest.mark.asyncio
async def test_event_streams_share_one_process_wide_pubsub_connection(monkeypatch):
    from routers import events

    class FakeRequest:
        async def is_disconnected(self):
            return False

    class FakePubSub:
        def __init__(self):
            self.subscribed = []
            self.unsubscribed = []
            self.closed = False

        async def subscribe(self, channel):
            self.subscribed.append(channel)

        async def psubscribe(self, channel):
            self.subscribed.append(channel)

        async def unsubscribe(self, channel):
            self.unsubscribed.append(channel)

        async def punsubscribe(self, channel):
            self.unsubscribed.append(channel)

        async def get_message(self, **_kwargs):
            await __import__('asyncio').sleep(3600)

        async def aclose(self):
            self.closed = True

    pubsubs = []

    def make_pubsub():
        pubsub = FakePubSub()
        pubsubs.append(pubsub)
        return pubsub

    redis_client = types.SimpleNamespace(pubsub=make_pubsub)
    monkeypatch.setattr(events, "get_redis_pubsub", lambda: redis_client)

    first = events._event_generator("user-1", FakeRequest())
    second = events._event_generator("user-2", FakeRequest())
    assert await anext(first) == b"retry: 15000\n\n"
    assert await anext(second) == b"retry: 15000\n\n"
    assert b"event: connected" in await anext(first)
    assert b"event: connected" in await anext(second)
    await __import__('asyncio').sleep(0)

    assert len(pubsubs) == 1

    await first.aclose()
    await second.aclose()
    await events.close_event_broker()
    assert pubsubs[0].closed is True


@pytest.mark.asyncio
async def test_shared_event_broker_routes_events_only_to_the_target_user(monkeypatch):
    from routers import events

    class FakePubSub:
        def __init__(self):
            self.messages = asyncio.Queue()

        async def psubscribe(self, _channel):
            return None

        async def punsubscribe(self, _channel):
            return None

        async def get_message(self, **_kwargs):
            return await self.messages.get()

        async def aclose(self):
            return None

    pubsub = FakePubSub()
    monkeypatch.setattr(
        events,
        "get_redis_pubsub",
        lambda: types.SimpleNamespace(pubsub=lambda: pubsub),
    )
    broker = events._UserEventBroker()
    first = await broker.subscribe("user-1")
    second = await broker.subscribe("user-2")

    await pubsub.messages.put({
        "type": "pmessage",
        "channel": "user_event:user-1",
        "data": json.dumps({"type": "task_failed", "task_id": "task-1"}),
    })

    event_type, payload = await asyncio.wait_for(first.get(), timeout=1)
    assert event_type == "task_failed"
    assert payload["task_id"] == "task-1"
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(second.get(), timeout=0.01)

    await broker.close()
