"""
支付订单仓库
"""
import asyncio
import time
import uuid
import json
from decimal import Decimal
from typing import Optional

from core.pool import acquire

_zpay_schema_ready = False
_zpay_schema_lock = asyncio.Lock()

DEFAULT_PAYMENT_SETTINGS = {
    "credits_ratio": 10,
    "min_amount_yuan": 1,
    "max_amount_yuan": 200,
    "order_timeout_minutes": 20,
    "max_pending_orders": 2,
    "daily_amount_limit_yuan": 1000,
    "cancel_cooldown_seconds": 30,
    "cancel_window_minutes": 60,
    "max_cancellations_per_window": 6,
}


class PendingSubscriptionOrderError(RuntimeError):
    """Raised when a user attempts to create a second unpaid membership order."""


def _json_object(value: object) -> dict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _json_array(value: object) -> list:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return []
        return list(parsed) if isinstance(parsed, list) else []
    return []


def _subscription_plan_payload(row: object) -> dict:
    payload = dict(row)
    payload["benefits"] = _json_array(payload.get("benefits"))
    return payload


def normalize_payment_settings(raw: dict | str | None) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    merged = {**DEFAULT_PAYMENT_SETTINGS, **raw}
    return {
        "credits_ratio": max(1, int(merged.get("credits_ratio") or 10)),
        "min_amount_yuan": max(1, int(merged.get("min_amount_yuan") or 1)),
        "max_amount_yuan": max(1, int(merged.get("max_amount_yuan") or 200)),
        "order_timeout_minutes": max(1, int(merged.get("order_timeout_minutes") or 20)),
        "max_pending_orders": max(1, int(merged.get("max_pending_orders") or 2)),
        "daily_amount_limit_yuan": max(0, int(merged.get("daily_amount_limit_yuan") or 1000)),
        "cancel_cooldown_seconds": max(0, int(merged.get("cancel_cooldown_seconds") or 30)),
        "cancel_window_minutes": max(1, int(merged.get("cancel_window_minutes") or 60)),
        "max_cancellations_per_window": max(1, int(merged.get("max_cancellations_per_window") or 6)),
    }


async def ensure_zpay_schema(conn) -> None:
    """Ensure the zpay channel row exists without requiring table-owner DDL privileges."""
    global _zpay_schema_ready
    if _zpay_schema_ready:
        return
    async with _zpay_schema_lock:
        if _zpay_schema_ready:
            return
        await conn.execute(
            """
            INSERT INTO payment_channels (channel_code, channel_name, api_url, config_json)
            VALUES ('zpay', 'Z-Pay 在线支付', 'https://zpayz.cn', '{"type":"alipay"}'::jsonb)
            ON CONFLICT (channel_code) DO NOTHING
            """
        )
        await conn.execute(
            """
            INSERT INTO system_settings (key, value)
            VALUES ('payment_settings', $1::jsonb)
            ON CONFLICT (key) DO NOTHING
            """,
            json.dumps(DEFAULT_PAYMENT_SETTINGS),
        )
        _zpay_schema_ready = True


def generate_order_no() -> str:
    """生成 Z-Pay 兼容订单号：纯数字，最长 32 位。"""
    ts = int(time.time() * 1000)
    rand = uuid.uuid4().int % 10_000_000_000
    return f"{ts}{rand:010d}"


async def create_order(
    user_id: str,
    amount_yuan: Decimal,
    credits: int,
    bonus_credits: int,
    pay_channel: str,
    product_kind: str = "credits",
    product_id: Optional[str] = None,
    product_name: str = "",
    product_snapshot: Optional[dict] = None,
    notify_url: str = "",
    return_url: str = "",
    timeout_minutes: int = 20,
    client_ip: str = "",
    order_no: str | None = None,
    legal_document=None,
    legal_source: str = "payment-order",
    legal_client_ip: str = "",
    legal_user_agent: str = "",
) -> dict:
    """创建支付订单"""
    order_no = order_no or generate_order_no()
    snapshot_json = json.dumps(product_snapshot or {}, ensure_ascii=False, default=str)
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        async with conn.transaction():
            if product_kind == "subscription":
                # Every membership creation path takes this lock. The second check closes the
                # race between the route-level preflight and the INSERT below.
                await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1::text))", str(user_id))
                pending = await conn.fetchrow(
                    """
                    SELECT order_no
                    FROM payment_orders
                    WHERE user_id = $1::uuid
                      AND product_kind = 'subscription'
                      AND status = 'pending'
                      AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    user_id,
                )
                if pending:
                    raise PendingSubscriptionOrderError(str(pending["order_no"]))
            acceptance_id = None
            if legal_document is not None:
                from repositories import legal_repo

                acceptance_ids = await legal_repo.record_acceptances(
                    user_id,
                    (legal_document,),
                    source=legal_source,
                    client_ip=legal_client_ip,
                    user_agent=legal_user_agent,
                    context_type="payment_order",
                    context_id=order_no,
                    metadata={"orderNo": order_no, "productKind": product_kind},
                    conn=conn,
                )
                acceptance_id = acceptance_ids[0]
                snapshot = dict(product_snapshot or {})
                snapshot["legal_acceptance_id"] = acceptance_id
                snapshot_json = json.dumps(snapshot, ensure_ascii=False, default=str)
            row = await conn.fetchrow(
                """
                INSERT INTO payment_orders
                    (user_id, order_no, amount_yuan, credits, bonus_credits,
                     product_kind, product_id, product_name, product_snapshot,
                     pay_channel, notify_url, return_url, expires_at, client_ip)
                VALUES (
                    $1::uuid, $2, $3, $4, $5,
                    $6, $7, $8, $9::jsonb,
                    $10, $11, $12, NOW() + make_interval(mins => $13::int), $14
                )
                RETURNING id::text, order_no, amount_yuan, credits, bonus_credits,
                          product_kind, product_id, product_name, product_snapshot,
                          pay_channel, status, expires_at::text, created_at::text
                """,
                user_id, order_no, amount_yuan, credits, bonus_credits,
                product_kind, product_id, product_name, snapshot_json,
                pay_channel, notify_url, return_url, timeout_minutes, client_ip,
            )
        payload = dict(row)
        payload["product_snapshot"] = _json_object(payload.get("product_snapshot"))
        return payload


async def expire_stale_orders(user_id: str | None = None) -> int:
    """把超时未支付订单标记为 expired。"""
    async with acquire() as conn:
        if user_id:
            result = await conn.execute(
                """
                UPDATE payment_orders
                SET status = 'expired', updated_at = NOW()
                WHERE user_id = $1::uuid
                  AND status = 'pending'
                  AND expires_at IS NOT NULL
                  AND expires_at < NOW()
                """,
                user_id,
            )
        else:
            result = await conn.execute(
                """
                UPDATE payment_orders
                SET status = 'expired', updated_at = NOW()
                WHERE status = 'pending'
                  AND expires_at IS NOT NULL
                  AND expires_at < NOW()
                """
            )
    return int(result.split()[-1]) if result.startswith("UPDATE") else 0


async def count_pending_orders(user_id: str) -> int:
    await expire_stale_orders(user_id)
    async with acquire() as conn:
        return int(await conn.fetchval(
            """
            SELECT COUNT(*)
            FROM payment_orders
            WHERE user_id = $1::uuid
              AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > NOW())
            """,
            user_id,
        ) or 0)


async def get_pending_subscription_order(user_id: str) -> Optional[dict]:
    """Return the current membership order that must be handled before another is created."""
    await expire_stale_orders(user_id)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id::text, order_no, amount_yuan, credits, bonus_credits,
                   product_kind, product_id, product_name, pay_channel, status,
                   expires_at::text, created_at::text
            FROM payment_orders
            WHERE user_id = $1::uuid
              AND product_kind = 'subscription'
              AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
            LIMIT 1
            """,
            user_id,
        )
        return dict(row) if row else None


async def sum_user_paid_amount_today(user_id: str) -> Decimal:
    async with acquire() as conn:
        value = await conn.fetchval(
            """
            SELECT COALESCE(SUM(amount_yuan), 0)
            FROM payment_orders
            WHERE user_id = $1::uuid
              AND status IN ('paid', 'completed')
              AND paid_at >= date_trunc('day', NOW())
            """,
            user_id,
        )
    return Decimal(str(value or 0))


async def count_recent_cancellations(user_id: str, window_minutes: int) -> int:
    async with acquire() as conn:
        return int(await conn.fetchval(
            """
            SELECT COUNT(*)
            FROM payment_orders
            WHERE user_id = $1::uuid
              AND status = 'cancelled'
              AND cancelled_at >= NOW() - make_interval(mins => $2::int)
            """,
            user_id, window_minutes,
        ) or 0)


async def seconds_since_last_cancellation(user_id: str) -> Optional[int]:
    async with acquire() as conn:
        seconds = await conn.fetchval(
            """
            SELECT EXTRACT(EPOCH FROM (NOW() - MAX(cancelled_at)))::int
            FROM payment_orders
            WHERE user_id = $1::uuid
              AND status = 'cancelled'
              AND cancelled_at IS NOT NULL
            """,
            user_id,
        )
    return int(seconds) if seconds is not None else None


async def cancel_order(user_id: str, order_no: str) -> Optional[dict]:
    """用户取消自己的待支付订单。"""
    await expire_stale_orders(user_id)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE payment_orders
            SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
            WHERE order_no = $1
              AND user_id = $2::uuid
              AND status = 'pending'
            RETURNING id::text, order_no, status, cancelled_at::text, updated_at::text
            """,
            order_no, user_id,
        )
        return dict(row) if row else None


async def get_order(order_no: str) -> Optional[dict]:
    """查询订单"""
    await expire_stale_orders()
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM payment_orders WHERE order_no = $1", order_no
        )
        return dict(row) if row else None


async def get_order_by_id(order_id: str) -> Optional[dict]:
    """通过ID查询订单"""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM payment_orders WHERE id = $1::uuid", order_id
        )
        return dict(row) if row else None


async def update_order_status(
    order_no: str,
    status: str,
    trade_no: str = "",
) -> bool:
    """更新订单状态"""
    async with acquire() as conn:
        if status == "paid":
            result = await conn.execute(
                """
                UPDATE payment_orders
                SET status = $1, trade_no = $2, paid_at = NOW(), updated_at = NOW()
                WHERE order_no = $3 AND status = 'pending'
                """,
                status, trade_no, order_no,
            )
        else:
            result = await conn.execute(
                """
                UPDATE payment_orders
                SET status = $1, updated_at = NOW()
                WHERE order_no = $2
                """,
                status, order_no,
            )
        return result == "UPDATE 1"


async def complete_paid_order(
    order_no: str,
    trade_no: str,
    provider_payload: dict,
) -> tuple[str, Optional[dict]]:
    """
    完成支付并入账。所有动作在同一事务内完成，依靠 FOR UPDATE 防止重复回调重复入账。
    返回 (result, order)：completed / duplicate / missing / invalid_state / trade_conflict。
    """
    payload_json = json.dumps(provider_payload, ensure_ascii=False)
    normalized_trade_no = str(trade_no or "").strip()
    async with acquire() as conn:
        async with conn.transaction():
            order = await conn.fetchrow(
                "SELECT * FROM payment_orders WHERE order_no = $1 FOR UPDATE",
                order_no,
            )
            if not order:
                return "missing", None

            order_dict = dict(order)
            status = str(order_dict["status"])
            if status == "completed" or order_dict.get("credit_transaction_id"):
                return "duplicate", order_dict
            if status in ("failed", "refunded"):
                return "invalid_state", order_dict
            if not normalized_trade_no:
                return "invalid_state", order_dict

            # Different local orders must never fulfill from one provider trade.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                f"{order_dict['pay_channel']}:{normalized_trade_no}",
            )
            conflicting_order = await conn.fetchrow(
                """
                SELECT id::text, order_no
                FROM payment_orders
                WHERE pay_channel = $1
                  AND trade_no = $2
                  AND id <> $3
                LIMIT 1
                """,
                order_dict["pay_channel"],
                normalized_trade_no,
                order_dict["id"],
            )
            if conflicting_order:
                return "trade_conflict", order_dict

            total_credits = int(order_dict["credits"]) + int(order_dict["bonus_credits"])
            product_kind = str(order_dict.get("product_kind") or "credits")
            product_snapshot = _json_object(order_dict.get("product_snapshot"))
            membership_plan_id: Optional[str] = None
            membership_duration_days = 0
            if product_kind == "subscription":
                membership_plan_id = str(
                    order_dict.get("product_id") or product_snapshot.get("id") or ""
                ).strip()
                try:
                    membership_duration_days = int(product_snapshot.get("duration_days") or 0)
                    snapshot_credits = int(product_snapshot.get("credits") or 0)
                except (TypeError, ValueError):
                    return "invalid_state", order_dict
                if (
                    not membership_plan_id
                    or membership_duration_days <= 0
                    or snapshot_credits != total_credits
                ):
                    return "invalid_state", order_dict
            elif product_kind != "credits":
                return "invalid_state", order_dict

            paid_row = await conn.fetchrow(
                """
                UPDATE payment_orders
                SET status = 'paid',
                    trade_no = $1,
                    paid_at = COALESCE(paid_at, NOW()),
                    provider_payload = $2::jsonb,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING *
                """,
                normalized_trade_no, payload_json, order_dict["id"],
            )

            if product_kind == "subscription":
                from repositories.membership_wallet_repo import create_membership_card

                membership = await create_membership_card(
                    conn,
                    user_id=str(paid_row["user_id"]),
                    plan_id=str(membership_plan_id),
                    quota=total_credits,
                    duration_days=membership_duration_days,
                    plan_snapshot=product_snapshot,
                    payment_order_id=str(paid_row["id"]),
                    source="payment",
                )
                tx_id = await conn.fetchval(
                    """
                    INSERT INTO credit_transactions
                        (user_id, amount, balance_after, type, related_task_id,
                         description, balance_source, subscription_id)
                    VALUES ($1, $2, $3, 'subscription', NULL, $4, 'subscription', $5::uuid)
                    RETURNING id
                    """,
                    paid_row["user_id"],
                    total_credits,
                    membership["quota_remaining"],
                    f"Membership {order_dict.get('product_name') or membership_plan_id} - order {order_no}",
                    membership["id"],
                )
                completed = await conn.fetchrow(
                    """
                    UPDATE payment_orders
                    SET status = 'completed', completed_at = NOW(), credited_at = NOW(),
                        credit_transaction_id = $1, updated_at = NOW()
                    WHERE id = $2
                    RETURNING id::text, user_id::text, order_no, amount_yuan, credits,
                              bonus_credits, product_kind, product_id, product_name,
                              product_snapshot, status, paid_at::text, completed_at::text,
                              credit_transaction_id::text
                    """,
                    tx_id,
                    paid_row["id"],
                )
                completed_payload = dict(completed)
                completed_payload["product_snapshot"] = _json_object(
                    completed_payload.get("product_snapshot")
                )
                completed_payload["subscription"] = membership
                return "completed", completed_payload

            balance_row = await conn.fetchrow(
                """
                UPDATE users
                SET credits = credits + $1, updated_at = NOW()
                WHERE id = $2
                RETURNING credits
                """,
                total_credits, paid_row["user_id"],
            )
            if not balance_row:
                raise RuntimeError("Paid order references a missing user")

            description = f"充值 {paid_row['amount_yuan']} 元 · 订单 {order_no}"
            tx_id = await conn.fetchval(
                """
                INSERT INTO credit_transactions
                    (user_id, amount, balance_after, type, related_task_id, description)
                VALUES ($1, $2, $3, $4, NULL, $5)
                RETURNING id
                """,
                paid_row["user_id"],
                total_credits,
                balance_row["credits"],
                "payment",
                description,
            )

            completed = await conn.fetchrow(
                """
                UPDATE payment_orders
                SET status = 'completed',
                    completed_at = NOW(),
                    credited_at = NOW(),
                    credit_transaction_id = $1,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING id::text, user_id::text, order_no, amount_yuan, credits,
                          bonus_credits, product_kind, product_id, product_name,
                          product_snapshot, status, paid_at::text, completed_at::text,
                          credit_transaction_id::text
                """,
                tx_id, paid_row["id"],
            )
            completed_payload = dict(completed)
            completed_payload["product_snapshot"] = _json_object(
                completed_payload.get("product_snapshot")
            )
            return "completed", completed_payload


async def get_user_orders(
    user_id: str,
    limit: int = 20,
    offset: int = 0,
) -> list[dict]:
    """获取用户订单列表"""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, order_no, amount_yuan, credits, bonus_credits,
                   product_kind, product_id, product_name, product_snapshot,
                   pay_channel, status, paid_at::text, expires_at::text,
                   cancelled_at::text, completed_at::text, created_at::text
            FROM payment_orders
            WHERE user_id = $1::uuid
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            user_id, limit, offset,
        )
        result = []
        for row in rows:
            payload = dict(row)
            payload["product_snapshot"] = _json_object(payload.get("product_snapshot"))
            result.append(payload)
        return result


async def get_all_orders(
    limit: int = 50,
    offset: int = 0,
    status: str = "",
) -> list[dict]:
    """获取所有订单（管理员用）"""
    async with acquire() as conn:
        if status:
            rows = await conn.fetch(
                """
                SELECT po.id::text, po.order_no, po.amount_yuan, po.credits, po.bonus_credits,
                       po.product_kind, po.product_id, po.product_name,
                       po.pay_channel, po.status, po.paid_at::text, po.expires_at::text,
                       po.cancelled_at::text, po.completed_at::text, po.created_at::text,
                       u.email as user_email
                FROM payment_orders po
                LEFT JOIN users u ON po.user_id = u.id
                WHERE po.status = $1
                ORDER BY po.created_at DESC
                LIMIT $2 OFFSET $3
                """,
                status, limit, offset,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT po.id::text, po.order_no, po.amount_yuan, po.credits, po.bonus_credits,
                       po.product_kind, po.product_id, po.product_name,
                       po.pay_channel, po.status, po.paid_at::text, po.expires_at::text,
                       po.cancelled_at::text, po.completed_at::text, po.created_at::text,
                       u.email as user_email
                FROM payment_orders po
                LEFT JOIN users u ON po.user_id = u.id
                ORDER BY po.created_at DESC
                LIMIT $1 OFFSET $2
                """,
                limit, offset,
            )
        return [dict(r) for r in rows]


async def get_finance_stats() -> dict:
    """获取财务统计数据"""
    async with acquire() as conn:
        # 平台总余额（全用户积分总和）
        total_balance = await conn.fetchval(
            "SELECT COALESCE(SUM(credits), 0) FROM users"
        )

        # 今日充值金额
        today_revenue = await conn.fetchval(
            """
            SELECT COALESCE(SUM(amount_yuan), 0)
            FROM payment_orders
            WHERE status IN ('paid', 'completed') AND DATE(paid_at) = CURRENT_DATE
            """
        )

        # 今日消费金额（按积分折算，1元=10积分）
        today_consumption_credits = await conn.fetchval(
            """
            SELECT COALESCE(SUM(ABS(amount)), 0)
            FROM credit_transactions
            WHERE type = 'consume' AND DATE(created_at) = CURRENT_DATE
            """
        )
        today_consumption_yuan = float(today_consumption_credits) / 10.0

        # 累计收入
        total_revenue = await conn.fetchval(
            """
            SELECT COALESCE(SUM(amount_yuan), 0)
            FROM payment_orders WHERE status IN ('paid', 'completed')
            """
        )

        # 今日新增用户
        today_new_users = await conn.fetchval(
            """
            SELECT COUNT(*) FROM users
            WHERE DATE(created_at) = CURRENT_DATE
            """
        )

        # 近30天每日充值
        daily_revenue = await conn.fetch(
            """
            SELECT DATE(paid_at) as date,
                   COALESCE(SUM(amount_yuan), 0) as revenue_yuan,
                   COALESCE(SUM(credits + bonus_credits), 0) as credits,
                   COUNT(DISTINCT user_id) as users
            FROM payment_orders
            WHERE status IN ('paid', 'completed') AND paid_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(paid_at)
            ORDER BY date
            """
        )

        # 近30天每日消费
        daily_consumption = await conn.fetch(
            """
            SELECT DATE(created_at) as date,
                   COALESCE(SUM(ABS(amount)), 0) as consumption_credits,
                   COUNT(*) as tasks
            FROM credit_transactions
            WHERE type = 'consume' AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date
            """
        )

        # 近30天新增用户
        daily_new_users = await conn.fetch(
            """
            SELECT DATE(created_at) as date,
                   COUNT(*) as new_users
            FROM users
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date
            """
        )

        return {
            "total_balance": float(total_balance),
            "today_revenue_yuan": float(today_revenue),
            "today_consumption_yuan": round(today_consumption_yuan, 2),
            "total_revenue_yuan": float(total_revenue) if total_revenue else 0.0,
            "today_new_users": today_new_users,
            "daily_revenue": [
                {
                    "date": str(r["date"]),
                    "revenue_yuan": float(r["revenue_yuan"]),
                    "credits": int(r["credits"]),
                    "users": r["users"],
                }
                for r in daily_revenue
            ],
            "daily_consumption": [
                {
                    "date": str(r["date"]),
                    "consumption_yuan": round(float(r["consumption_credits"]) / 10.0, 2),
                    "credits": int(r["consumption_credits"]),
                    "tasks": r["tasks"],
                }
                for r in daily_consumption
            ],
            "daily_new_users": [
                {
                    "date": str(r["date"]),
                    "new_users": r["new_users"],
                }
                for r in daily_new_users
            ],
        }


async def get_subscription_plans() -> list[dict]:
    """Return enabled prepaid membership plans in display order."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, description, badge_label, price_yuan, credits,
                   duration_days, benefits, sort_order
            FROM subscription_plans
            WHERE enabled = TRUE
            ORDER BY sort_order ASC, price_yuan ASC, id ASC
            """
        )
        return [_subscription_plan_payload(row) for row in rows]


async def get_subscription_plan(plan_id: str) -> Optional[dict]:
    """Resolve one enabled plan; callers must use this server-side price."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, description, badge_label, price_yuan, credits,
                   duration_days, benefits, sort_order
            FROM subscription_plans
            WHERE id = $1 AND enabled = TRUE
            """,
            str(plan_id or "").strip(),
        )
        return _subscription_plan_payload(row) if row else None


async def get_subscription_status(user_id: str) -> dict:
    from repositories.membership_wallet_repo import get_wallet_snapshot

    snapshot = await get_wallet_snapshot(user_id)
    active_cards = [card for card in snapshot["cards"] if card["status"] == "active"]
    selected = next(
        (card for card in active_cards if card["id"] == snapshot["selected_subscription_id"]),
        active_cards[0] if active_cards else None,
    )
    if not selected:
        return {
            "active": False,
            "plan_id": None,
            "name": None,
            "badge_label": None,
            "starts_at": None,
            "expires_at": None,
            "wallet": snapshot,
        }
    from datetime import datetime, timezone

    expires_at = datetime.fromisoformat(str(selected["expires_at"]).replace("Z", "+00:00"))
    days_remaining = max(0, int((expires_at - datetime.now(timezone.utc)).total_seconds() / 86400) + 1)
    return {
        "active": True,
        "plan_id": selected["plan_id"],
        "name": selected["plan_name"],
        "badge_label": selected.get("badge_label") or "",
        "starts_at": selected["starts_at"],
        "expires_at": selected["expires_at"],
        "days_remaining": days_remaining,
        "quota_total": selected["quota_total"],
        "quota_remaining": selected["quota_remaining"],
        "wallet": snapshot,
    }

async def get_packages() -> list[dict]:
    """获取充值套餐列表"""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, amount_yuan, base_credits, bonus_credits,
                   discount_label, sort_order
            FROM (
                SELECT DISTINCT ON (amount_yuan)
                    id, amount_yuan, base_credits, bonus_credits,
                    discount_label, sort_order, created_at
                FROM recharge_packages
                WHERE enabled = TRUE
                ORDER BY amount_yuan, sort_order ASC, created_at DESC
            ) deduped
            ORDER BY sort_order ASC, amount_yuan ASC
            """
        )
        return [dict(r) for r in rows]


async def get_all_packages(include_disabled: bool = False) -> list[dict]:
    where = "" if include_disabled else "WHERE enabled = TRUE"
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id::text, amount_yuan, base_credits, bonus_credits,
                   discount_label, sort_order, enabled, created_at::text
            FROM recharge_packages
            {where}
            ORDER BY enabled DESC, sort_order ASC, amount_yuan ASC, created_at DESC
            """
        )
        return [dict(r) for r in rows]


async def get_current_package_configs() -> list[dict]:
    """获取后台当前套餐配置。历史禁用行不回灌到后台表单。"""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, amount_yuan, base_credits, bonus_credits,
                   discount_label, sort_order, enabled, created_at::text
            FROM (
                SELECT DISTINCT ON (amount_yuan)
                    id, amount_yuan, base_credits, bonus_credits,
                    discount_label, sort_order, enabled, created_at
                FROM recharge_packages
                WHERE enabled = TRUE
                ORDER BY amount_yuan, sort_order ASC, created_at DESC
            ) current_packages
            ORDER BY sort_order ASC, amount_yuan ASC
            """
        )
        return [dict(r) for r in rows]


async def replace_packages(packages: list[dict]) -> list[dict]:
    """后台批量保存套餐。保留历史订单，套餐表只保留当前配置。"""
    async with acquire() as conn:
        async with conn.transaction():
            await conn.execute("UPDATE recharge_packages SET enabled = FALSE")
            for index, item in enumerate(packages, start=1):
                amount = int(item["amount_yuan"])
                base = int(item["base_credits"])
                bonus = int(item.get("bonus_credits") or 0)
                label = item.get("discount_label") or None
                enabled = bool(item.get("enabled", True))
                await conn.execute(
                    """
                    INSERT INTO recharge_packages
                        (amount_yuan, base_credits, bonus_credits, discount_label, sort_order, enabled)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    amount, base, bonus, label, int(item.get("sort_order") or index), enabled,
                )
    return await get_current_package_configs()


async def get_payment_settings() -> dict:
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        row = await conn.fetchrow(
            "SELECT value FROM system_settings WHERE key = 'payment_settings'"
        )
    return normalize_payment_settings(row["value"] if row else None)


async def update_payment_settings(value: dict) -> dict:
    settings = normalize_payment_settings(value)
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        await conn.execute(
            """
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('payment_settings', $1::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            json.dumps(settings),
        )
    return settings


def _channel_label(channel_code: str) -> str:
    if channel_code == "zpay":
        return "Z-Pay 在线支付"
    return channel_code


async def get_channel_statuses() -> dict[str, dict]:
    rows = await get_all_channels()
    by_code = {str(row["channel_code"]): row for row in rows}
    statuses: dict[str, dict] = {}

    for channel_code in ("zpay",):
        row = by_code.get(channel_code, {})
        enabled = bool(row.get("enabled"))
        configured = all(
            bool(str(row.get(key, "")).strip())
            for key in ("api_url", "merchant_id", "merchant_key", "notify_url", "return_url")
        )
        statuses[channel_code] = {
            "code": channel_code,
            "label": row.get("channel_name") or _channel_label(channel_code),
            "enabled": enabled,
            "configured": configured,
            "available": enabled and configured,
        }

    return statuses


async def get_channel(channel_code: str) -> Optional[dict]:
    """获取支付渠道配置"""
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        row = await conn.fetchrow(
            "SELECT * FROM payment_channels WHERE channel_code = $1", channel_code
        )
        return dict(row) if row else None


async def get_all_channels() -> list[dict]:
    """获取所有支付渠道配置"""
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        rows = await conn.fetch(
            "SELECT * FROM payment_channels WHERE channel_code = 'zpay' ORDER BY channel_code"
        )
        return [dict(r) for r in rows]


async def update_channel(
    channel_code: str,
    merchant_id: str = "",
    merchant_key: str = "",
    api_url: str = "",
    notify_url: str = "",
    return_url: str = "",
    enabled: bool = False,
    config_json: dict = None,
) -> bool:
    """更新支付渠道配置"""
    import json
    async with acquire() as conn:
        await ensure_zpay_schema(conn)
        result = await conn.execute(
            """
            UPDATE payment_channels
            SET merchant_id = $1, merchant_key = $2, api_url = $3,
                notify_url = $4, return_url = $5, enabled = $6,
                config_json = $7::jsonb, updated_at = NOW()
            WHERE channel_code = $8
            """,
            merchant_id, merchant_key, api_url, notify_url, return_url,
            enabled, json.dumps(config_json or {}), channel_code,
        )
        return result == "UPDATE 1"
