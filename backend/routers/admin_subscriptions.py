"""Protected admin endpoints for subscription plans and user memberships."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from routers.admin import require_admin
from services.subscription_admin import SubscriptionAdminError, subscription_admin


router = APIRouter(prefix="/api/admin/subscriptions", tags=["admin-subscriptions"])


def _raise_admin_error(exc: SubscriptionAdminError) -> None:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


class PlanMutationBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    badge_label: str = Field(default="", max_length=30)
    price_yuan: Decimal = Field(gt=0, le=1_000_000)
    credits: int = Field(gt=0, le=100_000_000)
    duration_days: int = Field(gt=0, le=3650)
    benefits: list[str] = Field(default_factory=list, max_length=20)
    enabled: bool = True
    sort_order: int = Field(default=0, ge=0, le=10000)
    operation_key: str = Field(min_length=8, max_length=160)

    @field_validator("benefits")
    @classmethod
    def normalize_benefits(cls, value: list[str]) -> list[str]:
        normalized = [str(item).strip()[:160] for item in value if str(item).strip()]
        if len(normalized) > 20:
            raise ValueError("套餐权益最多 20 条")
        return normalized


class AssignmentBody(BaseModel):
    user_ref: str = Field(min_length=1, max_length=320)
    plan_id: str = Field(min_length=2, max_length=64)
    duration_days: int | None = Field(default=None, ge=1, le=3650)
    quota_credits: int | None = Field(default=None, ge=0, le=100_000_000)
    note: str = Field(default="", max_length=500)
    operation_key: str = Field(min_length=8, max_length=160)


class SubscriptionActionBody(BaseModel):
    reason: str = Field(default="", max_length=500)
    operation_key: str = Field(min_length=8, max_length=160)


@router.get("")
async def get_subscription_dashboard(
    status: str = Query(default="", max_length=20),
    query: str = Query(default="", max_length=320),
    limit: int = Query(default=200, ge=1, le=500),
    _: bool = Depends(require_admin),
):
    try:
        return await subscription_admin.dashboard(status=status, query=query, limit=limit)
    except SubscriptionAdminError as exc:
        _raise_admin_error(exc)


@router.get("/users")
async def search_subscription_users(
    query: str = Query(min_length=2, max_length=320),
    limit: int = Query(default=20, ge=1, le=50),
    _: bool = Depends(require_admin),
):
    return {"items": await subscription_admin.search_users(query, limit=limit)}


@router.put("/plans/{plan_id}")
async def save_subscription_plan(
    plan_id: str,
    body: PlanMutationBody,
    _: bool = Depends(require_admin),
):
    try:
        plan = await subscription_admin.save_plan(
            plan_id=plan_id,
            name=body.name,
            description=body.description,
            badge_label=body.badge_label,
            price_yuan=body.price_yuan,
            credits=body.credits,
            duration_days=body.duration_days,
            benefits=body.benefits,
            enabled=body.enabled,
            sort_order=body.sort_order,
            operation_key=body.operation_key,
        )
        return {"ok": True, "plan": plan}
    except SubscriptionAdminError as exc:
        _raise_admin_error(exc)


@router.post("/assign")
async def assign_subscription(
    body: AssignmentBody,
    _: bool = Depends(require_admin),
):
    try:
        subscription = await subscription_admin.assign(
            user_ref=body.user_ref,
            plan_id=body.plan_id,
            operation_key=body.operation_key,
            duration_days=body.duration_days,
            quota_credits=body.quota_credits,
            note=body.note,
        )
        return {"ok": True, "subscription": subscription}
    except SubscriptionAdminError as exc:
        _raise_admin_error(exc)


@router.post("/{subscription_id}/revoke")
async def revoke_subscription(
    subscription_id: str,
    body: SubscriptionActionBody,
    _: bool = Depends(require_admin),
):
    try:
        subscription = await subscription_admin.revoke(
            subscription_id=subscription_id,
            operation_key=body.operation_key,
            reason=body.reason,
        )
        return {"ok": True, "subscription": subscription}
    except SubscriptionAdminError as exc:
        _raise_admin_error(exc)


@router.post("/{subscription_id}/reset-quota")
async def reset_subscription_quota(
    subscription_id: str,
    body: SubscriptionActionBody,
    _: bool = Depends(require_admin),
):
    try:
        subscription = await subscription_admin.reset_quota(
            subscription_id=subscription_id,
            operation_key=body.operation_key,
            reason=body.reason,
        )
        return {"ok": True, "subscription": subscription}
    except SubscriptionAdminError as exc:
        _raise_admin_error(exc)
