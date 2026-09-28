"""Regression tests for the admin queue monitoring endpoints."""

import asyncio
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from routers import queue_monitor
from routers.admin import require_admin


def test_queue_stats_accepts_admin_authentication():
    """An admin token must be sufficient to read queue stats."""

    async def _run():
        app = FastAPI()
        app.include_router(queue_monitor.router)
        app.dependency_overrides[require_admin] = lambda: True

        with patch(
            "routers.queue_monitor.get_queue_stats",
            new=AsyncMock(
                return_value={
                    "high": {"length": 0, "pending": 0},
                    "normal": {"length": 1, "pending": 0},
                    "low": {"length": 0, "pending": 0},
                    "dlq": {"length": 0, "pending": 0},
                }
            ),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get(
                    "/api/queue/stats",
                    headers={"Authorization": "Bearer admin-token"},
                )

        assert response.status_code == 200
        assert response.json()["ok"] is True

    asyncio.run(_run())
