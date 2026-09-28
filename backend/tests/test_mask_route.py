from __future__ import annotations

import base64
from io import BytesIO

import pytest
from fastapi import UploadFile
from PIL import Image

from routers import mask as mask_router


def _png(mode: str, size: tuple[int, int], color: int | tuple[int, int, int] = 0) -> bytes:
    buffer = BytesIO()
    Image.new(mode, size, color=color).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_refine_mask_returns_a_png_mask():
    response = await mask_router.refine_mask(
        image=UploadFile(filename="image.png", file=BytesIO(_png("RGB", (8, 8), (40, 80, 120)))),
        mask=UploadFile(filename="mask.png", file=BytesIO(_png("L", (8, 8), 255))),
    )

    output = base64.b64decode(response["maskBase64"])
    with Image.open(BytesIO(output)) as refined:
        assert refined.mode == "L"
        assert refined.size == (8, 8)


@pytest.mark.asyncio
async def test_refine_mask_enforces_its_lower_pixel_budget(monkeypatch):
    monkeypatch.setattr(mask_router.settings, "MASK_REFINE_MAX_PIXELS", 3)

    with pytest.raises(Exception) as error:
        await mask_router.refine_mask(
            image=UploadFile(filename="image.png", file=BytesIO(_png("RGB", (2, 2), (40, 80, 120)))),
            mask=UploadFile(filename="mask.png", file=BytesIO(_png("L", (2, 2), 255))),
        )

    assert getattr(error.value, "status_code", None) == 413
