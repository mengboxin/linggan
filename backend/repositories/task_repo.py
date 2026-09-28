"""Task state, terminal transitions, and durable settlement outbox.

Redis is the authoritative state machine for queued work.  A task may receive
several terminal signals at once (a worker callback, a timeout, and a user
cancel are common).  The transition script below makes the first signal win
and appends exactly one small outbox record in the same Redis transaction.

The outbox deliberately contains identifiers only.  Results can be large, so
the effect worker re-reads the task state instead of duplicating image data in
Redis Streams.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import logging
import os
import socket
import time
import traceback
import uuid
from typing import Any, Literal, Optional

from core.config import settings
from core.redis import get_redis
from core.task_errors import to_user_error_message
from core.user_context import bind_user_context, get_current_billing_mode
from services import foxapi_credentials
from services.compute_billing import ALL_BILLING_MODES, PLATFORM_BILLING_MODE
from services.job_events import publish_task_progress

logger = logging.getLogger(__name__)

_TTL = max(3600, int(settings.TASK_STATE_TTL_SECONDS))
_TERMINAL_STATUSES = frozenset(("completed", "failed", "cancelled"))
_ACTIVE_STATUSES = frozenset(("pending", "processing"))

# This stream is an outbox, not a work queue: never trim it on append.  Entries
# are deleted only after their side effects have been recorded as settled.
TERMINAL_EFFECT_STREAM = "task:terminal-effects"
TERMINAL_EFFECT_GROUP = "task-terminal-effects"
_TERMINAL_EFFECT_BATCH_SIZE = max(
    1,
    int(getattr(settings, "TASK_TERMINAL_EFFECT_BATCH_SIZE", 32)),
)
_TERMINAL_EFFECT_RECLAIM_IDLE_MS = max(
    1_000,
    int(getattr(settings, "TASK_TERMINAL_EFFECT_RECLAIM_IDLE_MS", 30_000)),
)
_TERMINAL_EFFECT_POLL_MS = max(
    100,
    int(getattr(settings, "TASK_TERMINAL_EFFECT_POLL_MS", 1_000)),
)
_TERMINAL_EFFECT_LOCK_SECONDS = max(
    5,
    int(getattr(settings, "TASK_TERMINAL_EFFECT_LOCK_SECONDS", 120)),
)

_RESULT_EVENT_KEYS = (
    "imageUrl",
    "image_url",
    "previewUrl",
    "preview_url",
    "thumbnailUrl",
    "thumbnail_url",
    "assetId",
    "asset_id",
    "model_id",
    "final_prompt",
    "pptx_url",
    "pptxUrl",
    "workspace_url",
    "download_url",
)


# KEYS[1] task key, KEYS[2] terminal-effect stream
# ARGV[1] target status, ARGV[2] JSON patch, ARGV[3] now ms, ARGV[4] TTL,
# ARGV[5] task id, ARGV[6] effect id
_TERMINAL_TRANSITION_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if not raw then
    return {0, 'missing', '', ''}
end

local decoded, data = pcall(cjson.decode, raw)
if not decoded or type(data) ~= 'table' then
    return {0, 'invalid', '', ''}
end

local previous = tostring(data['status'] or 'pending')
if previous == 'completed' or previous == 'failed' or previous == 'cancelled' then
    return {0, previous, '', ''}
end
if previous ~= 'pending' and previous ~= 'processing' then
    return {0, previous, '', ''}
end

local patch_ok, patch = pcall(cjson.decode, ARGV[2])
if not patch_ok or type(patch) ~= 'table' then
    return {0, 'invalid_patch', '', ''}
end
for key, value in pairs(patch) do
    data[key] = value
end

data['status'] = ARGV[1]
data['_terminal_effect_id'] = ARGV[6]
data['_terminal_at_ms'] = tonumber(ARGV[3])
data['_updated_ms'] = tonumber(ARGV[3])
if ARGV[1] == 'completed' then
    data['progress'] = 100
end

redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[4]))
local message_id = redis.call(
    'XADD', KEYS[2], '*',
    'task_id', ARGV[5],
    'effect_id', ARGV[6],
    'status', ARGV[1]
)
return {1, previous, ARGV[6], message_id}
"""


# KEYS[1] task key
# ARGV[1] JSON patch, ARGV[2] now ms, ARGV[3] TTL
_ACTIVE_UPDATE_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if not raw then
    return {0, 'missing'}
end

local decoded, data = pcall(cjson.decode, raw)
if not decoded or type(data) ~= 'table' then
    return {0, 'invalid'}
end

local current = tostring(data['status'] or 'pending')
if current == 'completed' or current == 'failed' or current == 'cancelled' then
    return {0, current}
end
if current ~= 'pending' and current ~= 'processing' then
    return {0, current}
end

local patch_ok, patch = pcall(cjson.decode, ARGV[1])
if not patch_ok or type(patch) ~= 'table' then
    return {0, 'invalid_patch'}
end
local requested = tostring(patch['status'] or '')
if requested == 'completed' or requested == 'failed' or requested == 'cancelled' then
    return {0, 'terminal_patch'}
end
for key, value in pairs(patch) do
    data[key] = value
end
data['_updated_ms'] = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[3]))
return {1, tostring(data['status'] or current)}
"""


# KEYS[1] task key
# ARGV[1] effect id, ARGV[2] now ms, ARGV[3] TTL
_MARK_EFFECT_SETTLED_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local decoded, data = pcall(cjson.decode, raw)
if not decoded or type(data) ~= 'table' then
    return 0
end
if tostring(data['_terminal_effect_id'] or '') ~= ARGV[1] then
    return 0
end
if data['_terminal_effect_settled'] == true then
    return 2
end
data['_terminal_effect_settled'] = true
data['_released'] = true
data['_terminal_settled_at_ms'] = tonumber(ARGV[2])
data['_updated_ms'] = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[3]))
return 1
"""


# KEYS[1] task key
# ARGV[1] effect id, ARGV[2] JSON patch, ARGV[3] now ms, ARGV[4] TTL
_PATCH_TERMINAL_STATE_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local decoded, data = pcall(cjson.decode, raw)
if not decoded or type(data) ~= 'table' then
    return 0
end
if tostring(data['_terminal_effect_id'] or '') ~= ARGV[1] then
    return 0
end
local patch_ok, patch = pcall(cjson.decode, ARGV[2])
if not patch_ok or type(patch) ~= 'table' then
    return 0
end
for key, value in pairs(patch) do
    data[key] = value
end
data['_updated_ms'] = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[4]))
return 1
"""


# KEYS[1] task key
# ARGV[1] effect id, ARGV[2] now ms, ARGV[3] TTL, ARGV[4] marker key,
# ARGV[5] channel, ARGV[6] event JSON
_PUBLISH_TERMINAL_EVENT_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if not raw then
    return 0
end
local decoded, data = pcall(cjson.decode, raw)
if not decoded or type(data) ~= 'table' then
    return 0
end
if tostring(data['_terminal_effect_id'] or '') ~= ARGV[1] then
    return 0
end
if data['_terminal_event_sent'] == true or data[ARGV[4]] == true then
    return 0
end
data['_terminal_event_sent'] = true
data[ARGV[4]] = true
data['_updated_ms'] = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[3]))
redis.call('PUBLISH', ARGV[5], ARGV[6])
return 1
"""


# KEYS[1] terminal-effect stream
# ARGV[1] group name, ARGV[2] message id
_ACK_DELETE_TERMINAL_EFFECT_SCRIPT = """
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if tonumber(acknowledged) == 0 then
    return 0
end
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""

# KEYS[1] terminal-effect lock key
# ARGV[1] lease token
_RELEASE_TERMINAL_EFFECT_LOCK_SCRIPT = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
return redis.call('DEL', KEYS[1])
"""


@dataclass(frozen=True)
class TerminalTransition:
    """Result of one terminal-state attempt.

    ``won`` is intentionally explicit: callers must not execute terminal side
    effects merely because they attempted a completion or failure update.
    """

    won: bool
    status: str | None
    previous_status: str | None = None
    effect_id: str | None = None
    stream_id: str | None = None


_fallback_locks: dict[str, asyncio.Lock] = {}
_fallback_locks_guard = asyncio.Lock()
_terminal_effect_worker_task: asyncio.Task | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(_text(value))
    except (TypeError, ValueError):
        return default


def _list_reply(value: Any) -> list[Any] | None:
    if isinstance(value, (list, tuple)):
        return list(value)
    return None


def _task_key(task_id: str) -> str:
    return f"task:{task_id}"


def _effect_lock_key(effect_id: str) -> str:
    return f"task:terminal-effect-lock:{effect_id}"


def _deleted_effect_tombstone_key(effect_id: str) -> str:
    """Mark an intentionally deleted, already-settled task for Stream ACK."""
    return f"task:terminal-effect-deleted:{effect_id}"


def _compact_event_result(result: dict | None) -> dict:
    if not isinstance(result, dict):
        return {}
    compact: dict = {}
    for key in _RESULT_EVENT_KEYS:
        value = result.get(key)
        if value:
            compact[key] = value
    return compact


def _normalize_billing_mode(value: Any) -> str | None:
    mode = str(value or "").strip()
    return mode if mode in ALL_BILLING_MODES else None


async def _task_billing_mode(user_id: str | None) -> str:
    """Capture the billing source once so later account switches cannot alter settlement."""
    mode = _normalize_billing_mode(get_current_billing_mode())
    if mode:
        return mode
    if user_id:
        mode = _normalize_billing_mode(
            await foxapi_credentials.get_billing_mode(str(user_id))
        )
        if mode:
            return mode
    return PLATFORM_BILLING_MODE


@asynccontextmanager
async def _fallback_task_lock(task_id: str):
    """A test/development fallback when a tiny fake Redis has no Lua support.

    Production Redis must execute the scripts above.  This lock only keeps
    in-process test doubles deterministic; it is deliberately never selected
    after a real Redis ``EVAL`` error.
    """

    async with _fallback_locks_guard:
        lock = _fallback_locks.get(task_id)
        if lock is None:
            lock = asyncio.Lock()
            _fallback_locks[task_id] = lock
    await lock.acquire()
    try:
        yield
    finally:
        lock.release()
        async with _fallback_locks_guard:
            waiters = getattr(lock, "_waiters", None)
            if _fallback_locks.get(task_id) is lock and not lock.locked() and not waiters:
                _fallback_locks.pop(task_id, None)


async def _release_user_slot_for_task(task_id: str) -> None:
    """Release the per-user active-task slot once a terminal state wins."""
    try:
        data = await get(task_id)
        if not data:
            return
        user_id = data.get("_user_id")
        if not user_id:
            return
        from core.queue import release_user_slot

        await release_user_slot(str(user_id), task_id)
    except Exception:
        # Slot cleanup has a TTL backstop.  It must never obscure a durable
        # terminal state or its settlement outbox record.
        logger.debug("task slot cleanup failed task_id=%s", task_id, exc_info=True)


async def create(
    task_type: str,
    user_id: Optional[str] = None,
    model_id: Optional[str] = None,
    cost: float = 0.0,
    model_name: str = "",
    charge_on_complete: bool = True,
    task_id: Optional[str] = None,
) -> str:
    task_id = str(task_id or uuid.uuid4())
    r = get_redis()
    now_ms = _now_ms()
    billing_mode = await _task_billing_mode(user_id)
    await r.set(
        _task_key(task_id),
        _json_dump(
            {
                "status": "pending",
                "progress": 0,
                "type": task_type,
                "result": None,
                "error": None,
                "_user_id": user_id,
                "_model_id": model_id,
                "_cost": cost,
                "_model_name": model_name,
                "_charge_on_complete": charge_on_complete,
                "_billing_mode": billing_mode,
                "_start_ms": now_ms,
                "_updated_ms": now_ms,
            }
        ),
        ex=_TTL,
    )
    await _pg_insert(task_id, task_type, user_id, model_id)
    return task_id


async def get(task_id: str) -> Optional[dict]:
    r = get_redis()
    raw = await r.get(_task_key(task_id))
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (TypeError, ValueError, json.JSONDecodeError):
        logger.warning("[task_repo] invalid task state task_id=%s", task_id)
        return None


async def _active_update_fallback(task_id: str, patch: dict) -> bool:
    """In-process fallback for fakes without ``eval``; see lock comment."""
    r = get_redis()
    async with _fallback_task_lock(task_id):
        raw = await r.get(_task_key(task_id))
        if not raw:
            return False
        data = json.loads(raw)
        current = str(data.get("status") or "pending")
        requested = str(patch.get("status") or "")
        if current not in _ACTIVE_STATUSES or requested in _TERMINAL_STATUSES:
            return False
        data.update(patch)
        data["_updated_ms"] = _now_ms()
        await r.set(_task_key(task_id), _json_dump(data), ex=_TTL)
        return True


async def _update(task_id: str, patch: dict) -> bool:
    """Patch an active task without ever allowing a terminal state to regress."""
    r = get_redis()
    evaluator = getattr(r, "eval", None)
    reply: list[Any] | None = None
    if callable(evaluator):
        result = await evaluator(
            _ACTIVE_UPDATE_SCRIPT,
            1,
            _task_key(task_id),
            _json_dump(patch),
            str(_now_ms()),
            str(_TTL),
        )
        reply = _list_reply(result)

    if reply is None:
        changed = await _active_update_fallback(task_id, patch)
    else:
        changed = bool(reply and _as_int(reply[0]) == 1)

    if not changed or not ({"status", "progress", "message"} & patch.keys()):
        return changed
    data = await get(task_id)
    if not data or str(data.get("status") or "") in _TERMINAL_STATUSES:
        return changed
    user_id = data.get("_user_id")
    if user_id:
        try:
            await publish_task_progress(r, task_id, data)
        except Exception as exc:
            logger.warning("[task_repo] progress event publish failed task_id=%s error=%s", task_id, exc)
    return changed


async def set_processing(task_id: str, progress: int = 10) -> bool:
    changed = await _update(task_id, {"status": "processing", "progress": progress})
    if changed:
        await _pg_update_status(task_id, "processing")
    return changed


async def set_progress(task_id: str, progress: int) -> bool:
    return await _update(task_id, {"progress": progress})


async def set_provider_request_id(task_id: str, provider_request_id: str) -> bool:
    """Persist an upstream request ID so retries can resume polling safely."""
    request_id = str(provider_request_id or "").strip()
    if not request_id:
        return False
    return await _update(task_id, {"_provider_request_id": request_id})


async def _terminal_transition_fallback(
    task_id: str,
    *,
    status: str,
    patch: dict,
    effect_id: str,
) -> TerminalTransition:
    """Fallback used only by test doubles without Redis scripting support."""
    r = get_redis()
    async with _fallback_task_lock(task_id):
        raw = await r.get(_task_key(task_id))
        if not raw:
            return TerminalTransition(False, "missing")
        data = json.loads(raw)
        previous = str(data.get("status") or "pending")
        if previous not in _ACTIVE_STATUSES:
            return TerminalTransition(False, previous, previous)
        now_ms = _now_ms()
        data.update(patch)
        data["status"] = status
        data["_terminal_effect_id"] = effect_id
        data["_terminal_at_ms"] = now_ms
        data["_updated_ms"] = now_ms
        if status == "completed":
            data["progress"] = 100
        await r.set(_task_key(task_id), _json_dump(data), ex=_TTL)

        stream_id: str | None = None
        xadd = getattr(r, "xadd", None)
        if callable(xadd):
            stream_id = _text(
                await xadd(
                    TERMINAL_EFFECT_STREAM,
                    {"task_id": task_id, "effect_id": effect_id, "status": status},
                )
            ) or None
        return TerminalTransition(True, status, previous, effect_id, stream_id)


async def transition_terminal(
    task_id: str,
    *,
    status: Literal["completed", "failed", "cancelled"],
    patch: dict,
) -> TerminalTransition:
    """Atomically make the first terminal signal win and append its outbox item."""
    if status not in _TERMINAL_STATUSES:
        raise ValueError(f"unsupported terminal status: {status}")

    r = get_redis()
    effect_id = f"{task_id}:{uuid.uuid4().hex}"
    evaluator = getattr(r, "eval", None)
    reply: list[Any] | None = None
    if callable(evaluator):
        result = await evaluator(
            _TERMINAL_TRANSITION_SCRIPT,
            2,
            _task_key(task_id),
            TERMINAL_EFFECT_STREAM,
            status,
            _json_dump(patch),
            str(_now_ms()),
            str(_TTL),
            task_id,
            effect_id,
        )
        reply = _list_reply(result)

    if reply is None:
        return await _terminal_transition_fallback(
            task_id,
            status=status,
            patch=patch,
            effect_id=effect_id,
        )

    won = bool(reply and _as_int(reply[0]) == 1)
    previous = _text(reply[1]) if len(reply) > 1 else None
    returned_effect_id = _text(reply[2]) if won and len(reply) > 2 else None
    stream_id = _text(reply[3]) if won and len(reply) > 3 else None
    return TerminalTransition(
        won=won,
        status=status if won else previous,
        previous_status=previous,
        effect_id=returned_effect_id,
        stream_id=stream_id,
    )


def _duration_ms(data: dict) -> int | None:
    try:
        start_ms = int(data.get("_start_ms") or 0)
        end_ms = int(data.get("_terminal_at_ms") or _now_ms())
    except (TypeError, ValueError):
        return None
    return max(0, end_ms - start_ms) if start_ms else None


async def _record_terminal_status(task_id: str, data: dict) -> None:
    status = str(data.get("status") or "")
    if status not in _TERMINAL_STATUSES:
        return
    await _pg_update_status(
        task_id,
        status,
        duration_ms=_duration_ms(data) if status == "completed" else None,
    )


async def _after_terminal_transition(task_id: str, transition: TerminalTransition) -> None:
    if not transition.won or not transition.effect_id:
        return
    await _release_user_slot_for_task(task_id)
    data = await get(task_id)
    if data:
        await _record_terminal_status(task_id, data)
    try:
        # Preserve the prior fast path for normal operation.  The Stream is the
        # recovery path if this process dies before or during settlement.
        await settle_terminal_effect(task_id, transition.effect_id)
    except Exception as exc:
        logger.warning(
            "[task_repo] terminal effect deferred task_id=%s effect_id=%s error=%s",
            task_id,
            transition.effect_id,
            exc,
        )


async def set_completed(task_id: str, result: dict) -> TerminalTransition:
    transition = await transition_terminal(
        task_id,
        status="completed",
        patch={"progress": 100, "result": result, "error": None},
    )
    await _after_terminal_transition(task_id, transition)
    return transition


async def set_failed(task_id: str, error: str) -> TerminalTransition:
    display_error = to_user_error_message(error)
    transition = await transition_terminal(
        task_id,
        status="failed",
        patch={"error": display_error, "_raw_error": error},
    )
    await _after_terminal_transition(task_id, transition)
    return transition


async def cancel(task_id: str) -> TerminalTransition:
    transition = await transition_terminal(
        task_id,
        status="cancelled",
        patch={"error": "\u5df2\u53d6\u6d88", "_raw_error": "cancelled"},
    )
    await _after_terminal_transition(task_id, transition)
    return transition


async def _claim_terminal_effect(effect_id: str) -> str | None:
    r = get_redis()
    # Minimal Redis fakes used by narrow unit tests intentionally implement
    # only GET/SET/PUBLISH.  Their SET methods often return ``None`` and may
    # treat every key as task state, so do not try to store a lock there.
    # Real redis-py clients always expose XADD.
    if not callable(getattr(r, "xadd", None)):
        return f"test-{uuid.uuid4().hex}"
    token = uuid.uuid4().hex
    claimed = await r.set(
        _effect_lock_key(effect_id),
        token,
        nx=True,
        ex=_TERMINAL_EFFECT_LOCK_SECONDS,
    )
    return token if claimed else None


async def _release_terminal_effect_claim(effect_id: str, token: str) -> None:
    """Release only the lease owned by this settlement attempt.

    A slow effect can outlive its Redis lease.  In that case another consumer
    may acquire a new token; an unconditional DEL from the old consumer would
    incorrectly remove the new owner's lock and permit a third settlement.
    """
    try:
        r = get_redis()
        if not callable(getattr(r, "xadd", None)):
            return
        evaluator = getattr(r, "eval", None)
        if callable(evaluator):
            await evaluator(
                _RELEASE_TERMINAL_EFFECT_LOCK_SCRIPT,
                1,
                _effect_lock_key(effect_id),
                token,
            )
            return

        # This path is for narrow test doubles only.  Production redis-py
        # supports EVAL, which performs the compare-and-delete atomically.
        if await r.get(_effect_lock_key(effect_id)) == token:
            await r.delete(_effect_lock_key(effect_id))
    except Exception:
        logger.debug("terminal effect claim cleanup failed effect_id=%s", effect_id, exc_info=True)


async def _mark_effect_settled(task_id: str, effect_id: str) -> bool:
    r = get_redis()
    evaluator = getattr(r, "eval", None)
    reply: Any = None
    if callable(evaluator):
        reply = await evaluator(
            _MARK_EFFECT_SETTLED_SCRIPT,
            1,
            _task_key(task_id),
            effect_id,
            str(_now_ms()),
            str(_TTL),
        )
    if isinstance(reply, (int, str, bytes)):
        return _as_int(reply) in (1, 2)

    async with _fallback_task_lock(task_id):
        raw = await r.get(_task_key(task_id))
        if not raw:
            return False
        data = json.loads(raw)
        if str(data.get("_terminal_effect_id") or "") != effect_id:
            return False
        data["_terminal_effect_settled"] = True
        data["_released"] = True
        data["_terminal_settled_at_ms"] = _now_ms()
        data["_updated_ms"] = _now_ms()
        await r.set(_task_key(task_id), _json_dump(data), ex=_TTL)
        return True


async def _patch_terminal_state(task_id: str, effect_id: str, patch: dict) -> bool:
    r = get_redis()
    evaluator = getattr(r, "eval", None)
    reply: Any = None
    if callable(evaluator):
        reply = await evaluator(
            _PATCH_TERMINAL_STATE_SCRIPT,
            1,
            _task_key(task_id),
            effect_id,
            _json_dump(patch),
            str(_now_ms()),
            str(_TTL),
        )
    if isinstance(reply, (int, str, bytes)):
        return _as_int(reply) == 1

    async with _fallback_task_lock(task_id):
        raw = await r.get(_task_key(task_id))
        if not raw:
            return False
        data = json.loads(raw)
        if str(data.get("_terminal_effect_id") or "") != effect_id:
            return False
        data.update(patch)
        data["_updated_ms"] = _now_ms()
        await r.set(_task_key(task_id), _json_dump(data), ex=_TTL)
        return True


async def _settle_task_reservation(data: dict, task_id: str) -> None:
    """Settle the task reservation without making duplicate releases possible."""
    user_id = str(data.get("_user_id") or "")
    cost = float(data.get("_cost") or 0)
    if not user_id or cost <= 0:
        return

    from core import credit_reserve

    billing_mode = _normalize_billing_mode(data.get("_billing_mode"))
    if billing_mode is None:
        # Compatibility for tasks created before billing-mode snapshots were
        # introduced. New tasks always carry the immutable value above.
        billing_mode = await _task_billing_mode(user_id)

    with bind_user_context(user_id, billing_mode):
        status = str(data.get("status") or "")
        if status == "completed" and data.get("_charge_on_complete", True):
            # The ledger is idempotent by task.  If the process dies after the
            # debit but before releasing Redis reservation state, the Stream retry
            # observes the same ledger transaction and only releases the task's
            # own reservation once.
            from repositories import credit_repo
            reservation = await credit_reserve.get_task_reservation(task_id)

            await credit_repo.consume_credits(
                user_id=user_id,
                amount=cost,
                description=f"task completed - {data.get('_model_name') or ''}",
                # Redis is the source of truth for execution; the analytical
                # PostgreSQL task row is best effort and may not exist.
                related_task_id=None,
                idempotency_key=f"task-terminal:{task_id}:charge",
                funding_source=reservation.funding_source if reservation else None,
                subscription_id=reservation.subscription_id if reservation else None,
            )
        # No legacy aggregate fallback: only a task-scoped record is permitted to
        # mutate the aggregate reservation.  Missing records are harmless no-ops
        # for free/external-billing tasks and old tasks drain by their Redis TTL.
        await credit_reserve.release_task_reservation(task_id)


async def _submit_public_gallery_if_needed(data: dict, task_id: str, effect_id: str) -> None:
    if str(data.get("status") or "") != "completed":
        return
    if not data.get("_make_public") or data.get("_public_submitted"):
        return
    if not settings.PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED:
        await _patch_terminal_state(
            task_id,
            effect_id,
            {
                "_make_public": False,
                "_public_submitted": True,
                "_public_skipped": True,
                "_public_skipped_count": 0,
                "_public_rewarded_credits": 0.0,
            },
        )
        return
    user_id = str(data.get("_user_id") or "")
    if not user_id:
        return

    from repositories import public_gallery_repo

    publish_result = await public_gallery_repo.publish_generation_result(
        user_id=user_id,
        task_id=task_id,
        prompt=str(data.get("_public_prompt") or ""),
        module=str(data.get("_public_module") or "TEXT_TO_IMAGE"),
        source=str(data.get("_public_source") or ""),
        result=data.get("result") if isinstance(data.get("result"), dict) else {},
        reward_per_image=float(data.get("_public_reward_per_image") or 1.0),
    )
    await _patch_terminal_state(
        task_id,
        effect_id,
        {
            "_public_submitted": True,
            "_public_submitted_count": int(publish_result.get("submitted_count") or 0),
            "_public_skipped_count": int(publish_result.get("skipped_count") or 0),
            "_public_rewarded_credits": 0.0,
        },
    )


def _terminal_event(data: dict, task_id: str) -> tuple[str, dict, str] | None:
    user_id = str(data.get("_user_id") or "")
    if not user_id:
        return None
    status = str(data.get("status") or "")
    cost = float(data.get("_cost") or 0)
    model_name = str(data.get("_model_name") or "")
    if status == "completed":
        return (
            "_complete_event_sent",
            {
                "type": "task_complete",
                "task_id": task_id,
                "cost": 0 if data.get("_charge_on_complete", True) is False else cost,
                "reserved_cost": cost,
                "model_name": model_name,
                "result": _compact_event_result(data.get("result")),
            },
            user_id,
        )
    if status in {"failed", "cancelled"}:
        return (
            "_failed_event_sent",
            {
                "type": "task_failed",
                "task_id": task_id,
                "error": str(data.get("error") or ""),
                "model_name": model_name,
                "status": status,
            },
            user_id,
        )
    return None


async def _publish_terminal_event_once(data: dict, task_id: str, effect_id: str) -> None:
    prepared = _terminal_event(data, task_id)
    if not prepared:
        return
    marker, payload, user_id = prepared
    r = get_redis()
    evaluator = getattr(r, "eval", None)
    reply: Any = None
    if callable(evaluator):
        reply = await evaluator(
            _PUBLISH_TERMINAL_EVENT_SCRIPT,
            1,
            _task_key(task_id),
            effect_id,
            str(_now_ms()),
            str(_TTL),
            marker,
            f"user_event:{user_id}",
            _json_dump(payload),
        )
    if isinstance(reply, (int, str, bytes)):
        return

    # Fallback for unit-test Redis fakes.  The production script combines the
    # marker and PUBLISH atomically, so a network retry cannot double-send it.
    async with _fallback_task_lock(task_id):
        raw = await r.get(_task_key(task_id))
        if not raw:
            return
        current = json.loads(raw)
        if str(current.get("_terminal_effect_id") or "") != effect_id:
            return
        if current.get("_terminal_event_sent") or current.get(marker):
            return
        current["_terminal_event_sent"] = True
        current[marker] = True
        current["_updated_ms"] = _now_ms()
        await r.set(_task_key(task_id), _json_dump(current), ex=_TTL)
        await r.publish(f"user_event:{user_id}", _json_dump(payload))


async def settle_terminal_effect(task_id: str, effect_id: str) -> bool:
    """Apply one durable terminal outbox effect.

    The Stream may deliver this more than once.  Credit settlement uses
    task-scoped idempotency; task state and user notification markers are Lua
    guarded, so repeat delivery is harmless.
    """
    if not effect_id:
        return False
    claim_token = await _claim_terminal_effect(effect_id)
    if claim_token is None:
        return False
    try:
        data = await get(task_id)
        if not data or str(data.get("_terminal_effect_id") or "") != effect_id:
            return False
        if str(data.get("status") or "") not in _TERMINAL_STATUSES:
            return False

        await _record_terminal_status(task_id, data)
        if not data.get("_terminal_effect_settled"):
            await _settle_task_reservation(data, task_id)
            if not await _mark_effect_settled(task_id, effect_id):
                return False

        # Re-read because the settled marker and gallery marker are concurrent
        # auxiliary patches owned by this effect.
        data = await get(task_id)
        if not data or str(data.get("_terminal_effect_id") or "") != effect_id:
            return False
        await _submit_public_gallery_if_needed(data, task_id, effect_id)
        data = await get(task_id)
        if data:
            await _publish_terminal_event_once(data, task_id, effect_id)
        return True
    finally:
        await _release_terminal_effect_claim(effect_id, claim_token)


def _normalize_stream_entries(entries: Any) -> list[tuple[str, dict]]:
    normalized: list[tuple[str, dict]] = []
    if not entries:
        return normalized
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        message_id, fields = entry[0], entry[1]
        if not isinstance(fields, dict):
            continue
        normalized.append(
            (
                _text(message_id),
                {_text(key): _text(value) for key, value in fields.items()},
            )
        )
    return normalized


async def ensure_terminal_effect_consumer_group() -> None:
    r = get_redis()
    try:
        await r.xgroup_create(
            TERMINAL_EFFECT_STREAM,
            TERMINAL_EFFECT_GROUP,
            id="0",
            mkstream=True,
        )
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def _ack_terminal_effect(message_id: str) -> bool:
    r = get_redis()
    evaluator = getattr(r, "eval", None)
    if callable(evaluator):
        reply = await evaluator(
            _ACK_DELETE_TERMINAL_EFFECT_SCRIPT,
            1,
            TERMINAL_EFFECT_STREAM,
            TERMINAL_EFFECT_GROUP,
            message_id,
        )
        if isinstance(reply, (int, str, bytes)):
            return _as_int(reply) == 1
    acknowledged = await r.xack(TERMINAL_EFFECT_STREAM, TERMINAL_EFFECT_GROUP, message_id)
    if acknowledged:
        await r.xdel(TERMINAL_EFFECT_STREAM, message_id)
    return bool(acknowledged)


async def _process_terminal_stream_entries(entries: list[tuple[str, dict]]) -> int:
    processed = 0
    for message_id, fields in entries:
        task_id = str(fields.get("task_id") or "")
        effect_id = str(fields.get("effect_id") or "")
        if not task_id or not effect_id:
            await _ack_terminal_effect(message_id)
            continue
        try:
            settled = await settle_terminal_effect(task_id, effect_id)
        except Exception as exc:
            logger.warning(
                "[task_repo] terminal outbox retry failed task_id=%s effect_id=%s error=%s",
                task_id,
                effect_id,
                exc,
            )
            continue
        if settled:
            await _ack_terminal_effect(message_id)
            processed += 1
            continue

        # ``delete()`` leaves a short tombstone only after settlement has
        # succeeded.  This lets the consumer remove its now-unreadable outbox
        # record without ever ACKing a task that disappeared before refunding.
        if not await get(task_id):
            tombstone = await get_redis().get(_deleted_effect_tombstone_key(effect_id))
            if tombstone:
                await _ack_terminal_effect(message_id)
                processed += 1
    return processed


def _terminal_effect_consumer_name() -> str:
    return f"terminal-{socket.gethostname()}-{os.getpid()}"


async def process_terminal_effect_outbox(
    *,
    consumer_name: str | None = None,
    limit: int | None = None,
    block_ms: int = 0,
) -> int:
    """Claim abandoned effects, then process newly appended terminal effects."""
    await ensure_terminal_effect_consumer_group()
    r = get_redis()
    consumer = consumer_name or _terminal_effect_consumer_name()
    remaining = max(1, int(limit or _TERMINAL_EFFECT_BATCH_SIZE))
    processed = 0

    xautoclaim = getattr(r, "xautoclaim", None)
    if callable(xautoclaim):
        try:
            claimed = await xautoclaim(
                TERMINAL_EFFECT_STREAM,
                TERMINAL_EFFECT_GROUP,
                consumer,
                _TERMINAL_EFFECT_RECLAIM_IDLE_MS,
                "0-0",
                count=remaining,
            )
            if isinstance(claimed, (list, tuple)) and len(claimed) >= 2:
                reclaimed_entries = _normalize_stream_entries(claimed[1])
                processed += await _process_terminal_stream_entries(reclaimed_entries)
                remaining = max(0, remaining - len(reclaimed_entries))
        except Exception as exc:
            logger.warning("[task_repo] terminal outbox reclaim failed: %s", exc)

    if remaining <= 0:
        return processed
    messages = await r.xreadgroup(
        TERMINAL_EFFECT_GROUP,
        consumer,
        {TERMINAL_EFFECT_STREAM: ">"},
        count=remaining,
        block=block_ms or None,
    )
    for _stream, entries in messages or []:
        processed += await _process_terminal_stream_entries(_normalize_stream_entries(entries))
    return processed


async def run_terminal_effect_worker(stop_event: asyncio.Event | None = None) -> None:
    """Run the durable terminal-effect consumer until cancelled or signalled."""
    consumer = _terminal_effect_consumer_name()
    while stop_event is None or not stop_event.is_set():
        try:
            await process_terminal_effect_outbox(
                consumer_name=consumer,
                block_ms=_TERMINAL_EFFECT_POLL_MS,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[task_repo] terminal outbox loop failed: %s", exc)
            await asyncio.sleep(1)


async def start_terminal_effect_worker() -> asyncio.Task:
    """Start one in-process retry loop. Safe to call from app or worker setup."""
    global _terminal_effect_worker_task
    if _terminal_effect_worker_task is None or _terminal_effect_worker_task.done():
        _terminal_effect_worker_task = asyncio.create_task(
            run_terminal_effect_worker(),
            name="task-terminal-effect-worker",
        )
    return _terminal_effect_worker_task


async def stop_terminal_effect_worker() -> None:
    global _terminal_effect_worker_task
    task = _terminal_effect_worker_task
    _terminal_effect_worker_task = None
    if task is None:
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def delete(task_id: str) -> None:
    """Delete only an already settled terminal task.

    A task deleted between the terminal Lua script and settlement would lose the
    data needed to refund its reservation.  Keep it until the outbox effect is
    durable; normal success is still synchronous and deletes immediately.
    """
    data = await get(task_id)
    if not data:
        return
    status = str(data.get("status") or "")
    if status in _ACTIVE_STATUSES:
        await cancel(task_id)
        data = await get(task_id)
    if not data:
        return
    effect_id = str(data.get("_terminal_effect_id") or "")
    needs_terminal_follow_up = bool(
        not data.get("_terminal_effect_settled")
        or (data.get("_user_id") and not data.get("_terminal_event_sent"))
        or (data.get("_make_public") and not data.get("_public_submitted"))
    )
    if effect_id and needs_terminal_follow_up:
        try:
            await settle_terminal_effect(task_id, effect_id)
        except Exception as exc:
            logger.warning("[task_repo] task deletion deferred task_id=%s error=%s", task_id, exc)
            return
        data = await get(task_id)
    if not data or not data.get("_terminal_effect_settled"):
        return
    if data.get("_user_id") and not data.get("_terminal_event_sent"):
        return
    if data.get("_make_public") and not data.get("_public_submitted"):
        return
    if effect_id:
        await get_redis().set(
            _deleted_effect_tombstone_key(effect_id),
            "1",
            ex=_TTL,
        )
    await get_redis().delete(_task_key(task_id))


async def _pg_insert(
    task_id: str,
    task_type: str,
    user_id: Optional[str],
    model_id: Optional[str],
) -> None:
    """Insert a task row for analytics. Best effort only."""
    try:
        from core.pool import acquire

        async with acquire() as conn:
            if user_id:
                await conn.execute(
                    """
                    INSERT INTO tasks (id, user_id, type, status, model_id, progress)
                    VALUES ($1::uuid, $2::uuid, $3, 'pending', $4, 0)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    task_id,
                    user_id,
                    task_type,
                    model_id,
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO tasks (id, type, status, model_id, progress)
                    VALUES ($1::uuid, $2, 'pending', $3, 0)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    task_id,
                    task_type,
                    model_id,
                )
        logger.info("[task_repo] PG insert OK: task_id=%s type=%s user=%s", task_id, task_type, user_id)
    except Exception as exc:
        logger.error("[task_repo] PG insert failed: %s\n%s", exc, traceback.format_exc())


async def _pg_update_status(
    task_id: str,
    status: str,
    duration_ms: Optional[int] = None,
) -> None:
    """Persist status without allowing a losing terminal signal to overwrite it."""
    try:
        from core.pool import acquire

        async with acquire() as conn:
            if status == "completed" and duration_ms is not None:
                await conn.execute(
                    """
                    UPDATE tasks
                    SET status       = $2,
                        progress     = 100,
                        duration_ms  = $3,
                        completed_at = NOW()
                    WHERE id = $1::uuid
                      AND status IN ('pending', 'processing')
                    """,
                    task_id,
                    status,
                    duration_ms,
                )
            elif status in ("failed", "cancelled"):
                await conn.execute(
                    """
                    UPDATE tasks
                    SET status       = $2,
                        completed_at = NOW()
                    WHERE id = $1::uuid
                      AND status IN ('pending', 'processing')
                    """,
                    task_id,
                    status,
                )
            elif status == "processing":
                await conn.execute(
                    """
                    UPDATE tasks SET status = $2
                    WHERE id = $1::uuid
                      AND status IN ('pending', 'processing')
                    """,
                    task_id,
                    status,
                )
    except Exception as exc:
        logger.warning("[task_repo] PG update failed: %s", exc)
