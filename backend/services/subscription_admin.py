"""Administrative subscription lifecycle operations behind one transactional interface."""
from __future__ import annotations

import json
import re
from contextlib import AbstractAsyncContextManager
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable

from core.pool import acquire


class SubscriptionAdminError(ValueError):
    """Raised when an administrative subscription action is invalid."""


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


def _row_payload(row: object | None) -> dict | None:
    if row is None:
        return None
    payload = dict(row)
    if "benefits" in payload:
        payload["benefits"] = _json_array(payload.get("benefits"))
    return payload


def _operation_key(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise SubscriptionAdminError("缺少操作幂等键，请刷新页面后重试")
    if len(normalized) > 160:
        raise SubscriptionAdminError("操作幂等键过长")
    return normalized


class SubscriptionAdminModule:
    """Deep module for plan configuration and user subscription operations."""

    def __init__(
        self,
        acquire_connection: Callable[[], AbstractAsyncContextManager[Any]] = acquire,
    ) -> None:
        self._acquire = acquire_connection

    async def dashboard(
        self,
        *,
        status: str = "",
        query: str = "",
        limit: int = 200,
    ) -> dict:
        normalized_status = str(status or "").strip().lower()
        if normalized_status not in ("", "active", "queued", "exhausted", "expired", "revoked"):
            raise SubscriptionAdminError("不支持的订阅状态筛选")
        normalized_query = str(query or "").strip()
        safe_limit = min(500, max(1, int(limit)))

        async with self._acquire() as conn:
            summary = await conn.fetchrow(
                """
                SELECT
                    COUNT(*) FILTER (
                        WHERE us.status = 'active'
                          AND us.starts_at <= NOW()
                          AND us.expires_at > NOW()
                    )::int AS active_count,
                    COUNT(*) FILTER (
                        WHERE us.status = 'active'
                          AND us.expires_at > NOW()
                          AND us.expires_at <= NOW() + INTERVAL '7 days'
                    )::int AS expiring_7d_count,
                    COUNT(*) FILTER (WHERE us.status = 'revoked')::int AS revoked_count,
                    COALESCE(SUM(us.quota_remaining) FILTER (
                        WHERE us.status = 'active' AND us.expires_at > NOW()
                    ), 0)::numeric AS active_quota_credits,
                    COUNT(DISTINCT us.user_id) FILTER (
                        WHERE us.status = 'active' AND us.expires_at > NOW()
                    )::int AS subscribed_users
                FROM user_subscriptions us
                """
            )
            plans = await conn.fetch(
                """
                SELECT id, name, description, badge_label, price_yuan, credits,
                       duration_days, benefits, enabled, sort_order,
                       created_at::text, updated_at::text
                FROM subscription_plans
                ORDER BY sort_order ASC, price_yuan ASC, id ASC
                """
            )
            subscriptions = await conn.fetch(
                """
                WITH records AS (
                    SELECT us.id::text, us.user_id::text, u.email, u.display_name,
                           u.billing_mode, us.plan_id, sp.name AS plan_name,
                           sp.badge_label, us.payment_order_id::text,
                           us.source, us.status, us.starts_at::text, us.expires_at::text,
                           us.credits_granted, us.quota_total, us.quota_remaining,
                           us.activated_at::text, us.exhausted_at::text,
                           CASE WHEN us.status = 'queued' THEN (
                               SELECT COUNT(*)::int FROM user_subscriptions earlier
                               WHERE earlier.user_id = us.user_id
                                 AND earlier.plan_id = us.plan_id
                                 AND earlier.status = 'queued'
                                 AND (earlier.created_at, earlier.id) <= (us.created_at, us.id)
                           ) ELSE NULL END AS queue_position,
                           us.quota_reset_count,
                           us.last_quota_reset_at::text, us.assigned_by, us.note,
                           us.revoked_at::text, us.revoked_by, us.revoke_reason,
                           us.created_at::text, us.updated_at::text,
                           CASE
                               WHEN us.status = 'active' AND us.expires_at <= NOW() THEN 'expired'
                               WHEN us.status = 'active' AND us.quota_remaining <= 0 THEN 'exhausted'
                               ELSE us.status
                           END AS effective_status
                    FROM user_subscriptions us
                    JOIN users u ON u.id = us.user_id
                    JOIN subscription_plans sp ON sp.id = us.plan_id
                )
                SELECT *
                FROM records
                WHERE ($1 = '' OR effective_status = $1)
                  AND (
                      $2 = ''
                      OR email ILIKE '%' || $2 || '%'
                      OR COALESCE(display_name, '') ILIKE '%' || $2 || '%'
                      OR user_id = $2
                      OR plan_name ILIKE '%' || $2 || '%'
                  )
                ORDER BY created_at DESC
                LIMIT $3
                """,
                normalized_status,
                normalized_query,
                safe_limit,
            )
            audits = await conn.fetch(
                """
                SELECT a.id::text, a.subscription_id::text, a.user_id::text,
                       u.email, a.plan_id, sp.name AS plan_name, a.action,
                       a.actor, a.reason, a.metadata, a.created_at::text
                FROM subscription_admin_audit a
                LEFT JOIN users u ON u.id = a.user_id
                LEFT JOIN subscription_plans sp ON sp.id = a.plan_id
                ORDER BY a.created_at DESC
                LIMIT 100
                """
            )

        return {
            "summary": dict(summary or {}),
            "plans": [_row_payload(row) for row in plans],
            "subscriptions": [dict(row) for row in subscriptions],
            "audit": [dict(row) for row in audits],
        }

    async def search_users(self, query: str, *, limit: int = 20) -> list[dict]:
        normalized = str(query or "").strip()
        if len(normalized) < 2:
            return []
        async with self._acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id::text, email, display_name, billing_mode, status, credits
                FROM users
                WHERE email ILIKE '%' || $1 || '%'
                   OR COALESCE(display_name, '') ILIKE '%' || $1 || '%'
                   OR id::text = $1
                ORDER BY (lower(email) = lower($1)) DESC, created_at DESC
                LIMIT $2
                """,
                normalized,
                min(50, max(1, int(limit))),
            )
        return [dict(row) for row in rows]

    async def save_plan(
        self,
        *,
        plan_id: str,
        name: str,
        description: str,
        badge_label: str,
        price_yuan: Decimal,
        credits: int,
        duration_days: int,
        benefits: list[str],
        enabled: bool,
        sort_order: int,
        operation_key: str,
        actor: str = "admin",
    ) -> dict:
        key = _operation_key(operation_key)
        normalized_plan_id = str(plan_id or "").strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", normalized_plan_id):
            raise SubscriptionAdminError("套餐 ID 必须以小写字母开头，且只能包含小写字母、数字和下划线")
        normalized_name = str(name or "").strip()
        if not normalized_name:
            raise SubscriptionAdminError("套餐名称不能为空")
        snapshot = {
            "name": normalized_name,
            "description": description,
            "badge_label": badge_label,
            "price_yuan": str(price_yuan),
            "credits": int(credits),
            "duration_days": int(duration_days),
            "benefits": list(benefits),
            "enabled": bool(enabled),
            "sort_order": int(sort_order),
        }
        async with self._acquire() as conn:
            async with conn.transaction():
                replay = await self._lock_and_find_replay(conn, key)
                if replay:
                    existing = await self._get_plan(conn, normalized_plan_id)
                    if existing:
                        return existing
                row = await conn.fetchrow(
                    """
                    INSERT INTO subscription_plans
                        (id, name, description, badge_label, price_yuan, credits,
                         duration_days, benefits, enabled, sort_order)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        badge_label = EXCLUDED.badge_label,
                        price_yuan = EXCLUDED.price_yuan,
                        credits = EXCLUDED.credits,
                        duration_days = EXCLUDED.duration_days,
                        benefits = EXCLUDED.benefits,
                        enabled = EXCLUDED.enabled,
                        sort_order = EXCLUDED.sort_order,
                        updated_at = NOW()
                    RETURNING id, name, description, badge_label, price_yuan,
                              credits, duration_days, benefits, enabled, sort_order,
                              created_at::text, updated_at::text
                    """,
                    normalized_plan_id,
                    normalized_name,
                    str(description).strip(),
                    str(badge_label).strip(),
                    price_yuan,
                    int(credits),
                    int(duration_days),
                    json.dumps(benefits, ensure_ascii=False),
                    bool(enabled),
                    int(sort_order),
                )
                await self._audit(
                    conn,
                    action="plan_saved",
                    operation_key=key,
                    actor=actor,
                    plan_id=normalized_plan_id,
                    metadata=snapshot,
                )
        return _row_payload(row) or {}

    async def assign(
        self,
        *,
        user_ref: str,
        plan_id: str,
        operation_key: str,
        duration_days: int | None = None,
        quota_credits: int | None = None,
        note: str = "",
        actor: str = "admin",
    ) -> dict:
        key = _operation_key(operation_key)
        normalized_user_ref = str(user_ref or "").strip()
        normalized_plan_id = str(plan_id or "").strip()
        async with self._acquire() as conn:
            async with conn.transaction():
                replay = await self._lock_and_find_replay(conn, key)
                if replay and replay.get("subscription_id"):
                    existing = await self._get_subscription(conn, replay["subscription_id"])
                    if existing:
                        return existing

                plan = await conn.fetchrow(
                    """
                    SELECT id, name, description, badge_label, price_yuan, credits,
                           duration_days, benefits, enabled, sort_order
                    FROM subscription_plans
                    WHERE id = $1 AND enabled = TRUE
                    FOR SHARE
                    """,
                    normalized_plan_id,
                )
                if not plan:
                    raise SubscriptionAdminError("套餐不存在或已下架")
                user = await conn.fetchrow(
                    """
                    SELECT id::text, email, display_name, billing_mode, status, credits
                    FROM users
                    WHERE id::text = $1 OR lower(email) = lower($1)
                    FOR UPDATE
                    """,
                    normalized_user_ref,
                )
                if not user:
                    raise SubscriptionAdminError("用户不存在")
                if user["status"] != "active":
                    raise SubscriptionAdminError("用户账号当前不可用")
                if user["billing_mode"] == "external_api_key":
                    raise SubscriptionAdminError("FoxAPI密钥账号不能分配平台会员")

                resolved_duration = int(duration_days or plan["duration_days"])
                resolved_quota = int(plan["credits"] if quota_credits is None else quota_credits)
                if resolved_duration <= 0 or resolved_duration > 3650:
                    raise SubscriptionAdminError("会员有效期必须在 1 到 3650 天之间")
                if resolved_quota < 0 or resolved_quota > 100_000_000:
                    raise SubscriptionAdminError("积分配额超出允许范围")
                plan_snapshot = {
                    "id": str(plan["id"]),
                    "name": str(plan["name"]),
                    "description": str(plan.get("description") or ""),
                    "badge_label": str(plan.get("badge_label") or ""),
                    "price_yuan": str(plan["price_yuan"]),
                    "credits": resolved_quota,
                    "duration_days": resolved_duration,
                    "benefits": _json_array(plan.get("benefits")),
                    "source": "admin",
                }
                from repositories.membership_wallet_repo import create_membership_card

                subscription = await create_membership_card(
                    conn,
                    user_id=str(user["id"]),
                    plan_id=normalized_plan_id,
                    quota=resolved_quota,
                    duration_days=resolved_duration,
                    plan_snapshot=plan_snapshot,
                    payment_order_id=None,
                    source="admin",
                    assigned_by=actor,
                    note=str(note or "").strip(),
                )
                if resolved_quota:
                    await conn.fetchval(
                        """
                        INSERT INTO credit_transactions
                            (user_id, amount, balance_after, type, related_task_id,
                             description, balance_source, subscription_id)
                        VALUES ($1::uuid, $2, $2, 'subscription', NULL, $3,
                                'subscription', $4::uuid)
                        RETURNING id::text
                        """,
                        user["id"],
                        resolved_quota,
                        f"Admin assigned membership {plan['name']}",
                        subscription["id"],
                    )
                await self._audit(
                    conn,
                    action="assigned",
                    operation_key=key,
                    actor=actor,
                    subscription_id=subscription["id"],
                    user_id=user["id"],
                    plan_id=normalized_plan_id,
                    reason=str(note or "").strip(),
                    metadata={
                        "duration_days": resolved_duration,
                        "quota_total": resolved_quota,
                        "status": subscription["status"],
                    },
                )
                return {
                    **subscription,
                    "email": user["email"],
                    "display_name": user.get("display_name"),
                    "billing_mode": user["billing_mode"],
                    "plan_name": plan["name"],
                    "badge_label": plan.get("badge_label") or "",
                    "effective_status": subscription["status"],
                }

    async def revoke(
        self,
        *,
        subscription_id: str,
        operation_key: str,
        reason: str,
        actor: str = "admin",
    ) -> dict:
        key = _operation_key(operation_key)
        async with self._acquire() as conn:
            async with conn.transaction():
                replay = await self._lock_and_find_replay(conn, key)
                if replay and replay.get("subscription_id"):
                    existing = await self._get_subscription(conn, replay["subscription_id"])
                    if existing:
                        return existing
                current = await self._get_subscription(conn, subscription_id, for_update=True)
                if not current:
                    raise SubscriptionAdminError("订阅记录不存在")
                if current["status"] == "revoked":
                    return current
                updated = await conn.fetchrow(
                    """
                    UPDATE user_subscriptions
                    SET status = 'revoked', revoked_at = NOW(), revoked_by = $2,
                        revoke_reason = $3, updated_at = NOW()
                    WHERE id = $1::uuid
                    RETURNING status, revoked_at::text, revoked_by, revoke_reason,
                              updated_at::text
                    """,
                    subscription_id,
                    actor,
                    str(reason or "").strip(),
                )
                current.update(dict(updated))
                current["effective_status"] = "revoked"
                from repositories.membership_wallet_repo import reconcile_user_memberships
                await reconcile_user_memberships(conn, current["user_id"])
                await self._audit(
                    conn,
                    action="revoked",
                    operation_key=key,
                    actor=actor,
                    subscription_id=subscription_id,
                    user_id=current["user_id"],
                    plan_id=current["plan_id"],
                    reason=str(reason or "").strip(),
                    metadata={"quota_forfeited": float(current.get("quota_remaining") or 0)},
                )
        return current

    async def reset_quota(
        self,
        *,
        subscription_id: str,
        operation_key: str,
        reason: str,
        actor: str = "admin",
    ) -> dict:
        key = _operation_key(operation_key)
        async with self._acquire() as conn:
            async with conn.transaction():
                replay = await self._lock_and_find_replay(conn, key)
                if replay and replay.get("subscription_id"):
                    existing = await self._get_subscription(conn, replay["subscription_id"])
                    if existing:
                        return existing
                current = await self._get_subscription(conn, subscription_id, for_update=True)
                if not current:
                    raise SubscriptionAdminError("订阅记录不存在")
                if current["status"] != "active":
                    raise SubscriptionAdminError("只有有效订阅可以重置配额")
                expires_at = datetime.fromisoformat(str(current["expires_at"]).replace("Z", "+00:00"))
                if expires_at <= datetime.now(timezone.utc):
                    raise SubscriptionAdminError("订阅已过期，不能重置配额")

                quota = float(current.get("quota_total") or current["credits_granted"] or 0)
                updated = await conn.fetchrow(
                    """
                    UPDATE user_subscriptions
                    SET quota_remaining = quota_total,
                        quota_reset_count = quota_reset_count + 1,
                        last_quota_reset_at = NOW(), updated_at = NOW()
                    WHERE id = $1::uuid
                    RETURNING quota_total, quota_remaining, quota_reset_count,
                              last_quota_reset_at::text, updated_at::text
                    """,
                    subscription_id,
                )
                current.update(dict(updated))
                await self._audit(
                    conn,
                    action="quota_reset",
                    operation_key=key,
                    actor=actor,
                    subscription_id=subscription_id,
                    user_id=current["user_id"],
                    plan_id=current["plan_id"],
                    reason=str(reason or "").strip(),
                    metadata={"quota_total": quota, "quota_remaining": quota},
                )
                return current

    async def _lock_and_find_replay(self, conn: Any, operation_key: str) -> dict | None:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            f"subscription-admin:{operation_key}",
        )
        row = await conn.fetchrow(
            """
            SELECT subscription_id::text, plan_id, action
            FROM subscription_admin_audit
            WHERE operation_key = $1
            """,
            operation_key,
        )
        return dict(row) if row else None

    async def _get_plan(self, conn: Any, plan_id: str) -> dict | None:
        row = await conn.fetchrow(
            """
            SELECT id, name, description, badge_label, price_yuan, credits,
                   duration_days, benefits, enabled, sort_order,
                   created_at::text, updated_at::text
            FROM subscription_plans
            WHERE id = $1
            """,
            plan_id,
        )
        return _row_payload(row)

    async def _get_subscription(
        self,
        conn: Any,
        subscription_id: str,
        *,
        for_update: bool = False,
    ) -> dict | None:
        lock_clause = "FOR UPDATE OF us" if for_update else ""
        row = await conn.fetchrow(
            f"""
            SELECT us.id::text, us.user_id::text, u.email, u.display_name,
                   u.billing_mode, us.plan_id, sp.name AS plan_name,
                   sp.badge_label, us.payment_order_id::text, us.source,
                   us.status, us.starts_at::text, us.expires_at::text,
                   us.credits_granted, us.quota_total, us.quota_remaining,
                   us.activated_at::text, us.exhausted_at::text,
                   us.quota_reset_count,
                   us.last_quota_reset_at::text, us.assigned_by, us.note,
                   us.revoked_at::text, us.revoked_by, us.revoke_reason,
                   us.created_at::text, us.updated_at::text,
                   CASE
                       WHEN us.status = 'active' AND us.expires_at <= NOW() THEN 'expired'
                       WHEN us.status = 'active' AND us.quota_remaining <= 0 THEN 'exhausted'
                       ELSE us.status
                   END AS effective_status
            FROM user_subscriptions us
            JOIN users u ON u.id = us.user_id
            JOIN subscription_plans sp ON sp.id = us.plan_id
            WHERE us.id = $1::uuid
            {lock_clause}
            """,
            subscription_id,
        )
        return dict(row) if row else None

    async def _audit(
        self,
        conn: Any,
        *,
        action: str,
        operation_key: str,
        actor: str,
        subscription_id: str | None = None,
        user_id: str | None = None,
        plan_id: str | None = None,
        reason: str = "",
        metadata: dict | None = None,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO subscription_admin_audit
                (subscription_id, user_id, plan_id, action, actor, reason,
                 operation_key, metadata)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)
            """,
            subscription_id,
            user_id,
            plan_id,
            action,
            actor,
            reason,
            operation_key,
            json.dumps(metadata or {}, ensure_ascii=False, default=str),
        )


subscription_admin = SubscriptionAdminModule()
