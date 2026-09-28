"""Durable settlement of successful platform-credit model calls."""
from __future__ import annotations

import asyncio
import logging
import math
import os
import socket
from dataclasses import dataclass
from typing import Any

from core import credit_reserve
from core.config import settings
from core.redis import get_redis
from core.user_context import bind_user_context
from repositories import credit_repo
from services import foxapi_credentials


logger = logging.getLogger(__name__)

MODEL_CALL_SETTLEMENT_GROUP = "model-call-settlement-workers"
_BATCH_SIZE = max(1, int(getattr(settings, "TASK_TERMINAL_EFFECT_BATCH_SIZE", 32)))
_POLL_MS = max(100, int(getattr(settings, "TASK_TERMINAL_EFFECT_POLL_MS", 1_000)))
_RECLAIM_IDLE_MS = max(
    1_000,
    int(getattr(settings, "TASK_TERMINAL_EFFECT_RECLAIM_IDLE_MS", 30_000)),
)

_ACK_DELETE_SETTLEMENT_SCRIPT = """
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if tonumber(acknowledged) == 0 then
    return 0
end
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""


@dataclass(frozen=True)
class ModelCallSettlement:
    claim_key: str
    user_id: str
    reservation_task_id: str
    operation_id: str
    amount: float
    description: str
    related_task_id: str | None
    idempotency_key: str
    funding_source: str = "metered"
    subscription_id: str | None = None
    aggregate_key: str = ""

    @classmethod
    def from_fields(cls, fields: dict[str, str]) -> "ModelCallSettlement":
        billing_mode = str(fields.get("billing_mode") or "").strip()
        if billing_mode != foxapi_credentials.PLATFORM_BILLING_MODE:
            raise ValueError("settlement is not frozen to platform_credits")

        claim_key = str(fields.get("claim_key") or "").strip()
        user_id = str(fields.get("user_id") or "").strip()
        reservation_task_id = str(fields.get("reservation_task_id") or "").strip()
        operation_id = str(fields.get("operation_id") or "").strip()
        idempotency_key = str(fields.get("idempotency_key") or "").strip()
        funding_source = str(fields.get("funding_source") or "metered").strip()
        subscription_id = str(fields.get("subscription_id") or "").strip() or None
        try:
            amount = float(fields.get("amount") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("settlement amount is invalid") from exc
        if (
            not claim_key.startswith("credit_reserve:claim:")
            or not user_id
            or not reservation_task_id
            or not operation_id
            or not idempotency_key
            or not math.isfinite(amount)
            or amount <= 0
            or funding_source not in {"metered", "subscription"}
            or (funding_source == "subscription" and not subscription_id)
        ):
            raise ValueError("settlement payload is incomplete")
        return cls(
            claim_key=claim_key,
            user_id=user_id,
            reservation_task_id=reservation_task_id,
            operation_id=operation_id,
            amount=amount,
            description=str(fields.get("description") or ""),
            related_task_id=str(fields.get("related_task_id") or "").strip() or None,
            idempotency_key=idempotency_key,
            funding_source=funding_source,
            subscription_id=subscription_id,
            aggregate_key=str(fields.get("aggregate_key") or "").strip(),
        )

    def claim(self) -> credit_reserve.ModelCallCreditClaim:
        return credit_reserve.ModelCallCreditClaim(
            user_id=self.user_id,
            reservation_task_id=self.reservation_task_id,
            operation_id=self.operation_id,
            amount=self.amount,
            claim_key=self.claim_key,
            provider_succeeded=True,
            funding_source=self.funding_source,
            subscription_id=self.subscription_id,
            aggregate_key=self.aggregate_key,
        )


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value or "")


def _normalize_entries(entries: Any) -> list[tuple[str, dict[str, str]]]:
    normalized: list[tuple[str, dict[str, str]]] = []
    if not isinstance(entries, (list, tuple)):
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


async def ensure_model_call_settlement_consumer_group() -> None:
    try:
        await get_redis().xgroup_create(
            credit_reserve.MODEL_CALL_SETTLEMENT_STREAM,
            MODEL_CALL_SETTLEMENT_GROUP,
            id="0",
            mkstream=True,
        )
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def _ack_settlement(message_id: str) -> bool:
    redis = get_redis()
    evaluator = getattr(redis, "eval", None)
    if callable(evaluator):
        result = await evaluator(
            _ACK_DELETE_SETTLEMENT_SCRIPT,
            1,
            credit_reserve.MODEL_CALL_SETTLEMENT_STREAM,
            MODEL_CALL_SETTLEMENT_GROUP,
            message_id,
        )
        if isinstance(result, (int, str, bytes)):
            return int(result) == 1
    acknowledged = await redis.xack(
        credit_reserve.MODEL_CALL_SETTLEMENT_STREAM,
        MODEL_CALL_SETTLEMENT_GROUP,
        message_id,
    )
    if acknowledged:
        await redis.xdel(credit_reserve.MODEL_CALL_SETTLEMENT_STREAM, message_id)
    return bool(acknowledged)


async def _settle_entry(message_id: str, fields: dict[str, str]) -> bool:
    try:
        settlement = ModelCallSettlement.from_fields(fields)
    except ValueError as exc:
        # API-key calls must never be debited.  If an invalid non-platform
        # record is injected, discard it rather than repeatedly attempting to
        # turn it into a platform ledger entry.  Malformed platform entries are
        # retained for operator inspection because silently dropping one could
        # lose a legitimate charge.
        if str(fields.get("billing_mode") or "") != foxapi_credentials.PLATFORM_BILLING_MODE:
            logger.error(
                "discarding non-platform model settlement message_id=%s error=%s",
                message_id,
                exc,
            )
            return await _ack_settlement(message_id)
        logger.error(
            "invalid platform model settlement retained message_id=%s error=%s",
            message_id,
            exc,
        )
        return False

    try:
        # The mode is part of the immutable outbox payload.  Binding it here is
        # essential: a later account switch to API-key mode must not cancel the
        # debit for a call that was funded by platform credits when authorized.
        with bind_user_context(
            settlement.user_id,
            foxapi_credentials.PLATFORM_BILLING_MODE,
        ):
            await credit_repo.consume_credits(
                user_id=settlement.user_id,
                amount=settlement.amount,
                description=settlement.description,
                related_task_id=settlement.related_task_id,
                idempotency_key=settlement.idempotency_key,
                funding_source=settlement.funding_source,
                subscription_id=settlement.subscription_id,
            )
            await credit_reserve.settle_model_call_claim(settlement.claim())
    except Exception as exc:
        logger.warning(
            "platform model settlement retry deferred message_id=%s operation=%s error=%s",
            message_id,
            settlement.operation_id,
            exc,
        )
        return False
    return await _ack_settlement(message_id)


async def _process_entries(entries: list[tuple[str, dict[str, str]]]) -> int:
    processed = 0
    for message_id, fields in entries:
        try:
            if await _settle_entry(message_id, fields):
                processed += 1
        except Exception as exc:
            # An ACK transport failure leaves the item pending.  XAUTOCLAIM
            # will replay it and both the ledger debit and claim settlement are
            # idempotent.
            logger.warning(
                "platform model settlement acknowledgement deferred message_id=%s error=%s",
                message_id,
                exc,
            )
    return processed


def _consumer_name() -> str:
    return f"model-billing-{socket.gethostname()}-{os.getpid()}"


async def process_model_call_settlement_outbox(
    *,
    consumer_name: str | None = None,
    limit: int | None = None,
    block_ms: int = 0,
) -> int:
    """Reclaim abandoned settlements, then consume newly ready calls."""
    await ensure_model_call_settlement_consumer_group()
    redis = get_redis()
    consumer = consumer_name or _consumer_name()
    remaining = max(1, int(limit or _BATCH_SIZE))
    processed = 0

    xautoclaim = getattr(redis, "xautoclaim", None)
    if callable(xautoclaim):
        try:
            claimed = await xautoclaim(
                credit_reserve.MODEL_CALL_SETTLEMENT_STREAM,
                MODEL_CALL_SETTLEMENT_GROUP,
                consumer,
                _RECLAIM_IDLE_MS,
                "0-0",
                count=remaining,
            )
            if isinstance(claimed, (list, tuple)) and len(claimed) >= 2:
                reclaimed = _normalize_entries(claimed[1])
                processed += await _process_entries(reclaimed)
                remaining = max(0, remaining - len(reclaimed))
        except Exception as exc:
            logger.warning("platform model settlement reclaim failed: %s", exc)

    if remaining <= 0:
        return processed
    messages = await redis.xreadgroup(
        MODEL_CALL_SETTLEMENT_GROUP,
        consumer,
        {credit_reserve.MODEL_CALL_SETTLEMENT_STREAM: ">"},
        count=remaining,
        block=block_ms or None,
    )
    for _stream, entries in messages or []:
        processed += await _process_entries(_normalize_entries(entries))
    return processed


async def run_model_call_settlement_worker(
    stop_event: asyncio.Event | None = None,
) -> None:
    consumer = _consumer_name()
    while stop_event is None or not stop_event.is_set():
        try:
            await process_model_call_settlement_outbox(
                consumer_name=consumer,
                block_ms=_POLL_MS,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("platform model settlement worker failed: %s", exc)
            await asyncio.sleep(1)


_worker_task: asyncio.Task | None = None


async def start_model_call_settlement_worker() -> asyncio.Task:
    """Start one process-local consumer; the Redis group coordinates replicas."""
    global _worker_task
    if _worker_task is None or _worker_task.done():
        await ensure_model_call_settlement_consumer_group()
        _worker_task = asyncio.create_task(
            run_model_call_settlement_worker(),
            name="model-call-settlement-worker",
        )
    return _worker_task


async def stop_model_call_settlement_worker() -> None:
    global _worker_task
    task = _worker_task
    _worker_task = None
    if task is None:
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
