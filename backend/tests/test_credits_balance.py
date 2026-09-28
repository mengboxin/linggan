from unittest.mock import AsyncMock

import pytest

from routers import credits


@pytest.mark.asyncio
async def test_balance_endpoint_returns_permanent_metered_wallet(monkeypatch: pytest.MonkeyPatch):
    get_balance = AsyncMock(return_value=18.0)
    monkeypatch.setattr(credits.credit_repo, "get_balance", get_balance)

    response = await credits.get_balance({"id": "user-1"})

    assert response.balance == 18.0
    assert response.funding_source == "metered"
    assert response.subscription_id is None
    get_balance.assert_awaited_once_with("user-1")
