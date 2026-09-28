from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from services.subscription_admin import SubscriptionAdminModule


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _SubscriptionConnection:
    def __init__(self):
        self.now = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
        self.user = {
            "id": "11111111-1111-1111-1111-111111111111",
            "email": "member@example.com",
            "display_name": "测试会员",
            "billing_mode": "platform_credits",
            "status": "active",
            "credits": Decimal("25"),
        }
        self.plan = {
            "id": "monthly",
            "name": "创作月卡",
            "description": "30 天会员",
            "badge_label": "MONTHLY",
            "price_yuan": Decimal("29.90"),
            "credits": 380,
            "duration_days": 30,
            "benefits": ["380 积分"],
            "enabled": True,
            "sort_order": 20,
        }
        self.subscription: dict | None = None
        self.audits: list[dict] = []
        self.transactions: list[dict] = []

    def transaction(self):
        return _Transaction()

    async def execute(self, sql: str, *args):
        if "pg_advisory_xact_lock" in sql:
            return "SELECT 1"
        if "INSERT INTO subscription_admin_audit" in sql:
            self.audits.append({
                "subscription_id": args[0],
                "user_id": args[1],
                "plan_id": args[2],
                "action": args[3],
                "actor": args[4],
                "reason": args[5],
                "operation_key": args[6],
            })
            return "INSERT 0 1"
        raise AssertionError(f"Unexpected execute SQL: {sql}")

    async def fetchrow(self, sql: str, *args):
        if "FROM subscription_admin_audit" in sql:
            match = next((audit for audit in self.audits if audit["operation_key"] == args[0]), None)
            return dict(match) if match else None
        if "FROM subscription_plans" in sql and "FOR SHARE" in sql:
            return dict(self.plan) if args[0] == self.plan["id"] else None
        if "FROM users" in sql and "FOR UPDATE" in sql:
            return dict(self.user) if args[0] in (self.user["id"], self.user["email"]) else None
        if "SELECT NOW() AS starts_at" in sql:
            return {
                "starts_at": self.now,
                "expires_at": self.now + timedelta(days=int(args[1])),
            }
        if "INSERT INTO user_subscriptions" in sql:
            self.subscription = {
                "id": "22222222-2222-2222-2222-222222222222",
                "user_id": self.user["id"],
                "plan_id": self.plan["id"],
                "payment_order_id": None,
                "source": "admin",
                "status": "active",
                "starts_at": args[2].isoformat(),
                "expires_at": args[3].isoformat(),
                "credits_granted": args[4],
                "quota_reset_count": 0,
                "last_quota_reset_at": None,
                "assigned_by": args[6],
                "note": args[7],
                "revoked_at": None,
                "revoked_by": None,
                "revoke_reason": "",
                "created_at": self.now.isoformat(),
                "updated_at": self.now.isoformat(),
            }
            return dict(self.subscription)
        if "UPDATE users" in sql and "credits = credits +" in sql:
            self.user["credits"] += Decimal(str(args[0]))
            return {"credits": self.user["credits"]}
        if "FROM user_subscriptions us" in sql:
            if not self.subscription or args[0] != self.subscription["id"]:
                return None
            return {
                **self.subscription,
                "email": self.user["email"],
                "display_name": self.user["display_name"],
                "billing_mode": self.user["billing_mode"],
                "plan_name": self.plan["name"],
                "badge_label": self.plan["badge_label"],
                "effective_status": (
                    "revoked" if self.subscription["status"] == "revoked" else "active"
                ),
            }
        if "SET status = 'revoked'" in sql:
            assert self.subscription is not None
            self.subscription.update({
                "status": "revoked",
                "revoked_at": self.now.isoformat(),
                "revoked_by": args[1],
                "revoke_reason": args[2],
                "updated_at": self.now.isoformat(),
            })
            return {
                "status": "revoked",
                "revoked_at": self.subscription["revoked_at"],
                "revoked_by": args[1],
                "revoke_reason": args[2],
                "updated_at": self.subscription["updated_at"],
            }
        if "quota_reset_count = quota_reset_count + 1" in sql:
            assert self.subscription is not None
            self.subscription["quota_reset_count"] += 1
            self.subscription["last_quota_reset_at"] = self.now.isoformat()
            return {
                "quota_reset_count": self.subscription["quota_reset_count"],
                "last_quota_reset_at": self.subscription["last_quota_reset_at"],
                "updated_at": self.now.isoformat(),
            }
        raise AssertionError(f"Unexpected fetchrow SQL: {sql}")

    async def fetchval(self, sql: str, *args):
        if "INSERT INTO credit_transactions" not in sql:
            raise AssertionError(f"Unexpected fetchval SQL: {sql}")
        self.transactions.append({
            "user_id": args[0],
            "amount": args[1],
            "balance_after": args[2],
            "description": args[3],
        })
        return f"tx-{len(self.transactions)}"


def _module(conn: _SubscriptionConnection) -> SubscriptionAdminModule:
    @asynccontextmanager
    async def acquire_connection():
        yield conn

    return SubscriptionAdminModule(acquire_connection)


@pytest.mark.asyncio
async def test_admin_assignment_is_idempotent_and_grants_plan_quota_once():
    conn = _SubscriptionConnection()
    module = _module(conn)

    first = await module.assign(
        user_ref=conn.user["email"],
        plan_id="monthly",
        operation_key="assign-operation-1",
        note="客服补发",
    )
    replay = await module.assign(
        user_ref=conn.user["email"],
        plan_id="monthly",
        operation_key="assign-operation-1",
        note="客服补发",
    )

    assert first["id"] == replay["id"]
    assert first["source"] == "admin"
    assert first["credits_granted"] == 380
    assert conn.user["credits"] == Decimal("405")
    assert len(conn.transactions) == 1
    assert conn.transactions[0]["amount"] == 380
    assert [audit["action"] for audit in conn.audits] == ["assigned"]


@pytest.mark.asyncio
async def test_quota_reset_reissues_frozen_credits_once_and_is_audited():
    conn = _SubscriptionConnection()
    module = _module(conn)
    assigned = await module.assign(
        user_ref=conn.user["id"],
        plan_id="monthly",
        operation_key="assign-operation-2",
    )

    first = await module.reset_quota(
        subscription_id=assigned["id"],
        operation_key="quota-reset-operation-1",
        reason="补偿一次周期额度",
    )
    replay = await module.reset_quota(
        subscription_id=assigned["id"],
        operation_key="quota-reset-operation-1",
        reason="补偿一次周期额度",
    )

    assert first["quota_reset_count"] == 1
    assert replay["quota_reset_count"] == 1
    assert conn.user["credits"] == Decimal("785")
    assert [tx["amount"] for tx in conn.transactions] == [380, 380]
    assert [audit["action"] for audit in conn.audits] == ["assigned", "quota_reset"]


@pytest.mark.asyncio
async def test_revocation_keeps_permanent_credits_and_stops_membership():
    conn = _SubscriptionConnection()
    module = _module(conn)
    assigned = await module.assign(
        user_ref=conn.user["id"],
        plan_id="monthly",
        operation_key="assign-operation-3",
    )
    balance_before_revoke = conn.user["credits"]

    revoked = await module.revoke(
        subscription_id=assigned["id"],
        operation_key="revoke-operation-1",
        reason="测试撤销",
    )

    assert revoked["status"] == "revoked"
    assert revoked["effective_status"] == "revoked"
    assert conn.user["credits"] == balance_before_revoke
    assert len(conn.transactions) == 1
    assert conn.audits[-1]["action"] == "revoked"


def test_subscription_admin_migration_contains_operational_guards():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260810_003_subscription_admin_operations.sql"
    ).read_text(encoding="utf-8")

    for required in (
        "ALTER COLUMN payment_order_id DROP NOT NULL",
        "ADD COLUMN IF NOT EXISTS source",
        "quota_reset_count",
        "CREATE TABLE IF NOT EXISTS subscription_admin_audit",
        "subscription_admin_audit_action_check",
        "idx_subscription_admin_audit_operation_unique",
    ):
        assert required in migration
