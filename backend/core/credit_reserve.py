"""
积分预留（并发安全）

问题：用户同时开 10 个标签页点生成，每个 submit 都只检查当前余额，
都能通过 → 10 个任务都进队列 → 后续成功后扣费会扣出负数。

解决：用 Redis 原子性的 INCRBY 做"预留计数"，
submit 时 balance - reserved >= cost 才允许入队并增加 reserved，
任务成功/失败后再相应释放 reserved（成功时不释放而是扣减真实余额，
然后独立减少 reserved）。

reserved 存在 Redis 的 key 为 credit_reserve:{user_id}，
用 INCRBYFLOAT / DECRBYFLOAT 保证原子性。
"""
import logging
import math
import hashlib
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from core.redis import get_redis
from core.config import settings
import repositories.credit_repo as credit_repo
import repositories.membership_wallet_repo as membership_wallet_repo
from services import foxapi_credentials

logger = logging.getLogger(__name__)

# Keep reservations for the same lifecycle as task state. A shorter TTL lets a
# long queue release funds before the task reaches its worker.
_RESERVE_TTL = max(3600, int(settings.TASK_STATE_TTL_SECONDS))

# The legacy functions below maintain only one aggregate key per user.  New
# task-backed work also keeps a small task record, so terminal handlers can
# release a reservation exactly once even when callbacks are duplicated or
# handled by separate API processes.
_TASK_RESERVATION_PREFIX = "credit_reserve:task:"
_MODEL_CALL_CLAIM_PREFIX = "credit_reserve:claim:"
MODEL_CALL_SETTLEMENT_STREAM = "billing:model-call-settlements"

# KEYS[1] = aggregate user reservation key
# KEYS[2] = task reservation hash key
# ARGV[1] = user id
# ARGV[2] = amount
# ARGV[3] = current platform balance
# ARGV[4] = TTL seconds
# ARGV[5] = funding source
# ARGV[6] = subscription id (empty for metered)
# ARGV[7] = aggregate reservation key snapshot
#
# Return values:
#   1: a new reservation was created
#   2: the same active task reservation already exists (idempotent retry)
#   0: insufficient available platform balance
#  -1: task id is already bound to a different reservation or was released
_RESERVE_FOR_TASK_LUA = """
-- credit_reserve_task_reserve_v1
local aggregate_key = KEYS[1]
local task_key = KEYS[2]
local user_id = ARGV[1]
local requested_amount = tonumber(ARGV[2])
local balance = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local funding_source = ARGV[5]
local subscription_id = ARGV[6]
local aggregate_snapshot = ARGV[7]
local epsilon = 0.000000001

if not requested_amount or requested_amount <= 0 or not balance or not ttl then
    return -1
end

local state = redis.call('HGET', task_key, 'state')
if state then
    local existing_user_id = redis.call('HGET', task_key, 'user_id')
    local existing_amount = tonumber(redis.call('HGET', task_key, 'amount'))
    local existing_source = redis.call('HGET', task_key, 'funding_source') or 'metered'
    local existing_subscription_id = redis.call('HGET', task_key, 'subscription_id') or ''
    local existing_aggregate_key = redis.call('HGET', task_key, 'aggregate_key') or aggregate_key
    if state == 'active'
        and existing_user_id == user_id
        and existing_amount
        and math.abs(existing_amount - requested_amount) <= epsilon
        and existing_source == funding_source
        and existing_subscription_id == subscription_id
        and existing_aggregate_key == aggregate_snapshot then
        redis.call('EXPIRE', aggregate_key, ttl)
        redis.call('EXPIRE', task_key, ttl)
        return 2
    end
    return -1
end

local aggregate = tonumber(redis.call('GET', aggregate_key) or '0') or 0
if aggregate + requested_amount > balance + epsilon then
    return 0
end

redis.call('SET', aggregate_key, tostring(aggregate + requested_amount), 'EX', ttl)
redis.call(
    'HSET', task_key,
    'user_id', user_id,
    'amount', tostring(requested_amount),
    'remaining', tostring(requested_amount),
    'claimed', '0',
    'settled', '0',
    'funding_source', funding_source,
    'subscription_id', subscription_id,
    'aggregate_key', aggregate_snapshot,
    'state', 'active'
)
redis.call('EXPIRE', task_key, ttl)
return 1
"""

# KEYS[1] = task reservation hash key
# KEYS[2] = aggregate user reservation key
# ARGV[1] = expected user id
# ARGV[2] = TTL seconds
#
# The task state transition and aggregate decrement happen in one script.  A
# second caller sees state=released and is a no-op.  If a stale aggregate has
# already expired or is unexpectedly smaller than this task's amount, do not
# touch it: subtracting it could release a different live task's reservation.
_RELEASE_TASK_RESERVATION_LUA = """
-- credit_reserve_task_release_v1
local task_key = KEYS[1]
local aggregate_key = KEYS[2]
local expected_user_id = ARGV[1]
local ttl = tonumber(ARGV[2])
local epsilon = 0.000000001

local state = redis.call('HGET', task_key, 'state')
if state ~= 'active' then
    return 0
end

local user_id = redis.call('HGET', task_key, 'user_id')
local amount = tonumber(redis.call('HGET', task_key, 'amount'))
local remaining = tonumber(redis.call('HGET', task_key, 'remaining') or '') or amount
local claimed = tonumber(redis.call('HGET', task_key, 'claimed') or '0') or 0
if user_id ~= expected_user_id or not amount or amount <= 0 or not remaining then
    return -1
end
if claimed > epsilon then
    return -2
end

redis.call('HSET', task_key, 'state', 'released')
redis.call('HSET', task_key, 'remaining', '0')
redis.call('EXPIRE', task_key, ttl)

local aggregate = tonumber(redis.call('GET', aggregate_key) or '0') or 0
if remaining <= epsilon or aggregate <= 0 then
    return 1
end
if aggregate + epsilon < remaining then
    return 1
end
if aggregate <= remaining + epsilon then
    redis.call('DEL', aggregate_key)
    return 1
end

redis.call('SET', aggregate_key, tostring(aggregate - remaining), 'EX', ttl)
return 1
"""

# A task reservation owns the full quoted budget in the aggregate key.  Each
# provider call claims a slice before transport starts.  Claims only change the
# task-local ``claimed`` counter; the aggregate remains held until a successful
# debit settles that slice or the terminal task handler releases what remains.
_CLAIM_MODEL_CALL_LUA = """
-- credit_reserve_model_call_claim_v1
local task_key = KEYS[1]
local claim_key = KEYS[2]
local aggregate_key = KEYS[3]
local expected_user_id = ARGV[1]
local requested_amount = tonumber(ARGV[2])
local operation_id = ARGV[3]
local ttl = tonumber(ARGV[4])
local epsilon = 0.000000001

if not requested_amount or requested_amount <= 0 or operation_id == '' or not ttl then
    return -1
end

local claim_state = redis.call('HGET', claim_key, 'state')
if claim_state then
    local claim_user_id = redis.call('HGET', claim_key, 'user_id')
    local claim_task_id = redis.call('HGET', claim_key, 'task_id')
    local claim_operation_id = redis.call('HGET', claim_key, 'operation_id')
    local claim_amount = tonumber(redis.call('HGET', claim_key, 'amount'))
    local task_id = redis.call('HGET', task_key, 'task_id') or ARGV[5]
    if claim_user_id ~= expected_user_id
        or claim_task_id ~= task_id
        or claim_operation_id ~= operation_id
        or not claim_amount
        or math.abs(claim_amount - requested_amount) > epsilon then
        return -1
    end
    if claim_state == 'active' then
        redis.call('EXPIRE', task_key, ttl)
        redis.call('EXPIRE', claim_key, ttl)
        redis.call('EXPIRE', aggregate_key, ttl)
        return 2
    end
    if claim_state == 'ready' then
        redis.call('EXPIRE', task_key, ttl)
        redis.call('EXPIRE', claim_key, ttl)
        redis.call('EXPIRE', aggregate_key, ttl)
        return 4
    end
    if claim_state == 'settled' then
        return 3
    end
    return -1
end

if redis.call('HGET', task_key, 'state') ~= 'active' then
    return -1
end
local user_id = redis.call('HGET', task_key, 'user_id')
local amount = tonumber(redis.call('HGET', task_key, 'amount'))
local remaining = tonumber(redis.call('HGET', task_key, 'remaining') or '') or amount
local claimed = tonumber(redis.call('HGET', task_key, 'claimed') or '0') or 0
local funding_source = redis.call('HGET', task_key, 'funding_source') or 'metered'
local subscription_id = redis.call('HGET', task_key, 'subscription_id') or ''
local aggregate_snapshot = redis.call('HGET', task_key, 'aggregate_key') or aggregate_key
if user_id ~= expected_user_id or not remaining or remaining - claimed + epsilon < requested_amount then
    return 0
end

redis.call('HSET', task_key, 'claimed', tostring(claimed + requested_amount))
redis.call('EXPIRE', task_key, ttl)
redis.call('EXPIRE', aggregate_key, ttl)
redis.call(
    'HSET', claim_key,
    'user_id', expected_user_id,
    'task_id', ARGV[5],
    'operation_id', operation_id,
    'amount', tostring(requested_amount),
    'funding_source', funding_source,
    'subscription_id', subscription_id,
    'aggregate_key', aggregate_snapshot,
    'state', 'active'
)
redis.call('EXPIRE', claim_key, ttl)
return 1
"""

_MARK_MODEL_CALL_READY_LUA = """
-- credit_reserve_model_call_ready_v1
local claim_key = KEYS[1]
local task_key = KEYS[2]
local aggregate_key = KEYS[3]
local expected_user_id = ARGV[1]
local expected_task_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local state = redis.call('HGET', claim_key, 'state')
if state == 'settled' then
    return 2
end
if state == 'ready' then
    redis.call('EXPIRE', claim_key, ttl)
    redis.call('EXPIRE', task_key, ttl)
    redis.call('EXPIRE', aggregate_key, ttl)
    return 2
end
if state ~= 'active' then
    return 0
end
if redis.call('HGET', claim_key, 'user_id') ~= expected_user_id
    or redis.call('HGET', claim_key, 'task_id') ~= expected_task_id then
    return -1
end
redis.call('HSET', claim_key, 'state', 'ready')
redis.call('EXPIRE', claim_key, ttl)
redis.call('EXPIRE', task_key, ttl)
redis.call('EXPIRE', aggregate_key, ttl)
return 1
"""

# Marking a provider call successful and publishing its immutable settlement
# payload must be one Redis operation.  Otherwise a process crash between the
# two writes can leave a successful platform-funded call with nothing for a
# background reconciler to debit.
_MARK_MODEL_CALL_READY_AND_ENQUEUE_LUA = """
-- credit_reserve_model_call_ready_and_enqueue_v1
local claim_key = KEYS[1]
local task_key = KEYS[2]
local aggregate_key = KEYS[3]
local settlement_stream = KEYS[4]
local expected_user_id = ARGV[1]
local expected_task_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local expected_operation_id = ARGV[4]
local expected_amount = tonumber(ARGV[5])
local description = ARGV[6]
local related_task_id = ARGV[7]
local idempotency_key = ARGV[8]
local billing_mode = ARGV[9]
local epsilon = 0.000000001

if not ttl or not expected_amount or expected_amount <= 0
    or expected_operation_id == '' or idempotency_key == ''
    or billing_mode ~= 'platform_credits' then
    return -1
end

local state = redis.call('HGET', claim_key, 'state')
if state == 'settled' then
    return 2
end
if state ~= 'active' and state ~= 'ready' then
    return 0
end

local claim_user_id = redis.call('HGET', claim_key, 'user_id')
local claim_task_id = redis.call('HGET', claim_key, 'task_id')
local claim_operation_id = redis.call('HGET', claim_key, 'operation_id')
local claim_amount = tonumber(redis.call('HGET', claim_key, 'amount'))
if claim_user_id ~= expected_user_id
    or claim_task_id ~= expected_task_id
    or claim_operation_id ~= expected_operation_id
    or not claim_amount
    or math.abs(claim_amount - expected_amount) > epsilon then
    return -1
end

local existing_message_id = redis.call('HGET', claim_key, 'settlement_message_id')
if existing_message_id and existing_message_id ~= '' then
    redis.call('EXPIRE', claim_key, ttl)
    redis.call('EXPIRE', task_key, ttl)
    redis.call('EXPIRE', aggregate_key, ttl)
    return 2
end

local funding_source = redis.call('HGET', claim_key, 'funding_source') or 'metered'
local subscription_id = redis.call('HGET', claim_key, 'subscription_id') or ''
local aggregate_snapshot = redis.call('HGET', claim_key, 'aggregate_key') or aggregate_key

-- XADD comes first.  Redis rolls the entire script back if it errors (for
-- example, if the stream key has the wrong type), so an active claim can never
-- become ready without a durable settlement entry.
local message_id = redis.call(
    'XADD', settlement_stream, '*',
    'claim_key', claim_key,
    'user_id', expected_user_id,
    'reservation_task_id', expected_task_id,
    'operation_id', expected_operation_id,
    'amount', tostring(expected_amount),
    'description', description,
    'related_task_id', related_task_id,
    'idempotency_key', idempotency_key,
    'billing_mode', billing_mode,
    'funding_source', funding_source,
    'subscription_id', subscription_id,
    'aggregate_key', aggregate_snapshot
)
redis.call(
    'HSET', claim_key,
    'state', 'ready',
    'settlement_message_id', message_id,
    'billing_mode', billing_mode
)
redis.call('EXPIRE', claim_key, ttl)
redis.call('EXPIRE', task_key, ttl)
redis.call('EXPIRE', aggregate_key, ttl)
return 1
"""

_SETTLE_MODEL_CALL_LUA = """
-- credit_reserve_model_call_settle_v1
local task_key = KEYS[1]
local claim_key = KEYS[2]
local aggregate_key = KEYS[3]
local expected_user_id = ARGV[1]
local expected_task_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local epsilon = 0.000000001

local claim_state = redis.call('HGET', claim_key, 'state')
if claim_state == 'settled' then
    return 2
end
if claim_state ~= 'active' and claim_state ~= 'ready' then
    return 0
end
local claim_user_id = redis.call('HGET', claim_key, 'user_id')
local claim_task_id = redis.call('HGET', claim_key, 'task_id')
local claim_amount = tonumber(redis.call('HGET', claim_key, 'amount'))
if claim_user_id ~= expected_user_id or claim_task_id ~= expected_task_id or not claim_amount then
    return -1
end
if redis.call('HGET', task_key, 'state') ~= 'active' then
    return -1
end
local task_user_id = redis.call('HGET', task_key, 'user_id')
local amount = tonumber(redis.call('HGET', task_key, 'amount'))
local remaining = tonumber(redis.call('HGET', task_key, 'remaining') or '') or amount
local claimed = tonumber(redis.call('HGET', task_key, 'claimed') or '0') or 0
local settled = tonumber(redis.call('HGET', task_key, 'settled') or '0') or 0
local aggregate = tonumber(redis.call('GET', aggregate_key) or '0') or 0
if task_user_id ~= expected_user_id
    or not remaining
    or claimed + epsilon < claim_amount
    or remaining + epsilon < claim_amount
    or aggregate + epsilon < claim_amount then
    return -2
end

local new_claimed = claimed - claim_amount
local new_remaining = remaining - claim_amount
if new_claimed < epsilon then new_claimed = 0 end
if new_remaining < epsilon then new_remaining = 0 end
redis.call(
    'HSET', task_key,
    'claimed', tostring(new_claimed),
    'remaining', tostring(new_remaining),
    'settled', tostring(settled + claim_amount)
)
if new_remaining == 0 and new_claimed == 0 then
    redis.call('HSET', task_key, 'state', 'settled')
end
redis.call('EXPIRE', task_key, ttl)
redis.call('HSET', claim_key, 'state', 'settled')
redis.call('EXPIRE', claim_key, ttl)

if aggregate <= claim_amount + epsilon then
    redis.call('DEL', aggregate_key)
else
    redis.call('SET', aggregate_key, tostring(aggregate - claim_amount), 'EX', ttl)
end
return 1
"""

_RELEASE_MODEL_CALL_CLAIM_LUA = """
-- credit_reserve_model_call_release_v1
local task_key = KEYS[1]
local claim_key = KEYS[2]
local expected_user_id = ARGV[1]
local expected_task_id = ARGV[2]
local ttl = tonumber(ARGV[3])
local epsilon = 0.000000001

local claim_state = redis.call('HGET', claim_key, 'state')
if not claim_state then
    return 0
end
if claim_state == 'settled' then
    return 2
end
if claim_state == 'ready' then
    return -2
end
if claim_state ~= 'active' then
    return 0
end
local claim_user_id = redis.call('HGET', claim_key, 'user_id')
local claim_task_id = redis.call('HGET', claim_key, 'task_id')
local claim_amount = tonumber(redis.call('HGET', claim_key, 'amount'))
if claim_user_id ~= expected_user_id or claim_task_id ~= expected_task_id or not claim_amount then
    return -1
end

if redis.call('HGET', task_key, 'state') == 'active' then
    local claimed = tonumber(redis.call('HGET', task_key, 'claimed') or '0') or 0
    if claimed + epsilon < claim_amount then
        return -1
    end
    local new_claimed = claimed - claim_amount
    if new_claimed < epsilon then new_claimed = 0 end
    redis.call('HSET', task_key, 'claimed', tostring(new_claimed))
    redis.call('EXPIRE', task_key, ttl)
end
redis.call('DEL', claim_key)
return 1
"""


@dataclass(frozen=True)
class TaskReservation:
    """A platform-credit reservation attached to one logical task."""

    user_id: str
    task_id: str
    amount: float
    remaining: float
    claimed: float
    settled: float
    funding_source: str = membership_wallet_repo.METERED
    subscription_id: str | None = None
    aggregate_key: str = ""


@dataclass(frozen=True)
class ModelCallCreditClaim:
    """Authorization for one in-flight platform-funded model operation."""

    user_id: str
    reservation_task_id: str
    operation_id: str
    amount: float
    claim_key: str
    owns_reservation: bool = False
    in_progress: bool = False
    provider_succeeded: bool = False
    already_settled: bool = False
    funding_source: str = membership_wallet_repo.METERED
    subscription_id: str | None = None
    aggregate_key: str = ""


class TaskReservationUnavailable(RuntimeError):
    """A task reservation could not be read or released reliably."""


def _key(user_id: str) -> str:
    return f"credit_reserve:{user_id}"


def _task_key(task_id: str) -> str:
    return f"{_TASK_RESERVATION_PREFIX}{task_id}"


def _claim_key(task_id: str, operation_id: str) -> str:
    digest = hashlib.sha256(f"{task_id}\0{operation_id}".encode("utf-8")).hexdigest()
    return f"{_MODEL_CALL_CLAIM_PREFIX}{digest}"


def _model_call_task_id(
    user_id: str,
    reservation_task_id: Optional[str],
    operation_id: Optional[str],
) -> str | None:
    normalized_task_id = _task_id_or_none(reservation_task_id)
    if normalized_task_id:
        return normalized_task_id
    normalized_operation_id = str(operation_id or "").strip()
    if not normalized_operation_id:
        return None
    digest = hashlib.sha256(
        f"{user_id}\0{normalized_operation_id}".encode("utf-8")
    ).hexdigest()
    return f"model-call-{digest[:40]}"


def _positive_amount(amount: float) -> float | None:
    """Return a finite positive amount, otherwise ``None``."""
    try:
        normalized = float(amount)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(normalized) or normalized <= 0:
        return None
    return normalized


def _nonnegative_amount(amount: object, default: float = 0.0) -> float:
    try:
        normalized = float(amount)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(normalized) or normalized < 0:
        return default
    return normalized


def _task_id_or_none(task_id: str) -> str | None:
    normalized = str(task_id or "").strip()
    return normalized or None


def _redis_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value or "")


def _script_code(value: Any) -> int:
    """Normalize Redis Lua return values across redis-py response modes."""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else 0
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


async def reserve_for_task(
    user_id: str,
    task_id: str,
    amount: float,
    *,
    model_id: Optional[str] = None,
) -> bool:
    """Reserve platform credits for one task using an idempotent Lua mutation.

    Calling this again with the same ``user_id``, ``task_id`` and ``amount``
    succeeds without increasing the aggregate reservation.  Reusing a task id
    with different reservation data is rejected so a retry can never silently
    charge more than the task's original quoted amount.

    Unlike the legacy :func:`reserve`, this intentionally fails closed when
    Redis is unavailable: without Redis there is nowhere durable to record
    the task-level release marker, so accepting the reservation would risk a
    permanent hold or a double release later.
    """
    normalized_task_id = _task_id_or_none(task_id)
    try:
        normalized_amount = float(amount)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(normalized_amount):
        return False
    if normalized_amount <= 0:
        # Free tasks and zero-priced models need no reservation record.
        return True
    if not normalized_task_id:
        logger.warning("[credit_reserve] cannot reserve credits without task_id")
        return False
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return True

    existing = await _read_task_reservation(normalized_task_id, strict=False)
    if existing is not None:
        if (
            existing.user_id == str(user_id)
            and abs(existing.amount - normalized_amount) <= 0.000000001
        ):
            try:
                redis = get_redis()
                await redis.expire(_task_key(normalized_task_id), _RESERVE_TTL)
                await redis.expire(existing.aggregate_key, _RESERVE_TTL)
            except Exception:
                return False
            return True
        return False

    try:
        wallet = await membership_wallet_repo.resolve_funding_wallet(user_id, model_id=model_id)
        balance = float(wallet.balance)
    except Exception as exc:
        logger.warning(
            "[credit_reserve] task reservation balance lookup failed: user=%s task=%s error=%s",
            user_id,
            normalized_task_id,
            exc,
        )
        return False
    if not math.isfinite(balance) or balance < 0:
        logger.warning(
            "[credit_reserve] invalid task reservation balance: user=%s task=%s balance=%r",
            user_id,
            normalized_task_id,
            balance,
        )
        return False

    try:
        r = get_redis()
        result = await r.eval(
            _RESERVE_FOR_TASK_LUA,
            2,
            wallet.aggregate_key,
            _task_key(normalized_task_id),
            str(user_id),
            repr(normalized_amount),
            repr(balance),
            str(_RESERVE_TTL),
            wallet.funding_source,
            wallet.subscription_id or "",
            wallet.aggregate_key,
        )
    except Exception as exc:
        logger.warning(
            "[credit_reserve] task reservation unavailable (fail closed): user=%s task=%s error=%s",
            user_id,
            normalized_task_id,
            exc,
        )
        return False

    status = _script_code(result)
    if status in {1, 2}:
        return True
    if status == -1:
        logger.warning(
            "[credit_reserve] conflicting task reservation: user=%s task=%s amount=%s",
            user_id,
            normalized_task_id,
            normalized_amount,
        )
    return False


def _task_reservation_from_record(
    task_id: str,
    record: object,
) -> TaskReservation | None:
    """Parse an active task reservation hash returned by Redis."""
    if not isinstance(record, dict) or not record:
        return None
    state = _redis_text(record.get("state") or record.get(b"state"))
    user_id = _redis_text(record.get("user_id") or record.get(b"user_id"))
    raw_amount = record.get("amount") if "amount" in record else record.get(b"amount")
    amount = _positive_amount(raw_amount)
    if state != "active" or not user_id or amount is None:
        return None
    raw_remaining = record.get("remaining") if "remaining" in record else record.get(b"remaining")
    raw_claimed = record.get("claimed") if "claimed" in record else record.get(b"claimed")
    raw_settled = record.get("settled") if "settled" in record else record.get(b"settled")
    funding_source = _redis_text(record.get("funding_source") or record.get(b"funding_source")) or membership_wallet_repo.METERED
    subscription_id = _redis_text(record.get("subscription_id") or record.get(b"subscription_id")) or None
    aggregate_key = _redis_text(record.get("aggregate_key") or record.get(b"aggregate_key")) or _key(user_id)
    remaining = _nonnegative_amount(raw_remaining, amount)
    claimed = _nonnegative_amount(raw_claimed)
    settled = _nonnegative_amount(raw_settled, max(0.0, amount - remaining))
    return TaskReservation(
        user_id=user_id,
        task_id=task_id,
        amount=amount,
        remaining=remaining,
        claimed=claimed,
        settled=settled,
        funding_source=funding_source,
        subscription_id=subscription_id,
        aggregate_key=aggregate_key,
    )


async def _read_task_reservation(
    task_id: str,
    *,
    strict: bool,
) -> TaskReservation | None:
    """Load a task record, optionally preserving a retryable Redis failure."""
    normalized_task_id = _task_id_or_none(task_id)
    if not normalized_task_id:
        return None
    try:
        record = await get_redis().hgetall(_task_key(normalized_task_id))
    except Exception as exc:
        if strict:
            raise TaskReservationUnavailable(
                f"task reservation lookup failed for {normalized_task_id}"
            ) from exc
        logger.warning(
            "[credit_reserve] task reservation lookup failed: task=%s error=%s",
            normalized_task_id,
            exc,
        )
        return None
    return _task_reservation_from_record(normalized_task_id, record)


async def get_task_reservation(task_id: str) -> TaskReservation | None:
    """Return the active reservation for a task without changing its state."""
    return await _read_task_reservation(task_id, strict=False)


async def release_task_reservation(task_id: str) -> float:
    """Release one task's unspent reservation and return that amount once.

    A return value of ``0.0`` means that the task had no active platform-credit
    reservation, including an already-released task, a free task, and an
    external-billing task.  The state check and aggregate decrement are in the
    same Lua script, making concurrent terminal callbacks safe.  Redis failures
    raise :class:`TaskReservationUnavailable` so a durable outbox can retry
    instead of acknowledging an unknown release result.
    """
    reservation = await _read_task_reservation(task_id, strict=True)
    if reservation is None:
        return 0.0

    try:
        result = await get_redis().eval(
            _RELEASE_TASK_RESERVATION_LUA,
            2,
            _task_key(reservation.task_id),
            reservation.aggregate_key,
            reservation.user_id,
            str(_RESERVE_TTL),
        )
    except Exception as exc:
        raise TaskReservationUnavailable(
            f"task reservation release failed for {reservation.task_id}"
        ) from exc

    status = _script_code(result)
    if status == 1:
        return reservation.remaining
    if status == 0:
        return 0.0
    if status == -2:
        raise TaskReservationUnavailable(
            f"task reservation still has active model-call claims for {reservation.task_id}"
        )
    raise TaskReservationUnavailable(
        f"task reservation release returned unexpected status {status} for {reservation.task_id}"
    )


async def claim_model_call_credits(
    user_id: str,
    amount: float,
    *,
    reservation_task_id: Optional[str] = None,
    operation_id: Optional[str] = None,
    model_id: Optional[str] = None,
) -> ModelCallCreditClaim | None:
    """Atomically authorize one platform-credit model call.

    A task-backed call claims from the task's existing quoted budget.  A
    synchronous call first creates a short-lived reservation of its own, so it
    cannot consume credits held by another queued task.  ``None`` means the
    requested amount was not safely available; no provider call may follow.
    """
    normalized_amount = _positive_amount(amount)
    if normalized_amount is None:
        return None
    supplied_operation_id = str(operation_id or "").strip()
    normalized_operation_id = supplied_operation_id or str(uuid.uuid4())
    normalized_task_id = _model_call_task_id(
        str(user_id),
        reservation_task_id,
        supplied_operation_id,
    )
    owns_reservation = normalized_task_id is None
    if normalized_task_id is None:
        normalized_task_id = f"model-call-{uuid.uuid4()}"
        owns_reservation = True
    elif not _task_id_or_none(reservation_task_id):
        owns_reservation = True
    if owns_reservation:
        if not await reserve_for_task(
            user_id,
            normalized_task_id,
            normalized_amount,
            model_id=model_id,
        ):
            return None

    reservation = await _read_task_reservation(normalized_task_id, strict=False)
    if reservation is None and reservation_task_id and model_id:
        # Older queue submissions may have skipped the reservation because the
        # user's legacy global mode pointed at the other external channel.  A
        # platform fallback must create its own reservation before charging.
        owns_reservation = True
        if not await reserve_for_task(
            user_id,
            normalized_task_id,
            normalized_amount,
            model_id=model_id,
        ):
            return None
        reservation = await _read_task_reservation(normalized_task_id, strict=False)
    if reservation is None or reservation.user_id != str(user_id):
        if owns_reservation:
            try:
                await release_task_reservation(normalized_task_id)
            except Exception:
                pass
        return None

    claim_key = _claim_key(normalized_task_id, normalized_operation_id)
    try:
        result = await get_redis().eval(
            _CLAIM_MODEL_CALL_LUA,
            3,
            _task_key(normalized_task_id),
            claim_key,
            reservation.aggregate_key,
            str(user_id),
            repr(normalized_amount),
            normalized_operation_id,
            str(_RESERVE_TTL),
            normalized_task_id,
        )
    except Exception as exc:
        if owns_reservation:
            try:
                await release_task_reservation(normalized_task_id)
            except Exception:
                pass
        logger.warning(
            "[credit_reserve] model-call claim unavailable: user=%s task=%s operation=%s error=%s",
            user_id,
            normalized_task_id,
            normalized_operation_id,
            exc,
        )
        return None

    status = _script_code(result)
    if status not in {1, 2, 3, 4}:
        if owns_reservation:
            try:
                await release_task_reservation(normalized_task_id)
            except Exception:
                pass
        return None
    return ModelCallCreditClaim(
        user_id=str(user_id),
        reservation_task_id=normalized_task_id,
        operation_id=normalized_operation_id,
        amount=normalized_amount,
        claim_key=claim_key,
        owns_reservation=owns_reservation,
        in_progress=status == 2,
        provider_succeeded=status == 4,
        already_settled=status == 3,
        funding_source=reservation.funding_source,
        subscription_id=reservation.subscription_id,
        aggregate_key=reservation.aggregate_key,
    )


async def get_model_call_claim(
    user_id: str,
    amount: float,
    *,
    reservation_task_id: Optional[str] = None,
    operation_id: Optional[str] = None,
) -> ModelCallCreditClaim | None:
    """Read a recoverable claim without allocating any additional credits."""
    normalized_amount = _positive_amount(amount)
    normalized_operation_id = str(operation_id or "").strip()
    task_id = _model_call_task_id(
        str(user_id),
        reservation_task_id,
        normalized_operation_id,
    )
    if normalized_amount is None or not normalized_operation_id or not task_id:
        return None
    claim_key = _claim_key(task_id, normalized_operation_id)
    try:
        record = await get_redis().hgetall(claim_key)
    except Exception as exc:
        raise TaskReservationUnavailable(
            f"model-call claim lookup failed for {normalized_operation_id}"
        ) from exc
    if not isinstance(record, dict) or not record:
        return None
    state = _redis_text(record.get("state") or record.get(b"state"))
    claim_user_id = _redis_text(record.get("user_id") or record.get(b"user_id"))
    claim_task_id = _redis_text(record.get("task_id") or record.get(b"task_id"))
    claim_operation_id = _redis_text(
        record.get("operation_id") or record.get(b"operation_id")
    )
    raw_claim_amount = (
        record.get("amount") if "amount" in record else record.get(b"amount")
    )
    funding_source = _redis_text(record.get("funding_source") or record.get(b"funding_source")) or membership_wallet_repo.METERED
    subscription_id = _redis_text(record.get("subscription_id") or record.get(b"subscription_id")) or None
    aggregate_key = _redis_text(record.get("aggregate_key") or record.get(b"aggregate_key")) or _key(str(user_id))
    claim_amount = _positive_amount(raw_claim_amount)
    if (
        state not in {"active", "ready", "settled"}
        or claim_user_id != str(user_id)
        or claim_task_id != task_id
        or claim_operation_id != normalized_operation_id
        or claim_amount is None
        or abs(claim_amount - normalized_amount) > 0.000000001
    ):
        raise TaskReservationUnavailable(
            f"model-call claim data conflict for {normalized_operation_id}"
        )
    return ModelCallCreditClaim(
        user_id=str(user_id),
        reservation_task_id=task_id,
        operation_id=normalized_operation_id,
        amount=normalized_amount,
        claim_key=claim_key,
        owns_reservation=not bool(_task_id_or_none(reservation_task_id)),
        in_progress=state == "active",
        provider_succeeded=state == "ready",
        already_settled=state == "settled",
        funding_source=funding_source,
        subscription_id=subscription_id,
        aggregate_key=aggregate_key,
    )


async def mark_model_call_claim_ready(
    claim: ModelCallCreditClaim,
    *,
    settlement_description: Optional[str] = None,
    related_task_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> None:
    """Persist provider success and, when supplied, its settlement outbox.

    The metadata-free path remains for compatibility with callers that only
    manipulate reservation state.  Billed provider calls always supply
    settlement metadata and therefore use the atomic ready-plus-XADD script.
    """
    if claim.already_settled:
        return
    settlement_key = str(idempotency_key or claim.operation_id).strip()
    use_settlement_outbox = settlement_description is not None
    if claim.provider_succeeded and not use_settlement_outbox:
        return
    try:
        if use_settlement_outbox:
            result = await get_redis().eval(
                _MARK_MODEL_CALL_READY_AND_ENQUEUE_LUA,
                4,
                claim.claim_key,
                _task_key(claim.reservation_task_id),
                claim.aggregate_key or _key(claim.user_id),
                MODEL_CALL_SETTLEMENT_STREAM,
                claim.user_id,
                claim.reservation_task_id,
                str(_RESERVE_TTL),
                claim.operation_id,
                repr(claim.amount),
                str(settlement_description or ""),
                str(related_task_id or ""),
                settlement_key,
                foxapi_credentials.PLATFORM_BILLING_MODE,
            )
        else:
            result = await get_redis().eval(
                _MARK_MODEL_CALL_READY_LUA,
                3,
                claim.claim_key,
                _task_key(claim.reservation_task_id),
                claim.aggregate_key or _key(claim.user_id),
                claim.user_id,
                claim.reservation_task_id,
                str(_RESERVE_TTL),
            )
    except Exception as exc:
        raise TaskReservationUnavailable(
            f"model-call claim ready marker failed for {claim.operation_id}"
        ) from exc
    status = _script_code(result)
    if status not in {1, 2}:
        raise TaskReservationUnavailable(
            f"model-call claim ready marker returned {status} for {claim.operation_id}"
        )


async def settle_model_call_claim(claim: ModelCallCreditClaim) -> None:
    """Commit a successful debit against its claim exactly once."""
    if claim.already_settled:
        return
    try:
        result = await get_redis().eval(
            _SETTLE_MODEL_CALL_LUA,
            3,
            _task_key(claim.reservation_task_id),
            claim.claim_key,
            claim.aggregate_key or _key(claim.user_id),
            claim.user_id,
            claim.reservation_task_id,
            str(_RESERVE_TTL),
        )
    except Exception as exc:
        raise TaskReservationUnavailable(
            f"model-call claim settlement failed for {claim.operation_id}"
        ) from exc
    status = _script_code(result)
    if status not in {1, 2}:
        raise TaskReservationUnavailable(
            f"model-call claim settlement returned {status} for {claim.operation_id}"
        )


async def release_model_call_claim(claim: ModelCallCreditClaim) -> None:
    """Release an unsuccessful call's claim without consuming task budget."""
    if claim.already_settled:
        return
    try:
        result = await get_redis().eval(
            _RELEASE_MODEL_CALL_CLAIM_LUA,
            2,
            _task_key(claim.reservation_task_id),
            claim.claim_key,
            claim.user_id,
            claim.reservation_task_id,
            str(_RESERVE_TTL),
        )
    except Exception as exc:
        raise TaskReservationUnavailable(
            f"model-call claim release failed for {claim.operation_id}"
        ) from exc
    status = _script_code(result)
    if status not in {0, 1, 2}:
        raise TaskReservationUnavailable(
            f"model-call claim release returned {status} for {claim.operation_id}"
        )
    if claim.owns_reservation and status != 2:
        await release_task_reservation(claim.reservation_task_id)


async def get_reserved(user_id: str) -> float:
    """查询当前预留总额。"""
    if await foxapi_credentials.uses_external_billing(user_id):
        return 0.0
    try:
        wallet = await membership_wallet_repo.resolve_funding_wallet(user_id)
        r = get_redis()
        val = await r.get(wallet.aggregate_key)
        return float(val) if val else 0.0
    except Exception:
        return 0.0


async def get_available_balance(user_id: str) -> float:
    """可用余额 = 真实余额 - 预留"""
    wallet = await membership_wallet_repo.resolve_funding_wallet(user_id)
    balance = wallet.balance
    try:
        val = await get_redis().get(wallet.aggregate_key)
        reserved = float(val) if val else 0.0
    except Exception:
        reserved = 0.0
    return balance - reserved


async def reserve(user_id: str, amount: float) -> bool:
    """
    原子预留积分：
    1. 查当前真实余额
    2. 原子性 INCRBY，得到新的 reserved 值
    3. 如果 balance < new_reserved，说明并发超量了，立即回滚并拒绝
    返回 True 表示预留成功，False 表示余额不足（含并发竞争）
    """
    if await foxapi_credentials.uses_external_billing(user_id):
        return True
    if amount <= 0:
        return True

    try:
        r = get_redis()
    except Exception as e:
        logger.error(f"[credit_reserve] Redis 不可用，降级到仅余额检查: {e}")
        # 降级：仅做非原子检查
        balance = await credit_repo.get_balance(user_id)
        return balance >= amount

    balance = await credit_repo.get_balance(user_id)
    key = _key(user_id)

    # 原子增加预留值，拿到新总预留
    new_reserved = await r.incrbyfloat(key, amount)
    await r.expire(key, _RESERVE_TTL)

    if balance < float(new_reserved):
        # 超过可用余额，回滚
        await r.incrbyfloat(key, -amount)
        return False

    return True


async def release(user_id: str, amount: float) -> None:
    """释放预留（任务结束时调用，不管成功失败）。"""
    if await foxapi_credentials.uses_external_billing(user_id):
        return
    if amount <= 0:
        return
    try:
        r = get_redis()
        val = await r.incrbyfloat(_key(user_id), -amount)
        # 预留值归零或为负时直接清空，避免浮点漂移
        if float(val) <= 0:
            await r.delete(_key(user_id))
    except Exception as e:
        logger.warning(f"[credit_reserve] 释放预留失败（不影响主流程）: {e}")


async def consume_and_release(
    user_id: str,
    amount: float,
    description: str,
    related_task_id: Optional[str] = None,
) -> dict:
    """
    任务成功时调用：真实扣费 + 释放预留。
    两步操作可能出现部分失败，按以下顺序以保证不会扣多：
    1. 先真实扣费（从 users.credits 减去）
    2. 成功后再减 reserved
    若第 1 步失败，reserved 仍在，会被后续 release 或 TTL 清理。
    """
    if await foxapi_credentials.uses_external_billing(user_id):
        return {
            "balance_after": 0.0,
            "transaction_id": None,
            "billing_mode": foxapi_credentials.BILLING_MODE,
        }
    if amount <= 0:
        return {"balance_after": await credit_repo.get_balance(user_id), "transaction_id": None}

    result = await credit_repo.consume_credits(
        user_id=user_id,
        amount=amount,
        description=description,
        related_task_id=related_task_id,
    )
    await release(user_id, amount)
    return result
