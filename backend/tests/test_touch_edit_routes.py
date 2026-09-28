"""Queue-contract tests for the single-image touch-edit endpoints."""
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image
from io import BytesIO

from core.queue import QueueCapacityExceeded, UserConcurrencyExceeded
from main import app
from routers import layer_edit
from routers.auth import get_current_user


USER = {"id": "user-touch-test-001", "billing_mode": "platform"}


@pytest.fixture(autouse=True)
def _priced_provider_skus():
    sku = {
        "id": "provider-sku",
        "name": "Provider SKU",
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


def _image(mode: str = "RGBA") -> bytes:
    image = Image.new(mode, (32, 32), (255, 0, 0, 255) if mode == "RGBA" else 255)
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _queue_references() -> list[dict]:
    return [
        {"role": "image", "asset_id": "image-asset", "key": "assets/input.png"},
        {"role": "mask", "asset_id": "mask-asset", "key": "assets/mask.png"},
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "task_type", "fields"),
    [
        ("/api/layer-edit/touch-replace", "touch-replace", {"prompt": "replace the object"}),
        ("/api/layer-edit/touch-recolor", "touch-recolor", {"target_color": "#00ff00"}),
        ("/api/layer-edit/touch-remove", "touch-remove", {}),
    ],
)
async def test_touch_edit_queues_asset_backed_job(path: str, task_type: str, fields: dict):
    app.dependency_overrides[get_current_user] = lambda: USER
    enqueue = AsyncMock()
    try:
        with patch("routers.layer_edit.task_repo.create", new=AsyncMock(return_value="task-1")), patch(
            "routers.layer_edit.queue_assets.persist_queue_inputs",
            new=AsyncMock(return_value=_queue_references()),
        ), patch("routers.layer_edit.enqueue", new=enqueue), patch(
            "routers.layer_edit.rate_limit", new=AsyncMock()
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    path,
                    files={
                        "image": ("input.png", _image(), "image/png"),
                        "mask": ("mask.png", _image("L"), "image/png"),
                    },
                    data={"element_id": "element-1", **fields},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 200
    assert response.json() == {"taskId": "task-1", "status": "queued"}
    call = enqueue.await_args.kwargs
    assert call["task_type"] == task_type
    assert call["payload"]["image_asset"]["asset_id"] == "image-asset"
    assert call["payload"]["mask_asset"]["asset_id"] == "mask-asset"
    assert call["payload"]["image_bytes"] == ""
    assert call["payload"]["mask_bytes"] == ""


@pytest.mark.asyncio
async def test_touch_edit_rejects_user_concurrency_and_marks_task_failed():
    app.dependency_overrides[get_current_user] = lambda: USER
    set_failed = AsyncMock()
    try:
        with patch("routers.layer_edit.task_repo.create", new=AsyncMock(return_value="task-full")), patch(
            "routers.layer_edit.task_repo.set_failed", new=set_failed
        ), patch(
            "routers.layer_edit.queue_assets.persist_queue_inputs",
            new=AsyncMock(return_value=_queue_references()),
        ), patch(
            "routers.layer_edit.enqueue",
            new=AsyncMock(side_effect=UserConcurrencyExceeded(USER["id"], 10, 10)),
        ), patch("routers.layer_edit.rate_limit", new=AsyncMock()):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/layer-edit/touch-remove",
                    files={
                        "image": ("input.png", _image(), "image/png"),
                        "mask": ("mask.png", _image("L"), "image/png"),
                    },
                    data={"element_id": "element-1"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 429
    set_failed.assert_awaited_once()


@pytest.mark.asyncio
async def test_touch_edit_maps_global_queue_capacity_to_retryable_response():
    app.dependency_overrides[get_current_user] = lambda: USER
    try:
        with patch("routers.layer_edit.task_repo.create", new=AsyncMock(return_value="task-full")), patch(
            "routers.layer_edit.queue_assets.persist_queue_inputs",
            new=AsyncMock(return_value=_queue_references()),
        ), patch(
            "routers.layer_edit.enqueue",
            new=AsyncMock(side_effect=QueueCapacityExceeded(100, 100)),
        ), patch("routers.layer_edit.rate_limit", new=AsyncMock()):
            transport = ASGITransport(app=app, raise_app_exceptions=False)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/layer-edit/touch-remove",
                    files={
                        "image": ("input.png", _image(), "image/png"),
                        "mask": ("mask.png", _image("L"), "image/png"),
                    },
                    data={"element_id": "element-1"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"


@pytest.mark.asyncio
async def test_touch_edit_queue_rejection_marks_task_failed_and_releases_input_assets():
    failed = AsyncMock()
    release_inputs = AsyncMock()
    payload = {
        "image_asset": {
            "file_asset_id": "file-image",
            "key": "assets/users/user-touch-test-001/queue-inputs/task/files/image.png",
        },
        "mask_asset": {
            "file_asset_id": "file-mask",
            "key": "assets/users/user-touch-test-001/queue-inputs/task/files/mask.png",
        },
    }
    with patch(
        "routers.layer_edit.enqueue",
        new=AsyncMock(side_effect=QueueCapacityExceeded(100, 100)),
    ), patch("routers.layer_edit.task_repo.set_failed", new=failed), patch(
        "routers.layer_edit.queue_assets.release_consumed_queue_inputs",
        new=release_inputs,
    ):
        with pytest.raises(QueueCapacityExceeded):
            await layer_edit._enqueue_touch_edit(
                task_type="touch-remove",
                task_id="task-full",
                payload=payload,
                user_id=USER["id"],
            )

    failed.assert_awaited_once()
    release_inputs.assert_awaited_once_with(user_id=USER["id"], payload=payload)


@pytest.mark.asyncio
async def test_touch_edit_requires_authentication():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/layer-edit/touch-remove",
            files={
                "image": ("input.png", _image(), "image/png"),
                "mask": ("mask.png", _image("L"), "image/png"),
            },
            data={"element_id": "element-1"},
        )

    assert response.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/layer-edit/status/task-other", "/api/layer-edit/result/task-other"])
async def test_layer_edit_task_endpoints_hide_other_users_tasks(path: str):
    app.dependency_overrides[get_current_user] = lambda: USER
    try:
        with patch(
            "routers.layer_edit.task_repo.get",
            new=AsyncMock(return_value={
                "_user_id": "someone-else",
                "status": "completed",
                "progress": 100,
                "error": None,
                "result": {"imageBase64": "private-image"},
            }),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get(path)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 404
