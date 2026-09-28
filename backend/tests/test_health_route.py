from unittest.mock import AsyncMock

import pytest


class _ConnectionContext:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback):
        return None


class _Redis:
    def __init__(self):
        self.ping = AsyncMock()


@pytest.mark.asyncio
async def test_health_reports_all_dependencies_ready(monkeypatch):
    import main

    connection = type("Connection", (), {"fetchval": AsyncMock(return_value=1)})()
    monkeypatch.setattr(main, "get_redis", lambda: _Redis())
    monkeypatch.setattr(main, "acquire", lambda: _ConnectionContext(connection))

    monkeypatch.setattr(
        main,
        "pool_stats",
        lambda: {"ready": True, "size": 2, "idle": 1, "used": 1, "max": 8},
    )

    result = await main.health()

    assert result == {
        "ok": True,
        "redis": True,
        "database": True,
        "db_pool": {"ready": True, "size": 2, "idle": 1, "used": 1, "max": 8},
    }


@pytest.mark.asyncio
async def test_health_reports_database_outage(monkeypatch):
    import main

    connection = type("Connection", (), {"fetchval": AsyncMock(side_effect=RuntimeError("database down"))})()
    monkeypatch.setattr(main, "get_redis", lambda: _Redis())
    monkeypatch.setattr(main, "acquire", lambda: _ConnectionContext(connection))

    monkeypatch.setattr(
        main,
        "pool_stats",
        lambda: {"ready": True, "size": 1, "idle": 0, "used": 1, "max": 8},
    )

    result = await main.health()

    assert result == {
        "ok": False,
        "redis": True,
        "database": False,
        "db_pool": {"ready": True, "size": 1, "idle": 0, "used": 1, "max": 8},
    }
