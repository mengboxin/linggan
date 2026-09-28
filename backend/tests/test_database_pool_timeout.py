from unittest.mock import AsyncMock

import pytest

from core import pool as pool_module
from core.queue import QueueCapacityExceeded


@pytest.mark.asyncio
async def test_acquire_releases_connection(monkeypatch):
    connection = object()

    class Pool:
        acquire = AsyncMock(return_value=connection)
        release = AsyncMock()

    db_pool = Pool()
    monkeypatch.setattr(pool_module, "get_pool", lambda: db_pool)
    monkeypatch.setattr(pool_module.settings, "DB_POOL_ACQUIRE_TIMEOUT_SECONDS", 1.5)

    async with pool_module.acquire() as acquired:
        assert acquired is connection

    db_pool.acquire.assert_awaited_once_with(timeout=1.5)
    db_pool.release.assert_awaited_once_with(connection)


@pytest.mark.asyncio
async def test_acquire_reports_saturated_pool(monkeypatch):
    class Pool:
        async def acquire(self, *, timeout):
            raise TimeoutError

    monkeypatch.setattr(pool_module, "get_pool", lambda: Pool())

    with pytest.raises(pool_module.DatabasePoolBusy):
        async with pool_module.acquire():
            raise AssertionError("unreachable")


def test_pool_stats_report_used_connections(monkeypatch):
    class Pool:
        def get_size(self):
            return 3

        def get_idle_size(self):
            return 1

        def get_max_size(self):
            return 8

    monkeypatch.setattr(pool_module, "_pool", Pool())

    assert pool_module.pool_stats() == {
        "ready": True,
        "size": 3,
        "idle": 1,
        "used": 2,
        "max": 8,
    }


@pytest.mark.asyncio
async def test_queue_capacity_has_a_retryable_http_response():
    from core.error_handlers import queue_capacity_exceeded_handler

    response = await queue_capacity_exceeded_handler(
        None,
        QueueCapacityExceeded(current=10, limit=10),
    )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
