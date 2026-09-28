import base64
from io import BytesIO
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from PIL import Image
from starlette.requests import Request

from main import app
from routers import assets
from routers.auth import get_current_user
from services import image_upload_validation


USER = {"id": "user-upload-limits", "billing_mode": "platform"}


def _image_bytes(width: int = 8, height: int = 8, image_format: str = "PNG") -> bytes:
    image = Image.new("RGB", (width, height), "white")
    output = BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


def _request() -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/assets/images",
        "headers": [],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("test", 1234),
        "scheme": "http",
    })


class _RecordingUpload:
    filename = "large.png"
    content_type = "image/png"

    def __init__(self, data: bytes):
        self.data = data
        self.read_sizes: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return self.data if size < 0 else self.data[:size]


@pytest.mark.asyncio
async def test_image_upload_reader_uses_a_bounded_read(monkeypatch):
    monkeypatch.setattr(image_upload_validation.settings, "MAX_FILE_SIZE_MB", 1)
    upload = _RecordingUpload(b"x" * (1024 * 1024 + 100))

    with pytest.raises(HTTPException) as exc_info:
        await image_upload_validation.read_image_upload(upload)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 413
    assert upload.read_sizes == [1024 * 1024 + 1]


@pytest.mark.asyncio
async def test_related_image_uploads_enforce_the_shared_request_limit(monkeypatch):
    monkeypatch.setattr(image_upload_validation.settings, "MAX_FILE_SIZE_MB", 1)
    monkeypatch.setattr(image_upload_validation.settings, "MAX_IMAGE_REQUEST_MB", 1)
    first = _RecordingUpload(_image_bytes(500, 400, "BMP"))
    second = _RecordingUpload(_image_bytes(500, 400, "BMP"))

    with pytest.raises(HTTPException) as exc_info:
        await image_upload_validation.read_image_uploads((("图片", first), ("蒙版", second)))  # type: ignore[arg-type]

    assert exc_info.value.status_code == 413
    assert len(first.read_sizes) == 1
    assert len(second.read_sizes) == 1


@pytest.mark.asyncio
async def test_layer_edit_route_rejects_excessive_image_pixels(monkeypatch):
    monkeypatch.setattr(image_upload_validation.settings, "MAX_IMAGE_PIXELS", 3)
    app.dependency_overrides[get_current_user] = lambda: USER
    try:
        with patch("routers.layer_edit.rate_limit", new=AsyncMock()):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.post(
                    "/api/layer-edit/submit",
                    files={"image": ("input.png", _image_bytes(2, 2), "image/png")},
                    data={"model_id": "image2"},
                )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 413


@pytest.mark.asyncio
async def test_segmentation_partial_route_rejects_excessive_image_pixels(monkeypatch):
    monkeypatch.setattr(image_upload_validation.settings, "MAX_IMAGE_PIXELS", 3)
    app.dependency_overrides[get_current_user] = lambda: USER
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/segmentation/partial",
                files={"image": ("input.png", _image_bytes(2, 2), "image/png")},
                data={"region_x": "0", "region_y": "0", "region_w": "2", "region_h": "2"},
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 413


@pytest.mark.asyncio
async def test_asset_import_decodes_validated_base64_before_storage(monkeypatch):
    image_bytes = _image_bytes()
    stored = type("Stored", (), {
        "to_meta": lambda self: {
            "asset_id": "asset-1",
            "image_url": "/api/assets/asset-1/original",
            "preview_url": "/api/assets/asset-1/preview",
            "thumbnail_url": "/api/assets/asset-1/thumb",
        },
    })()
    store = AsyncMock(return_value=stored)
    monkeypatch.setattr(assets, "_resolve_user", AsyncMock(return_value=USER))
    monkeypatch.setattr(assets.asset_storage, "store_generated_image", store)

    response = await assets.upload_image_asset(
        _request(),
        assets.UploadImageBody(
            image_base64="data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii"),
        ),
    )

    assert response["assetId"] == "asset-1"
    assert store.await_args.kwargs["image_bytes"] == image_bytes
    assert "image_base64" not in store.await_args.kwargs


def test_asset_import_rejects_oversized_base64_before_decode(monkeypatch):
    monkeypatch.setattr(image_upload_validation.settings, "MAX_FILE_SIZE_MB", 1)
    max_file_bytes = 1024 * 1024
    oversized = "A" * (((max_file_bytes + 2) // 3) * 4 + 1)

    with pytest.raises(HTTPException) as exc_info:
        image_upload_validation.decode_base64_image(oversized)

    assert exc_info.value.status_code == 413
