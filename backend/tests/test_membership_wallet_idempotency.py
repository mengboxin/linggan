from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from repositories import membership_wallet_repo


class _Connection:
    def __init__(self):
        self.execute_calls: list[tuple[str, tuple]] = []

    @asynccontextmanager
    async def transaction(self):
        yield

    async def execute(self, sql: str, *args):
        self.execute_calls.append((sql, args))

    async def fetchrow(self, sql: str, *_args):
        if "FROM credit_transactions" in sql:
            return {
                "id": "existing-debit",
                "amount": -2.0,
                "balance_after": 8.0,
                "description": "Image generation",
                "balance_source": "metered",
                "subscription_id": None,
            }
        raise AssertionError(f"Unexpected fetchrow query: {sql}")


@pytest.mark.asyncio
async def test_wallet_debit_serializes_same_idempotency_key(monkeypatch: pytest.MonkeyPatch):
    connection = _Connection()

    @asynccontextmanager
    async def acquire_connection():
        yield connection

    monkeypatch.setattr(membership_wallet_repo, "acquire", acquire_connection)
    monkeypatch.setattr(
        membership_wallet_repo.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        membership_wallet_repo,
        "reconcile_user_memberships",
        AsyncMock(),
    )

    result = await membership_wallet_repo.consume_wallet_credits(
        user_id="00000000-0000-0000-0000-000000000001",
        amount=2,
        description="Image generation",
        idempotency_key="task-terminal:task-1:charge",
        funding_source="metered",
    )

    assert result["idempotent"] is True
    assert connection.execute_calls == [
        (
            "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
            ("00000000-0000-0000-0000-000000000001", "task-terminal:task-1:charge"),
        )
    ]
