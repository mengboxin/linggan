"""Independent pay-as-you-go and membership-card wallet lifecycle."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Optional

from core.pool import acquire
from services import foxapi_credentials


METERED = "metered"
SUBSCRIPTION = "subscription"
VALID_FUNDING_SOURCES = {METERED, SUBSCRIPTION}


class MembershipWalletError(ValueError):
    """A wallet selection or debit is invalid."""


class WalletIdempotencyConflict(MembershipWalletError):
    """An idempotency key was reused for another wallet mutation."""


@dataclass(frozen=True)
class FundingWallet:
    user_id: str
    funding_source: str
    subscription_id: str | None
    balance: float

    @property
    def aggregate_key(self) -> str:
        if self.funding_source == SUBSCRIPTION and self.subscription_id:
            return f"credit_reserve:subscription:{self.subscription_id}"
        return f"credit_reserve:metered:{self.user_id}"


def _row_dict(row: object | None) -> dict | None:
    return dict(row) if row else None


def _json_object(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}


async def _activate_waiting_cards(conn: Any, user_id: str) -> None:
    """Activate the first queued card for every plan without an active card."""
    await conn.execute(
        """
        WITH candidates AS (
            SELECT queued.id,
                   COALESCE(
                       CASE
                           WHEN COALESCE(queued.plan_snapshot->>'duration_days', '') ~ '^[0-9]+$'
                           THEN (queued.plan_snapshot->>'duration_days')::int
                       END,
                       sp.duration_days
                   ) AS duration_days,
                   ROW_NUMBER() OVER (
                       PARTITION BY queued.plan_id
                       ORDER BY queued.created_at, queued.id
                   ) AS queue_rank
            FROM user_subscriptions queued
            JOIN subscription_plans sp ON sp.id = queued.plan_id
            WHERE queued.user_id = $1::uuid
              AND queued.status = 'queued'
              AND queued.quota_remaining > 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM user_subscriptions active
                  WHERE active.user_id = queued.user_id
                    AND active.plan_id = queued.plan_id
                    AND active.status = 'active'
                    AND active.quota_remaining > 0
                    AND active.expires_at > NOW()
              )
        )
        UPDATE user_subscriptions us
        SET status = 'active',
            starts_at = NOW(),
            activated_at = NOW(),
            expires_at = NOW() + make_interval(days => candidates.duration_days),
            updated_at = NOW()
        FROM candidates
        WHERE candidates.id = us.id AND candidates.queue_rank = 1
        """,
        user_id,
    )


async def reconcile_user_memberships(conn: Any, user_id: str) -> None:
    """Advance expired/exhausted cards and repair the selected-card pointer."""
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        f"membership-wallet:{user_id}",
    )
    await conn.execute(
        """
        UPDATE user_subscriptions
        SET status = 'expired', updated_at = NOW()
        WHERE user_id = $1::uuid
          AND status = 'active'
          AND expires_at <= NOW()
        """,
        user_id,
    )
    await conn.execute(
        """
        UPDATE user_subscriptions
        SET status = 'exhausted', exhausted_at = COALESCE(exhausted_at, NOW()),
            updated_at = NOW()
        WHERE user_id = $1::uuid
          AND status = 'active'
          AND quota_remaining <= 0
        """,
        user_id,
    )
    await _activate_waiting_cards(conn, user_id)

    preference = await conn.fetchrow(
        """
        SELECT preference.funding_source,
               preference.selected_subscription_id::text,
               selected.plan_id AS selected_plan_id
        FROM user_billing_preferences preference
        LEFT JOIN user_subscriptions selected
          ON selected.id = preference.selected_subscription_id
        WHERE preference.user_id = $1::uuid
        FOR UPDATE OF preference
        """,
        user_id,
    )
    if not preference or preference["funding_source"] != SUBSCRIPTION:
        return
    selected = await conn.fetchrow(
        """
        SELECT id
        FROM user_subscriptions
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'active'
          AND quota_remaining > 0 AND expires_at > NOW()
        """,
        preference["selected_subscription_id"],
        user_id,
    ) if preference["selected_subscription_id"] else None
    if selected:
        return
    replacement = await conn.fetchval(
        """
        SELECT id
        FROM user_subscriptions
        WHERE user_id = $1::uuid AND status = 'active'
          AND quota_remaining > 0 AND expires_at > NOW()
        ORDER BY (plan_id = $2) DESC, created_at, id
        LIMIT 1
        """,
        user_id,
        preference["selected_plan_id"],
    )
    await conn.execute(
        """
        UPDATE user_billing_preferences
        SET funding_source = CASE WHEN $2::uuid IS NULL THEN 'metered' ELSE 'subscription' END,
            selected_subscription_id = $2::uuid,
            updated_at = NOW()
        WHERE user_id = $1::uuid
        """,
        user_id,
        replacement,
    )


async def create_membership_card(
    conn: Any,
    *,
    user_id: str,
    plan_id: str,
    quota: float,
    duration_days: int,
    plan_snapshot: dict,
    payment_order_id: str | None,
    source: str,
    assigned_by: str | None = None,
    note: str = "",
) -> dict:
    """Create one independent card, queuing duplicate plan purchases."""
    await reconcile_user_memberships(conn, user_id)
    has_active_same_plan = bool(await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM user_subscriptions
            WHERE user_id = $1::uuid AND plan_id = $2 AND status = 'active'
              AND quota_remaining > 0 AND expires_at > NOW()
        )
        """,
        user_id,
        plan_id,
    ))
    status = "queued" if has_active_same_plan else "active"
    row = await conn.fetchrow(
        """
        INSERT INTO user_subscriptions
            (user_id, plan_id, payment_order_id, status, starts_at, expires_at,
             activated_at, credits_granted, quota_total, quota_remaining,
             plan_snapshot, source, assigned_by, note)
        VALUES
            ($1::uuid, $2, $3::uuid, $4,
             CASE WHEN $4 = 'active' THEN NOW() ELSE NULL END,
             CASE WHEN $4 = 'active' THEN NOW() + make_interval(days => $6::int) ELSE NULL END,
             CASE WHEN $4 = 'active' THEN NOW() ELSE NULL END,
             $5, $5, $5, $7::jsonb, $8, $9, $10)
        ON CONFLICT (payment_order_id) DO NOTHING
        RETURNING id::text, user_id::text, plan_id, payment_order_id::text,
                  status, starts_at::text, expires_at::text, activated_at::text,
                  quota_total, quota_remaining, credits_granted, plan_snapshot,
                  source, assigned_by, note, created_at::text, updated_at::text
        """,
        user_id,
        plan_id,
        payment_order_id,
        status,
        quota,
        duration_days,
        json.dumps(plan_snapshot, ensure_ascii=False, default=str),
        source,
        assigned_by,
        str(note or "").strip(),
    )
    if not row:
        raise MembershipWalletError("membership card already exists for payment order")

    # A first membership defaults to membership funding. Existing user choice
    # is preserved, including an explicit preference for pay-as-you-go credits.
    await conn.execute(
        """
        INSERT INTO user_billing_preferences
            (user_id, funding_source, selected_subscription_id)
        VALUES (
            $1::uuid,
            CASE WHEN $2 = 'active' THEN 'subscription' ELSE 'metered' END,
            CASE WHEN $2 = 'active' THEN $3::uuid ELSE NULL END
        )
        ON CONFLICT (user_id) DO NOTHING
        """,
        user_id,
        status,
        row["id"],
    )
    return dict(row)


async def resolve_funding_wallet(
    user_id: str,
    *,
    model_id: Optional[str] = None,
) -> FundingWallet:
    """Resolve the wallet selected for a new reservation."""
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return FundingWallet(user_id, METERED, None, 0.0)
    async with acquire() as conn:
        async with conn.transaction():
            await reconcile_user_memberships(conn, user_id)
            row = await conn.fetchrow(
                """
                SELECT u.credits,
                       COALESCE(preference.funding_source, 'metered') AS funding_source,
                       preference.selected_subscription_id::text AS subscription_id,
                       selected.quota_remaining
                FROM users u
                LEFT JOIN user_billing_preferences preference ON preference.user_id = u.id
                LEFT JOIN user_subscriptions selected
                  ON selected.id = preference.selected_subscription_id
                 AND selected.user_id = u.id
                 AND selected.status = 'active'
                 AND selected.quota_remaining > 0
                 AND selected.expires_at > NOW()
                WHERE u.id = $1::uuid
                """,
                user_id,
            )
    if not row:
        raise MembershipWalletError("user does not exist")
    source = str(row["funding_source"] or METERED)
    subscription_id = str(row["subscription_id"]) if row["subscription_id"] else None
    if source == SUBSCRIPTION and subscription_id:
        return FundingWallet(user_id, source, subscription_id, float(row["quota_remaining"] or 0))
    return FundingWallet(user_id, METERED, None, float(row["credits"] or 0))


async def get_wallet_snapshot(user_id: str) -> dict:
    """Return both wallets, cards, queue positions, and current selection."""
    if await foxapi_credentials.uses_external_billing(user_id):
        return {
            "billing_mode": foxapi_credentials.BILLING_MODE,
            "funding_source": None,
            "selected_subscription_id": None,
            "spendable_balance": 0,
            "metered_balance": 0,
            "cards": [],
        }
    async with acquire() as conn:
        async with conn.transaction():
            await reconcile_user_memberships(conn, user_id)
            user = await conn.fetchrow(
                """
                SELECT u.credits,
                       COALESCE(preference.funding_source, 'metered') AS funding_source,
                       preference.selected_subscription_id::text
                FROM users u
                LEFT JOIN user_billing_preferences preference ON preference.user_id = u.id
                WHERE u.id = $1::uuid
                """,
                user_id,
            )
            rows = await conn.fetch(
                """
                SELECT us.id::text, us.plan_id, sp.name AS plan_name,
                       sp.badge_label, us.status, us.quota_total,
                       us.quota_remaining, us.starts_at::text,
                       us.activated_at::text, us.expires_at::text,
                       us.exhausted_at::text, us.created_at::text,
                       CASE WHEN us.status = 'queued' THEN (
                           SELECT COUNT(*)::int
                           FROM user_subscriptions earlier
                           WHERE earlier.user_id = us.user_id
                             AND earlier.plan_id = us.plan_id
                             AND earlier.status = 'queued'
                             AND (earlier.created_at, earlier.id) <= (us.created_at, us.id)
                       ) ELSE NULL END AS queue_position
                FROM user_subscriptions us
                JOIN subscription_plans sp ON sp.id = us.plan_id
                WHERE us.user_id = $1::uuid
                ORDER BY
                    CASE us.status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                    us.created_at, us.id
                """,
                user_id,
            )
    if not user:
        raise MembershipWalletError("user does not exist")
    cards = [dict(row) for row in rows]
    for card in cards:
        card["quota_total"] = float(card.get("quota_total") or 0)
        card["quota_remaining"] = float(card.get("quota_remaining") or 0)
    selected_id = str(user["selected_subscription_id"]) if user["selected_subscription_id"] else None
    source = str(user["funding_source"] or METERED)
    selected = next((card for card in cards if card["id"] == selected_id and card["status"] == "active"), None)
    if source != SUBSCRIPTION or selected is None:
        source = METERED
        selected_id = None
        spendable = float(user["credits"] or 0)
    else:
        spendable = float(selected["quota_remaining"])
    return {
        "billing_mode": foxapi_credentials.PLATFORM_BILLING_MODE,
        "funding_source": source,
        "selected_subscription_id": selected_id,
        "spendable_balance": spendable,
        "metered_balance": float(user["credits"] or 0),
        "cards": cards,
    }


async def set_funding_preference(
    user_id: str,
    funding_source: str,
    subscription_id: str | None = None,
) -> dict:
    source = str(funding_source or "").strip().lower()
    if source not in VALID_FUNDING_SOURCES:
        raise MembershipWalletError("invalid funding source")
    if await foxapi_credentials.uses_external_billing(user_id):
        raise MembershipWalletError("external API-key accounts do not use platform wallets")
    async with acquire() as conn:
        async with conn.transaction():
            await reconcile_user_memberships(conn, user_id)
            selected_id: str | None = None
            if source == SUBSCRIPTION:
                selected = await conn.fetchrow(
                    """
                    SELECT id::text
                    FROM user_subscriptions
                    WHERE id = $1::uuid AND user_id = $2::uuid
                      AND status = 'active' AND quota_remaining > 0 AND expires_at > NOW()
                    """,
                    subscription_id,
                    user_id,
                ) if subscription_id else None
                if not selected:
                    raise MembershipWalletError("selected membership card is not active")
                selected_id = str(selected["id"])
            await conn.execute(
                """
                INSERT INTO user_billing_preferences
                    (user_id, funding_source, selected_subscription_id)
                VALUES ($1::uuid, $2, $3::uuid)
                ON CONFLICT (user_id) DO UPDATE SET
                    funding_source = EXCLUDED.funding_source,
                    selected_subscription_id = EXCLUDED.selected_subscription_id,
                    updated_at = NOW()
                """,
                user_id,
                source,
                selected_id,
            )
    return await get_wallet_snapshot(user_id)


async def consume_wallet_credits(
    *,
    user_id: str,
    amount: float,
    description: str,
    related_task_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    funding_source: Optional[str] = None,
    subscription_id: Optional[str] = None,
    model_id: Optional[str] = None,
) -> dict:
    normalized_amount = float(amount)
    if not math.isfinite(normalized_amount) or normalized_amount <= 0:
        raise MembershipWalletError("amount must be positive")
    if await foxapi_credentials.uses_external_billing(user_id, model_id=model_id):
        return {"balance_after": 0.0, "transaction_id": None, "billing_mode": foxapi_credentials.BILLING_MODE}
    normalized_key = str(idempotency_key or "").strip() or None
    requested_source = str(funding_source or "").strip().lower() or None
    if requested_source and requested_source not in VALID_FUNDING_SOURCES:
        raise MembershipWalletError("invalid funding source")

    async with acquire() as conn:
        async with conn.transaction():
            await reconcile_user_memberships(conn, user_id)
            if normalized_key:
                # The partial unique index is the permanent database guard,
                # but production maintenance may apply it after deployment.
                # Serializing this key also keeps the SELECT-then-INSERT path
                # idempotent while that index is unavailable or rebuilding.
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
                    user_id,
                    normalized_key,
                )
                existing = await conn.fetchrow(
                    """
                    SELECT id::text, amount, balance_after, description,
                           balance_source, subscription_id::text
                    FROM credit_transactions
                    WHERE user_id = $1::uuid AND idempotency_key = $2
                    """,
                    user_id,
                    normalized_key,
                )
                if existing:
                    same_source = not requested_source or existing["balance_source"] == requested_source
                    same_card = not subscription_id or str(existing["subscription_id"] or "") == str(subscription_id)
                    if (
                        round(abs(float(existing["amount"])), 2) != round(normalized_amount, 2)
                        or str(existing["description"] or "") != str(description or "")
                        or not same_source
                        or not same_card
                    ):
                        raise WalletIdempotencyConflict("billing idempotency key belongs to another wallet mutation")
                    return {
                        "balance_after": float(existing["balance_after"]),
                        "transaction_id": str(existing["id"]),
                        "funding_source": str(existing["balance_source"]),
                        "subscription_id": str(existing["subscription_id"]) if existing["subscription_id"] else None,
                        "idempotent": True,
                    }

            source = requested_source
            selected_id = str(subscription_id or "").strip() or None
            if source is None:
                preference = await conn.fetchrow(
                    """
                    SELECT COALESCE(funding_source, 'metered') AS funding_source,
                           selected_subscription_id::text
                    FROM user_billing_preferences
                    WHERE user_id = $1::uuid
                    """,
                    user_id,
                )
                source = str(preference["funding_source"]) if preference else METERED
                selected_id = str(preference["selected_subscription_id"]) if preference and preference["selected_subscription_id"] else None

            if source == SUBSCRIPTION:
                if not selected_id:
                    raise MembershipWalletError("no membership card selected")
                wallet = await conn.fetchrow(
                    """
                    UPDATE user_subscriptions
                    SET quota_remaining = quota_remaining - $1,
                        updated_at = NOW()
                    WHERE id = $2::uuid AND user_id = $3::uuid
                      AND (
                          (status = 'active' AND expires_at > NOW())
                          OR ($4::boolean AND status IN ('expired', 'revoked'))
                      )
                      AND quota_remaining >= $1
                    RETURNING id::text, plan_id, quota_remaining
                    """,
                    normalized_amount,
                    selected_id,
                    user_id,
                    requested_source is not None,
                )
                if not wallet:
                    raise MembershipWalletError("membership card quota is insufficient or no longer active")
                balance_after = float(wallet["quota_remaining"])
                if balance_after <= 0.000000001:
                    await conn.execute(
                        """
                        UPDATE user_subscriptions
                        SET quota_remaining = 0,
                            status = CASE WHEN status = 'active' THEN 'exhausted' ELSE status END,
                            exhausted_at = NOW(), updated_at = NOW()
                        WHERE id = $1::uuid
                        """,
                        selected_id,
                    )
                    await _activate_waiting_cards(conn, user_id)
                    replacement = await conn.fetchval(
                        """
                        SELECT id FROM user_subscriptions
                        WHERE user_id = $1::uuid AND plan_id = $2 AND status = 'active'
                          AND quota_remaining > 0 AND expires_at > NOW()
                        ORDER BY created_at, id LIMIT 1
                        """,
                        user_id,
                        wallet["plan_id"],
                    )
                    await conn.execute(
                        """
                        UPDATE user_billing_preferences
                        SET funding_source = CASE WHEN $2::uuid IS NULL THEN 'metered' ELSE 'subscription' END,
                            selected_subscription_id = $2::uuid, updated_at = NOW()
                        WHERE user_id = $1::uuid AND selected_subscription_id = $3::uuid
                        """,
                        user_id,
                        replacement,
                        selected_id,
                    )
            else:
                source = METERED
                selected_id = None
                wallet = await conn.fetchrow(
                    """
                    UPDATE users
                    SET credits = credits - $1, updated_at = NOW()
                    WHERE id = $2::uuid AND credits >= $1
                    RETURNING credits
                    """,
                    normalized_amount,
                    user_id,
                )
                if not wallet:
                    raise MembershipWalletError("pay-as-you-go credits are insufficient")
                balance_after = float(wallet["credits"])

            tx_id = await conn.fetchval(
                """
                INSERT INTO credit_transactions
                    (user_id, amount, balance_after, type, related_task_id,
                     description, idempotency_key, balance_source, subscription_id)
                VALUES ($1::uuid, $2, $3, 'consume', $4::uuid, $5, $6, $7, $8::uuid)
                RETURNING id::text
                """,
                user_id,
                -normalized_amount,
                balance_after,
                related_task_id,
                description,
                normalized_key,
                source,
                selected_id,
            )
    await invalidate_wallet_cache(user_id)
    return {
        "balance_after": balance_after,
        "transaction_id": tx_id,
        "funding_source": source,
        "subscription_id": selected_id,
    }


async def refund_wallet_credits(
    *,
    user_id: str,
    amount: float,
    description: str,
    related_task_id: Optional[str] = None,
    funding_source: Optional[str] = None,
    subscription_id: Optional[str] = None,
) -> dict:
    """Refund to the wallet that funded the original task whenever known."""
    normalized_amount = float(amount)
    if not math.isfinite(normalized_amount) or normalized_amount <= 0:
        raise MembershipWalletError("amount must be positive")
    if await foxapi_credentials.uses_external_billing(user_id):
        return {"balance_after": 0.0, "transaction_id": None, "billing_mode": foxapi_credentials.BILLING_MODE}
    async with acquire() as conn:
        async with conn.transaction():
            source = str(funding_source or "").strip().lower() or None
            selected_id = str(subscription_id or "").strip() or None
            if source is None and related_task_id:
                original = await conn.fetchrow(
                    """
                    SELECT balance_source, subscription_id::text
                    FROM credit_transactions
                    WHERE user_id = $1::uuid AND related_task_id = $2::uuid
                      AND type = 'consume'
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    user_id,
                    related_task_id,
                )
                if original:
                    source = str(original["balance_source"])
                    selected_id = str(original["subscription_id"]) if original["subscription_id"] else None
            if source == SUBSCRIPTION and selected_id:
                wallet = await conn.fetchrow(
                    """
                    UPDATE user_subscriptions
                    SET quota_remaining = LEAST(quota_total, quota_remaining + $1),
                        updated_at = NOW()
                    WHERE id = $2::uuid AND user_id = $3::uuid
                    RETURNING quota_remaining
                    """,
                    normalized_amount,
                    selected_id,
                    user_id,
                )
                if not wallet:
                    raise MembershipWalletError("original membership card no longer exists")
                balance_after = float(wallet["quota_remaining"])
            else:
                source = METERED
                selected_id = None
                wallet = await conn.fetchrow(
                    """
                    UPDATE users SET credits = credits + $1, updated_at = NOW()
                    WHERE id = $2::uuid RETURNING credits
                    """,
                    normalized_amount,
                    user_id,
                )
                if not wallet:
                    raise MembershipWalletError("user does not exist")
                balance_after = float(wallet["credits"])
            tx_id = await conn.fetchval(
                """
                INSERT INTO credit_transactions
                    (user_id, amount, balance_after, type, related_task_id,
                     description, balance_source, subscription_id)
                VALUES ($1::uuid, $2, $3, 'refund', $4::uuid, $5, $6, $7::uuid)
                RETURNING id::text
                """,
                user_id,
                normalized_amount,
                balance_after,
                related_task_id,
                description,
                source,
                selected_id,
            )
    await invalidate_wallet_cache(user_id)
    return {
        "balance_after": balance_after,
        "transaction_id": tx_id,
        "funding_source": source,
        "subscription_id": selected_id,
    }


async def invalidate_wallet_cache(user_id: str) -> None:
    try:
        from core.redis import get_redis
        await get_redis().delete(f"balance:{user_id}", f"wallet:{user_id}")
    except Exception:
        pass
