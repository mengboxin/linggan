"""Image asset storage helpers.

Production stores images in Cloudflare R2/S3-compatible storage and keeps only
URLs/keys in Postgres. If R2 is not configured, callers can fall back to legacy
base64 metadata without failing local development.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import mimetypes
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, quote, unquote, urlsplit

from PIL import Image, ImageOps

from core.config import settings
from repositories import asset_mirror_repo, file_asset_repo, image_asset_repo

logger = logging.getLogger(__name__)

_image_transform_sem = asyncio.Semaphore(max(1, settings.IMAGE_TRANSFORM_CONCURRENCY))
_storage_io_sem = asyncio.Semaphore(max(1, settings.STORAGE_IO_CONCURRENCY))
_IMAGE_UPLOAD_CHUNK_BYTES = 1024 * 1024


def _strip_nul(value: str | None) -> str:
    """PostgreSQL text fields cannot contain NUL bytes from untrusted input."""
    return (value or '').replace('\x00', '')


@asynccontextmanager
async def _no_asset_write_lock():
    yield


async def _run_storage_io(function, /, *args, **kwargs):
    async with _storage_io_sem:
        return await asyncio.to_thread(function, *args, **kwargs)


@dataclass
class StoredImageAsset:
    id: str
    original_url: str
    preview_url: str
    thumb_url: str
    original_key: str
    preview_key: str
    thumb_key: str
    width: int
    height: int
    mime_type: str
    size_bytes: int
    sha256: str

    def to_meta(self) -> dict:
        return {
            "asset_id": self.id,
            "image_url": self.original_url,
            "preview_url": self.preview_url,
            "thumbnail_url": self.thumb_url,
            "asset_original_key": self.original_key,
            "asset_preview_key": self.preview_key,
            "asset_thumb_key": self.thumb_key,
            "image_width": self.width,
            "image_height": self.height,
            "image_mime": self.mime_type,
            "image_size_bytes": self.size_bytes,
            "image_sha256": self.sha256,
        }


@dataclass(frozen=True)
class StagedImageFile:
    """A bounded on-disk copy of an internal generated-image callback."""

    path: Path
    size_bytes: int
    sha256: str


class ImageUploadTooLargeError(ValueError):
    """Raised when a streamed callback image exceeds its configured limit."""


async def stage_uploaded_image(
    upload: Any,
    *,
    max_bytes: int,
    chunk_bytes: int = _IMAGE_UPLOAD_CHUNK_BYTES,
) -> StagedImageFile:
    """Copy an async upload into a bounded temporary file while hashing it.

    ``UploadFile.read()`` is deliberately called in chunks, so a Go worker
    callback cannot make the API process retain its full generated image in a
    Python ``bytes`` object. The returned file remains owned by the caller and
    must be removed with :func:`remove_staged_image_file`.
    """
    limit = max(1, int(max_bytes))
    read_size = max(1, int(chunk_bytes))
    descriptor, raw_path = tempfile.mkstemp(prefix="pixelscribe-image-", suffix=".upload")
    path = Path(raw_path)
    digest = hashlib.sha256()
    size_bytes = 0
    try:
        with os.fdopen(descriptor, "wb") as destination:
            while True:
                # Read at most one byte beyond the remaining quota. This
                # identifies oversized uploads without materializing them.
                remaining_with_sentinel = limit - size_bytes + 1
                chunk = await upload.read(min(read_size, remaining_with_sentinel))
                if not chunk:
                    break
                size_bytes += len(chunk)
                if size_bytes > limit:
                    raise ImageUploadTooLargeError("generated image exceeds configured size limit")
                digest.update(chunk)
                await _run_storage_io(destination.write, chunk)
            await _run_storage_io(destination.flush)
        if not size_bytes:
            raise ValueError("empty generated image")
        return StagedImageFile(path=path, size_bytes=size_bytes, sha256=digest.hexdigest())
    except BaseException:
        try:
            await asyncio.to_thread(path.unlink, missing_ok=True)
        except OSError:
            pass
        raise


async def remove_staged_image_file(staged: StagedImageFile | str | Path | None) -> None:
    """Best-effort cleanup for a temporary callback image."""
    if staged is None:
        return
    path = staged.path if isinstance(staged, StagedImageFile) else Path(staged)
    try:
        await asyncio.to_thread(path.unlink, missing_ok=True)
    except OSError as exc:
        logger.warning("failed to remove staged image path=%s error=%s", path, exc)


def _stored_image_asset_from_row(
    row: dict,
    *,
    fallback_width: int = 0,
    fallback_height: int = 0,
    fallback_mime_type: str = "image/png",
    fallback_size_bytes: int = 0,
    fallback_sha256: str = "",
) -> StoredImageAsset:
    return StoredImageAsset(
        id=str(row.get("id") or ""),
        original_url=str(row.get("original_url") or ""),
        preview_url=str(row.get("preview_url") or ""),
        thumb_url=str(row.get("thumb_url") or ""),
        original_key=str(row.get("original_key") or ""),
        preview_key=str(row.get("preview_key") or ""),
        thumb_key=str(row.get("thumb_key") or ""),
        width=int(row.get("width") or fallback_width),
        height=int(row.get("height") or fallback_height),
        mime_type=str(row.get("mime_type") or fallback_mime_type),
        size_bytes=int(row.get("size_bytes") or fallback_size_bytes),
        sha256=str(row.get("sha256") or fallback_sha256),
    )


def _asset_row_matches_write(
    row: dict,
    *,
    task_id: str,
    sha256: str,
) -> bool:
    """Verify that a retry is resuming the same generated image write."""
    expected_task_id = str(task_id or "").strip()
    stored_task_id = str(row.get("task_id") or "").strip()
    stored_sha256 = str(row.get("sha256") or "").strip()
    if expected_task_id and stored_task_id != expected_task_id:
        return False
    return bool(stored_sha256 and hmac.compare_digest(stored_sha256, sha256))


def is_asset_storage_enabled() -> bool:
    return bool(
        settings.S3_ENDPOINT
        and settings.S3_ACCESS_KEY_ID
        and settings.S3_SECRET_ACCESS_KEY
        and settings.S3_BUCKET
    )


def is_asset_storage_mirror_enabled() -> bool:
    return bool(
        settings.STORAGE_MIRROR_ENABLED
        and settings.STORAGE_MIRROR_ENDPOINT
        and settings.STORAGE_MIRROR_BUCKET
    )


def is_asset_storage_mirror_client_configured() -> bool:
    return bool(
        settings.STORAGE_MIRROR_ACCESS_KEY_ID
        and settings.STORAGE_MIRROR_SECRET_ACCESS_KEY
    )


def _asset_url(asset_id: str, variant: str) -> str:
    return f"/api/assets/{asset_id}/{variant}"


def _asset_backend_url(asset_id: str, variant: str) -> str:
    return f"{_asset_url(asset_id, variant)}?direct=1"


def is_asset_delivery_enabled() -> bool:
    return bool(
        settings.ASSET_DELIVERY_BASE_URL.strip()
        and settings.ASSET_DELIVERY_SIGNING_KEY.strip()
    )


def _asset_delivery_signature(path: str, expires_at: int) -> str:
    payload = f"{path}\n{expires_at}".encode("utf-8")
    digest = hmac.new(
        settings.ASSET_DELIVERY_SIGNING_KEY.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def asset_delivery_url(key: str, *, expires_at: Optional[int] = None) -> str:
    if not is_asset_delivery_enabled():
        return ""
    normalized_key = key.strip().lstrip("/")
    if not normalized_key:
        return ""
    base_url = settings.ASSET_DELIVERY_BASE_URL.strip().rstrip("/")
    encoded_key = quote(normalized_key, safe="/-._~")
    target = f"{base_url}/{encoded_key}"
    target_path = urlsplit(target).path
    expiry = (
        expires_at
        if expires_at is not None
        else int(time.time()) + max(60, settings.ASSET_DELIVERY_URL_TTL_SECONDS)
    )
    signature = _asset_delivery_signature(target_path, expiry)
    return f"{target}?expires={expiry}&signature={signature}"


def verify_asset_delivery_signature(
    url: str,
    *,
    now: Optional[int] = None,
    min_ttl_seconds: int = 0,
) -> bool:
    if not is_asset_delivery_enabled():
        return False
    parsed = urlsplit(url)
    query = parse_qs(parsed.query)
    try:
        expires_at = int((query.get("expires") or [""])[0])
    except (TypeError, ValueError):
        return False
    signature = (query.get("signature") or [""])[0]
    current_time = int(time.time()) if now is None else now
    if not signature or expires_at < current_time + max(0, min_ttl_seconds):
        return False
    expected = _asset_delivery_signature(parsed.path, expires_at)
    return hmac.compare_digest(signature, expected)


def _first_string(mapping: dict, *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def client_image_asset_urls(meta: dict, *, allow_delivery_keys: bool = False) -> dict:
    """Build client URLs without changing durable asset metadata.

    Object keys are signed only after the caller has established ownership.
    """
    if not isinstance(meta, dict):
        meta = {}
    asset_id = _first_string(meta, "asset_id", "assetId")
    original_key = _first_string(
        meta,
        "asset_original_key",
        "assetOriginalKey",
        "original_key",
        "originalKey",
    )
    preview_key = _first_string(
        meta,
        "asset_preview_key",
        "assetPreviewKey",
        "preview_key",
        "previewKey",
    )
    thumb_key = _first_string(
        meta,
        "asset_thumb_key",
        "assetThumbKey",
        "thumb_key",
        "thumbKey",
    )

    image_asset_url = _asset_url(asset_id, "original") if asset_id else ""
    preview_asset_url = _asset_url(asset_id, "preview") if asset_id else ""
    thumbnail_asset_url = _asset_url(asset_id, "thumb") if asset_id else ""
    image_fallback = _asset_backend_url(asset_id, "original") if asset_id else ""
    preview_fallback = _asset_backend_url(asset_id, "preview") if asset_id else ""
    thumbnail_fallback = _asset_backend_url(asset_id, "thumb") if asset_id else ""
    existing_image = _first_string(meta, "image_url", "imageUrl", "original_url", "originalUrl")
    existing_preview = _first_string(meta, "preview_url", "previewUrl", "rendered_url", "renderedUrl")
    existing_thumbnail = _first_string(
        meta,
        "thumbnail_url",
        "thumbnailUrl",
        "thumb_url",
        "thumbUrl",
        "thumbnail",
    )

    direct_image = asset_delivery_url(original_key) if allow_delivery_keys else ""
    direct_preview = asset_delivery_url(preview_key or original_key) if allow_delivery_keys else ""
    direct_thumbnail = asset_delivery_url(thumb_key or preview_key or original_key) if allow_delivery_keys else ""
    image_url = direct_image or existing_image or image_asset_url
    preview_url = direct_preview or existing_preview or preview_asset_url or image_url
    thumbnail_url = direct_thumbnail or existing_thumbnail or thumbnail_asset_url or preview_url

    return {
        "asset_id": asset_id,
        "image_url": image_url,
        "preview_url": preview_url,
        "thumbnail_url": thumbnail_url,
        "image_fallback_url": image_fallback,
        "preview_fallback_url": preview_fallback,
        "thumbnail_fallback_url": thumbnail_fallback,
    }


def _asset_reference(value: str) -> tuple[str, str] | None:
    raw = (value or "").strip()
    if not raw:
        return None
    path = urlsplit(raw).path
    parts = path.strip("/").split("/")
    if len(parts) != 4 or parts[:2] != ["api", "assets"]:
        return None
    variant = parts[3].lower()
    if variant not in {"original", "preview", "thumb", "thumbnail"}:
        return None
    return parts[2], "thumb" if variant == "thumbnail" else variant


def _queryable_asset_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (TypeError, ValueError, AttributeError):
        return ""


def _embedded_asset_row(value: dict) -> tuple[str, dict] | None:
    asset_id = _first_string(value, "asset_id", "assetId")
    if not asset_id:
        return None
    row = {
        "id": asset_id,
        "original_key": _first_string(
            value,
            "asset_original_key",
            "assetOriginalKey",
            "original_key",
            "originalKey",
        ),
        "preview_key": _first_string(
            value,
            "asset_preview_key",
            "assetPreviewKey",
            "preview_key",
            "previewKey",
        ),
        "thumb_key": _first_string(
            value,
            "asset_thumb_key",
            "assetThumbKey",
            "thumb_key",
            "thumbKey",
        ),
    }
    if any(row[key] for key in ("original_key", "preview_key", "thumb_key")):
        return asset_id, row
    return None


def _fallback_field_name(field: str) -> str:
    if field == "src":
        return "fallback_src"
    if field in {"imageBase64", "thumbnailBase64", "preview_base64", "canvas_image"}:
        return f"{field}_fallback"
    if field.endswith("_url"):
        return f"{field[:-4]}_fallback_url"
    if field.endswith("Url"):
        return f"{field[:-3]}FallbackUrl"
    return ""


def _owned_delivery_asset_key(value: str, owned_prefix: str) -> str:
    """Extract an owned object key from a legacy signed delivery URL."""
    raw = (value or "").strip()
    if not raw or not owned_prefix:
        return ""
    try:
        parsed = urlsplit(raw)
        delivery_base = urlsplit(settings.ASSET_DELIVERY_BASE_URL)
    except ValueError:
        return ""
    if not parsed.scheme or not parsed.netloc:
        return ""
    if (parsed.scheme, parsed.netloc) != (delivery_base.scheme, delivery_base.netloc):
        return ""
    path = unquote(parsed.path).lstrip("/")
    start = path.find(owned_prefix)
    return path[start:] if start >= 0 else ""


async def prepare_image_asset_payload(payload: Any, user_id: str) -> Any:
    """Rewrite private asset references for one authenticated API response.

    Embedded keys avoid a database query for current records. Legacy records
    are resolved in one batch, so a history page never performs one API lookup
    per thumbnail.
    """
    if not is_asset_delivery_enabled():
        return payload

    asset_ids: set[str] = set()
    asset_keys: set[str] = set()
    embedded_assets: dict[str, dict] = {}
    owned_prefix = user_asset_prefix(user_id) + "/"

    def collect(value: Any) -> None:
        if isinstance(value, str):
            reference = _asset_reference(value)
            if reference:
                queryable = _queryable_asset_id(reference[0])
                if queryable:
                    asset_ids.add(queryable)
            delivery_key = _owned_delivery_asset_key(value, owned_prefix)
            if delivery_key:
                asset_keys.add(delivery_key)
            return
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if not isinstance(value, dict):
            return
        embedded = _embedded_asset_row(value)
        if embedded and all(
            not key or key.startswith(owned_prefix)
            for key in (
                embedded[1].get("original_key", ""),
                embedded[1].get("preview_key", ""),
                embedded[1].get("thumb_key", ""),
            )
        ):
            embedded_assets[embedded[0]] = embedded[1]
        explicit_id = _first_string(value, "asset_id", "assetId")
        queryable = _queryable_asset_id(explicit_id)
        has_fresh_delivery_url = any(
            isinstance(item, str) and verify_asset_delivery_signature(item, min_ttl_seconds=300)
            for item in value.values()
        )
        if queryable and not has_fresh_delivery_url:
            asset_ids.add(queryable)
        for key, item in value.items():
            if has_fresh_delivery_url and "fallback" in key.lower():
                continue
            collect(item)

    collect(payload)
    assets_by_id = dict(embedded_assets)
    unresolved = sorted(asset_id for asset_id in asset_ids if asset_id not in assets_by_id)
    if unresolved:
        try:
            rows = await image_asset_repo.list_assets_by_ids(unresolved, user_id)
            assets_by_id.update({str(row.get("id") or ""): row for row in rows if row.get("id")})
        except Exception as exc:
            logger.warning("image asset delivery batch lookup failed user_id=%s count=%s error=%s", user_id, len(unresolved), exc)
    assets_by_key: dict[str, dict] = {}
    if asset_keys:
        try:
            rows = await image_asset_repo.list_assets_by_object_keys(sorted(asset_keys), user_id)
            for row in rows:
                asset_id = str(row.get("id") or "")
                if asset_id:
                    assets_by_id.setdefault(asset_id, row)
                for key in (row.get("original_key"), row.get("preview_key"), row.get("thumb_key")):
                    if isinstance(key, str) and key:
                        assets_by_key[key] = row
        except Exception as exc:
            logger.warning("image asset delivery key lookup failed user_id=%s count=%s error=%s", user_id, len(asset_keys), exc)

    def rewrite(value: Any, field: str = "", preserve_stable_asset_urls: bool = False) -> Any:
        if isinstance(value, str):
            reference = _asset_reference(value)
            if reference:
                if preserve_stable_asset_urls:
                    return _asset_url(reference[0], "thumb")
                asset_id, variant = reference
                row = assets_by_id.get(asset_id)
                if not row:
                    return value
                urls = client_image_asset_urls({**row, "asset_id": asset_id}, allow_delivery_keys=True)
                return urls[{"original": "image_url", "preview": "preview_url", "thumb": "thumbnail_url"}[variant]] or value
            if preserve_stable_asset_urls:
                delivery_key = _owned_delivery_asset_key(value, owned_prefix)
                asset = assets_by_key.get(delivery_key)
                if asset:
                    asset_id = str(asset.get("id") or "")
                    if asset_id:
                        return _asset_url(asset_id, "thumb")
            return value
        if isinstance(value, list):
            return [rewrite(item, field, preserve_stable_asset_urls) for item in value]
        if not isinstance(value, dict):
            return value

        result: dict = {}
        for key, item in value.items():
            rewritten = rewrite(item, key, preserve_stable_asset_urls or key == "refImages")
            result[key] = rewritten
            if isinstance(item, str) and rewritten != item and _asset_reference(item):
                fallback_field = _fallback_field_name(key)
                if fallback_field:
                    reference = _asset_reference(item)
                    fallback_value = (
                        _asset_backend_url(reference[0], reference[1])
                        if reference
                        else item
                    )
                    result.setdefault(fallback_field, fallback_value)

        asset_id = _first_string(value, "asset_id", "assetId")
        row = assets_by_id.get(asset_id)
        if row:
            urls = client_image_asset_urls(
                {**row, **result, "asset_id": asset_id},
                allow_delivery_keys=True,
            )
            if "asset_id" in value:
                result.update({
                    "image_url": urls["image_url"],
                    "preview_url": urls["preview_url"],
                    "thumbnail_url": urls["thumbnail_url"],
                    "image_fallback_url": urls["image_fallback_url"],
                    "preview_fallback_url": urls["preview_fallback_url"],
                    "thumbnail_fallback_url": urls["thumbnail_fallback_url"],
                })
            if "assetId" in value:
                result.update({
                    "imageUrl": urls["image_url"],
                    "previewUrl": urls["preview_url"],
                    "thumbnailUrl": urls["thumbnail_url"],
                    "imageFallbackUrl": urls["image_fallback_url"],
                    "previewFallbackUrl": urls["preview_fallback_url"],
                    "thumbnailFallbackUrl": urls["thumbnail_fallback_url"],
                })
        return result

    return rewrite(payload)


def _file_url(key: str, filename: str = "") -> str:
    from urllib.parse import quote

    url = f"/api/assets/files/by-key?key={quote(key, safe='')}"
    if filename:
        url += f"&filename={quote(filename, safe='')}"
    return url


def safe_file_name(value: str, fallback: str = "file") -> str:
    return _safe_key_part(value, fallback)


def file_url_for_key(key: str, filename: str = "") -> str:
    return _file_url(key, filename)


def _url_for_asset(asset_id: str, variant: str, key: str) -> str:
    return _asset_url(asset_id, variant)


def _storage_client(
    *,
    endpoint: str,
    access_key_id: str,
    secret_access_key: str,
    region: str,
    timeout_seconds: int,
    addressing_style: str = "auto",
):
    import boto3
    from botocore.config import Config

    timeout = max(3, int(timeout_seconds or 20))

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name=region or "auto",
        config=Config(
            connect_timeout=timeout,
            read_timeout=timeout,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": addressing_style},
        ),
    )


def _s3_client():
    return _storage_client(
        endpoint=settings.S3_ENDPOINT,
        access_key_id=settings.S3_ACCESS_KEY_ID,
        secret_access_key=settings.S3_SECRET_ACCESS_KEY,
        region=settings.S3_REGION,
        timeout_seconds=settings.ASSET_STORAGE_REQUEST_TIMEOUT_SECONDS,
        addressing_style="auto",
    )


def _mirror_s3_client(
    *,
    endpoint: str | None = None,
    region: str | None = None,
):
    return _storage_client(
        endpoint=endpoint or settings.STORAGE_MIRROR_ENDPOINT,
        access_key_id=settings.STORAGE_MIRROR_ACCESS_KEY_ID,
        secret_access_key=settings.STORAGE_MIRROR_SECRET_ACCESS_KEY,
        region=region or settings.STORAGE_MIRROR_REGION,
        timeout_seconds=settings.STORAGE_MIRROR_REQUEST_TIMEOUT_SECONDS,
        addressing_style="virtual",
    )


def _strip_data_url(value: str) -> str:
    return value.split(",", 1)[-1] if value.startswith("data:") and "," in value else value


def _safe_key_part(value: str, fallback: str = "item") -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in (value or "").strip())
    return (cleaned or fallback).strip("._") or fallback


def user_asset_prefix(user_id: str) -> str:
    prefix = settings.ASSET_STORAGE_PREFIX.strip("/ ") or "assets"
    user_part = _safe_key_part(user_id.replace("-", ""), "anonymous")
    return f"{prefix}/users/{user_part}"


def storage_bucket_name() -> str:
    return settings.S3_BUCKET or settings.R2_BUCKET


def mirror_storage_bucket_name() -> str:
    return settings.STORAGE_MIRROR_BUCKET


def retention_days(retention_class: str = "web_history") -> int:
    normalized = (retention_class or "web_history").strip().lower()
    if normalized in {"temporary", "temp"}:
        return max(1, settings.TEMP_ASSET_RETENTION_DAYS)
    if normalized in {"export", "exports", "pptx_export"}:
        return max(1, settings.EXPORTED_FILE_RETENTION_DAYS)
    return max(0, settings.WEB_HISTORY_RETENTION_DAYS)


def expiry_for_retention(retention_class: str = "web_history", source_client: str = "web") -> str:
    if (source_client or "web").strip().lower() == "desktop":
        return ""
    if (retention_class or "web_history").strip().lower() == "web_history":
        return ""
    expires = datetime.now(timezone.utc) + timedelta(days=retention_days(retention_class))
    return expires.isoformat()


IMAGE_FORMAT_METADATA = {
    "BMP": ("image/bmp", "bmp"),
    "GIF": ("image/gif", "gif"),
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "TIFF": ("image/tiff", "tiff"),
    "WEBP": ("image/webp", "webp"),
    "AVIF": ("image/avif", "avif"),
}


def _image_source(source: bytes | Path) -> BytesIO | Path:
    return BytesIO(source) if isinstance(source, bytes) else source


def _image_metadata(source: bytes | Path) -> tuple[int, int, str, str]:
    with Image.open(_image_source(source)) as img:
        if img.width * img.height > settings.MAX_IMAGE_PIXELS:
            raise ValueError("image pixel count exceeds configured limit")
        image_format = (img.format or "").upper()
        metadata = IMAGE_FORMAT_METADATA.get(image_format)
        if not metadata:
            raise ValueError(f"unsupported image format: {image_format or 'unknown'}")
        oriented = ImageOps.exif_transpose(img)
        mime_type, extension = metadata
        return oriented.width, oriented.height, mime_type, extension


def _webp_variant(source: bytes | Path, max_px: int, quality: int) -> tuple[bytes, int, int]:
    with Image.open(_image_source(source)) as img:
        if img.width * img.height > settings.MAX_IMAGE_PIXELS:
            raise ValueError("image pixel count exceeds configured limit")
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
        width, height = img.size
        out = BytesIO()
        img.save(out, format="WEBP", quality=quality, method=6)
        return out.getvalue(), width, height


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(_IMAGE_UPLOAD_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _put_file_object(
    client: Any,
    *,
    bucket: str,
    key: str,
    path: Path,
    content_type: str,
    cache_control: str,
    size_bytes: int,
) -> Any:
    """Open the source in the storage thread so the original stays streamed."""
    with path.open("rb") as source:
        return client.put_object(
            Bucket=bucket,
            Key=key,
            Body=source,
            ContentLength=size_bytes,
            ContentType=content_type,
            CacheControl=cache_control,
        )


async def _upload_objects(
    client: Any,
    bucket: str,
    uploads: list[tuple[str, bytes | Path, str, str]],
    *,
    file_size_bytes: int,
) -> list[Exception]:
    results = await asyncio.gather(*(
        _run_storage_io(
            _put_file_object,
            client,
            bucket=bucket,
            key=key,
            path=body,
            content_type=content_type,
            cache_control=cache_control,
            size_bytes=file_size_bytes,
        )
        if isinstance(body, Path)
        else _run_storage_io(
            client.put_object,
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl=cache_control,
        )
        for key, body, content_type, cache_control in uploads
    ), return_exceptions=True)
    return [result for result in results if isinstance(result, Exception)]


async def store_generated_image(
    *,
    image_bytes: Optional[bytes] = None,
    image_base64: str = "",
    image_path: str | Path | None = None,
    image_sha256: str = "",
    image_size_bytes: Optional[int] = None,
    user_id: str,
    conversation_id: Optional[str],
    task_id: str,
    prompt: str,
    model_id: str,
    category: str = "images",
    asset_id: str = "",
    item_id: str = "",
    retention_class: str = "web_history",
    source_client: str = "web",
) -> Optional[StoredImageAsset]:
    # JSON prompts and callback metadata may legally carry ``\u0000``. Keep
    # those requests from turning a successful upload into a database 503.
    task_id = _strip_nul(task_id)
    prompt = _strip_nul(prompt)
    model_id = _strip_nul(model_id)
    category = _strip_nul(category) or "images"
    asset_id = _strip_nul(asset_id)
    item_id = _strip_nul(item_id)
    retention_class = _strip_nul(retention_class) or "web_history"
    source_client = _strip_nul(source_client) or "web"
    conversation_id = _strip_nul(conversation_id) or None

    if not is_asset_storage_enabled():
        return None

    uploads: list[tuple[str, bytes | Path, str, str]] = []
    metadata_write_started = False

    async def recover_write_failure(
        exc: Exception,
        *,
        expected_task_id: str,
        connection: Any | None = None,
    ) -> Optional[StoredImageAsset]:
        """Resolve an ambiguous write while the explicit asset lock is held."""
        logger.warning("image asset storage failed task_id=%s error=%s", task_id, exc)
        selected_asset_id = str(asset_id or "").strip()
        if metadata_write_started and selected_asset_id and "digest" in locals():
            try:
                persisted = await image_asset_repo.get_image_asset(
                    selected_asset_id,
                    user_id,
                    connection=connection,
                )
            except Exception as lookup_exc:
                # A DB commit may have succeeded after a broken response. Do not
                # delete its objects until the durable row can be checked.
                logger.warning(
                    "image asset persistence outcome is unknown asset_id=%s task_id=%s error=%s",
                    selected_asset_id,
                    task_id,
                    lookup_exc,
                )
                return None
            if persisted:
                if _asset_row_matches_write(persisted, task_id=expected_task_id, sha256=digest):
                    return _stored_image_asset_from_row(persisted)
                logger.error(
                    "image asset rollback skipped for conflicting persisted asset_id=%s task_id=%s",
                    selected_asset_id,
                    task_id,
                )
                return None
        uploaded_keys = [key for key, _, _, _ in uploads]
        try:
            await delete_asset_keys(
                uploaded_keys,
                user_id=user_id,
                reason="image-upload-rollback",
                delete_mirror=False,
            )
        except Exception as cleanup_exc:
            logger.warning(
                "failed to clean up orphaned S3 objects after storage failure task_id=%s error=%s",
                task_id,
                cleanup_exc,
            )
        return None

    try:
        raw: bytes | None = None
        source_path: Path | None = None
        if image_path is not None:
            source_path = Path(image_path)
            if not source_path.is_file():
                return None
            actual_size_bytes = source_path.stat().st_size
            if not actual_size_bytes:
                return None
            if image_size_bytes is not None and int(image_size_bytes) != actual_size_bytes:
                raise ValueError("staged image size changed before archival")
            digest = str(image_sha256 or "").strip().lower() or await asyncio.to_thread(_sha256_file, source_path)
            if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
                raise ValueError("staged image hash is invalid")
            size_bytes = actual_size_bytes
            image_source: bytes | Path = source_path
        else:
            raw = image_bytes or base64.b64decode(_strip_data_url(image_base64))
            if not raw:
                return None
            digest = hashlib.sha256(raw).hexdigest()
            size_bytes = len(raw)
            image_source = raw
        requested_asset_id = str(asset_id or "").strip()
        if requested_asset_id:
            existing = await image_asset_repo.get_image_asset(requested_asset_id, user_id)
            if existing:
                if _asset_row_matches_write(existing, task_id=task_id, sha256=digest):
                    return _stored_image_asset_from_row(existing)
                logger.error(
                    "image asset id conflict asset_id=%s task_id=%s",
                    requested_asset_id,
                    task_id,
                )
                return None
        normalized_category = (category or "images").strip().lower()
        is_workspace_asset = normalized_category == "workspace"
        if is_workspace_asset:
            existing = await image_asset_repo.find_workspace_asset_by_sha(
                user_id=user_id,
                task_id=task_id,
                sha256=digest,
            )
            if existing:
                return _stored_image_asset_from_row(existing)

        # Each Pillow conversion can decode the full source into an RGBA/RGB
        # pixel buffer. Run these sequentially so one completed image does not
        # retain three such buffers alongside its provider result.
        async with _image_transform_sem:
            image_metadata = await asyncio.to_thread(_image_metadata, image_source)
            preview_result = await asyncio.to_thread(
                _webp_variant, image_source, settings.IMAGE_ASSET_MAX_PREVIEW_PX, 82,
            )
            thumb_result = await asyncio.to_thread(
                _webp_variant, image_source, settings.IMAGE_ASSET_THUMB_PX, 72,
            )
        width, height, original_mime_type, original_extension = image_metadata
        asset_id = requested_asset_id or str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"pixelscribe:workspace:{user_id}:{task_id}:{digest}",
            )
            if is_workspace_asset
            else uuid.uuid4()
        )
        prefix = settings.ASSET_STORAGE_PREFIX.strip("/ ") or "assets"
        user_part = _safe_key_part(user_id.replace("-", ""), "anonymous")
        category_part = _safe_key_part(category, "images")
        task_part = _safe_key_part(task_id or asset_id, asset_id)
        key_item = asset_id if is_workspace_asset else (item_id or asset_id)
        # A caller may accidentally reuse an explicit asset id with a different
        # image. Content-addressing keeps that rejected write from replacing the
        # already committed object's bytes before its metadata conflict is seen.
        item_part = _safe_key_part(f"{key_item}-{digest}", asset_id)
        base_key = f"{prefix}/users/{user_part}/{category_part}/{task_part}/images/{item_part}"
        expected_task_id = task_id or task_part
        preview, _, _ = preview_result
        thumb, _, _ = thumb_result
        preview_digest = hashlib.sha256(preview).hexdigest()
        thumb_digest = hashlib.sha256(thumb).hexdigest()
        original_key = f"{base_key}/original-{digest}.{original_extension}"
        preview_key = f"{base_key}/preview-{preview_digest}.webp"
        thumb_key = f"{base_key}/thumb-{thumb_digest}.webp"
        uploads = [
            (original_key, image_source, original_mime_type, "public, max-age=31536000, immutable"),
            (preview_key, preview, "image/webp", "public, max-age=31536000, immutable"),
            (thumb_key, thumb, "image/webp", "public, max-age=31536000, immutable"),
        ]
        write_lock = (
            image_asset_repo.image_asset_write_lock(asset_id)
            if requested_asset_id
            else _no_asset_write_lock()
        )
        stored_result: Optional[StoredImageAsset] = None
        async with write_lock:
            try:
                # Recheck after the in-process lock, but do not hold a Postgres
                # connection across object storage I/O.
                if requested_asset_id:
                    existing = await image_asset_repo.get_image_asset(
                        requested_asset_id,
                        user_id,
                    )
                    if existing:
                        if _asset_row_matches_write(existing, task_id=expected_task_id, sha256=digest):
                            return _stored_image_asset_from_row(existing)
                        logger.error(
                            "image asset id conflict asset_id=%s task_id=%s",
                            requested_asset_id,
                            task_id,
                        )
                        return None

                upload_errors = await _upload_objects(
                    _s3_client(),
                    storage_bucket_name(),
                    uploads,
                    file_size_bytes=size_bytes,
                )
                if upload_errors:
                    raise RuntimeError("; ".join(str(error) for error in upload_errors[:3]))

                metadata_lock = (
                    image_asset_repo.image_asset_metadata_lock(asset_id)
                    if requested_asset_id
                    else _no_asset_write_lock()
                )
                async with metadata_lock as write_connection:
                    if requested_asset_id:
                        existing = await image_asset_repo.get_image_asset(
                            requested_asset_id,
                            user_id,
                            connection=write_connection,
                        )
                        if existing:
                            if _asset_row_matches_write(existing, task_id=expected_task_id, sha256=digest):
                                stored_result = _stored_image_asset_from_row(existing)
                                return stored_result
                            logger.error(
                                "image asset id conflict asset_id=%s task_id=%s",
                                requested_asset_id,
                                task_id,
                            )
                            return None
                    metadata_write_started = True
                    row = await image_asset_repo.create_image_asset(
                        asset_id=asset_id,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        task_id=expected_task_id,
                        prompt=prompt[:2000],
                        model_id=model_id,
                        mime_type=original_mime_type,
                        width=width,
                        height=height,
                        size_bytes=size_bytes,
                        sha256=digest,
                        original_key=original_key,
                        original_url=_url_for_asset(asset_id, "original", original_key),
                        preview_key=preview_key,
                        preview_url=_url_for_asset(asset_id, "preview", preview_key),
                        thumb_key=thumb_key,
                        thumb_url=_url_for_asset(asset_id, "thumb", thumb_key),
                        asset_scope=category,
                        retention_class=retention_class,
                        source_client=source_client,
                        expires_at=expiry_for_retention(retention_class, source_client),
                        storage_provider=settings.STORAGE_PROVIDER or "s3",
                        object_count=3,
                        mirror_keys=(
                            [key for key, _, _, _ in uploads]
                            if is_asset_storage_mirror_enabled()
                            else None
                        ),
                        connection=write_connection,
                    )
                    if requested_asset_id and not _asset_row_matches_write(
                        row,
                        task_id=expected_task_id,
                        sha256=digest,
                    ):
                        raise RuntimeError("image asset id conflicts with a different task or image")
                    stored_result = _stored_image_asset_from_row(
                        row,
                        fallback_width=width,
                        fallback_height=height,
                        fallback_mime_type=original_mime_type,
                        fallback_size_bytes=size_bytes,
                        fallback_sha256=digest,
                    )
            except Exception as exc:
                return await recover_write_failure(
                    exc,
                    expected_task_id=expected_task_id,
                )
        if stored_result is not None:
            try:
                from repositories import storage_repo

                await storage_repo.invalidate_user_storage_cache(user_id)
            except Exception:
                pass
            return stored_result
        return None
    except Exception as exc:
        return await recover_write_failure(exc, expected_task_id=str(task_id or "").strip())


async def store_generated_image_best_effort(**kwargs: Any) -> Optional[StoredImageAsset]:
    """Archive an image already produced upstream without changing its outcome.

    Generation callers use this after they have image bytes. A storage outage
    must not turn that paid result into a failed generation; the caller retains
    its in-task fallback and may archive it again later.
    """
    return await store_generated_image(**kwargs)


async def attach_message(asset_id: str, message_id: str) -> None:
    try:
        await image_asset_repo.attach_message(asset_id, message_id)
    except Exception as exc:
        logger.warning("failed to attach image asset message asset_id=%s error=%s", asset_id, exc)


async def store_file_asset(
    *,
    file_path: str | Path,
    user_id: str,
    category: str,
    task_id: str,
    filename: str = "",
    content_type: str = "",
    retention_class: str = "web_history",
    source_client: str = "web",
    replace_task_asset: bool = False,
) -> Optional[dict]:
    path = Path(file_path)
    return await _store_file_source(
        source=path,
        user_id=user_id,
        category=category,
        task_id=task_id or path.stem,
        filename=filename or path.name,
        content_type=content_type,
        retention_class=retention_class,
        source_client=source_client,
        replace_task_asset=replace_task_asset,
    )


async def store_file_bytes(
    *,
    data: bytes,
    user_id: str,
    category: str,
    task_id: str,
    filename: str,
    content_type: str = "",
    retention_class: str = "web_history",
    source_client: str = "web",
    replace_task_asset: bool = False,
) -> Optional[dict]:
    return await _store_file_source(
        source=data,
        user_id=user_id,
        category=category,
        task_id=task_id,
        filename=filename,
        content_type=content_type,
        retention_class=retention_class,
        source_client=source_client,
        replace_task_asset=replace_task_asset,
    )


async def _store_file_source(
    *,
    source: bytes | Path,
    user_id: str,
    category: str,
    task_id: str,
    filename: str,
    content_type: str = "",
    retention_class: str = "web_history",
    source_client: str = "web",
    replace_task_asset: bool = False,
) -> Optional[dict]:
    """Archive bytes or a stable local file without copying file inputs into RAM."""
    if not is_asset_storage_enabled():
        return None

    key = ""
    try:
        if isinstance(source, Path):
            if not source.is_file():
                return None
            size_bytes = (await _run_storage_io(source.stat)).st_size
            if not size_bytes:
                return None
            digest = await _run_storage_io(_sha256_file, source)
        else:
            if not source:
                return None
            size_bytes = len(source)
            digest = hashlib.sha256(source).hexdigest()
        prefix = settings.ASSET_STORAGE_PREFIX.strip("/ ") or "assets"
        user_part = _safe_key_part(user_id.replace("-", ""), "anonymous")
        category_part = _safe_key_part(category, "files")
        task_part = _safe_key_part(task_id or digest[:16], digest[:16])
        safe_name = _safe_key_part(filename, "file")
        key_name = f"{digest}-{safe_name}"
        key = f"{prefix}/users/{user_part}/{category_part}/{task_part}/files/{key_name}"
        mime = content_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
        cache_control = "public, max-age=31536000, immutable"
        uploads = [(key, source, mime, cache_control)]
        upload_errors = await _upload_objects(
            _s3_client(),
            storage_bucket_name(),
            uploads,
            file_size_bytes=size_bytes,
        )
        if upload_errors:
            raise RuntimeError("; ".join(str(error) for error in upload_errors[:3]))
        file_url = _file_url(key, safe_name)
        expires_at = expiry_for_retention(retention_class, source_client)
        old_keys: list[str] = []
        if replace_task_asset:
            file_row, old_keys = await file_asset_repo.replace_task_file_asset(
                user_id=user_id,
                task_id=task_id or task_part,
                category=category_part,
                filename=safe_name,
                mime_type=mime,
                size_bytes=size_bytes,
                sha256=digest,
                storage_key=key,
                storage_url=file_url,
                retention_class=retention_class,
                source_client=source_client,
                expires_at=expires_at,
                storage_provider=settings.STORAGE_PROVIDER or "s3",
                mirror_keys=[key] if is_asset_storage_mirror_enabled() else None,
            )
        else:
            file_row = await file_asset_repo.create_file_asset(
                user_id=user_id,
                task_id=task_id or task_part,
                category=category_part,
                filename=safe_name,
                mime_type=mime,
                size_bytes=size_bytes,
                sha256=digest,
                storage_key=key,
                storage_url=file_url,
                retention_class=retention_class,
                source_client=source_client,
                expires_at=expires_at,
                storage_provider=settings.STORAGE_PROVIDER or "s3",
                mirror_keys=[key] if is_asset_storage_mirror_enabled() else None,
            )
        try:
            from repositories import storage_repo

            await storage_repo.invalidate_user_storage_cache(user_id)
        except Exception:
            pass
        return {
            "id": file_row.get("id", ""),
            "key": key,
            "url": file_url,
            "mime_type": mime,
            "size_bytes": size_bytes,
            "sha256": digest,
            "filename": safe_name,
            "retention_class": retention_class,
            "source_client": source_client,
            "expires_at": expires_at,
            "storage_provider": settings.STORAGE_PROVIDER or "s3",
            "replaced_keys": old_keys,
        }
    except Exception as exc:
        logger.warning("file asset storage failed task_id=%s filename=%s error=%s", task_id, filename, exc)
        if key:
            try:
                key_is_referenced = await file_asset_repo.storage_key_exists(key)
                if not key_is_referenced:
                    await delete_asset_keys(
                        [key],
                        user_id=user_id,
                        reason="file-upload-rollback",
                        delete_mirror=False,
                    )
            except Exception as cleanup_exc:
                logger.warning("failed to clean up orphaned file object after storage failure task_id=%s error=%s", task_id, cleanup_exc)
        return None


async def update_task_file_asset_filename(
    *,
    user_id: str,
    task_id: str,
    category: str,
    filename: str,
) -> Optional[dict]:
    safe_name = _safe_key_part(filename, "file")
    try:
        category_part = _safe_key_part(category, "files")
        row = None
        storage_key_hint = ""
        row = await file_asset_repo.update_latest_task_file_filename(
            user_id=user_id,
            task_id=task_id,
            category=category_part,
            filename=safe_name,
            storage_url="",
        )
        if not row:
            return None
        storage_key = row.get("storage_key") or ""
        storage_url = _file_url(storage_key, safe_name) if storage_key else ""
        if storage_url and storage_url != row.get("storage_url"):
            keyed_row = await file_asset_repo.update_task_file_filename_by_key(
                user_id=user_id,
                task_id=task_id,
                category=category_part,
                storage_key=storage_key,
                filename=safe_name,
                storage_url=storage_url,
            )
            row = keyed_row or row
        pruned_keys: list[str] = []
        if category_part == "ppt" and storage_key:
            pruned_keys = await file_asset_repo.prune_task_file_assets(
                user_id=user_id,
                task_id=task_id,
                category=category_part,
                keep_storage_key=storage_key,
            )
            if pruned_keys:
                await delete_asset_keys(pruned_keys, user_id=user_id, reason="file-asset-prune")
        try:
            from repositories import storage_repo

            await storage_repo.invalidate_user_storage_cache(user_id)
        except Exception:
            pass
        if pruned_keys:
            row["replaced_keys"] = pruned_keys
        return row
    except Exception as exc:
        logger.warning("file asset filename update failed task_id=%s filename=%s error=%s", task_id, filename, exc)
        return None


async def fetch_asset_bytes(url: str) -> bytes:
    import httpx

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.get(url)
        res.raise_for_status()
        return res.content


def _fetch_asset_key_bytes_sync(client: Any, bucket: str, key: str) -> bytes:
    obj = client.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]
    try:
        return body.read()
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()


async def fetch_asset_key_bytes(key: str) -> bytes:
    if not is_asset_storage_enabled():
        raise RuntimeError("asset storage is not configured")
    try:
        return await _run_storage_io(
            _fetch_asset_key_bytes_sync,
            _s3_client(),
            storage_bucket_name(),
            key,
        )
    except Exception as primary_exc:
        if not (
            is_asset_storage_mirror_enabled()
            and is_asset_storage_mirror_client_configured()
        ):
            raise
        try:
            mirror_ready = await asset_mirror_repo.is_read_ready(key)
        except Exception as mirror_state_exc:
            logger.warning(
                "asset mirror state lookup failed key=%s error=%s",
                key,
                mirror_state_exc,
            )
            raise primary_exc from mirror_state_exc
        if not mirror_ready:
            raise primary_exc
        logger.warning(
            "primary asset read failed; trying mirror key=%s error=%s",
            key,
            primary_exc,
        )
        return await _run_storage_io(
            _fetch_asset_key_bytes_sync,
            _mirror_s3_client(),
            mirror_storage_bucket_name(),
            key,
        )


async def delete_asset_keys(
    keys: list[str],
    *,
    max_retries: int = 2,
    user_id: str | None = None,
    reason: str = "asset-delete",
    enqueue_failed: bool = True,
    delete_mirror: bool = True,
) -> dict:
    unique_keys = sorted({key.strip().lstrip("/") for key in keys if isinstance(key, str) and key.strip()})
    result = {"requested": len(unique_keys), "deleted": 0, "failed": [], "queued": 0}
    if not unique_keys:
        return result

    deletion_repo = None
    if enqueue_failed:
        from repositories import storage_repo

        deletion_repo = storage_repo
        try:
            result["queued"] = await storage_repo.enqueue_asset_object_deletions(
                unique_keys,
                user_id=user_id,
                reason=reason,
            )
            if result["queued"] != len(unique_keys):
                raise RuntimeError(
                    f"persisted {result['queued']} of {len(unique_keys)} deletion intents"
                )
        except Exception as exc:
            logger.warning(
                "failed to persist asset object deletion intent count=%s error=%s",
                len(unique_keys),
                exc,
            )
            result["failed"] = [
                {"key": key, "error": f"deletion queue: {exc}"}
                for key in unique_keys
            ]
            return result

    async def _finalize_durable_intent() -> None:
        if deletion_repo is None:
            return
        failed_keys = {
            str(item.get("key") or "").strip().lstrip("/")
            for item in result["failed"]
            if str(item.get("key") or "").strip()
        }
        deleted_keys = [key for key in unique_keys if key not in failed_keys]
        try:
            await deletion_repo.mark_asset_object_deletions_deleted(deleted_keys)
        except Exception as exc:
            logger.warning(
                "failed to clear completed asset deletion intents count=%s error=%s",
                len(deleted_keys),
                exc,
            )
        try:
            await deletion_repo.mark_asset_object_deletions_failed(result["failed"])
        except Exception as exc:
            logger.warning(
                "failed to defer asset deletion intents count=%s error=%s",
                len(result["failed"]),
                exc,
            )

    if not is_asset_storage_enabled():
        result["failed"] = [{"key": key, "error": "asset storage is not configured"} for key in unique_keys]
        await _finalize_durable_intent()
        return result

    async def _delete_batch(
        client: Any,
        bucket: str,
        batch_keys: list[str],
        *,
        provider: str,
    ) -> list[dict]:
        errors: list[dict] = []
        for start in range(0, len(batch_keys), 1000):
            chunk = batch_keys[start:start + 1000]
            try:
                response = await _run_storage_io(
                    client.delete_objects,
                    Bucket=bucket,
                    Delete={
                        "Objects": [{"Key": key} for key in chunk],
                        "Quiet": True,
                    },
                )
                for item in (response.get("Errors") or []):
                    errors.append({
                        "key": item.get("Key") or "",
                        "error": item.get("Message") or item.get("Code") or "delete failed",
                    })
                result["deleted"] += len(chunk) - len(response.get("Errors") or [])
            except Exception as exc:
                logger.warning(
                    "asset object batch delete failed provider=%s count=%s error=%s",
                    provider,
                    len(chunk),
                    exc,
                )
                errors.extend({"key": key, "error": str(exc)} for key in chunk)
        return errors

    failures_by_key: dict[str, list[str]] = {}
    if delete_mirror:
        try:
            await asset_mirror_repo.enqueue_deletions(
                unique_keys,
                include_current_target=is_asset_storage_mirror_enabled(),
            )
        except Exception as exc:
            logger.warning("failed to enqueue mirror object deletions count=%s error=%s", len(unique_keys), exc)
            for key in unique_keys:
                failures_by_key.setdefault(key, []).append(f"mirror queue: {exc}")

    if failures_by_key:
        result["failed"] = [
            {"key": key, "error": "; ".join(messages)}
            for key, messages in sorted(failures_by_key.items())
        ]
        await _finalize_durable_intent()
        return result

    targets = [(settings.STORAGE_PROVIDER or "s3", _s3_client, storage_bucket_name())]

    for target_index, (provider, client_factory, bucket) in enumerate(targets):
        try:
            client = client_factory()
        except Exception as exc:
            logger.warning(
                "asset object client initialization failed provider=%s error=%s",
                provider,
                exc,
            )
            message = f"{provider}: {exc}" if target_index else str(exc)
            for key in unique_keys:
                failures_by_key.setdefault(key, []).append(message)
            continue
        pending = list(unique_keys)
        final_failures: list[dict] = []
        for attempt in range(max_retries + 1):
            if not pending:
                break
            failed = await _delete_batch(
                client,
                bucket,
                pending,
                provider=provider,
            )
            if not failed:
                break
            if attempt < max_retries:
                pending = [item["key"] for item in failed if item.get("key")]
                logger.info(
                    "retrying failed object delete provider=%s attempt=%d keys=%d",
                    provider,
                    attempt + 1,
                    len(pending),
                )
            else:
                final_failures = failed
        for item in final_failures:
            key = str(item.get("key") or "")
            if not key:
                continue
            message = str(item.get("error") or "delete failed")
            if target_index:
                message = f"{provider}: {message}"
            failures_by_key.setdefault(key, []).append(message)

    result["failed"] = [
        {"key": key, "error": "; ".join(messages)}
        for key, messages in sorted(failures_by_key.items())
    ]
    result["deleted"] = len(unique_keys) - len(failures_by_key)
    await _finalize_durable_intent()
    return result


async def delete_asset_keys_with_queue(
    keys: list[str] | set[str],
    *,
    user_id: str | None = None,
    reason: str = "asset-delete",
    max_retries: int = 2,
) -> dict:
    try:
        from repositories import storage_repo

        normalized_keys = sorted({
            str(key).strip().lstrip("/")
            for key in keys or []
            if str(key).strip()
        })
        if not normalized_keys:
            return {"requested": 0, "deleted": 0, "failed": [], "queued": 0, "queue_deleted": 0, "queue_failed": 0}
        queued = await storage_repo.enqueue_asset_object_deletions(
            normalized_keys,
            user_id=user_id,
            reason=reason,
        )
        result = await delete_asset_keys(
            normalized_keys,
            max_retries=max_retries,
            user_id=user_id,
            reason=reason,
            enqueue_failed=False,
        )
        failed_keys = {
            str(item.get("key") or "").strip().lstrip("/")
            for item in result.get("failed") or []
        }
        deleted_keys = [key for key in normalized_keys if key not in failed_keys]
        queue_deleted = await storage_repo.mark_asset_object_deletions_deleted(deleted_keys)
        queue_failed = await storage_repo.mark_asset_object_deletions_failed(result.get("failed") or [])
        return {
            **result,
            "queued": queued,
            "queue_deleted": queue_deleted,
            "queue_failed": queue_failed,
        }
    except Exception as exc:
        logger.warning("asset object queued delete failed reason=%s error=%s", reason, exc)
        return {
            "requested": len(keys or []),
            "deleted": 0,
            "failed": [{"key": "", "error": str(exc)}],
            "queued": 0,
            "queue_deleted": 0,
            "queue_failed": 0,
        }


async def retry_pending_asset_deletions(limit: int = 1000) -> dict:
    try:
        from repositories import storage_repo

        keys = await storage_repo.pending_asset_object_deletions(limit)
        if not keys:
            return {"requested": 0, "deleted": 0, "failed": [], "queue_deleted": 0, "queue_failed": 0}
        result = await delete_asset_keys(
            keys,
            max_retries=1,
            reason="queued-asset-delete",
            enqueue_failed=False,
        )
        failed_keys = {str(item.get("key") or "").strip().lstrip("/") for item in result.get("failed") or []}
        deleted_keys = [key for key in keys if key not in failed_keys]
        queue_deleted = await storage_repo.mark_asset_object_deletions_deleted(deleted_keys)
        queue_failed = await storage_repo.mark_asset_object_deletions_failed(result.get("failed") or [])
        return {**result, "queue_deleted": queue_deleted, "queue_failed": queue_failed}
    except Exception as exc:
        logger.warning("queued asset object delete retry failed error=%s", exc)
        return {"requested": 0, "deleted": 0, "failed": [{"key": "", "error": str(exc)}], "queue_deleted": 0, "queue_failed": 0}


def _copy_primary_object_to_mirror_sync(job: dict[str, Any]) -> None:
    key = str(job.get("object_key") or "")
    primary = _s3_client()
    mirror = _mirror_s3_client(
        endpoint=str(job.get("target_endpoint") or ""),
        region=str(job.get("target_region") or ""),
    )
    source = primary.get_object(Bucket=storage_bucket_name(), Key=key)
    body = source["Body"]
    try:
        kwargs: dict[str, Any] = {
            "Bucket": str(job.get("target_bucket") or ""),
            "Key": key,
            "Body": body,
        }
        content_length = source.get("ContentLength")
        if content_length is not None:
            kwargs["ContentLength"] = int(content_length)
        if source.get("ContentType"):
            kwargs["ContentType"] = source["ContentType"]
        if source.get("CacheControl"):
            kwargs["CacheControl"] = source["CacheControl"]
        mirror.put_object(**kwargs)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()


def _delete_mirror_object_sync(job: dict[str, Any]) -> None:
    _mirror_s3_client(
        endpoint=str(job.get("target_endpoint") or ""),
        region=str(job.get("target_region") or ""),
    ).delete_object(
        Bucket=str(job.get("target_bucket") or ""),
        Key=str(job.get("object_key") or ""),
    )


async def _run_mirror_io_to_completion(function: Any, job: dict[str, Any]) -> None:
    task = asyncio.create_task(_run_storage_io(function, job))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


async def retry_pending_asset_mirror_operations(limit: int = 200) -> dict:
    result = {"requested": 0, "completed": 0, "failed": []}
    if not is_asset_storage_mirror_client_configured():
        return result

    for _ in range(max(1, min(int(limit or 200), 2000))):
        async with asset_mirror_repo.claim_pending_job(
            include_copies=is_asset_storage_mirror_enabled(),
        ) as (connection, job):
            if not job:
                break
            result["requested"] += 1
            try:
                if job.get("operation") == "copy":
                    await _run_mirror_io_to_completion(_copy_primary_object_to_mirror_sync, job)
                elif job.get("operation") == "delete":
                    await _run_mirror_io_to_completion(_delete_mirror_object_sync, job)
                else:
                    raise RuntimeError(f"unsupported mirror operation: {job.get('operation')}")
                if await asset_mirror_repo.complete_claimed_job(connection, job):
                    result["completed"] += 1
            except Exception as exc:
                await asset_mirror_repo.fail_claimed_job(connection, job, str(exc))
                result["failed"].append({
                    "key": str(job.get("object_key") or ""),
                    "operation": str(job.get("operation") or ""),
                    "error": str(exc),
                })
    return result


def guess_content_type(path_or_key: str, fallback: str = "application/octet-stream") -> str:
    return mimetypes.guess_type(path_or_key)[0] or fallback


async def fetch_image_asset_variant(asset_id: str, user_id: str, variant: str = "original") -> tuple[bytes, str]:
    asset = await image_asset_repo.get_image_asset(asset_id, user_id)
    if not asset:
        raise RuntimeError("asset not found")
    key_field = {
        "original": "original_key",
        "preview": "preview_key",
        "thumb": "thumb_key",
        "thumbnail": "thumb_key",
    }.get(variant, "original_key")
    key = asset.get(key_field) or asset.get("original_key")
    if not key:
        raise RuntimeError("asset key not found")
    return await fetch_asset_key_bytes(key), guess_content_type(key, asset.get("mime_type") or "image/png")
