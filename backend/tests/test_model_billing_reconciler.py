from __future__ import annotations

import asyncio
from collections import OrderedDict
from unittest.mock import AsyncMock

import pytest

from core import credit_reserve
from core.user_context import get_current_billing_mode
from services import model_billing
from services import model_billing_reconciler as reconciler


def _claim(*, provider_succeeded: bool = False) -> credit_reserve.ModelCallCreditClaim:
    return credit_reserve.ModelCallCreditClaim(
        user_id="user-1",
        reservation_task_id="task-1",
        operation_id="operation-1",
        amount=3.0,
        claim_key="credit_reserve:claim:claim-1",
        provider_succeeded=provider_succeeded,
    )


class _StreamRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {
            _claim().claim_key: {
                "user_id": "user-1",
                "task_id": "task-1",
                "operation_id": "operation-1",
                "amount": "3.0",
                "state": "active",
            }
        }
        self.entries: OrderedDict[str, dict[str, str]] = OrderedDict()
        self.pending: dict[str, str] = {}
        self.group_created = False
        self.sequence = 0
        self.fail_ack_once = False
        self.xautoclaim_calls = 0
        self._lock = asyncio.Lock()

    def add_entry(self, fields: dict[str, str]) -> str:
        self.sequence += 1
        message_id = f"{self.sequence}-0"
        self.entries[message_id] = dict(fields)
        return message_id

    async def eval(self, script: str, key_count: int, *args: str):
        async with self._lock:
            if script == credit_reserve._MARK_MODEL_CALL_READY_AND_ENQUEUE_LUA:
                (
                    claim_key,
                    _task_key,
                    _aggregate_key,
                    stream_key,
                    user_id,
                    task_id,
                    _ttl,
                    operation_id,
                    raw_amount,
                    description,
                    related_task_id,
                    idempotency_key,
                    billing_mode,
                ) = args
                assert key_count == 4
                assert stream_key == credit_reserve.MODEL_CALL_SETTLEMENT_STREAM
                claim = self.hashes.get(claim_key, {})
                if claim.get("state") == "settled":
                    return 2
                if (
                    claim.get("state") not in {"active", "ready"}
                    or claim.get("user_id") != user_id
                    or claim.get("task_id") != task_id
                    or claim.get("operation_id") != operation_id
                    or float(claim.get("amount", 0)) != float(raw_amount)
                    or billing_mode != "platform_credits"
                ):
                    return -1
                if claim.get("settlement_message_id"):
                    return 2
                message_id = self.add_entry({
                    "claim_key": claim_key,
                    "user_id": user_id,
                    "reservation_task_id": task_id,
                    "operation_id": operation_id,
                    "amount": raw_amount,
                    "description": description,
                    "related_task_id": related_task_id,
                    "idempotency_key": idempotency_key,
                    "billing_mode": billing_mode,
                })
                claim["state"] = "ready"
                claim["settlement_message_id"] = message_id
                claim["billing_mode"] = billing_mode
                return 1

            if script == reconciler._ACK_DELETE_SETTLEMENT_SCRIPT:
                _stream, _group, message_id = args
                assert key_count == 1
                if self.fail_ack_once:
                    self.fail_ack_once = False
                    raise RuntimeError("connection lost before ACK response")
                if message_id not in self.pending:
                    return 0
                self.pending.pop(message_id, None)
                self.entries.pop(message_id, None)
                return 1
        raise AssertionError(f"unexpected script {script[:60]!r}")

    async def xgroup_create(self, *_args, **_kwargs):
        if self.group_created:
            raise RuntimeError("BUSYGROUP Consumer Group name already exists")
        self.group_created = True
        return True

    async def xreadgroup(self, _group, consumer, streams, *, count, block=None):
        assert streams == {credit_reserve.MODEL_CALL_SETTLEMENT_STREAM: ">"}
        available = [
            (message_id, fields)
            for message_id, fields in self.entries.items()
            if message_id not in self.pending
        ][:count]
        for message_id, _fields in available:
            self.pending[message_id] = consumer
        if not available:
            return []
        return [(credit_reserve.MODEL_CALL_SETTLEMENT_STREAM, available)]

    async def xautoclaim(
        self,
        _stream,
        _group,
        consumer,
        _min_idle,
        _start,
        *,
        count,
    ):
        self.xautoclaim_calls += 1
        claimed = [
            (message_id, self.entries[message_id])
            for message_id in list(self.pending)
            if message_id in self.entries
        ][:count]
        for message_id, _fields in claimed:
            self.pending[message_id] = consumer
        return ("0-0", claimed, [])


async def _enqueue_ready(monkeypatch, redis: _StreamRedis, *, ready_claim=None) -> None:
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)
    await credit_reserve.mark_model_call_claim_ready(
        ready_claim or _claim(),
        settlement_description="vision analysis",
        related_task_id=None,
        idempotency_key="operation-1",
    )


@pytest.mark.asyncio
async def test_mark_ready_atomically_enqueues_one_platform_settlement(monkeypatch):
    redis = _StreamRedis()
    await _enqueue_ready(monkeypatch, redis)
    await _enqueue_ready(monkeypatch, redis)

    assert len(redis.entries) == 1
    fields = next(iter(redis.entries.values()))
    assert fields["billing_mode"] == "platform_credits"
    assert fields["amount"] == "3.0"
    assert fields["idempotency_key"] == "operation-1"
    assert redis.hashes[_claim().claim_key]["state"] == "ready"


@pytest.mark.asyncio
async def test_legacy_ready_claim_is_upgraded_to_settlement_outbox(monkeypatch):
    redis = _StreamRedis()
    redis.hashes[_claim().claim_key]["state"] = "ready"

    await _enqueue_ready(monkeypatch, redis, ready_claim=_claim(provider_succeeded=True))

    assert len(redis.entries) == 1
    assert redis.hashes[_claim().claim_key]["settlement_message_id"] == "1-0"


@pytest.mark.asyncio
async def test_ready_entry_is_debited_settled_and_removed(monkeypatch):
    redis = _StreamRedis()
    await _enqueue_ready(monkeypatch, redis)
    monkeypatch.setattr(reconciler, "get_redis", lambda: redis)
    debit = AsyncMock(return_value={"transaction_id": "tx-1"})
    settle = AsyncMock()
    monkeypatch.setattr(reconciler.credit_repo, "consume_credits", debit)
    monkeypatch.setattr(reconciler.credit_reserve, "settle_model_call_claim", settle)

    processed = await reconciler.process_model_call_settlement_outbox(
        consumer_name="consumer-a",
    )

    assert processed == 1
    debit.assert_awaited_once()
    settle.assert_awaited_once()
    assert not redis.entries
    assert not redis.pending


@pytest.mark.asyncio
async def test_db_debit_then_redis_failure_reclaims_without_second_logical_debit(monkeypatch):
    redis = _StreamRedis()
    await _enqueue_ready(monkeypatch, redis)
    monkeypatch.setattr(reconciler, "get_redis", lambda: redis)
    transactions: dict[str, dict] = {}
    debit_keys: list[str] = []

    async def debit(**kwargs):
        key = kwargs["idempotency_key"]
        debit_keys.append(key)
        return transactions.setdefault(key, {"transaction_id": "tx-1"})

    settle = AsyncMock(side_effect=[RuntimeError("redis unavailable"), None])
    monkeypatch.setattr(reconciler.credit_repo, "consume_credits", debit)
    monkeypatch.setattr(reconciler.credit_reserve, "settle_model_call_claim", settle)

    assert await reconciler.process_model_call_settlement_outbox(consumer_name="first") == 0
    assert len(redis.pending) == 1
    assert await reconciler.process_model_call_settlement_outbox(consumer_name="second") == 1

    assert debit_keys == ["operation-1", "operation-1"]
    assert len(transactions) == 1
    assert settle.await_count == 2
    assert redis.xautoclaim_calls >= 2
    assert not redis.entries


@pytest.mark.asyncio
async def test_settlement_then_ack_failure_replays_idempotently(monkeypatch):
    redis = _StreamRedis()
    await _enqueue_ready(monkeypatch, redis)
    redis.fail_ack_once = True
    monkeypatch.setattr(reconciler, "get_redis", lambda: redis)
    transactions: dict[str, dict] = {}

    async def debit(**kwargs):
        key = kwargs["idempotency_key"]
        return transactions.setdefault(key, {"transaction_id": "tx-1"})

    settle = AsyncMock()
    monkeypatch.setattr(reconciler.credit_repo, "consume_credits", debit)
    monkeypatch.setattr(reconciler.credit_reserve, "settle_model_call_claim", settle)

    assert await reconciler.process_model_call_settlement_outbox(consumer_name="first") == 0
    assert len(redis.pending) == 1
    assert await reconciler.process_model_call_settlement_outbox(consumer_name="second") == 1

    assert len(transactions) == 1
    assert settle.await_count == 2
    assert not redis.entries


@pytest.mark.asyncio
async def test_reconciler_freezes_platform_mode_even_after_account_switch(monkeypatch):
    redis = _StreamRedis()
    await _enqueue_ready(monkeypatch, redis)
    monkeypatch.setattr(reconciler, "get_redis", lambda: redis)

    async def debit(**_kwargs):
        assert get_current_billing_mode() == "platform_credits"
        return {"transaction_id": "tx-1"}

    monkeypatch.setattr(reconciler.credit_repo, "consume_credits", debit)
    monkeypatch.setattr(
        reconciler.credit_reserve,
        "settle_model_call_claim",
        AsyncMock(),
    )

    assert await reconciler.process_model_call_settlement_outbox() == 1


@pytest.mark.asyncio
async def test_external_api_key_call_never_creates_claim_or_outbox(monkeypatch):
    redis = _StreamRedis()
    redis.hashes.clear()
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)
    invoke = AsyncMock(return_value="external-result")

    result = await model_billing.execute_billed_model_call(
        user_id="user-1",
        model_id="external-model",
        expected_category="generate",
        description="external image",
        invoke=invoke,
        idempotency_key="external-operation",
    )

    assert result == "external-result"
    invoke.assert_awaited_once()
    assert not redis.hashes
    assert not redis.entries


@pytest.mark.asyncio
async def test_charge_uses_authorized_claim_amount_after_catalog_price_changes(monkeypatch):
    claim = _claim()
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    catalog = AsyncMock(side_effect=AssertionError("catalog must not be read after provider success"))
    monkeypatch.setattr(model_billing.model_repo, "get_model", catalog)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(return_value=None),
    )
    debit = AsyncMock(return_value={"transaction_id": "tx-1"})
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", debit)
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "mark_model_call_claim_ready",
        AsyncMock(),
    )
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "settle_model_call_claim",
        AsyncMock(),
    )

    charged = await model_billing.charge_model_call(
        user_id="user-1",
        model_id="vision-model-now-priced-at-9",
        expected_category="vision",
        description="authorized at three credits",
        idempotency_key="operation-1",
        reservation_task_id="task-1",
        credit_claim=claim,
    )

    assert charged == 3.0
    assert debit.await_args.kwargs["amount"] == 3.0
    catalog.assert_not_awaited()
