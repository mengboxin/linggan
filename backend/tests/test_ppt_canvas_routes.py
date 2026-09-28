"""
PPT 画布编辑路由单元测试

覆盖：
- PUT /api/ppt-canvas/slide/{job_id}/{index}/element/{element_id} 正常流程
- PUT 元素不存在返回 404
- PUT 并发冲突返回 409
- PUT Inpainting 失败时保留原始数据（R5.7）
- PUT TextRender 失败时保留原始数据（R5.7）
- POST /api/ppt-canvas/slide/{job_id}/{index}/background 正常流程
- POST AI 背景生成失败时保留原始背景（R5.7）
- 认证保护
- 速率限制

Requirements: R5.3, R5.4, R5.5, R5.7
"""
import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from httpx import AsyncClient, ASGITransport
from main import app
from routers.auth import get_current_user


MOCK_USER = {
    "id": "user-ppt-canvas-001",
    "email": "pptcanvas@example.com",
    "role": "user",
    "status": "active",
    "display_name": "PPT Canvas Test User",
}


MOCK_SLIDE = {
    "job_id": "job-001",
    "index": 0,
    "elements": [
        {
            "id": "elem-text-1",
            "type": "text",
            "text": "Hello World",
            "bbox": {"x": 10, "y": 10, "w": 200, "h": 50},
            "fontFamily": "Arial",
            "fontSize": 24,
            "color": "#000000",
        },
        {
            "id": "elem-icon-1",
            "type": "icon",
            "src": "https://example.com/icon.png",
            "bbox": {"x": 300, "y": 100, "w": 64, "h": 64},
        },
    ],
    "background": {"kind": "solid", "value": "#ffffff"},
    "version": 1,
}


async def _run_provider_call(**kwargs):
    return await kwargs["invoke"]()


@pytest.fixture(autouse=True)
def _provider_billing_passthrough():
    with patch(
        "routers.ppt_canvas.execute_platform_provider_call",
        side_effect=_run_provider_call,
    ):
        yield


# ---------------------------------------------------------------------------
# 测试：PUT /slide/{job_id}/{index}/element/{element_id} 正常流程
# ---------------------------------------------------------------------------


class TestUpdateSlideElement:
    """PUT /api/ppt-canvas/slide/{job_id}/{index}/element/{element_id}"""

    def test_update_element_success(self):
        """正常更新元素：纯数据 patch"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas.update_element",
                    new_callable=AsyncMock,
                    return_value=2,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/elem-text-1",
                            json={
                                "patch": {"text": "Updated Text"},
                                "expected_version": 1,
                            },
                        )

                    assert resp.status_code == 200
                    data = resp.json()
                    assert data["ok"] is True
                    assert data["version"] == 2
                    assert data["element_id"] == "elem-text-1"
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_element_slide_not_found(self):
        """幻灯片不存在返回 404"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=None,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-999/0/element/elem-1",
                            json={"patch": {"text": "x"}},
                        )

                    assert resp.status_code == 404
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_update_element_not_found(self):
        """元素不存在返回 404"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/nonexistent",
                            json={"patch": {"text": "x"}},
                        )

                    assert resp.status_code == 404
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_element_concurrent_conflict(self):
        """并发更新冲突返回 409"""
        async def _run():
            from repositories.ppt_canvas_repo import ConcurrentUpdateError

            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas.update_element",
                    new_callable=AsyncMock,
                    side_effect=ConcurrentUpdateError("job-001", 0, 1, 2),
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/elem-text-1",
                            json={
                                "patch": {"text": "conflict"},
                                "expected_version": 1,
                            },
                        )

                    assert resp.status_code == 409
                    assert "冲突" in resp.json()["detail"]
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_element_inpainting_failure_preserves_data(self):
        """R5.7: Inpainting 失败时保留原始元素数据"""
        async def _run():
            import base64
            fake_image = base64.b64encode(b"fake-png-data").decode()
            fake_mask = base64.b64encode(b"fake-mask-data").decode()

            mock_inpainting = MagicMock()
            mock_inpainting.inpaint = AsyncMock(
                side_effect=RuntimeError("Inpainting 服务不可用")
            )

            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas._get_inpainting_router",
                    return_value=mock_inpainting,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ), patch(
                    "routers.ppt_canvas.update_element",
                    new_callable=AsyncMock,
                ) as mock_update:
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/elem-icon-1",
                            json={
                                "patch": {"src": "new-icon.png"},
                                "use_inpainting": True,
                                "inpainting_mode": "replace",
                                "inpainting_prompt": "一个新图标",
                                "inpainting_image_base64": fake_image,
                                "inpainting_mask_base64": fake_mask,
                            },
                        )

                    # 应返回 502，表示 AI 服务失败
                    assert resp.status_code == 502
                    assert "保留" in resp.json()["detail"]
                    # update_element 不应被调用（数据未被修改）
                    mock_update.assert_not_called()
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_element_text_render_failure_preserves_data(self):
        """R5.7: TextRender 失败时保留原始元素数据"""
        async def _run():
            import base64
            fake_image = base64.b64encode(b"fake-png-data").decode()
            fake_mask = base64.b64encode(b"fake-mask-data").decode()

            mock_text_provider = MagicMock()
            mock_text_provider.render = AsyncMock(
                side_effect=RuntimeError("TextRender 服务不可用")
            )

            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas._get_text_render_provider",
                    return_value=mock_text_provider,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ), patch(
                    "routers.ppt_canvas.update_element",
                    new_callable=AsyncMock,
                ) as mock_update:
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/elem-text-1",
                            json={
                                "patch": {"text": "新文字"},
                                "use_text_render": True,
                                "text_content": "新文字",
                                "text_render_image_base64": fake_image,
                                "text_render_mask_base64": fake_mask,
                                "font_family": "Arial",
                                "font_size": 24,
                                "text_color": "#ff0000",
                            },
                        )

                    # 应返回 502
                    assert resp.status_code == 502
                    assert "保留" in resp.json()["detail"]
                    # update_element 不应被调用
                    mock_update.assert_not_called()
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())



# ---------------------------------------------------------------------------
# 测试：POST /slide/{job_id}/{index}/background
# ---------------------------------------------------------------------------


class TestUpdateSlideBackground:
    """POST /api/ppt-canvas/slide/{job_id}/{index}/background"""

    def test_update_background_solid_success(self):
        """正常更新背景为纯色"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas.save_slide",
                    new_callable=AsyncMock,
                    return_value=2,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.post(
                            "/api/ppt-canvas/slide/job-001/0/background",
                            json={
                                "kind": "solid",
                                "value": "#ff5500",
                            },
                        )

                    assert resp.status_code == 200
                    data = resp.json()
                    assert data["ok"] is True
                    assert data["version"] == 2
                    assert data["background"]["kind"] == "solid"
                    assert data["background"]["value"] == "#ff5500"
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_background_gradient_success(self):
        """正常更新背景为渐变"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas.save_slide",
                    new_callable=AsyncMock,
                    return_value=2,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.post(
                            "/api/ppt-canvas/slide/job-001/0/background",
                            json={
                                "kind": "gradient",
                                "value": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                            },
                        )

                    assert resp.status_code == 200
                    data = resp.json()
                    assert data["ok"] is True
                    assert data["background"]["kind"] == "gradient"
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_update_background_slide_not_found(self):
        """幻灯片不存在返回 404"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=None,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.post(
                            "/api/ppt-canvas/slide/job-999/0/background",
                            json={"kind": "solid", "value": "#000000"},
                        )

                    assert resp.status_code == 404
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())


    def test_update_background_ai_failure_preserves_original(self):
        """R5.7: AI 背景生成失败时保留原始背景"""
        async def _run():
            import base64
            fake_image = base64.b64encode(b"fake-png-data").decode()
            fake_mask = base64.b64encode(b"fake-mask-data").decode()

            mock_inpainting = MagicMock()
            mock_inpainting.inpaint = AsyncMock(
                side_effect=RuntimeError("AI 服务不可用")
            )

            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.get_slide",
                    new_callable=AsyncMock,
                    return_value=MOCK_SLIDE,
                ), patch(
                    "routers.ppt_canvas._get_inpainting_router",
                    return_value=mock_inpainting,
                ), patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                ), patch(
                    "routers.ppt_canvas.save_slide",
                    new_callable=AsyncMock,
                ) as mock_save:
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.post(
                            "/api/ppt-canvas/slide/job-001/0/background",
                            json={
                                "kind": "image",
                                "value": "",
                                "use_ai_generation": True,
                                "ai_prompt": "一片星空",
                                "ai_image_base64": fake_image,
                                "ai_mask_base64": fake_mask,
                            },
                        )

                    # 应返回 502
                    assert resp.status_code == 502
                    assert "保留" in resp.json()["detail"]
                    # save_slide 不应被调用（背景未被修改）
                    mock_save.assert_not_called()
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())



# ---------------------------------------------------------------------------
# 测试：认证保护
# ---------------------------------------------------------------------------


class TestPPTCanvasAuth:
    """PPT 画布编辑端点认证测试"""

    def test_update_element_requires_auth(self):
        """未认证用户应返回 401"""
        async def _run():
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                resp = await client.put(
                    "/api/ppt-canvas/slide/job-001/0/element/elem-1",
                    json={"patch": {"text": "x"}},
                )
            assert resp.status_code == 401

        asyncio.run(_run())

    def test_update_background_requires_auth(self):
        """未认证用户应返回 401"""
        async def _run():
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                resp = await client.post(
                    "/api/ppt-canvas/slide/job-001/0/background",
                    json={"kind": "solid", "value": "#000"},
                )
            assert resp.status_code == 401

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# 测试：速率限制
# ---------------------------------------------------------------------------


class TestPPTCanvasRateLimit:
    """PPT 画布编辑速率限制测试"""

    def test_update_element_rate_limited(self):
        """超过速率限制返回 429"""
        async def _run():
            from core.rate_limit import RateLimitExceeded

            app.dependency_overrides[get_current_user] = lambda: MOCK_USER
            try:
                with patch(
                    "routers.ppt_canvas.rate_limit",
                    new_callable=AsyncMock,
                    side_effect=RateLimitExceeded("ppt-canvas", 20, 60, 30),
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(
                        transport=transport, base_url="http://test"
                    ) as client:
                        resp = await client.put(
                            "/api/ppt-canvas/slide/job-001/0/element/elem-1",
                            json={"patch": {"text": "x"}},
                        )

                    assert resp.status_code == 429
                    assert "Retry-After" in resp.headers
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())
