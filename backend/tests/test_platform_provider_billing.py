from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from services.platform_provider_billing import (
    execute_platform_provider_call,
    require_platform_provider_sku,
)


PRICED_SKU = {
    "id": "server-provider-test",
    "name": "Server provider test",
    "category": "generate",
    "enabled": True,
    "price_type": "credits",
    "price_credits": 3.5,
}


def _authorization(
    claim=None,
    *,
    already_settled: bool = False,
    resume_settlement: bool = False,
):
    return SimpleNamespace(
        cost=3.5,
        claim=claim,
        already_settled=already_settled,
        resume_settlement=resume_settlement,
    )


@pytest.mark.asyncio
async def test_missing_platform_sku_fails_before_provider_call():
    invoke = AsyncMock(return_value=b"pixels")
    authorize = AsyncMock()
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=None),
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=authorize,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await execute_platform_provider_call(
                user_id="user-1",
                model_id="missing-provider-sku",
                expected_category="generate",
                description="test provider",
                idempotency_key="provider:test:1",
                invoke=invoke,
            )

    assert exc_info.value.status_code == 503
    invoke.assert_not_awaited()
    authorize.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sku",
    [
        {**PRICED_SKU, "enabled": False},
        {**PRICED_SKU, "category": "vision"},
        {**PRICED_SKU, "price_type": "free", "price_credits": 0},
        {**PRICED_SKU, "price_credits": 0},
    ],
)
async def test_unbillable_platform_sku_fails_closed(sku):
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=sku),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await require_platform_provider_sku(
                user_id="user-1",
                model_id=sku["id"],
                expected_category="generate",
                description="test provider",
            )

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_successful_platform_provider_call_claims_then_charges_once():
    invoke = AsyncMock(return_value=b"pixels")
    claim = SimpleNamespace(operation_id="provider:test:success")
    authorize = AsyncMock(return_value=_authorization(claim))
    charge = AsyncMock(return_value=3.5)
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=PRICED_SKU),
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=authorize,
    ), patch(
        "services.platform_provider_billing.charge_model_call",
        new=charge,
    ):
        result = await execute_platform_provider_call(
            user_id="user-1",
            model_id=PRICED_SKU["id"],
            expected_category="generate",
            description="test provider",
            related_task_id=None,
            reservation_task_id="task-1",
            idempotency_key="provider:test:success",
            invoke=invoke,
        )

    assert result == b"pixels"
    authorize.assert_awaited_once()
    invoke.assert_awaited_once()
    charge.assert_awaited_once()
    assert authorize.await_args.kwargs["reservation_task_id"] == "task-1"
    assert charge.await_args.kwargs["reservation_task_id"] == "task-1"
    assert charge.await_args.kwargs["credit_claim"] is claim
    assert charge.await_args.kwargs["related_task_id"] is None
    assert charge.await_args.kwargs["idempotency_key"] == "provider:test:success"


@pytest.mark.asyncio
@pytest.mark.parametrize("resume_settlement", [False, True])
async def test_settled_provider_retry_never_invokes_provider_again(resume_settlement: bool):
    claim = SimpleNamespace(operation_id="provider:test:settled-retry") if resume_settlement else None
    authorize = AsyncMock(
        return_value=_authorization(
            claim,
            already_settled=not resume_settlement,
            resume_settlement=resume_settlement,
        )
    )
    charge = AsyncMock(return_value=3.5)
    invoke = AsyncMock(return_value=b"must-not-run")
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=PRICED_SKU),
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=authorize,
    ), patch(
        "services.platform_provider_billing.charge_model_call",
        new=charge,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await execute_platform_provider_call(
                user_id="user-1",
                model_id=PRICED_SKU["id"],
                expected_category="generate",
                description="settled retry",
                idempotency_key="provider:test:settled-retry",
                invoke=invoke,
            )

    assert exc_info.value.status_code == 409
    invoke.assert_not_awaited()
    assert charge.await_count == int(resume_settlement)


@pytest.mark.asyncio
async def test_failed_or_empty_platform_provider_result_releases_claim_without_charge():
    charge = AsyncMock(return_value=3.5)
    release = AsyncMock()

    for key, result, failure in (
        ("provider:test:empty", None, None),
        ("provider:test:failed", None, RuntimeError("upstream failed")),
    ):
        claim = SimpleNamespace(operation_id=key)
        invoke = AsyncMock(side_effect=failure) if failure else AsyncMock(return_value=result)
        with patch(
            "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
            new=AsyncMock(return_value=False),
        ), patch(
            "services.platform_provider_billing.model_repo.get_model",
            new=AsyncMock(return_value=PRICED_SKU),
        ), patch(
            "services.platform_provider_billing.authorize_model_call",
            new=AsyncMock(return_value=_authorization(claim)),
        ), patch(
            "services.platform_provider_billing.charge_model_call",
            new=charge,
        ), patch(
            "services.platform_provider_billing.credit_reserve.release_model_call_claim",
            new=release,
        ):
            if failure:
                with pytest.raises(RuntimeError, match="upstream failed"):
                    await execute_platform_provider_call(
                        user_id="user-1",
                        model_id=PRICED_SKU["id"],
                        expected_category="generate",
                        description="test provider",
                        idempotency_key=key,
                        invoke=invoke,
                    )
            else:
                assert await execute_platform_provider_call(
                    user_id="user-1",
                    model_id=PRICED_SKU["id"],
                    expected_category="generate",
                    description="test provider",
                    idempotency_key=key,
                    success_when=bool,
                    invoke=invoke,
                ) is None
        release.assert_awaited_once_with(claim)
        release.reset_mock()

    charge.assert_not_awaited()


@pytest.mark.asyncio
async def test_external_api_key_mode_bypasses_all_platform_billing_state():
    invoke = AsyncMock(return_value=b"pixels")
    lookup = AsyncMock()
    authorize = AsyncMock()
    charge = AsyncMock()
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=True),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=lookup,
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=authorize,
    ), patch(
        "services.platform_provider_billing.charge_model_call",
        new=charge,
    ):
        result = await execute_platform_provider_call(
            user_id="user-1",
            model_id="server-provider-test",
            expected_category="generate",
            description="test provider",
            idempotency_key="provider:test:external",
            invoke=invoke,
        )

    assert result == b"pixels"
    invoke.assert_awaited_once()
    lookup.assert_not_awaited()
    authorize.assert_not_awaited()
    charge.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_billing_precheck_failure_is_exposed_before_transport():
    invoke = AsyncMock(return_value=b"pixels")
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=PRICED_SKU),
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=AsyncMock(side_effect=RuntimeError("balance store unavailable")),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await execute_platform_provider_call(
                user_id="user-1",
                model_id=PRICED_SKU["id"],
                expected_category="generate",
                description="test provider",
                idempotency_key="provider:test:precheck-failure",
                invoke=invoke,
            )

    assert exc_info.value.status_code == 503
    invoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_billing_settlement_failure_keeps_success_claim_for_retry():
    invoke = AsyncMock(return_value=b"pixels")
    claim = SimpleNamespace(operation_id="provider:test:settlement-failure")
    release = AsyncMock()
    with patch(
        "services.platform_provider_billing.foxapi_credentials.uses_external_billing",
        new=AsyncMock(return_value=False),
    ), patch(
        "services.platform_provider_billing.model_repo.get_model",
        new=AsyncMock(return_value=PRICED_SKU),
    ), patch(
        "services.platform_provider_billing.authorize_model_call",
        new=AsyncMock(return_value=_authorization(claim)),
    ), patch(
        "services.platform_provider_billing.charge_model_call",
        new=AsyncMock(side_effect=RuntimeError("ledger unavailable")),
    ), patch(
        "services.platform_provider_billing.credit_reserve.release_model_call_claim",
        new=release,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await execute_platform_provider_call(
                user_id="user-1",
                model_id=PRICED_SKU["id"],
                expected_category="generate",
                description="test provider",
                idempotency_key="provider:test:settlement-failure",
                invoke=invoke,
            )

    assert exc_info.value.status_code == 503
    invoke.assert_awaited_once()
    release.assert_not_awaited()
