import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from core import credit_reserve
from services import model_billing


def _platform_model():
    return {
        "id": "vision-model",
        "category": "vision",
        "enabled": True,
        "price_type": "credits",
        "price_credits": 3,
    }


def test_subscription_models_do_not_consume_platform_credits():
    assert model_billing.model_price({
        **_platform_model(),
        "price_type": "subscription",
        "price_credits": 99,
    }) == 0


def _use_platform_credits(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        model_billing.model_repo,
        "get_model",
        AsyncMock(return_value=_platform_model()),
    )
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_balance",
        AsyncMock(return_value=20),
    )
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "get_available_balance",
        AsyncMock(return_value=20),
    )
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(return_value=None),
    )
    consume = AsyncMock(return_value={"balance_after": 17, "transaction_id": "tx-1"})
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "claim_model_call_credits",
        AsyncMock(
            side_effect=lambda user_id, amount, **kwargs: credit_reserve.ModelCallCreditClaim(
                user_id=user_id,
                reservation_task_id=str(kwargs.get("reservation_task_id") or "sync-lease"),
                operation_id=str(kwargs.get("operation_id") or "operation"),
                amount=amount,
                claim_key="claim-key",
            )
        ),
    )
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "get_model_call_claim",
        AsyncMock(return_value=None),
    )
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
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "release_model_call_claim",
        AsyncMock(),
    )
    return consume


@pytest.mark.asyncio
async def test_execute_billed_model_call_charges_once_after_success(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    invoke = AsyncMock(return_value="model-result")

    result = await model_billing.execute_billed_model_call(
        user_id="user-1",
        model_id="vision-model",
        expected_category="vision",
        description="visual review",
        invoke=invoke,
        related_task_id="00000000-0000-0000-0000-000000000111",
        idempotency_key="task-1:visual-review:1",
    )

    assert result == "model-result"
    invoke.assert_awaited_once_with()
    consume.assert_awaited_once()
    assert consume.await_args.kwargs["amount"] == 3
    assert consume.await_args.kwargs["idempotency_key"] == "task-1:visual-review:1"


@pytest.mark.asyncio
async def test_zero_cost_multiplier_does_not_debit_credits(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    invoke = AsyncMock(return_value="promotional-result")

    result = await model_billing.execute_billed_model_call(
        user_id="user-1",
        model_id="vision-model",
        expected_category="vision",
        description="promotional visual review",
        invoke=invoke,
        cost_multiplier=0,
        idempotency_key="promotion:visual-review:1",
    )

    assert result == "promotional-result"
    invoke.assert_awaited_once_with()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_billed_model_call_does_not_charge_a_failed_model(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    invoke = AsyncMock(side_effect=RuntimeError("upstream failed"))

    with pytest.raises(RuntimeError, match="upstream failed"):
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=invoke,
            idempotency_key="task-1:visual-review:1",
        )

    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_billed_model_call_passes_the_same_operation_key_on_retry(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    operation_key = "task-1:visual-review:1"

    for result in ("first", "replayed"):
        assert await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=AsyncMock(return_value=result),
            idempotency_key=operation_key,
        ) == result

    assert [call.kwargs["idempotency_key"] for call in consume.await_args_list] == [
        operation_key,
        operation_key,
    ]


@pytest.mark.asyncio
async def test_execute_billed_model_call_does_not_reinvoke_an_already_settled_operation(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(
            return_value={
                "transaction_id": "tx-existing",
                "amount": -3,
                "balance_after": 0,
                "description": "visual review",
            }
        ),
        raising=False,
    )
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_balance",
        AsyncMock(return_value=0),
    )
    invoke = AsyncMock(return_value="replayed-result")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=invoke,
            idempotency_key="task-1:visual-review:1",
        )

    assert exc_info.value.status_code == 409
    invoke.assert_not_awaited()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_billed_model_call_rejects_same_price_idempotency_collision(monkeypatch):
    _use_platform_credits(monkeypatch)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(
            return_value={
                "transaction_id": "tx-existing",
                "amount": -3,
                "balance_after": 0,
                "description": "a different model operation",
            }
        ),
    )
    invoke = AsyncMock(return_value="must-not-run")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=invoke,
            idempotency_key="task-1:visual-review:1",
        )

    assert exc_info.value.status_code == 409
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_charge_rejects_a_claim_bound_to_another_operation(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    claim = credit_reserve.ModelCallCreditClaim(
        user_id="user-1",
        reservation_task_id="task-1",
        operation_id="operation-a",
        amount=3,
        claim_key="claim-a",
    )

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.charge_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            related_task_id=None,
            reservation_task_id="task-1",
            idempotency_key="operation-b",
            credit_claim=claim,
        )

    assert exc_info.value.status_code == 409
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_reserved_task_requires_a_stable_operation_key_before_provider(monkeypatch):
    _use_platform_credits(monkeypatch)
    invoke = AsyncMock(return_value="must-not-run")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="task visual review",
            reservation_task_id="task-1",
            invoke=invoke,
        )

    assert exc_info.value.status_code == 503
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_billed_model_call_exposes_ledger_failure_after_model_success(monkeypatch):
    consume = _use_platform_credits(monkeypatch)
    consume.side_effect = RuntimeError("database unavailable")
    invoke = AsyncMock(return_value="model-result")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=invoke,
            idempotency_key="task-1:visual-review:1",
        )

    assert exc_info.value.status_code == 503
    invoke.assert_awaited_once_with()
    consume.assert_awaited_once()


@pytest.mark.asyncio
async def test_execute_billed_model_call_exposes_precheck_failure_before_transport(monkeypatch):
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        model_billing.model_repo,
        "get_model",
        AsyncMock(side_effect=RuntimeError("catalog unavailable")),
    )
    invoke = AsyncMock(return_value="must-not-run")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="visual review",
            invoke=invoke,
        )

    assert exc_info.value.status_code == 503
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_billed_model_call_never_touches_credit_ledger_for_external_api_key(monkeypatch):
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    get_model = AsyncMock(side_effect=AssertionError("model catalog must not be read"))
    monkeypatch.setattr(
        model_billing.model_repo,
        "get_model",
        get_model,
    )
    get_balance = AsyncMock(side_effect=AssertionError("credit balance must not be read"))
    get_existing = AsyncMock(side_effect=AssertionError("credit ledger must not be read"))
    consume = AsyncMock(side_effect=AssertionError("credits must not be consumed"))
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        get_existing,
    )
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)

    result = await model_billing.execute_billed_model_call(
        user_id="user-1",
        model_id="vision-model",
        expected_category="vision",
        description="visual review",
        invoke=AsyncMock(return_value="external-result"),
        idempotency_key="external:visual-review:1",
    )

    assert result == "external-result"
    get_model.assert_not_awaited()
    get_balance.assert_not_awaited()
    get_existing.assert_not_awaited()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_operation_key_is_rejected_before_a_second_provider_call(monkeypatch):
    redis = _ReservationRedis()
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(model_billing.model_repo, "get_model", AsyncMock(return_value=_platform_model()))
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", AsyncMock(return_value=3))
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", AsyncMock(return_value=3))
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    first = await model_billing.authorize_model_call(
        user_id="user-1",
        model_id="vision-model",
        expected_category="vision",
        description="one logical call",
        idempotency_key="operation-active",
    )
    assert first.claim is not None

    invoke = AsyncMock(return_value="must-not-run")
    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="one logical call",
            idempotency_key="operation-active",
            invoke=invoke,
        )

    assert exc_info.value.status_code == 409
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_retry_reconciles_db_debit_after_redis_settle_failure_without_reinvoking(monkeypatch):
    redis = _ReservationRedis()
    redis.fail_settle_once = True
    current_balance = 3.0
    transaction = None

    async def get_balance(_user_id: str) -> float:
        return current_balance

    async def get_existing(_user_id: str, _operation_id: str):
        return transaction

    async def consume_credits(*, amount: float, description: str, **_kwargs):
        nonlocal current_balance, transaction
        if transaction is None:
            current_balance -= amount
            transaction = {
                "amount": -amount,
                "description": description,
                "balance_after": current_balance,
                "transaction_id": "tx-recovery",
            }
        return transaction

    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(model_billing.model_repo, "get_model", AsyncMock(return_value=_platform_model()))
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(model_billing.credit_repo, "get_consumption_by_idempotency_key", get_existing)
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume_credits)
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    first_invoke = AsyncMock(return_value="provider-result")
    with pytest.raises(HTTPException) as first_error:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="recover settlement",
            idempotency_key="operation-recovery",
            invoke=first_invoke,
        )
    assert first_error.value.status_code == 503
    first_invoke.assert_awaited_once()
    assert current_balance == 0

    retry_invoke = AsyncMock(return_value="must-not-run")
    with pytest.raises(HTTPException) as retry_error:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="recover settlement",
            idempotency_key="operation-recovery",
            invoke=retry_invoke,
        )
    assert retry_error.value.status_code == 409
    retry_invoke.assert_not_awaited()
    assert "credit_reserve:user-1" not in redis.values


@pytest.mark.asyncio
async def test_sync_call_cannot_spend_credits_reserved_by_another_task(monkeypatch):
    """A DB balance is not available when an active task already holds it."""
    redis = _ReservationRedis()
    balance = AsyncMock(return_value=8)
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(model_billing.model_repo, "get_model", AsyncMock(return_value=_platform_model()))
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", balance)
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", balance)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(return_value=None),
    )
    consume = AsyncMock(return_value={"balance_after": 5, "transaction_id": "tx-sync"})
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    assert await credit_reserve.reserve_for_task("user-1", "reserved-task", 8)
    invoke = AsyncMock(return_value="must-not-run")

    with pytest.raises(HTTPException) as exc_info:
        await model_billing.execute_billed_model_call(
            user_id="user-1",
            model_id="vision-model",
            expected_category="vision",
            description="unreserved synchronous call",
            invoke=invoke,
            idempotency_key="sync-call-1",
        )

    assert exc_info.value.status_code == 402
    invoke.assert_not_awaited()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_reserved_task_can_settle_four_parallel_calls_from_its_own_budget(monkeypatch):
    """Four 2-credit candidates can consume one 8-credit task reservation."""
    redis = _ReservationRedis()
    current_balance = 8.0
    ledger_lock = asyncio.Lock()
    transactions: dict[str, dict] = {}

    async def get_balance(_user_id: str) -> float:
        return current_balance

    async def get_existing(_user_id: str, operation_key: str):
        return transactions.get(operation_key)

    async def consume_credits(*, amount: float, description: str, idempotency_key: str, **_kwargs):
        nonlocal current_balance
        async with ledger_lock:
            existing = transactions.get(idempotency_key)
            if existing:
                return existing
            if current_balance < amount:
                raise ValueError("insufficient after provider success")
            current_balance -= amount
            result = {
                "balance_after": current_balance,
                "transaction_id": f"tx-{len(transactions) + 1}",
                "amount": -amount,
                "description": description,
            }
            transactions[idempotency_key] = result
            return result

    model = {**_platform_model(), "price_credits": 2}
    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(model_billing.model_repo, "get_model", AsyncMock(return_value=model))
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(model_billing.credit_repo, "get_consumption_by_idempotency_key", get_existing)
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume_credits)
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    assert await credit_reserve.reserve_for_task("user-1", "icon-task", 8)

    results = await asyncio.gather(
        *(
            model_billing.execute_billed_model_call(
                user_id="user-1",
                model_id="vision-model",
                expected_category="vision",
                description=f"icon candidate {index}",
                invoke=AsyncMock(return_value=f"candidate-{index}"),
                related_task_id="icon-task",
                reservation_task_id="icon-task",
                idempotency_key=f"icon-task:candidate:{index}",
            )
            for index in range(1, 5)
        )
    )

    assert results == ["candidate-1", "candidate-2", "candidate-3", "candidate-4"]
    assert current_balance == 0
    assert len(transactions) == 4


class _ReservationRedis:
    """Minimal Redis/Lua model used by the cross-layer billing regressions."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self._lock = asyncio.Lock()
        self.fail_settle_once = False

    async def get(self, key: str):
        return self.values.get(key)

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    async def eval(self, script: str, key_count: int, *args: str):
        async with self._lock:
            if script == credit_reserve._RESERVE_FOR_TASK_LUA:
                aggregate_key, task_key, user_id, raw_amount, raw_balance, _ttl = args
                amount = float(raw_amount)
                balance = float(raw_balance)
                existing = self.hashes.get(task_key)
                if existing:
                    return 2 if (
                        existing.get("user_id") == user_id
                        and float(existing.get("amount", 0)) == amount
                        and existing.get("state") == "active"
                    ) else -1
                aggregate = float(self.values.get(aggregate_key, "0"))
                if aggregate + amount > balance:
                    return 0
                self.values[aggregate_key] = str(aggregate + amount)
                self.hashes[task_key] = {
                    "user_id": user_id,
                    "amount": str(amount),
                    "remaining": str(amount),
                    "claimed": "0",
                    "settled": "0",
                    "state": "active",
                }
                return 1
            if script == credit_reserve._CLAIM_MODEL_CALL_LUA:
                (
                    task_key,
                    claim_key,
                    _aggregate_key,
                    user_id,
                    raw_amount,
                    operation_id,
                    _ttl,
                    task_id,
                ) = args
                amount = float(raw_amount)
                existing = self.hashes.get(claim_key)
                if existing:
                    if (
                        existing.get("user_id") != user_id
                        or existing.get("task_id") != task_id
                        or existing.get("operation_id") != operation_id
                        or float(existing.get("amount", 0)) != amount
                    ):
                        return -1
                    if existing.get("state") == "active":
                        return 2
                    if existing.get("state") == "ready":
                        return 4
                    return 3
                task = self.hashes.get(task_key, {})
                if task.get("state") != "active" or task.get("user_id") != user_id:
                    return -1
                remaining = float(task.get("remaining", task.get("amount", 0)))
                claimed = float(task.get("claimed", 0))
                if remaining - claimed < amount:
                    return 0
                task["claimed"] = str(claimed + amount)
                self.hashes[claim_key] = {
                    "user_id": user_id,
                    "task_id": task_id,
                    "operation_id": operation_id,
                    "amount": str(amount),
                    "state": "active",
                }
                return 1
            if script == credit_reserve._MARK_MODEL_CALL_READY_LUA:
                claim_key, _task_key, _aggregate_key, user_id, task_id, _ttl = args
                claim = self.hashes.get(claim_key, {})
                if claim.get("state") in {"ready", "settled"}:
                    return 2
                if (
                    claim.get("state") != "active"
                    or claim.get("user_id") != user_id
                    or claim.get("task_id") != task_id
                ):
                    return -1
                claim["state"] = "ready"
                return 1
            if script == credit_reserve._MARK_MODEL_CALL_READY_AND_ENQUEUE_LUA:
                (
                    claim_key,
                    _task_key,
                    _aggregate_key,
                    _stream_key,
                    user_id,
                    task_id,
                    _ttl,
                    operation_id,
                    raw_amount,
                    _description,
                    _related_task_id,
                    idempotency_key,
                    billing_mode,
                ) = args
                claim = self.hashes.get(claim_key, {})
                if claim.get("state") == "settled":
                    return 2
                if (
                    claim.get("state") not in {"active", "ready"}
                    or claim.get("user_id") != user_id
                    or claim.get("task_id") != task_id
                    or claim.get("operation_id") != operation_id
                    or float(claim.get("amount", 0)) != float(raw_amount)
                    or not idempotency_key
                    or billing_mode != "platform_credits"
                ):
                    return -1
                if claim.get("settlement_message_id"):
                    return 2
                claim["state"] = "ready"
                claim["settlement_message_id"] = "1-0"
                claim["billing_mode"] = billing_mode
                return 1
            if script == credit_reserve._SETTLE_MODEL_CALL_LUA:
                if self.fail_settle_once:
                    self.fail_settle_once = False
                    raise RuntimeError("redis settlement unavailable")
                task_key, claim_key, aggregate_key, user_id, task_id, _ttl = args
                claim = self.hashes.get(claim_key, {})
                if claim.get("state") == "settled":
                    return 2
                if (
                    claim.get("state") not in {"active", "ready"}
                    or claim.get("user_id") != user_id
                    or claim.get("task_id") != task_id
                ):
                    return -1
                task = self.hashes.get(task_key, {})
                amount = float(claim["amount"])
                remaining = float(task.get("remaining", task.get("amount", 0)))
                claimed = float(task.get("claimed", 0))
                aggregate = float(self.values.get(aggregate_key, "0"))
                if min(remaining, claimed, aggregate) < amount:
                    return -2
                task["claimed"] = str(claimed - amount)
                task["remaining"] = str(remaining - amount)
                task["settled"] = str(float(task.get("settled", 0)) + amount)
                if float(task["remaining"]) == 0 and float(task["claimed"]) == 0:
                    task["state"] = "settled"
                claim["state"] = "settled"
                if aggregate == amount:
                    self.values.pop(aggregate_key, None)
                else:
                    self.values[aggregate_key] = str(aggregate - amount)
                return 1
            if script == credit_reserve._RELEASE_MODEL_CALL_CLAIM_LUA:
                task_key, claim_key, user_id, task_id, _ttl = args
                claim = self.hashes.get(claim_key, {})
                if not claim:
                    return 0
                if claim.get("state") == "settled":
                    return 2
                if claim.get("state") == "ready":
                    return -2
                if claim.get("user_id") != user_id or claim.get("task_id") != task_id:
                    return -1
                task = self.hashes.get(task_key, {})
                task["claimed"] = str(float(task.get("claimed", 0)) - float(claim["amount"]))
                self.hashes.pop(claim_key, None)
                return 1
            if script == credit_reserve._RELEASE_TASK_RESERVATION_LUA:
                task_key, aggregate_key, user_id, _ttl = args
                task = self.hashes.get(task_key, {})
                if task.get("state") != "active":
                    return 0
                if task.get("user_id") != user_id:
                    return -1
                if float(task.get("claimed", 0)) > 0:
                    return -2
                remaining = float(task.get("remaining", task.get("amount", 0)))
                aggregate = float(self.values.get(aggregate_key, "0"))
                task["state"] = "released"
                task["remaining"] = "0"
                if aggregate <= remaining:
                    self.values.pop(aggregate_key, None)
                else:
                    self.values[aggregate_key] = str(aggregate - remaining)
                return 1
        raise AssertionError(f"unexpected Lua script: {script[:48]!r} / {key_count}")


@pytest.mark.asyncio
async def test_task_claims_never_exceed_quote_and_terminal_releases_only_unspent(monkeypatch):
    redis = _ReservationRedis()
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", AsyncMock(return_value=8))
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    assert await credit_reserve.reserve_for_task("user-1", "budget-task", 8)
    claims = [
        await credit_reserve.claim_model_call_credits(
            "user-1",
            2,
            reservation_task_id="budget-task",
            operation_id=f"candidate-{index}",
        )
        for index in range(1, 5)
    ]
    assert all(claim is not None for claim in claims)
    assert await credit_reserve.claim_model_call_credits(
        "user-1",
        2,
        reservation_task_id="budget-task",
        operation_id="candidate-5",
    ) is None

    for claim in claims[:2]:
        assert claim is not None
        await credit_reserve.mark_model_call_claim_ready(claim)
        await credit_reserve.settle_model_call_claim(claim)
    for claim in claims[2:]:
        assert claim is not None
        await credit_reserve.release_model_call_claim(claim)

    reservation = await credit_reserve.get_task_reservation("budget-task")
    assert reservation is not None
    assert reservation.remaining == 4
    assert reservation.claimed == 0
    assert reservation.settled == 4
    assert float(redis.values["credit_reserve:user-1"]) == 4
    assert await credit_reserve.release_task_reservation("budget-task") == 4
    assert "credit_reserve:user-1" not in redis.values


@pytest.mark.asyncio
async def test_stable_sync_operation_does_not_create_a_second_reservation(monkeypatch):
    redis = _ReservationRedis()
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", AsyncMock(return_value=3))
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)

    first = await credit_reserve.claim_model_call_credits(
        "user-1",
        3,
        operation_id="stable-operation",
    )
    second = await credit_reserve.claim_model_call_credits(
        "user-1",
        3,
        operation_id="stable-operation",
    )

    assert first is not None and first.owns_reservation
    assert second is not None and second.in_progress
    assert first.reservation_task_id == second.reservation_task_id
    assert float(redis.values["credit_reserve:user-1"]) == 3
