from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import pytest


class ScriptRedis:
    """Small Redis model that executes the task repository script contracts."""

    def __init__(self, task_id: str, state: dict):
        self.task_id = task_id
        self.values = {f"task:{task_id}": json.dumps(state)}
        self.stream: list[tuple[str, dict[str, str]]] = []
        self.published: list[tuple[str, dict]] = []
        self.eval_calls: list[str] = []
        self._next_stream_id = 1
        self._delivered = False

    async def get(self, key: str):
        return self.values.get(key)

    async def set(self, key: str, value: str, *, ex=None, nx=False):
        if nx and key in self.values:
            return None
        self.values[key] = value
        return True

    async def delete(self, *keys: str):
        deleted = 0
        for key in keys:
            if key in self.values:
                del self.values[key]
                deleted += 1
        return deleted

    async def xadd(self, stream: str, fields: dict[str, str]):
        assert stream == "task:terminal-effects"
        message_id = f"{self._next_stream_id}-0"
        self._next_stream_id += 1
        self.stream.append((message_id, {str(key): str(value) for key, value in fields.items()}))
        return message_id

    async def publish(self, channel: str, raw: str):
        self.published.append((channel, json.loads(raw)))
        return 1

    async def xgroup_create(self, *_args, **_kwargs):
        return True

    async def xautoclaim(self, *_args, **_kwargs):
        return ["0-0", [], []]

    async def xreadgroup(self, *_args, **_kwargs):
        if self._delivered or not self.stream:
            return []
        self._delivered = True
        return [("task:terminal-effects", list(self.stream))]

    async def xack(self, _stream: str, _group: str, message_id: str):
        return int(any(existing_id == message_id for existing_id, _ in self.stream))

    async def xdel(self, _stream: str, message_id: str):
        self.stream = [entry for entry in self.stream if entry[0] != message_id]
        return 1

    async def eval(self, script: str, key_count: int, *args):
        from repositories import task_repo

        self.eval_calls.append(script)
        keys = args[:key_count]
        argv = args[key_count:]

        if script == task_repo._TERMINAL_TRANSITION_SCRIPT:
            task_key, stream_key = keys
            status, patch_raw, now_ms, _ttl, task_id, effect_id = argv
            raw = self.values.get(task_key)
            if not raw:
                return [0, "missing", "", ""]
            data = json.loads(raw)
            previous = str(data.get("status") or "pending")
            if previous not in {"pending", "processing"}:
                return [0, previous, "", ""]
            data.update(json.loads(patch_raw))
            data.update(
                {
                    "status": status,
                    "_terminal_effect_id": effect_id,
                    "_terminal_at_ms": int(now_ms),
                    "_updated_ms": int(now_ms),
                }
            )
            if status == "completed":
                data["progress"] = 100
            self.values[task_key] = json.dumps(data)
            stream_id = await self.xadd(
                stream_key,
                {"task_id": task_id, "effect_id": effect_id, "status": status},
            )
            return [1, previous, effect_id, stream_id]

        if script == task_repo._ACTIVE_UPDATE_SCRIPT:
            task_key = keys[0]
            patch_raw, now_ms, _ttl = argv
            raw = self.values.get(task_key)
            if not raw:
                return [0, "missing"]
            data = json.loads(raw)
            current = str(data.get("status") or "pending")
            patch = json.loads(patch_raw)
            if current not in {"pending", "processing"}:
                return [0, current]
            if str(patch.get("status") or "") in {"completed", "failed", "cancelled"}:
                return [0, "terminal_patch"]
            data.update(patch)
            data["_updated_ms"] = int(now_ms)
            self.values[task_key] = json.dumps(data)
            return [1, data.get("status", current)]

        if script == task_repo._MARK_EFFECT_SETTLED_SCRIPT:
            task_key = keys[0]
            effect_id, now_ms, _ttl = argv
            data = json.loads(self.values[task_key])
            if data.get("_terminal_effect_id") != effect_id:
                return 0
            if data.get("_terminal_effect_settled"):
                return 2
            data.update(
                {
                    "_terminal_effect_settled": True,
                    "_released": True,
                    "_terminal_settled_at_ms": int(now_ms),
                    "_updated_ms": int(now_ms),
                }
            )
            self.values[task_key] = json.dumps(data)
            return 1

        if script == task_repo._PATCH_TERMINAL_STATE_SCRIPT:
            task_key = keys[0]
            effect_id, patch_raw, now_ms, _ttl = argv
            data = json.loads(self.values[task_key])
            if data.get("_terminal_effect_id") != effect_id:
                return 0
            data.update(json.loads(patch_raw))
            data["_updated_ms"] = int(now_ms)
            self.values[task_key] = json.dumps(data)
            return 1

        if script == task_repo._PUBLISH_TERMINAL_EVENT_SCRIPT:
            task_key = keys[0]
            effect_id, now_ms, _ttl, marker, channel, event_raw = argv
            data = json.loads(self.values[task_key])
            if data.get("_terminal_effect_id") != effect_id:
                return 0
            if data.get("_terminal_event_sent") or data.get(marker):
                return 0
            data["_terminal_event_sent"] = True
            data[marker] = True
            data["_updated_ms"] = int(now_ms)
            self.values[task_key] = json.dumps(data)
            await self.publish(channel, event_raw)
            return 1

        if script == task_repo._ACK_DELETE_TERMINAL_EFFECT_SCRIPT:
            _stream = keys[0]
            _group, message_id = argv
            if not any(existing_id == message_id for existing_id, _ in self.stream):
                return 0
            await self.xdel(_stream, message_id)
            return 1

        if script == task_repo._RELEASE_TERMINAL_EFFECT_LOCK_SCRIPT:
            lock_key = keys[0]
            token = argv[0]
            if self.values.get(lock_key) != token:
                return 0
            await self.delete(lock_key)
            return 1

        raise AssertionError("unexpected Lua script")


def _state(
    *,
    charge_on_complete: bool = True,
    billing_mode: str = "platform_credits",
) -> dict:
    return {
        "status": "processing",
        "progress": 40,
        "type": "generate",
        "result": None,
        "error": None,
        "_user_id": "user-1",
        "_model_id": "image2",
        "_cost": 4.0,
        "_model_name": "Image 2",
        "_charge_on_complete": charge_on_complete,
        "_billing_mode": billing_mode,
        "_start_ms": 1,
        "_updated_ms": 1,
    }


def _install_dependencies(monkeypatch, redis: ScriptRedis):
    from core import credit_reserve
    from repositories import credit_repo, task_repo

    monkeypatch.setattr(task_repo, "get_redis", lambda: redis)
    monkeypatch.setattr(task_repo, "_release_user_slot_for_task", AsyncMock())
    monkeypatch.setattr(task_repo, "_pg_update_status", AsyncMock())
    release = AsyncMock(return_value=4.0)
    consume = AsyncMock(return_value={"transaction_id": "tx-1"})
    monkeypatch.setattr(credit_reserve, "release_task_reservation", release)
    monkeypatch.setattr(credit_repo, "consume_credits", consume)
    return task_repo, consume, release


@pytest.mark.asyncio
async def test_task_create_freezes_request_billing_mode(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import task_repo

    task_id = "task-freeze-on-create"
    redis = ScriptRedis(task_id, {})
    monkeypatch.setattr(task_repo, "get_redis", lambda: redis)
    monkeypatch.setattr(task_repo, "_pg_insert", AsyncMock())

    with bind_user_context("user-1", "external_api_key"):
        await task_repo.create(
            "generate",
            user_id="user-1",
            model_id="image2",
            cost=4,
            task_id=task_id,
        )

    state = await task_repo.get(task_id)
    assert state is not None
    assert state["_billing_mode"] == "external_api_key"


@pytest.mark.asyncio
async def test_terminal_lua_first_winner_emits_one_outbox_and_one_settlement(monkeypatch):
    task_id = "task-race"
    redis = ScriptRedis(task_id, _state())
    task_repo, consume, release = _install_dependencies(monkeypatch, redis)

    outcomes = await asyncio.gather(
        task_repo.set_completed(task_id, {"imageUrl": "/asset/a"}),
        task_repo.set_failed(task_id, "timeout"),
        task_repo.cancel(task_id),
    )

    winners = [outcome for outcome in outcomes if outcome.won]
    assert len(winners) == 1
    final = await task_repo.get(task_id)
    assert final is not None
    assert final["status"] == winners[0].status
    assert final["_terminal_effect_settled"] is True
    assert len(redis.stream) == 1
    assert redis.eval_calls.count(task_repo._TERMINAL_TRANSITION_SCRIPT) == 3
    assert len(redis.published) == 1

    if final["status"] == "completed":
        consume.assert_awaited_once()
    else:
        consume.assert_not_awaited()
    release.assert_awaited_once_with(task_id)


@pytest.mark.asyncio
async def test_terminal_outbox_retries_after_reservation_release_failure(monkeypatch):
    task_id = "task-retry"
    redis = ScriptRedis(task_id, _state())
    task_repo, consume, release = _install_dependencies(monkeypatch, redis)
    release.side_effect = [RuntimeError("redis temporarily unavailable"), 4.0]

    transition = await task_repo.transition_terminal(
        task_id,
        status="completed",
        patch={"result": {"imageUrl": "/asset/a"}, "progress": 100},
    )
    assert transition.won is True

    with pytest.raises(RuntimeError, match="temporarily unavailable"):
        await task_repo.settle_terminal_effect(task_id, transition.effect_id or "")

    state_after_failure = await task_repo.get(task_id)
    assert state_after_failure is not None
    assert state_after_failure.get("_terminal_effect_settled") is not True

    processed = await task_repo.process_terminal_effect_outbox(
        consumer_name="terminal-test",
        limit=4,
    )

    final = await task_repo.get(task_id)
    assert processed == 1
    assert final is not None and final["_terminal_effect_settled"] is True
    assert redis.stream == []
    assert release.await_count == 2
    assert consume.await_count == 2
    assert {
        call.kwargs["idempotency_key"]
        for call in consume.await_args_list
    } == {f"task-terminal:{task_id}:charge"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("frozen_mode", "current_mode", "should_charge"),
    [
        ("platform_credits", "external_api_key", True),
        ("external_api_key", "platform_credits", False),
    ],
)
async def test_terminal_settlement_uses_task_frozen_billing_mode(
    monkeypatch,
    frozen_mode: str,
    current_mode: str,
    should_charge: bool,
):
    from core.user_context import bind_user_context, get_current_billing_mode

    task_id = f"task-frozen-{frozen_mode}"
    redis = ScriptRedis(task_id, _state(billing_mode=frozen_mode))
    task_repo, consume, release = _install_dependencies(monkeypatch, redis)
    charged_modes: list[str | None] = []
    released_modes: list[str | None] = []

    async def consume_like_credit_repo(**_kwargs):
        mode = get_current_billing_mode()
        if mode != "external_api_key":
            charged_modes.append(mode)
        return {"transaction_id": "tx-1" if mode != "external_api_key" else None}

    async def release_like_credit_reserve(_task_id: str):
        released_modes.append(get_current_billing_mode())
        return 4.0

    consume.side_effect = consume_like_credit_repo
    release.side_effect = release_like_credit_reserve

    with bind_user_context("user-1", current_mode):
        await task_repo.set_completed(task_id, {"imageUrl": "/asset/a"})

    assert bool(charged_modes) is should_charge
    if should_charge:
        assert charged_modes == [frozen_mode]
        assert consume.await_args.kwargs["related_task_id"] is None
    assert released_modes == [frozen_mode]


@pytest.mark.asyncio
async def test_active_updates_cannot_regress_cancelled_task(monkeypatch):
    task_id = "task-no-regress"
    redis = ScriptRedis(task_id, _state(charge_on_complete=False))
    task_repo, consume, release = _install_dependencies(monkeypatch, redis)

    transition = await task_repo.cancel(task_id)
    assert transition.won is True
    assert await task_repo.set_processing(task_id, 20) is False
    assert await task_repo.set_progress(task_id, 88) is False

    final = await task_repo.get(task_id)
    assert final is not None
    assert final["status"] == "cancelled"
    assert final["progress"] == 40
    consume.assert_not_awaited()
    release.assert_awaited_once_with(task_id)


@pytest.mark.asyncio
async def test_expired_effect_owner_cannot_remove_a_replacement_lock(monkeypatch):
    task_id = "task-lock-token"
    redis = ScriptRedis(task_id, _state())
    task_repo, _consume, _release = _install_dependencies(monkeypatch, redis)
    effect_id = "effect-1"

    first_token = await task_repo._claim_terminal_effect(effect_id)
    assert first_token

    # Model the lease expiring while a slow consumer is still settling, then a
    # second consumer taking ownership with a new token.
    lock_key = task_repo._effect_lock_key(effect_id)
    await redis.delete(lock_key)
    replacement_token = "replacement-token"
    await redis.set(lock_key, replacement_token, nx=True, ex=120)

    await task_repo._release_terminal_effect_claim(effect_id, first_token)
    assert await redis.get(lock_key) == replacement_token

    await task_repo._release_terminal_effect_claim(effect_id, replacement_token)
    assert await redis.get(lock_key) is None


@pytest.mark.asyncio
async def test_delete_acknowledges_only_a_settled_terminal_outbox_tombstone(monkeypatch):
    task_id = "task-delete"
    redis = ScriptRedis(task_id, _state(charge_on_complete=False))
    task_repo, consume, release = _install_dependencies(monkeypatch, redis)

    transition = await task_repo.set_completed(task_id, {"imageUrl": "/asset/a"})
    assert transition.won is True
    assert len(redis.stream) == 1

    await task_repo.delete(task_id)
    assert await task_repo.get(task_id) is None

    processed = await task_repo.process_terminal_effect_outbox(
        consumer_name="terminal-delete-test",
        limit=4,
    )

    assert processed == 1
    assert redis.stream == []
    consume.assert_not_awaited()
    release.assert_awaited_once_with(task_id)


@pytest.mark.asyncio
async def test_disabled_public_submission_consumes_a_legacy_task_intent_before_reenable(monkeypatch):
    from repositories import public_gallery_repo

    task_id = "task-public-disabled"
    state = _state(charge_on_complete=False)
    state.update({
        "_make_public": True,
        "_public_prompt": "legacy public request",
        "_public_module": "TEXT_TO_IMAGE",
    })
    redis = ScriptRedis(task_id, state)
    task_repo, _consume, _release = _install_dependencies(monkeypatch, redis)
    publish = AsyncMock(return_value={"submitted_count": 1, "skipped_count": 0})
    monkeypatch.setattr(public_gallery_repo, "publish_generation_result", publish)
    monkeypatch.setattr(task_repo.settings, "PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED", False)

    transition = await task_repo.set_completed(task_id, {"imageUrl": "/asset/a"})
    assert transition.won is True
    settled = await task_repo.get(task_id)
    assert settled is not None
    assert settled["_make_public"] is False
    assert settled["_public_submitted"] is True
    assert settled["_public_skipped"] is True
    publish.assert_not_awaited()

    monkeypatch.setattr(task_repo.settings, "PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED", True)
    await task_repo.settle_terminal_effect(task_id, transition.effect_id or "")
    await task_repo.delete(task_id)
    publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_queue_monitor_cancel_delegates_to_terminal_repository(monkeypatch):
    from repositories.task_repo import TerminalTransition
    from routers import queue_monitor

    redis = AsyncMock()
    cancel = AsyncMock(
        return_value=TerminalTransition(
            won=True,
            status="cancelled",
            previous_status="processing",
            effect_id="task-monitor:effect",
        )
    )
    monkeypatch.setattr(
        queue_monitor.task_repo,
        "get",
        AsyncMock(return_value={"status": "processing", "_user_id": "user-1"}),
    )
    monkeypatch.setattr(queue_monitor.task_repo, "cancel", cancel)
    monkeypatch.setattr(queue_monitor, "get_redis", lambda: redis)

    result = await queue_monitor.cancel_task("task-monitor", user={"id": "user-1"})

    cancel.assert_awaited_once_with("task-monitor")
    redis.setex.assert_awaited_once_with("cancel:task-monitor", 60, "1")
    assert result == {
        "ok": True,
        "task_id": "task-monitor",
        "previous_status": "processing",
        "status": "cancelled",
    }
