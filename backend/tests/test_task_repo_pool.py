from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_task_repository_uses_bounded_pool_acquire(monkeypatch):
    from core import pool as pool_module
    from repositories import task_repo

    connection = type("Connection", (), {"execute": AsyncMock()})()
    db_pool = type(
        "Pool",
        (),
        {
            "acquire": AsyncMock(return_value=connection),
            "release": AsyncMock(),
        },
    )()
    monkeypatch.setattr(pool_module, "get_pool", lambda: db_pool)
    monkeypatch.setattr(pool_module.settings, "DB_POOL_ACQUIRE_TIMEOUT_SECONDS", 1.5)

    await task_repo._pg_insert("task-1", "generate", "user-1", "image2")
    await task_repo._pg_update_status("task-1", "completed", duration_ms=12)

    assert db_pool.acquire.await_count == 2
    for call in db_pool.acquire.await_args_list:
        assert call.kwargs == {"timeout": 1.5}
    assert db_pool.release.await_count == 2
    assert connection.execute.await_count == 2


@pytest.mark.asyncio
async def test_task_repository_keeps_persistence_best_effort_when_pool_is_busy(monkeypatch):
    from core import pool as pool_module
    from repositories import task_repo

    db_pool = type(
        "Pool",
        (),
        {
            "acquire": AsyncMock(side_effect=TimeoutError),
            "release": AsyncMock(),
        },
    )()
    monkeypatch.setattr(pool_module, "get_pool", lambda: db_pool)

    await task_repo._pg_insert("task-1", "generate", "user-1", "image2")
    await task_repo._pg_update_status("task-1", "processing")

    assert db_pool.acquire.await_count == 2
    db_pool.release.assert_not_awaited()
