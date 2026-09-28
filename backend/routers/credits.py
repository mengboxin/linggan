"""
积分路由
- GET  /api/credits/balance       查询余额
- GET  /api/credits/transactions  交易记录
- POST /api/credits/recharge      充值（管理员或支付回调）
- POST /api/credits/consume       消费（内部调用，也可前端直接调）
"""
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field
from typing import Optional

import repositories.credit_repo as credit_repo
from routers.auth import get_current_user

router = APIRouter(prefix="/api/credits", tags=["积分"])


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class RechargeRequest(BaseModel):
    amount: float = Field(gt=0, description="充值积分数量")
    description: str = Field(default="手动充值")

class ConsumeRequest(BaseModel):
    amount: float = Field(gt=0, description="消费积分数量")
    description: str = Field(default="任务消费")
    related_task_id: Optional[str] = None

class BalanceResponse(BaseModel):
    balance: float
    user_id: str
    funding_source: Optional[str] = None
    subscription_id: Optional[str] = None


class FundingPreferenceRequest(BaseModel):
    funding_source: str = Field(pattern="^(metered|subscription)$")
    subscription_id: Optional[str] = None


# ─── 查询余额 ──────────────────────────────────────────────────────────────────

@router.get("/balance", response_model=BalanceResponse)
async def get_balance(user: dict = Depends(get_current_user)):
    # This endpoint is the permanent pay-as-you-go wallet. The selected
    # membership card is exposed separately by GET /api/credits/wallet.
    balance = await credit_repo.get_balance(user["id"])
    return BalanceResponse(
        balance=float(balance),
        user_id=user["id"],
        funding_source="metered",
        subscription_id=None,
    )


@router.get("/wallet")
async def get_wallet(user: dict = Depends(get_current_user)):
    from repositories.membership_wallet_repo import get_wallet_snapshot

    return await get_wallet_snapshot(user["id"])


@router.put("/wallet/preference")
async def set_wallet_preference(
    body: FundingPreferenceRequest,
    user: dict = Depends(get_current_user),
):
    from repositories.membership_wallet_repo import (
        MembershipWalletError,
        set_funding_preference,
    )

    try:
        return await set_funding_preference(
            user["id"], body.funding_source, body.subscription_id,
        )
    except MembershipWalletError as exc:
        raise HTTPException(400, str(exc)) from exc


# ─── 交易记录 ──────────────────────────────────────────────────────────────────

@router.get("/transactions")
async def get_transactions(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    txs = await credit_repo.list_transactions(user["id"], limit=limit, offset=offset)
    return {"transactions": txs, "limit": limit, "offset": offset}


# ─── 充值（管理员权限）────────────────────────────────────────────────────────

@router.post("/recharge")
async def recharge(
    body: RechargeRequest,
    user: dict = Depends(get_current_user),
):
    """管理员给自己或通过 admin 路由给指定用户充值"""
    if user["role"] not in ("admin",):
        raise HTTPException(403, "仅管理员可直接充值，普通用户请通过支付渠道")

    result = await credit_repo.add_credits(
        user_id=user["id"],
        amount=body.amount,
        tx_type="recharge",
        description=body.description,
    )
    return {"ok": True, **result}


# ─── 管理员给指定用户充值 ──────────────────────────────────────────────────────

@router.post("/admin/recharge/{target_user_id}")
async def admin_recharge(
    target_user_id: str,
    body: RechargeRequest,
    user: dict = Depends(get_current_user),
):
    if user["role"] != "admin":
        raise HTTPException(403, "无权限")

    result = await credit_repo.add_credits(
        user_id=target_user_id,
        amount=body.amount,
        tx_type="admin_adjust",
        description=f"管理员调整：{body.description}",
    )
    return {"ok": True, **result}


# ─── 消费积分（内部/前端均可调用）────────────────────────────────────────────

@router.post("/consume")
async def consume(
    body: ConsumeRequest,
    user: dict = Depends(get_current_user),
):
    try:
        result = await credit_repo.consume_credits(
            user_id=user["id"],
            amount=body.amount,
            description=body.description,
            related_task_id=body.related_task_id,
        )
    except ValueError as e:
        raise HTTPException(402, str(e))

    return {"ok": True, **result}


# ─── 查询模型价格 ──────────────────────────────────────────────────────────────

@router.get("/model-price/{model_id}")
async def get_model_price(
    model_id: str,
    user: dict = Depends(get_current_user),
):
    price = await credit_repo.get_model_price(model_id)
    return {"model_id": model_id, "price_credits": price}
