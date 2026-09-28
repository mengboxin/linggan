"""Regression coverage for result images kept out of Redis task state."""

import base64
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from PIL import Image

from core import worker as worker_module
from services import asset_storage, layer_edit, touch_edit


async def _run_provider_call(**kwargs):
    return await kwargs["invoke"]()


@pytest.fixture(autouse=True)
def _provider_billing_passthrough():
    with patch(
        "services.touch_edit.execute_platform_provider_call",
        side_effect=_run_provider_call,
    ):
        yield


def _png(width: int = 32, height: int = 24) -> bytes:
    image = Image.new("RGBA", (width, height), (20, 120, 220, 255))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _stored_asset() -> asset_storage.StoredImageAsset:
    return asset_storage.StoredImageAsset(
        id="asset-1",
        original_url="/api/assets/asset-1/original",
        preview_url="/api/assets/asset-1/preview",
        thumb_url="/api/assets/asset-1/thumb",
        original_key="assets/original.png",
        preview_key="assets/preview.webp",
        thumb_key="assets/thumb.webp",
        width=32,
        height=24,
        mime_type="image/png",
        size_bytes=123,
        sha256="abc",
    )


@pytest.mark.asyncio
async def test_touch_edit_archives_completed_result_before_writing_task_state():
    result_bytes = _png()
    router = MagicMock()
    router.inpaint = AsyncMock(return_value=result_bytes)
    completed = AsyncMock()
    store = AsyncMock(return_value=_stored_asset())

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_completed", new=completed
    ), patch("services.touch_edit.asset_storage.store_generated_image_best_effort", new=store):
        await touch_edit.run_touch_inpaint(
            "touch-task",
            _png(),
            _png(),
            "replace the badge",
            "replace",
            element_id="badge-1",
            user_id="user-1",
        )

    store.assert_awaited_once()
    assert store.await_args.kwargs["user_id"] == "user-1"
    assert store.await_args.kwargs["task_id"] == "touch-task"
    result = completed.await_args.args[1]
    assert result["image"] == "/api/assets/asset-1/original"
    assert result["imageBase64"] == ""
    assert result["assetId"] == "asset-1"


@pytest.mark.asyncio
async def test_touch_edit_keeps_base64_only_when_asset_archive_is_unavailable():
    result_bytes = _png()
    router = MagicMock()
    router.inpaint = AsyncMock(return_value=result_bytes)
    completed = AsyncMock()

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_completed", new=completed
    ), patch(
        "services.touch_edit.asset_storage.store_generated_image_best_effort",
        new=AsyncMock(return_value=None),
    ):
        await touch_edit.run_touch_inpaint(
            "touch-task",
            _png(),
            _png(),
            "remove the badge",
            "remove",
            user_id="user-1",
        )

    result = completed.await_args.args[1]
    assert result["image"] == base64.b64encode(result_bytes).decode()
    assert result["imageBase64"] == result["image"]
    assert result["imageUrl"] == ""


@pytest.mark.asyncio
async def test_icon_alternatives_return_asset_references_without_inline_pixels():
    source = _png()
    router = MagicMock()
    router.inpaint = AsyncMock(return_value=source)
    completed = AsyncMock()
    store = AsyncMock(return_value=_stored_asset())

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_completed", new=completed
    ), patch("services.touch_edit.asset_storage.store_generated_image_best_effort", new=store):
        await touch_edit.run_icon_alternatives(
            task_id="icon-task",
            image_bytes=source,
            mask_bytes=_png(),
            element_id="icon-1",
            user_id="user-1",
        )

    assert store.await_count == 4
    result = completed.await_args.args[1]
    assert result["total"] == 4
    assert all(candidate["image_base64"] == "" for candidate in result["candidates"])
    assert all(candidate["asset_id"] == "asset-1" for candidate in result["alternatives"])


@pytest.mark.asyncio
async def test_layer_edit_archives_completed_result_before_writing_task_state():
    source = _png()
    model_result = Image.new("RGBA", (32, 24), (220, 120, 20, 255))
    completed = AsyncMock()
    store = AsyncMock(return_value=_stored_asset())

    async def model_call(*_args, **_kwargs):
        return model_result

    with patch(
        "repositories.model_repo.get_model_internal",
        new=AsyncMock(return_value={"endpoint": "http://model", "api_key": "key"}),
    ), patch("services.layer_edit._call_model_endpoint", new=model_call), patch(
        "services.layer_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.layer_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.layer_edit.task_repo.set_completed", new=completed
    ), patch("services.layer_edit.asset_storage.store_generated_image_best_effort", new=store):
        await layer_edit.run_layer_edit(
            "layer-task",
            source,
            {"model_id": "image2", "prompt": "refine edges"},
            user_id="user-1",
        )

    store.assert_awaited_once()
    result = completed.await_args.args[1]
    assert result["imageBase64"] == ""
    assert result["imageUrl"] == "/api/assets/asset-1/original"
    assert result["assetId"] == "asset-1"


@pytest.mark.asyncio
async def test_worker_passes_queue_user_to_asset_backed_edit_handlers():
    encoded = base64.b64encode(_png()).decode()
    touch_handler = AsyncMock()
    layer_handler = AsyncMock()
    icon_handler = AsyncMock()
    original_handlers = dict(worker_module._handlers)
    try:
        worker_module._handlers.clear()
        worker_module._register_all_handlers()
        with patch("services.touch_edit.run_touch_inpaint", new=touch_handler), patch(
            "services.layer_edit.run_layer_edit", new=layer_handler
        ), patch("services.touch_edit.run_icon_alternatives", new=icon_handler):
            payload = {
                "_queue_user_id": "user-1",
                "image_bytes": encoded,
                "mask_bytes": encoded,
                "params": {},
            }
            await worker_module._handlers["touch-replace"]("touch-task", payload)
            await worker_module._handlers["layer-edit"]("layer-task", payload)
            await worker_module._handlers["icon-alternatives"]("icon-task", payload)

        assert touch_handler.await_args.kwargs["user_id"] == "user-1"
        assert layer_handler.await_args.kwargs["user_id"] == "user-1"
        assert icon_handler.await_args.kwargs["user_id"] == "user-1"
    finally:
        worker_module._handlers.clear()
        worker_module._handlers.update(original_handlers)
