"""Fail-closed billing for server-key model providers outside ``ai_client``.

These providers cannot use a user's FoxAPI credential.  Platform-credit calls
therefore need an explicit, positively priced ``ai_models`` SKU before any
upstream request is made.  The caller owns the SKU identifier and a stable
idempotency key; this module deliberately does not invent provider prices.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional, TypeVar

from fastapi import HTTPException

from core import credit_reserve
import repositories.model_repo as model_repo
from services import foxapi_credentials
from services.model_billing import authorize_model_call, charge_model_call


_T = TypeVar("_T")


def _configuration_error(model_id: str, description: str) -> HTTPException:
    return HTTPException(
        503,
        (
            f"{description} is not available: platform billing SKU "
            f"{model_id!r} is missing or is not configured with a positive "
            "credit price. No provider request was sent."
        ),
    )


async def require_platform_provider_sku(
    *,
    user_id: str,
    model_id: str,
    expected_category: str,
    description: str,
) -> Optional[dict]:
    """Resolve a priced platform SKU, or return ``None`` for API-key mode.

    A free/subscription row is not a usable credit SKU for a server-funded
    provider.  Treating it as one would silently spend provider funds without
    deducting the user's platform credits.
    """
    if not user_id:
        raise HTTPException(503, f"{description} cannot be billed without a user")
    if await foxapi_credentials.uses_external_billing(user_id):
        return None

    try:
        model = await model_repo.get_model(model_id)
    except Exception as exc:
        raise HTTPException(503, f"{description} billing catalog is unavailable") from exc

    try:
        price = float((model or {}).get("price_credits", 0) or 0)
    except (TypeError, ValueError):
        price = 0.0
    if (
        not model
        or model.get("enabled") is False
        or model.get("category") != expected_category
        or model.get("price_type") != "credits"
        or price <= 0
    ):
        raise _configuration_error(model_id, description)
    return model


async def execute_platform_provider_call(
    *,
    user_id: str,
    model_id: str,
    expected_category: str,
    description: str,
    invoke: Callable[[], Awaitable[_T]],
    idempotency_key: str,
    related_task_id: Optional[str] = None,
    reservation_task_id: Optional[str] = None,
    cost_multiplier: float = 1.0,
    success_when: Optional[Callable[[_T], bool]] = None,
) -> _T:
    """Run one provider operation and debit only a successful platform call."""
    if await foxapi_credentials.uses_external_billing(user_id):
        return await invoke()
    if not str(idempotency_key or "").strip():
        raise HTTPException(503, f"{description} is missing a billing idempotency key")

    await require_platform_provider_sku(
        user_id=user_id,
        model_id=model_id,
        expected_category=expected_category,
        description=description,
    )
    try:
        authorization = await authorize_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=expected_category,
            description=description,
            cost_multiplier=cost_multiplier,
            idempotency_key=idempotency_key,
            reservation_task_id=reservation_task_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Platform credit precheck is temporarily unavailable") from exc

    credit_claim = authorization.claim
    if authorization.resume_settlement:
        await charge_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=expected_category,
            description=description,
            related_task_id=related_task_id,
            prechecked=True,
            cost_multiplier=cost_multiplier,
            idempotency_key=idempotency_key,
            reservation_task_id=reservation_task_id,
            credit_claim=credit_claim,
        )
        raise HTTPException(409, "This billed provider operation already completed settlement")
    if authorization.already_settled:
        raise HTTPException(409, "This billed provider operation is already settled")

    try:
        result = await invoke()
    except BaseException:
        if credit_claim is not None:
            await credit_reserve.release_model_call_claim(credit_claim)
        raise
    if success_when is not None and not success_when(result):
        if credit_claim is not None:
            await credit_reserve.release_model_call_claim(credit_claim)
        return result

    try:
        await charge_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=expected_category,
            description=description,
            related_task_id=related_task_id,
            prechecked=True,
            cost_multiplier=cost_multiplier,
            idempotency_key=idempotency_key,
            reservation_task_id=reservation_task_id,
            credit_claim=credit_claim,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Platform credit settlement is temporarily unavailable") from exc
    return result
