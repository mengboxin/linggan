from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

import repositories.payment_repo as payment_repo
from routers import payment
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS


PLAN = {
    "id": "weekly",
    "name": "灵感周卡",
    "description": "7 天会员身份与 120 永久积分",
    "badge_label": "WEEKLY",
    "price_yuan": Decimal("9.90"),
    "credits": 120,
    "duration_days": 7,
    "benefits": ["120 积分永久有效", "7 天 VIP 身份展示", "续费有效期自动顺延"],
    "sort_order": 10,
}


def _payment_claim():
    document = CURRENT_LEGAL_DOCUMENTS["payment"]
    return {
        "documentType": "payment",
        "version": document.version,
        "contentHash": document.content_hash,
    }


@pytest.mark.asyncio
async def test_packages_include_frontend_subscription_contract(monkeypatch):
    monkeypatch.setattr(payment.payment_repo, "get_packages", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        payment.payment_repo,
        "get_subscription_plans",
        AsyncMock(return_value=[PLAN]),
    )
    monkeypatch.setattr(
        payment.payment_repo,
        "get_channel_statuses",
        AsyncMock(return_value={"zpay": {"available": True}}),
    )
    monkeypatch.setattr(
        payment.payment_repo,
        "get_payment_settings",
        AsyncMock(return_value=payment_repo.DEFAULT_PAYMENT_SETTINGS),
    )

    response = await payment.get_packages()

    assert response["subscription_plans"] == [{
        **PLAN,
        "price_yuan": 9.9,
        "included_credits": 120,
        "badge": "WEEKLY",
        "billing_period": "week",
    }]


@pytest.mark.asyncio
async def test_subscription_create_uses_server_plan_price_and_snapshot(monkeypatch):
    create_order = AsyncMock(return_value={
        "order_no": "order-weekly",
        "amount_yuan": Decimal("9.90"),
        "credits": 120,
        "bonus_credits": 0,
        "product_kind": "subscription",
        "product_id": "weekly",
        "product_name": "灵感周卡",
        "status": "pending",
    })
    prepare_order = AsyncMock(return_value=(
        payment_repo.DEFAULT_PAYMENT_SETTINGS,
        {"notify_url": "https://example.test/notify", "return_url": "https://example.test/return"},
    ))
    monkeypatch.setattr(
        payment.payment_repo,
        "get_subscription_plan",
        AsyncMock(return_value=PLAN),
    )
    monkeypatch.setattr(
        payment.payment_repo,
        "get_pending_subscription_order",
        AsyncMock(return_value=None),
        raising=False,
    )
    monkeypatch.setattr(payment, "_prepare_payment_order", prepare_order)
    monkeypatch.setattr(
        payment,
        "_record_payment_legal_acceptance",
        AsyncMock(return_value=CURRENT_LEGAL_DOCUMENTS["payment"]),
    )
    monkeypatch.setattr(payment.payment_repo, "create_order", create_order)
    monkeypatch.setattr(
        payment,
        "_build_zpay_payment_payload",
        AsyncMock(side_effect=lambda order, _user_id: order),
    )
    request = SimpleNamespace(
        headers={"x-forwarded-for": "203.0.113.8"},
        client=SimpleNamespace(host="127.0.0.1"),
    )

    result = await payment.create_subscription_payment(
        payment.CreateSubscriptionRequest(plan_id="weekly", legal_acceptance=_payment_claim()),
        request,
        user={"id": "11111111-1111-1111-1111-111111111111", "billing_mode": "platform_credits"},
    )

    assert result["order_no"] == "order-weekly"
    prepare_order.assert_awaited_once_with(
        {"id": "11111111-1111-1111-1111-111111111111", "billing_mode": "platform_credits"},
        Decimal("9.90"),
    )
    kwargs = create_order.await_args.kwargs
    assert kwargs["amount_yuan"] == Decimal("9.90")
    assert kwargs["credits"] == 120
    assert kwargs["product_kind"] == "subscription"
    assert kwargs["product_id"] == "weekly"
    assert kwargs["product_snapshot"] == {
        "id": "weekly",
        "name": "灵感周卡",
        "description": "7 天会员身份与 120 永久积分",
        "badge_label": "WEEKLY",
        "badge": "WEEKLY",
        "price_yuan": "9.90",
        "credits": 120,
        "included_credits": 120,
        "duration_days": 7,
        "billing_period": "week",
        "benefits": PLAN["benefits"],
        "legal_document_version": CURRENT_LEGAL_DOCUMENTS["payment"].version,
        "legal_document_hash": CURRENT_LEGAL_DOCUMENTS["payment"].content_hash,
    }
    assert kwargs["legal_document"] is CURRENT_LEGAL_DOCUMENTS["payment"]
    assert kwargs["legal_source"] == "subscription-order"


@pytest.mark.asyncio
async def test_subscription_create_rejects_an_existing_pending_membership_order(monkeypatch):
    pending_order = AsyncMock(return_value={
        "order_no": "pending-membership-order",
        "product_kind": "subscription",
        "status": "pending",
    })
    create_order = AsyncMock()
    monkeypatch.setattr(
        payment.payment_repo,
        "get_pending_subscription_order",
        pending_order,
        raising=False,
    )
    monkeypatch.setattr(payment.payment_repo, "get_subscription_plan", AsyncMock(return_value=PLAN))
    monkeypatch.setattr(payment.payment_repo, "create_order", create_order)
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))

    with pytest.raises(payment.HTTPException) as exc_info:
        await payment.create_subscription_payment(
            payment.CreateSubscriptionRequest(plan_id="weekly", legal_acceptance=_payment_claim()),
            request,
            user={"id": "11111111-1111-1111-1111-111111111111", "billing_mode": "platform_credits"},
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "PENDING_SUBSCRIPTION_ORDER"
    assert "待支付会员订单" in exc_info.value.detail["message"]
    assert exc_info.value.detail["orderNo"] == "pending-membership-order"
    pending_order.assert_awaited_once_with("11111111-1111-1111-1111-111111111111")
    create_order.assert_not_awaited()


@pytest.mark.asyncio
async def test_subscription_create_rejects_byok_before_plan_lookup(monkeypatch):
    get_plan = AsyncMock(return_value=PLAN)
    monkeypatch.setattr(payment.payment_repo, "get_subscription_plan", get_plan)
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))

    with pytest.raises(payment.HTTPException) as exc_info:
        await payment.create_subscription_payment(
            payment.CreateSubscriptionRequest(plan_id="weekly", legal_acceptance=_payment_claim()),
            request,
            user={
                "id": "11111111-1111-1111-1111-111111111111",
                "billing_mode": "external_api_key",
            },
        )

    assert exc_info.value.status_code == 409
    get_plan.assert_not_awaited()


@pytest.mark.asyncio
async def test_subscription_status_exposes_aliases_without_enabling_byok_benefits(monkeypatch):
    monkeypatch.setattr(
        payment.payment_repo,
        "get_subscription_status",
        AsyncMock(return_value={
            "active": True,
            "plan_id": "pro_monthly",
            "name": "专业创作月卡",
            "badge_label": "PRO",
            "days_remaining": 30,
            "starts_at": "2026-08-10T00:00:00Z",
            "expires_at": "2026-09-09T00:00:00Z",
        }),
    )

    response = await payment.get_subscription_status({
        "id": "11111111-1111-1111-1111-111111111111",
        "billing_mode": "external_api_key",
    })

    assert response["plan_name"] == "专业创作月卡"
    assert response["badge"] == "PRO"
    assert response["days_remaining"] == 30
    assert response["benefits_active"] is False


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _PaymentConnection:
    def __init__(self):
        self.now = datetime(2026, 8, 10, tzinfo=timezone.utc)
        self.balance = Decimal("5.00")
        self.balance_updates = 0
        self.ledger_inserts = 0
        self.ledger_types: list[str] = []
        self.ledger_descriptions: list[str] = []
        self.membership_inserts = 0
        self.membership_sql = ""
        self.conflicting_order = None
        self.order = {
            "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "user_id": "11111111-1111-1111-1111-111111111111",
            "order_no": "membership-order-1",
            "trade_no": None,
            "amount_yuan": Decimal("9.90"),
            "credits": 120,
            "bonus_credits": 0,
            "pay_channel": "zpay",
            "status": "pending",
            "credit_transaction_id": None,
            "product_kind": "subscription",
            "product_id": "weekly",
            "product_name": "灵感周卡",
            "product_snapshot": {
                "id": "weekly",
                "name": "灵感周卡",
                "price_yuan": "9.90",
                "credits": 120,
                "duration_days": 7,
            },
        }

    def transaction(self):
        return _Transaction()

    async def execute(self, sql: str, *_args):
        assert "pg_advisory_xact_lock" in sql
        return "SELECT 1"

    async def fetchrow(self, sql: str, *args):
        if "SELECT * FROM payment_orders" in sql and "FOR UPDATE" in sql:
            return dict(self.order)
        if "FROM payment_orders" in sql and "trade_no = $2" in sql:
            return self.conflicting_order
        if "SET status = 'paid'" in sql:
            self.order.update({"status": "paid", "trade_no": args[0]})
            return dict(self.order)
        if "UPDATE users" in sql:
            self.balance_updates += 1
            self.balance += Decimal(str(args[0]))
            return {"credits": self.balance}
        if "INSERT INTO user_subscriptions" in sql:
            self.membership_inserts += 1
            self.membership_sql = sql
            return {
                "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                "plan_id": args[1],
                "starts_at": self.now.isoformat(),
                "expires_at": (self.now + timedelta(days=int(args[3]))).isoformat(),
                "credits_granted": args[4],
                "status": "active",
            }
        if "SET status = 'completed'" in sql:
            self.order.update({
                "status": "completed",
                "credit_transaction_id": str(args[0]),
            })
            return {
                **self.order,
                "id": str(self.order["id"]),
                "user_id": str(self.order["user_id"]),
                "paid_at": self.now.isoformat(),
                "completed_at": self.now.isoformat(),
            }
        raise AssertionError(f"Unexpected fetchrow SQL: {sql}")

    async def fetchval(self, sql: str, *args):
        assert "INSERT INTO credit_transactions" in sql
        self.ledger_inserts += 1
        self.ledger_types.append(str(args[3]))
        self.ledger_descriptions.append(str(args[4]))
        return "cccccccc-cccc-cccc-cccc-cccccccccccc"


@pytest.mark.asyncio
async def test_duplicate_subscription_callback_grants_once(monkeypatch):
    conn = _PaymentConnection()

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(payment_repo, "acquire", acquire)

    first_result, first_order = await payment_repo.complete_paid_order(
        conn.order["order_no"],
        "provider-trade-1",
        {"trade_status": "TRADE_SUCCESS"},
    )
    second_result, _second_order = await payment_repo.complete_paid_order(
        conn.order["order_no"],
        "provider-trade-1",
        {"trade_status": "TRADE_SUCCESS"},
    )

    assert first_result == "completed"
    assert first_order["subscription"]["plan_id"] == "weekly"
    assert second_result == "duplicate"
    assert conn.balance == Decimal("125.00")
    assert conn.balance_updates == 1
    assert conn.ledger_inserts == 1
    assert conn.membership_inserts == 1
    assert "NOW() AS starts_at" in conn.membership_sql
    assert "GREATEST" in conn.membership_sql


@pytest.mark.asyncio
async def test_legacy_credit_order_keeps_payment_ledger_contract(monkeypatch):
    conn = _PaymentConnection()
    conn.order.update({
        "product_kind": "credits",
        "product_id": None,
        "product_name": "",
        "product_snapshot": {},
        "credits": 100,
        "bonus_credits": 8,
    })

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(payment_repo, "acquire", acquire)

    result, completed_order = await payment_repo.complete_paid_order(
        conn.order["order_no"],
        "provider-trade-legacy",
        {"trade_status": "TRADE_SUCCESS"},
    )

    assert result == "completed"
    assert completed_order["product_kind"] == "credits"
    assert "subscription" not in completed_order
    assert conn.balance == Decimal("113.00")
    assert conn.ledger_types == ["payment"]
    assert conn.ledger_descriptions == [
        "充值 9.90 元 · 订单 membership-order-1",
    ]
    assert conn.membership_inserts == 0


@pytest.mark.asyncio
async def test_provider_trade_number_cannot_fulfill_two_local_orders(monkeypatch):
    conn = _PaymentConnection()
    conn.conflicting_order = {
        "id": "dddddddd-dddd-dddd-dddd-dddddddddddd",
        "order_no": "another-order",
    }

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(payment_repo, "acquire", acquire)

    result, _order = await payment_repo.complete_paid_order(
        conn.order["order_no"],
        "provider-trade-reused",
        {"trade_status": "TRADE_SUCCESS"},
    )

    assert result == "trade_conflict"
    assert conn.balance_updates == 0
    assert conn.ledger_inserts == 0
    assert conn.membership_inserts == 0


@pytest.mark.asyncio
async def test_invalid_subscription_snapshot_fails_before_crediting(monkeypatch):
    conn = _PaymentConnection()
    conn.order["product_snapshot"] = {
        **conn.order["product_snapshot"],
        "credits": 999,
    }

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(payment_repo, "acquire", acquire)

    result, _order = await payment_repo.complete_paid_order(
        conn.order["order_no"],
        "provider-trade-invalid-snapshot",
        {"trade_status": "TRADE_SUCCESS"},
    )

    assert result == "invalid_state"
    assert conn.balance_updates == 0
    assert conn.ledger_inserts == 0
    assert conn.membership_inserts == 0


def test_subscription_request_rejects_client_controlled_price_or_credits():
    with pytest.raises(ValidationError):
        payment.CreateSubscriptionRequest.model_validate({
            "plan_id": "weekly",
            "amount_yuan": "0.01",
            "credits": 999999,
        })


def test_prepaid_membership_migration_contains_idempotency_guards():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260810_002_prepaid_memberships.sql"
    ).read_text(encoding="utf-8")

    for required in (
        "ADD COLUMN IF NOT EXISTS product_kind",
        "DROP CONSTRAINT IF EXISTS payment_orders_product_kind_check",
        "product_snapshot JSONB",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_trade_no_unique",
        "CREATE TABLE IF NOT EXISTS subscription_plans",
        "ON CONFLICT (id) DO UPDATE",
        "CREATE TABLE IF NOT EXISTS user_subscriptions",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_payment_order_unique",
        "'subscription'",
    ):
        assert required in migration
