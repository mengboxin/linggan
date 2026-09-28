"""
分割路由集成测试

覆盖：
- GET /api/segmentation/by-hash/{content_hash} 缓存命中
- GET /api/segmentation/by-hash/{content_hash} 缓存未命中
- POST /api/segmentation/partial 有效区域
- POST /api/segmentation/partial 区域越界保护

Requirements: R12.2, R12.3, R12.4
"""
import asyncio
import json
import os
import sys
from io import BytesIO
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from httpx import AsyncClient, ASGITransport
from core.queue import QueueCapacityExceeded
from main import app
from routers import segmentation
from routers.auth import get_current_user


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _make_test_image(width: int = 200, height: int = 150) -> bytes:
    """创建测试用 PNG 图像"""
    img = Image.new("RGBA", (width, height), (255, 0, 0, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


MOCK_USER = {
    "id": "user-seg-test-001",
    "email": "segtest@example.com",
    "role": "user",
    "status": "active",
    "display_name": "Seg Test User",
}

MOCK_SEGMENTATION_RESULT = {
    "masks": [
        {
            "id": "mask-001",
            "category": "object",
            "mask_base64": "iVBORw0KGgo=",
            "bbox": {"x": 10, "y": 20, "w": 50, "h": 60},
            "confidence": 0.95,
        }
    ],
    "width": 200,
    "height": 150,
    "content_hash": "abc123def456",
}


@pytest.fixture(autouse=True)
def _priced_partial_segmentation_sku():
    sku = {
        "id": "segmentation-sam2-grounding-dino",
        "name": "SAM2 + GroundingDINO",
        "category": "segmentation",
        "enabled": True,
        "price_type": "credits",
        "price_credits": 3,
    }
    with patch(
        "routers.segmentation.require_platform_provider_sku",
        new=AsyncMock(return_value=sku),
    ), patch(
        "routers.segmentation.reserve_for_task",
        new=AsyncMock(return_value=True),
    ):
        yield


# ---------------------------------------------------------------------------
# GET /api/segmentation/by-hash/{content_hash} 测试
# ---------------------------------------------------------------------------


class TestGetByHash:
    """GET /api/segmentation/by-hash/{content_hash} 集成测试"""

    def test_cache_hit_returns_200(self):
        """缓存命中时应返回 200 和分割结果"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            mock_redis = AsyncMock()
            mock_redis.get = AsyncMock(
                return_value=json.dumps(MOCK_SEGMENTATION_RESULT)
            )

            try:
                with patch("routers.segmentation.get_redis", return_value=mock_redis):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/segmentation/by-hash/abc123def456",
                            headers={"Authorization": "Bearer fake-token"},
                        )

                assert resp.status_code == 200
                data = resp.json()
                assert data["content_hash"] == "abc123def456"
                assert len(data["masks"]) == 1
                assert data["masks"][0]["category"] == "object"
                assert data["width"] == 200
                assert data["height"] == 150

                # 验证 Redis 被正确调用
                mock_redis.get.assert_called_once_with("seg:hash:abc123def456")
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_cache_miss_returns_404(self):
        """缓存未命中时应返回 404"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            mock_redis = AsyncMock()
            mock_redis.get = AsyncMock(return_value=None)

            try:
                with patch("routers.segmentation.get_redis", return_value=mock_redis):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/segmentation/by-hash/nonexistent_hash",
                            headers={"Authorization": "Bearer fake-token"},
                        )

                assert resp.status_code == 404
                data = resp.json()
                assert "未命中" in data["detail"]

                mock_redis.get.assert_called_once_with("seg:hash:nonexistent_hash")
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_corrupted_cache_returns_404_and_deletes(self):
        """缓存数据损坏时应返回 404 并删除损坏条目"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            mock_redis = AsyncMock()
            mock_redis.get = AsyncMock(return_value="not-valid-json{{{")
            mock_redis.delete = AsyncMock()

            try:
                with patch("routers.segmentation.get_redis", return_value=mock_redis):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        resp = await client.get(
                            "/api/segmentation/by-hash/corrupted_hash",
                            headers={"Authorization": "Bearer fake-token"},
                        )

                assert resp.status_code == 404
                assert "损坏" in resp.json()["detail"]
                mock_redis.delete.assert_called_once_with("seg:hash:corrupted_hash")
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_unauthenticated_returns_401(self):
        """未登录应返回 401"""
        async def _run():
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get("/api/segmentation/by-hash/somehash")
            assert resp.status_code == 401

        asyncio.run(_run())


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/segmentation/status/task-other", "/api/segmentation/result/task-other"])
async def test_segmentation_task_endpoints_hide_other_users_tasks(path: str):
    app.dependency_overrides[get_current_user] = lambda: MOCK_USER
    try:
        with patch(
            "routers.segmentation.task_repo.get",
            new=AsyncMock(return_value={
                "_user_id": "someone-else",
                "status": "completed",
                "progress": 100,
                "error": None,
                "result": {"masks": ["private-mask"]},
            }),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get(path)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_segmentation_queue_rejection_marks_task_failed_and_releases_input_assets():
    failed = AsyncMock()
    release_inputs = AsyncMock()
    payload = {
        "image_asset": {
            "file_asset_id": "file-image",
            "key": "assets/users/user-seg-test-001/queue-inputs/task/files/image.png",
        },
    }
    with patch(
        "routers.segmentation.enqueue",
        new=AsyncMock(side_effect=QueueCapacityExceeded(100, 100)),
    ), patch("routers.segmentation.task_repo.set_failed", new=failed), patch(
        "routers.segmentation.queue_assets.release_consumed_queue_inputs",
        new=release_inputs,
    ):
        with pytest.raises(QueueCapacityExceeded):
            await segmentation._enqueue_submission(
                task_type="segmentation",
                task_id="task-full",
                user_id=MOCK_USER["id"],
                payload=payload,
            )

    failed.assert_awaited_once()
    release_inputs.assert_awaited_once_with(user_id=MOCK_USER["id"], payload=payload)


# ---------------------------------------------------------------------------
# POST /api/segmentation/partial 测试
# ---------------------------------------------------------------------------


class TestSubmitPartial:
    """POST /api/segmentation/partial 集成测试"""

    def test_valid_region_returns_task_id(self):
        """有效区域应返回 200 和 taskId"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            mock_task_id = "task-partial-001"

            try:
                with patch(
                    "routers.segmentation.task_repo.create",
                    new_callable=AsyncMock,
                    return_value=mock_task_id,
                ), patch(
                    "routers.segmentation.enqueue",
                    new_callable=AsyncMock,
                ), patch(
                    "routers.segmentation.queue_assets.persist_queue_inputs",
                    new=AsyncMock(return_value=[{"role": "image", "asset_id": "input-asset"}]),
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        image_bytes = _make_test_image(200, 150)
                        resp = await client.post(
                            "/api/segmentation/partial",
                            headers={"Authorization": "Bearer fake-token"},
                            files={"image": ("test.png", image_bytes, "image/png")},
                            data={
                                "region_x": "10",
                                "region_y": "20",
                                "region_w": "50",
                                "region_h": "60",
                            },
                        )

                assert resp.status_code == 200
                data = resp.json()
                assert data["taskId"] == mock_task_id
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_region_exceeds_image_width_returns_400(self):
        """区域超出图像宽度应返回 400"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            try:
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    # 图像 200x150，区域 x=180, w=50 → 180+50=230 > 200
                    image_bytes = _make_test_image(200, 150)
                    resp = await client.post(
                        "/api/segmentation/partial",
                        headers={"Authorization": "Bearer fake-token"},
                        files={"image": ("test.png", image_bytes, "image/png")},
                        data={
                            "region_x": "180",
                            "region_y": "10",
                            "region_w": "50",
                            "region_h": "30",
                        },
                    )

                assert resp.status_code == 400
                assert "越界" in resp.json()["detail"]
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_region_exceeds_image_height_returns_400(self):
        """区域超出图像高度应返回 400"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            try:
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    # 图像 200x150，区域 y=120, h=50 → 120+50=170 > 150
                    image_bytes = _make_test_image(200, 150)
                    resp = await client.post(
                        "/api/segmentation/partial",
                        headers={"Authorization": "Bearer fake-token"},
                        files={"image": ("test.png", image_bytes, "image/png")},
                        data={
                            "region_x": "10",
                            "region_y": "120",
                            "region_w": "30",
                            "region_h": "50",
                        },
                    )

                assert resp.status_code == 400
                assert "越界" in resp.json()["detail"]
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_zero_width_returns_400(self):
        """区域宽度为 0 应返回 400"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            try:
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    image_bytes = _make_test_image(200, 150)
                    resp = await client.post(
                        "/api/segmentation/partial",
                        headers={"Authorization": "Bearer fake-token"},
                        files={"image": ("test.png", image_bytes, "image/png")},
                        data={
                            "region_x": "10",
                            "region_y": "10",
                            "region_w": "0",
                            "region_h": "50",
                        },
                    )

                assert resp.status_code == 400
                assert "正整数" in resp.json()["detail"]
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_negative_coordinates_returns_400(self):
        """负坐标应返回 400"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            try:
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    image_bytes = _make_test_image(200, 150)
                    resp = await client.post(
                        "/api/segmentation/partial",
                        headers={"Authorization": "Bearer fake-token"},
                        files={"image": ("test.png", image_bytes, "image/png")},
                        data={
                            "region_x": "-10",
                            "region_y": "10",
                            "region_w": "50",
                            "region_h": "50",
                        },
                    )

                assert resp.status_code == 400
                assert "负数" in resp.json()["detail"]
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_exact_boundary_region_succeeds(self):
        """区域恰好等于图像边界应成功"""
        async def _run():
            app.dependency_overrides[get_current_user] = lambda: MOCK_USER

            mock_task_id = "task-partial-boundary"

            try:
                with patch(
                    "routers.segmentation.task_repo.create",
                    new_callable=AsyncMock,
                    return_value=mock_task_id,
                ), patch(
                    "routers.segmentation.enqueue",
                    new_callable=AsyncMock,
                ), patch(
                    "routers.segmentation.queue_assets.persist_queue_inputs",
                    new=AsyncMock(return_value=[{"role": "image", "asset_id": "input-asset"}]),
                ):
                    transport = ASGITransport(app=app)
                    async with AsyncClient(transport=transport, base_url="http://test") as client:
                        # 图像 200x150，区域覆盖整张图
                        image_bytes = _make_test_image(200, 150)
                        resp = await client.post(
                            "/api/segmentation/partial",
                            headers={"Authorization": "Bearer fake-token"},
                            files={"image": ("test.png", image_bytes, "image/png")},
                            data={
                                "region_x": "0",
                                "region_y": "0",
                                "region_w": "200",
                                "region_h": "150",
                            },
                        )

                assert resp.status_code == 200
                assert resp.json()["taskId"] == mock_task_id
            finally:
                app.dependency_overrides.pop(get_current_user, None)

        asyncio.run(_run())

    def test_unauthenticated_returns_401(self):
        """未登录应返回 401"""
        async def _run():
            app.dependency_overrides.pop(get_current_user, None)
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                image_bytes = _make_test_image(200, 150)
                resp = await client.post(
                    "/api/segmentation/partial",
                    files={"image": ("test.png", image_bytes, "image/png")},
                    data={
                        "region_x": "10",
                        "region_y": "10",
                        "region_w": "50",
                        "region_h": "50",
                    },
                )
            assert resp.status_code == 401

        asyncio.run(_run())
