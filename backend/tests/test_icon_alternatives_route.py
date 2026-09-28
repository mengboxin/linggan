"""Route tests for queued Image2 icon-alternative generation."""
from io import BytesIO
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from core.queue import UserConcurrencyExceeded
from main import app
from routers.auth import get_current_user


USER = {"id": "user-icon-test-001", "billing_mode": "platform"}


@pytest.fixture(autouse=True)
def _priced_provider_skus():
    sku = {
        "id": "inpainting-icon-alternatives",
        "name": "Icon Alternatives",
        "category": "generate",
        "enabled": True,
        "price_type": "credits",
        "price_credits": 2,
    }
    with patch(
        "routers.layer_edit.require_platform_provider_sku",
        new=AsyncMock(return_value=sku),
    ), patch(
        "routers.layer_edit.reserve_for_task",
        new=AsyncMock(return_value=True),
    ):
        yield


def _png(mode: str = "RGBA") -> bytes:
    image = Image.new(mode, (48, 48), (255, 0, 0, 255) if mode == "RGBA" else 255)
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _references() -> list[dict]:
    return [
        {"role": "image", "asset_id": "icon-input", "key": "assets/icon-input.png"},
        {"role": "mask", "asset_id": "icon-mask", "key": "assets/icon-mask.png"},
    ]


@pytest.mark.asyncio
async def test_icon_alternatives_queues_asset_backed_image2_job():
    app.dependency_overrides[get_current_user] = lambda: USER
    enqueue = AsyncMock()
    try:
        with patch("routers.layer_edit.task_repo.create", new=AsyncMock(return_value="icon-task")), patch(
            "routers.layer_edit.queue_assets.persist_queue_inputs",
            new=AsyncMock(return_value=_references()),
        ), patch("routers.layer_edit.enqueue", new=enqueue), patch(
            "routers.layer_edit.rate_limit", new=AsyncMock()
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/layer-edit/icon-alternatives",
                    files={
                        "image": ("image.png", _png(), "image/png"),
                        "mask": ("mask.png", _png("L"), "image/png"),
                    },
                    data={"element_id": "icon-1", "prompt": "a concise star icon"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 200
    assert response.json() == {
        "taskId": "icon-task",
        "status": "queued",
        "element_id": "icon-1",
    }
    call = enqueue.await_args.kwargs
    assert call["task_type"] == "icon-alternatives"
    assert call["payload"]["image_asset"]["asset_id"] == "icon-input"
    assert call["payload"]["mask_asset"]["asset_id"] == "icon-mask"
    assert call["payload"]["prompt"] == "a concise star icon"
    assert call["payload"]["image_bytes"] == ""


@pytest.mark.asyncio
async def test_icon_alternatives_handles_per_user_queue_limit():
    app.dependency_overrides[get_current_user] = lambda: USER
    set_failed = AsyncMock()
    try:
        with patch("routers.layer_edit.task_repo.create", new=AsyncMock(return_value="icon-full")), patch(
            "routers.layer_edit.task_repo.set_failed", new=set_failed
        ), patch(
            "routers.layer_edit.queue_assets.persist_queue_inputs",
            new=AsyncMock(return_value=_references()),
        ), patch(
            "routers.layer_edit.enqueue",
            new=AsyncMock(side_effect=UserConcurrencyExceeded(USER["id"], 10, 10)),
        ), patch("routers.layer_edit.rate_limit", new=AsyncMock()):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/layer-edit/icon-alternatives",
                    files={
                        "image": ("image.png", _png(), "image/png"),
                        "mask": ("mask.png", _png("L"), "image/png"),
                    },
                    data={"element_id": "icon-1"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 429
    set_failed.assert_awaited_once()


@pytest.mark.asyncio
async def test_icon_alternatives_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/layer-edit/icon-alternatives",
            files={
                "image": ("image.png", _png(), "image/png"),
                "mask": ("mask.png", _png("L"), "image/png"),
            },
            data={"element_id": "icon-1"},
        )

    assert response.status_code == 401
