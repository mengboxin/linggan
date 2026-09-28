"""Consistent platform-credit authorization and settlement for model calls."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, TypeVar

from fastapi import HTTPException

from core import credit_reserve
import repositories.credit_repo as credit_repo
import repositories.model_repo as model_repo
from services import foxapi_credentials


_T = TypeVar("_T")


@dataclass(frozen=True)
class ModelCallAuthorization:
    """Pre-provider platform-credit authorization."""

    cost: float
    claim: Optional[credit_reserve.ModelCallCreditClaim]
    already_settled: bool = False
    resume_settlement: bool = False


async def resolve_model_for_billing(
    model_id: str,
    *,
    expected_category: Optional[str] = None,
    label: str = "model",
) -> dict:
    """Return an enabled model row with the expected category."""
    model = await model_repo.get_model(model_id)
    if not model or model.get("enabled") is False:
        raise HTTPException(404, f"{label} {model_id!r} does not exist or is disabled")
    if expected_category and model.get("category") != expected_category:
        raise HTTPException(400, f"{label} must be a {expected_category} model")
    return model


def model_price(model: Optional[dict]) -> float:
    if not model or model.get("price_type") != "credits":
        return 0.0
    return float(model.get("price_credits", 0) or 0)


async def ensure_credits(
    user_id: str,
    cost: float,
    *,
    model_id: Optional[str] = None,
    description: str,
) -> None:
    """Check unreserved platform balance for a synchronous model call."""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return
    if cost <= 0:
        return
    available = await credit_reserve.get_available_balance(user_id)
    if available < cost:
        raise HTTPException(
            402,
            f"Insufficient credits: {description} requires {cost:g}; available {available:.2f}",
        )


async def _existing_settlement(
    *,
    user_id: str,
    model_id: Optional[str],
    idempotency_key: Optional[str],
    cost: float,
    description: str,
) -> Optional[dict]:
    normalized_key = str(idempotency_key or "").strip()
    if not normalized_key:
        return None
    existing = await credit_repo.get_consumption_by_idempotency_key(
        user_id,
        normalized_key,
        model_id=model_id,
    )
    if not existing:
        return None
    settled_cost = round(abs(float(existing.get("amount") or 0)), 2)
    settled_description = str(existing.get("description") or "")
    if settled_cost != cost or settled_description != str(description or ""):
        raise HTTPException(
            409,
            "The billing idempotency key is already bound to a different model operation",
        )
    return existing


async def _ensure_task_reservation(
    *,
    user_id: str,
    reservation_task_id: str,
    cost: float,
    description: str,
) -> None:
    reservation = await credit_reserve.get_task_reservation(reservation_task_id)
    if (
        reservation is None
        or reservation.user_id != str(user_id)
        or reservation.remaining + 0.000000001 < cost
    ):
        raise HTTPException(
            402,
            f"Reserved credits are insufficient: {description} requires {cost:g}",
        )


async def check_model_call(
    *,
    user_id: str,
    model_id: str,
    description: str,
    expected_category: Optional[str] = None,
    cost_multiplier: float = 1.0,
    idempotency_key: Optional[str] = None,
    reservation_task_id: Optional[str] = None,
) -> float:
    """Validate and price a call without starting provider transport."""
    # User-supplied API keys never access the platform catalog or credit stores.
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return 0.0
    if not model_id:
        return 0.0
    cost, existing = await _quote_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=expected_category,
        description=description,
        cost_multiplier=cost_multiplier,
        idempotency_key=idempotency_key,
    )
    if existing or cost <= 0:
        return cost
    if reservation_task_id:
        await _ensure_task_reservation(
            user_id=user_id,
            reservation_task_id=reservation_task_id,
            cost=cost,
            description=description,
        )
    else:
        await ensure_credits(user_id, cost, model_id=model_id, description=description)
    return cost


async def _quote_model_call(
    *,
    user_id: str,
    model_id: str,
    expected_category: Optional[str],
    description: str,
    cost_multiplier: float,
    idempotency_key: Optional[str],
) -> tuple[float, Optional[dict]]:
    model = await resolve_model_for_billing(
        model_id,
        expected_category=expected_category,
        label="billing model",
    )
    cost = round(
        model_price(model) * max(0.0, float(cost_multiplier)),
        2,
    )
    existing = await _existing_settlement(
        user_id=user_id,
        model_id=model_id,
        idempotency_key=idempotency_key,
        cost=cost,
        description=description,
    )
    return cost, existing


async def _claim_call(
    *,
    user_id: str,
    model_id: str,
    cost: float,
    reservation_task_id: Optional[str],
    idempotency_key: Optional[str],
) -> credit_reserve.ModelCallCreditClaim:
    claim = await credit_reserve.claim_model_call_credits(
        user_id,
        cost,
        model_id=model_id,
        reservation_task_id=reservation_task_id,
        operation_id=idempotency_key,
    )
    if claim is None:
        raise HTTPException(402, "Insufficient credits or billing protection is unavailable")
    if claim.in_progress:
        # Reusing an active operation must not launch a second provider call.
        raise HTTPException(409, "This billed model operation is already in progress")
    return claim


async def authorize_model_call(
    *,
    user_id: str,
    model_id: str,
    description: str,
    expected_category: Optional[str] = None,
    cost_multiplier: float = 1.0,
    idempotency_key: Optional[str] = None,
    reservation_task_id: Optional[str] = None,
) -> ModelCallAuthorization:
    """Authorize before provider transport and recover interrupted settlement.

    Callers with split provider/charge phases use the returned ``claim`` in
    :func:`charge_model_call`.  If ``resume_settlement`` is true, the provider
    already succeeded: call ``charge_model_call`` immediately without invoking
    it again, then surface an idempotent in-progress/completed response.
    """
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return ModelCallAuthorization(cost=0.0, claim=None)
    if not model_id:
        return ModelCallAuthorization(cost=0.0, claim=None)
    cost, existing = await _quote_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=expected_category,
        description=description,
        cost_multiplier=cost_multiplier,
        idempotency_key=idempotency_key,
    )
    normalized_idempotency_key = str(idempotency_key or "").strip()
    if cost > 0 and reservation_task_id and not normalized_idempotency_key:
        raise HTTPException(503, "Task model billing requires a stable idempotency key")
    recoverable = None
    if cost > 0 and normalized_idempotency_key:
        recoverable = await credit_reserve.get_model_call_claim(
            user_id,
            cost,
            reservation_task_id=reservation_task_id,
            operation_id=idempotency_key,
        )
    if recoverable is not None:
        if recoverable.in_progress:
            raise HTTPException(409, "This billed model operation is already in progress")
        if recoverable.provider_succeeded:
            return ModelCallAuthorization(
                cost=cost,
                claim=recoverable,
                already_settled=bool(existing),
                resume_settlement=True,
            )
    if existing:
        return ModelCallAuthorization(cost=cost, claim=None, already_settled=True)
    if cost <= 0:
        return ModelCallAuthorization(cost=cost, claim=None)
    if reservation_task_id:
        await _ensure_task_reservation(
            user_id=user_id,
            reservation_task_id=reservation_task_id,
            cost=cost,
            description=description,
        )
    else:
        await ensure_credits(user_id, cost, model_id=model_id, description=description)
    claim = await _claim_call(
        user_id=user_id,
        model_id=model_id,
        cost=cost,
        reservation_task_id=reservation_task_id,
        idempotency_key=idempotency_key,
    )
    if claim.already_settled:
        raise HTTPException(503, "Credit claim and debit ledger are inconsistent")
    return ModelCallAuthorization(cost=cost, claim=claim)


async def charge_model_call(
    *,
    user_id: str,
    model_id: str,
    description: str,
    expected_category: Optional[str] = None,
    related_task_id: Optional[str] = None,
    prechecked: bool = False,
    cost_multiplier: float = 1.0,
    idempotency_key: Optional[str] = None,
    reservation_task_id: Optional[str] = None,
    credit_claim: Optional[credit_reserve.ModelCallCreditClaim] = None,
) -> float:
    """Debit one successful platform-funded call and settle its claim."""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return 0.0
    if not model_id:
        return 0.0

    # A claim is the immutable authorization captured before provider
    # transport.  Do not re-read the mutable model catalog after an upstream
    # success: a concurrent price/enablement change must not make the call
    # unbillable or change its authorized amount.
    if credit_claim is not None:
        cost = round(float(credit_claim.amount), 2)
    else:
        model = await resolve_model_for_billing(
            model_id,
            expected_category=expected_category,
            label="billing model",
        )
        cost = round(
            model_price(model) * max(0.0, float(cost_multiplier)),
            2,
        )
    if cost <= 0:
        return 0.0

    # Ledger linkage and reservation ownership are separate concepts.  Some
    # jobs use non-task operation ids, while some task rows have no reservation.
    effective_reservation_task_id = str(reservation_task_id or "").strip() or None
    normalized_idempotency_key = str(idempotency_key or "").strip()
    effective_idempotency_key = normalized_idempotency_key or (
        credit_claim.operation_id if credit_claim is not None else ""
    )
    if cost > 0 and effective_reservation_task_id and not normalized_idempotency_key:
        raise HTTPException(503, "Task model billing requires a stable idempotency key")
    existing = await _existing_settlement(
        user_id=user_id,
        model_id=model_id,
        idempotency_key=effective_idempotency_key,
        cost=cost,
        description=description,
    )
    if credit_claim is not None and (
        credit_claim.user_id != str(user_id)
        or abs(credit_claim.amount - cost) > 0.000000001
        or (
            normalized_idempotency_key
            and credit_claim.operation_id != normalized_idempotency_key
        )
        or (
            effective_reservation_task_id
            and credit_claim.reservation_task_id != effective_reservation_task_id
        )
    ):
        raise HTTPException(409, "The credit claim does not match this model operation")

    if existing is None and credit_claim is None:
        if not prechecked:
            await check_model_call(
                user_id=user_id,
                model_id=model_id,
                expected_category=expected_category,
                description=description,
                cost_multiplier=cost_multiplier,
                idempotency_key=idempotency_key,
                reservation_task_id=effective_reservation_task_id,
            )
        credit_claim = await _claim_call(
            user_id=user_id,
            model_id=model_id,
            cost=cost,
            reservation_task_id=effective_reservation_task_id,
            idempotency_key=idempotency_key,
        )

    if credit_claim is not None:
        try:
            await credit_reserve.mark_model_call_claim_ready(
                credit_claim,
                settlement_description=description,
                related_task_id=related_task_id,
                idempotency_key=effective_idempotency_key,
            )
        except Exception as exc:
            raise HTTPException(503, "Credit authorization state is temporarily unavailable") from exc

    try:
        await credit_repo.consume_credits(
            user_id=user_id,
            amount=cost,
            description=description,
            related_task_id=related_task_id,
            idempotency_key=effective_idempotency_key or None,
            funding_source=credit_claim.funding_source if credit_claim else None,
            subscription_id=credit_claim.subscription_id if credit_claim else None,
            model_id=model_id,
        )
    except credit_repo.CreditIdempotencyConflict as exc:
        raise HTTPException(409, str(exc))
    except ValueError as exc:
        raise HTTPException(503, f"Provider succeeded but credit settlement failed: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        # The database outcome may be unknown.  Keep the claim held so a retry
        # with the same ledger key cannot expose credits that might be debited.
        raise HTTPException(503, "Platform credit settlement is temporarily unavailable") from exc

    if credit_claim is not None:
        try:
            await credit_reserve.settle_model_call_claim(credit_claim)
        except Exception as exc:
            raise HTTPException(503, "Credit reservation settlement is temporarily unavailable") from exc
    return cost


async def execute_billed_model_call(
    *,
    user_id: str,
    model_id: str,
    expected_category: Optional[str],
    description: str,
    invoke: Callable[[], Awaitable[_T]],
    related_task_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    cost_multiplier: float = 1.0,
    reservation_task_id: Optional[str] = None,
) -> _T:
    """Claim, invoke, then settle; failed provider calls only release claims."""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return await invoke()

    effective_reservation_task_id = str(reservation_task_id or "").strip() or None
    try:
        authorization = await authorize_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=expected_category,
            description=description,
            cost_multiplier=cost_multiplier,
            idempotency_key=idempotency_key,
            reservation_task_id=effective_reservation_task_id,
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
            reservation_task_id=effective_reservation_task_id,
            credit_claim=credit_claim,
        )
        raise HTTPException(409, "This billed model operation already completed settlement")
    if authorization.already_settled:
        # The ledger proves this logical call already completed. Replaying the
        # provider would create another paid upstream result even though the
        # idempotent ledger correctly refuses a second debit.
        raise HTTPException(409, "This billed model operation already completed")
    try:
        result = await invoke()
    except BaseException:
        if credit_claim is not None:
            await credit_reserve.release_model_call_claim(credit_claim)
        raise

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
            reservation_task_id=effective_reservation_task_id,
            credit_claim=credit_claim,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Platform credit settlement is temporarily unavailable") from exc
    return result
