from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from routers import legal, payment
from repositories import payment_repo
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS


def _claim(document_type: str) -> legal.LegalAcceptanceClaim:
    document = CURRENT_LEGAL_DOCUMENTS[document_type]
    return legal.LegalAcceptanceClaim(
        documentType=document_type,
        version=document.version,
        contentHash=document.content_hash,
    )


def _request() -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/payment/create",
        "headers": [(b"user-agent", b"pytest")],
        "client": ("127.0.0.1", 12345),
    })


def test_payment_request_rejects_missing_acceptance():
    body = payment.CreatePaymentRequest(amount_yuan=10)
    assert body.legal_acceptance is None


@pytest.mark.asyncio
async def test_payment_order_requires_payment_document(monkeypatch):
    with pytest.raises(HTTPException) as error:
        await payment._record_payment_legal_acceptance(
            _claim("terms"),
            _request(),
            "11111111-1111-1111-1111-111111111111",
            source="payment-order",
        )

    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_payment_order_records_current_version_and_hash(monkeypatch):
    document = await payment._record_payment_legal_acceptance(
        _claim("payment"),
        _request(),
        "11111111-1111-1111-1111-111111111111",
        source="payment-order",
    )

    assert document.document_type == "payment"
    assert document.content_hash == CURRENT_LEGAL_DOCUMENTS["payment"].content_hash


@pytest.mark.asyncio
async def test_old_payment_client_receives_upgrade_required_instead_of_validation_422():
    body = payment.CreatePaymentRequest(amount_yuan=10)
    with pytest.raises(HTTPException) as error:
        await payment._record_payment_legal_acceptance(
            body.legal_acceptance,
            _request(),
            "11111111-1111-1111-1111-111111111111",
            source="payment-order",
        )
    assert error.value.status_code == 426
    assert error.value.detail["code"] == "LEGAL_CLIENT_UPGRADE_REQUIRED"


class _Transaction:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        self.connection.in_transaction = True

    async def __aexit__(self, exc_type, _exc, _traceback):
        self.connection.in_transaction = False
        self.connection.rolled_back = exc_type is not None
        return False


class _Connection:
    def __init__(self, *, fail_order=False):
        self.fail_order = fail_order
        self.in_transaction = False
        self.rolled_back = False

    def transaction(self):
        return _Transaction(self)

    async def fetchrow(self, sql, *_args):
        assert self.in_transaction
        if self.fail_order:
            raise RuntimeError("order insert failed")
        return {
            "id": "order-id",
            "order_no": "123",
            "amount_yuan": 10,
            "credits": 100,
            "bonus_credits": 0,
            "product_kind": "credits",
            "product_id": None,
            "product_name": "",
            "product_snapshot": {"legal_acceptance_id": "acceptance-id"},
            "pay_channel": "zpay",
            "status": "pending",
            "expires_at": "later",
            "created_at": "now",
        }


class _Acquire:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *_args):
        return False


@pytest.mark.asyncio
async def test_payment_acceptance_and_order_share_one_transaction(monkeypatch):
    connection = _Connection()
    calls = []

    async def record(*_args, conn=None, context_id="", **_kwargs):
        assert conn is connection and connection.in_transaction
        calls.append(context_id)
        return ["acceptance-id"]

    monkeypatch.setattr(payment_repo, "acquire", lambda: _Acquire(connection))
    async def ensure_schema(_conn):
        return None

    monkeypatch.setattr(payment_repo, "ensure_zpay_schema", ensure_schema)
    monkeypatch.setattr("repositories.legal_repo.record_acceptances", record)

    order = await payment_repo.create_order(
        user_id="11111111-1111-1111-1111-111111111111",
        amount_yuan=10,
        credits=100,
        bonus_credits=0,
        pay_channel="zpay",
        order_no="123",
        legal_document=CURRENT_LEGAL_DOCUMENTS["payment"],
    )

    assert calls == ["123"]
    assert order["product_snapshot"]["legal_acceptance_id"] == "acceptance-id"


@pytest.mark.asyncio
async def test_order_failure_rolls_back_the_linked_acceptance(monkeypatch):
    connection = _Connection(fail_order=True)

    async def record(*_args, conn=None, **_kwargs):
        assert conn is connection and connection.in_transaction
        return ["acceptance-id"]

    async def ensure_schema(_conn):
        return None

    monkeypatch.setattr(payment_repo, "acquire", lambda: _Acquire(connection))
    monkeypatch.setattr(payment_repo, "ensure_zpay_schema", ensure_schema)
    monkeypatch.setattr("repositories.legal_repo.record_acceptances", record)

    with pytest.raises(RuntimeError, match="order insert failed"):
        await payment_repo.create_order(
            user_id="11111111-1111-1111-1111-111111111111",
            amount_yuan=10,
            credits=100,
            bonus_credits=0,
            pay_channel="zpay",
            order_no="123",
            legal_document=CURRENT_LEGAL_DOCUMENTS["payment"],
        )

    assert connection.rolled_back is True
