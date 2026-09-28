"""积分数据仓库 —— 使用全局 asyncpg 连接池"""
from typing import Optional
from core.pool import acquire
from services import foxapi_credentials


class CreditIdempotencyConflict(ValueError):
    """An operation key was reused for a different credit debit."""


async def get_balance(user_id: str) -> float:
    """查询余额（带 Redis 缓存，5 秒 TTL，减少 DB 压力）。"""
    if await foxapi_credentials.uses_external_billing(user_id):
        return 0.0
    from core.redis import get_redis
    cache_key = f"balance:{user_id}"
    try:
        r = get_redis()
        cached = await r.get(cache_key)
        if cached is not None:
            return float(cached)
    except Exception:
        pass  # Redis 不可用时降级到直查

    async with acquire() as conn:
        val = await conn.fetchval(
            "SELECT credits FROM users WHERE id = $1::uuid", user_id
        )
    balance = float(val) if val is not None else 0.0

    try:
        r = get_redis()
        await r.set(cache_key, str(balance), ex=5)
    except Exception:
        pass

    return balance


async def get_consumption_by_idempotency_key(
    user_id: str,
    idempotency_key: str,
    *,
    model_id: Optional[str] = None,
) -> Optional[dict]:
    """Return an existing platform-credit debit for one logical operation."""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return None
    normalized_key = str(idempotency_key or "").strip()
    if not normalized_key:
        return None
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id::text AS transaction_id, amount, balance_after, description,
                   balance_source, subscription_id::text
            FROM credit_transactions
            WHERE user_id = $1::uuid
              AND idempotency_key = $2
              AND type = 'consume'
            """,
            user_id,
            normalized_key,
        )
    return dict(row) if row else None


async def add_credits(
    user_id: str,
    amount: float,
    tx_type: str,
    description: str,
    related_task_id: Optional[str] = None,
) -> dict:
    """增加积分（充值/赠送/退款/管理员调整）"""
    async with acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE users SET credits = credits + $1, updated_at = NOW()
                WHERE id = $2::uuid RETURNING credits
                """,
                amount, user_id,
            )
            balance_after = float(row["credits"])
            tx_id = await conn.fetchval(
                """
                INSERT INTO credit_transactions
                    (user_id, amount, balance_after, type, related_task_id, description)
                VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
                RETURNING id::text
                """,
                user_id, amount, balance_after, tx_type, related_task_id, description,
            )
    # 清除余额缓存
    try:
        from core.redis import get_redis
        await get_redis().delete(f"balance:{user_id}")
    except Exception:
        pass
    return {"balance_after": balance_after, "transaction_id": tx_id}


async def consume_credits(
    user_id: str,
    amount: float,
    description: str,
    related_task_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    funding_source: Optional[str] = None,
    subscription_id: Optional[str] = None,
    model_id: Optional[str] = None,
) -> dict:
    """消费积分，余额不足时抛出 ValueError。"""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return {
            "balance_after": 0.0,
            "transaction_id": None,
            "billing_mode": foxapi_credentials.BILLING_MODE,
        }
    from repositories.membership_wallet_repo import (
        WalletIdempotencyConflict,
        consume_wallet_credits,
    )
    try:
        return await consume_wallet_credits(
            user_id=user_id,
            amount=amount,
            description=description,
            related_task_id=related_task_id,
            idempotency_key=idempotency_key,
            funding_source=funding_source,
            subscription_id=subscription_id,
            model_id=model_id,
        )
    except WalletIdempotencyConflict as exc:
        raise CreditIdempotencyConflict(str(exc)) from exc


async def list_transactions(user_id: str, limit: int = 20, offset: int = 0) -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, amount, balance_after, type,
                   related_task_id::text, description, created_at::text,
                   balance_source, subscription_id::text
            FROM credit_transactions
            WHERE user_id = $1::uuid
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            user_id, limit, offset,
        )
        return [dict(r) for r in rows]


async def get_model_price(model_id: str) -> float:
    async with acquire() as conn:
        val = await conn.fetchval(
            "SELECT price_credits FROM ai_models WHERE id = $1 AND enabled = TRUE", model_id,
        )
        return float(val) if val is not None else 0.0


async def refund_credits(
    user_id: str,
    amount: float,
    description: str,
    related_task_id: Optional[str] = None,
    funding_source: Optional[str] = None,
    subscription_id: Optional[str] = None,
) -> dict:
    if await foxapi_credentials.uses_external_billing(user_id):
        return {
            "balance_after": 0.0,
            "transaction_id": None,
            "billing_mode": foxapi_credentials.BILLING_MODE,
        }
    from repositories.membership_wallet_repo import refund_wallet_credits
    return await refund_wallet_credits(
        user_id=user_id,
        amount=amount,
        description=description,
        related_task_id=related_task_id,
        funding_source=funding_source,
        subscription_id=subscription_id,
    )
