from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_external_user_balance_and_consumption_do_not_touch_credit_rows(monkeypatch):
    from repositories import credit_repo

    monkeypatch.setattr(
        credit_repo.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    acquire = MagicMock()
    monkeypatch.setattr(credit_repo, "acquire", acquire)

    balance = await credit_repo.get_balance("user-1")
    result = await credit_repo.consume_credits("user-1", 99, "external call")

    assert balance == 0
    assert result == {
        "balance_after": 0.0,
        "transaction_id": None,
        "billing_mode": "external_api_key",
    }
    acquire.assert_not_called()


@pytest.mark.asyncio
async def test_external_user_credit_reservation_is_a_noop(monkeypatch):
    from core import credit_reserve

    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    redis = MagicMock()
    monkeypatch.setattr(credit_reserve, "get_redis", redis)

    assert await credit_reserve.reserve("user-1", 99) is True
    await credit_reserve.release("user-1", 99)
    result = await credit_reserve.consume_and_release("user-1", 99, "external call")

    assert result["transaction_id"] is None
    assert result["billing_mode"] == "external_api_key"
    redis.assert_not_called()


@pytest.mark.asyncio
async def test_model_billing_precheck_skips_platform_balance_for_external_user(monkeypatch):
    from services import model_billing

    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    get_balance = AsyncMock()
    monkeypatch.setattr(model_billing.credit_repo, "get_balance", get_balance)

    await model_billing.ensure_credits("user-1", 100, description="external model")

    get_balance.assert_not_awaited()


@pytest.mark.asyncio
async def test_external_charge_bypasses_model_catalog_and_credit_ledger(monkeypatch):
    from services import model_billing

    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    get_model = AsyncMock(side_effect=AssertionError("catalog must not be read"))
    monkeypatch.setattr(model_billing.model_repo, "get_model", get_model)
    consume = AsyncMock()
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)

    charged = await model_billing.charge_model_call(
        user_id="user-1",
        model_id="foxapi:generate:not-in-catalog",
        expected_category="generate",
        description="external model",
    )

    assert charged == 0
    get_model.assert_not_awaited()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_external_valid_model_is_not_charged(monkeypatch):
    from services import model_billing

    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    get_model = AsyncMock(return_value={
        "id": "foxapi:generate:gpt-image-2",
        "category": "generate",
        "enabled": True,
        "price_type": "free",
        "price_credits": 0,
    })
    consume = AsyncMock()
    monkeypatch.setattr(model_billing.model_repo, "get_model", get_model)
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)

    charged = await model_billing.charge_model_call(
        user_id="user-1",
        model_id="foxapi:generate:gpt-image-2",
        expected_category="generate",
        description="external model",
    )

    assert charged == 0
    get_model.assert_not_awaited()
    consume.assert_not_awaited()


@pytest.mark.asyncio
async def test_model_charge_passes_completion_idempotency_key(monkeypatch):
    from core import credit_reserve
    from services import model_billing

    monkeypatch.setattr(
        model_billing.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        model_billing.model_repo,
        "get_model",
        AsyncMock(return_value={
            "id": "image2",
            "category": "generate",
            "enabled": True,
            "price_type": "credits",
            "price_credits": 2,
        }),
    )
    consume = AsyncMock(return_value={"transaction_id": "tx-1"})
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)
    monkeypatch.setattr(
        model_billing.credit_repo,
        "get_consumption_by_idempotency_key",
        AsyncMock(return_value=None),
    )
    claim = credit_reserve.ModelCallCreditClaim(
        user_id="user-1",
        reservation_task_id="billing-lease",
        operation_id="go-image2:task-1:variant:1",
        amount=2,
        claim_key="claim-key",
    )
    monkeypatch.setattr(
        model_billing.credit_reserve,
        "claim_model_call_credits",
        AsyncMock(return_value=claim),
    )
    monkeypatch.setattr(model_billing.credit_reserve, "mark_model_call_claim_ready", AsyncMock())
    monkeypatch.setattr(model_billing.credit_reserve, "settle_model_call_claim", AsyncMock())

    await model_billing.charge_model_call(
        user_id="user-1",
        model_id="image2",
        expected_category="generate",
        description="go image2 completion",
        related_task_id="task-1",
        idempotency_key="go-image2:task-1:variant:1",
        prechecked=True,
    )

    assert consume.await_args.kwargs["idempotency_key"] == "go-image2:task-1:variant:1"
