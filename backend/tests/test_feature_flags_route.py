"""
Feature Flags 路由集成测试

验证：
- 未登录返回 401
- 登录后返回当前用户的 flag 状态
- 返回格式包含 touch_edit、agent_orchestrator、ppt_canvas、user_id

Requirements: R14.1, R14.2
"""
import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from httpx import AsyncClient, ASGITransport
from main import app
from routers.auth import get_current_user


class TestFeatureFlagsRoute:
    """GET /api/system/flags 集成测试。"""

    def test_unauthenticated_returns_401(self):
        """未登录（无 Authorization header）应返回 401。"""
        async def _run():
            # 确保没有 override
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get("/api/system/flags")
                assert resp.status_code == 401

        asyncio.run(_run())

    def test_invalid_token_returns_401(self):
        """无效 token 应返回 401。"""
        async def _run():
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get(
                    "/api/system/flags",
                    headers={"Authorization": "Bearer invalid-token-xyz"}
                )
                assert resp.status_code == 401

        asyncio.run(_run())

    def test_authenticated_returns_flags(self):
        """登录用户应返回正确的 flag 状态和 user_id。"""
        async def _run():
            mock_user = {
                "id": "user-test-123",
                "email": "test@example.com",
                "role": "user",
                "status": "active",
                "display_name": "Test User",
            }
            mock_flags = {
                "touch_edit": True,
                "agent_orchestrator": False,
                "ppt_canvas": True,
            }

            # 使用 FastAPI dependency_overrides 覆盖认证依赖
            app.dependency_overrides[get_current_user] = lambda: mock_user

            try:
                with patch("routers.feature_flags.get_user_flags",
                           new_callable=AsyncMock, return_value=mock_flags):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/system/flags",
                            headers={"Authorization": "Bearer fake-valid-token"}
                        )

                assert resp.status_code == 200
                data = resp.json()
                assert data["touch_edit"] is True
                assert data["agent_orchestrator"] is False
                assert data["ppt_canvas"] is True
                assert data["user_id"] == "user-test-123"
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_authenticated_all_flags_disabled(self):
        """所有 flag 关闭时返回全 False。"""
        async def _run():
            mock_user = {
                "id": "user-disabled-456",
                "email": "disabled@example.com",
                "role": "user",
                "status": "active",
                "display_name": "Disabled User",
            }
            mock_flags = {
                "touch_edit": False,
                "agent_orchestrator": False,
                "ppt_canvas": False,
            }

            app.dependency_overrides[get_current_user] = lambda: mock_user

            try:
                with patch("routers.feature_flags.get_user_flags",
                           new_callable=AsyncMock, return_value=mock_flags):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/system/flags",
                            headers={"Authorization": "Bearer fake-valid-token"}
                        )

                assert resp.status_code == 200
                data = resp.json()
                assert data["touch_edit"] is False
                assert data["agent_orchestrator"] is False
                assert data["ppt_canvas"] is False
                assert data["user_id"] == "user-disabled-456"
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_response_contains_all_required_fields(self):
        """响应必须包含 touch_edit、agent_orchestrator、ppt_canvas、user_id 四个字段。"""
        async def _run():
            mock_user = {
                "id": "user-fields-789",
                "email": "fields@example.com",
                "role": "user",
                "status": "active",
                "display_name": "Fields User",
            }
            mock_flags = {
                "touch_edit": True,
                "agent_orchestrator": True,
                "ppt_canvas": False,
            }

            app.dependency_overrides[get_current_user] = lambda: mock_user

            try:
                with patch("routers.feature_flags.get_user_flags",
                           new_callable=AsyncMock, return_value=mock_flags):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/system/flags",
                            headers={"Authorization": "Bearer fake-valid-token"}
                        )

                assert resp.status_code == 200
                data = resp.json()
                # 验证所有必需字段存在
                required_fields = {"touch_edit", "agent_orchestrator", "ppt_canvas", "user_id"}
                assert required_fields.issubset(set(data.keys()))
                # 验证类型
                assert isinstance(data["touch_edit"], bool)
                assert isinstance(data["agent_orchestrator"], bool)
                assert isinstance(data["ppt_canvas"], bool)
                assert isinstance(data["user_id"], str)
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())
