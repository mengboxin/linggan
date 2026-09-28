"""Bounded image-input readers shared by API upload routes."""
from __future__ import annotations

import base64
import binascii
import io
from typing import Sequence

from fastapi import HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from core.config import settings


def _max_file_bytes() -> int:
    return max(1, int(settings.MAX_FILE_SIZE_MB)) * 1024 * 1024


def _max_request_bytes() -> int:
    # Keep this aligned with the generation route: one allowed file must not
    # become invalid merely because the aggregate setting is configured lower.
    return max(_max_file_bytes(), int(settings.MAX_IMAGE_REQUEST_MB) * 1024 * 1024)


def _validate_image_bytes(raw: bytes, *, label: str) -> bytes:
    if not raw:
        raise HTTPException(400, f"{label}不能为空")

    try:
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            if width <= 0 or height <= 0:
                raise HTTPException(400, f"{label}尺寸无效")
            if width * height > max(1, int(settings.MAX_IMAGE_PIXELS)):
                raise HTTPException(413, f"{label}像素尺寸过大")
            image.verify()
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(413, f"{label}像素尺寸过大") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise HTTPException(400, f"无法解析{label}文件") from None

    return raw


async def _read_upload_bytes(upload: UploadFile, *, label: str) -> bytes:
    max_file_bytes = _max_file_bytes()
    raw = await upload.read(max_file_bytes + 1)
    if len(raw) > max_file_bytes:
        raise HTTPException(413, f"{label}不能超过 {settings.MAX_FILE_SIZE_MB}MB")
    return raw


async def read_image_upload(upload: UploadFile, *, label: str = "图片") -> bytes:
    """Read one image with a hard byte cap and header-level image validation."""
    raw = await _read_upload_bytes(upload, label=label)
    return _validate_image_bytes(raw, label=label)


async def read_image_uploads(
    uploads: Sequence[tuple[str, UploadFile]],
) -> list[bytes]:
    """Read related image uploads while enforcing their shared request limit."""
    total_bytes = 0
    images: list[bytes] = []
    max_request_bytes = _max_request_bytes()
    for label, upload in uploads:
        raw = await _read_upload_bytes(upload, label=label)
        total_bytes += len(raw)
        if total_bytes > max_request_bytes:
            raise HTTPException(413, f"图片总大小不能超过 {settings.MAX_IMAGE_REQUEST_MB}MB")
        images.append(_validate_image_bytes(raw, label=label))
    return images


def _base64_payload(value: str) -> str:
    payload = (value or "").strip()
    if payload.startswith("data:"):
        header, separator, payload = payload.partition(",")
        if not separator or ";base64" not in header.lower():
            raise HTTPException(400, "图片数据格式无效")
    if not payload:
        raise HTTPException(400, "图片不能为空")
    return payload


def decode_base64_image(value: str, *, label: str = "图片") -> bytes:
    """Decode one Base64 image only after checking its maximum possible size."""
    payload = _base64_payload(value)
    max_file_bytes = _max_file_bytes()
    max_encoded_bytes = ((max_file_bytes + 2) // 3) * 4
    if len(payload) > max_encoded_bytes:
        raise HTTPException(413, f"{label}不能超过 {settings.MAX_FILE_SIZE_MB}MB")

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "图片数据格式无效") from None
    if len(raw) > max_file_bytes:
        raise HTTPException(413, f"{label}不能超过 {settings.MAX_FILE_SIZE_MB}MB")
    if len(raw) > _max_request_bytes():
        raise HTTPException(413, f"图片总大小不能超过 {settings.MAX_IMAGE_REQUEST_MB}MB")
    return _validate_image_bytes(raw, label=label)
