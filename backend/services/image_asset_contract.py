"""Canonical reference-image contract shared by creative modules.

Browser clients submit stable image asset identifiers.  Workers resolve the
original variant server-side, so a reference never turns into a sequence of
URL/base64/thumbnail fallbacks while it moves between modules.
"""
from __future__ import annotations

import base64
from typing import Any, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator

from services import asset_storage


MAX_REFERENCE_ASSETS = 8


class ImageAssetReference(BaseModel):
    """A user-owned image input with an explicit semantic role and order."""

    model_config = ConfigDict(populate_by_name=True)

    asset_id: str = Field(min_length=1, max_length=80, alias="assetId")
    role: Literal["source", "reference"] = "reference"
    index: int = Field(default=1, ge=0, le=MAX_REFERENCE_ASSETS)

    @field_validator("asset_id")
    @classmethod
    def _strip_asset_id(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError("图片资产标识不能为空")
        return normalized


class ImageAssetReferenceError(RuntimeError):
    """The requested canonical image input is absent or cannot be read."""


def normalize_image_asset_references(
    references: Sequence[ImageAssetReference | dict[str, Any]] | None,
) -> list[ImageAssetReference]:
    """Validate order and roles without changing the caller's intended order."""
    normalized = list(references or [])
    if len(normalized) > MAX_REFERENCE_ASSETS:
        raise ImageAssetReferenceError(f"最多可使用 {MAX_REFERENCE_ASSETS} 张参考图")

    seen_ids: set[str] = set()
    source_count = 0
    result: list[ImageAssetReference] = []
    reference_index = 1
    for position, raw_item in enumerate(normalized):
        try:
            item = raw_item if isinstance(raw_item, ImageAssetReference) else ImageAssetReference.model_validate(raw_item)
        except Exception as exc:
            raise ImageAssetReferenceError(f"第 {position + 1} 张参考图格式无效") from exc
        if item.asset_id in seen_ids:
            raise ImageAssetReferenceError("同一张图片不能重复作为参考图提交")
        seen_ids.add(item.asset_id)
        if item.role == "source":
            source_count += 1
            if source_count > 1:
                raise ImageAssetReferenceError("一次创作只能指定一张主图")
            index = 0
        else:
            index = reference_index
            reference_index += 1
        result.append(item.model_copy(update={"index": index}))
    return result


async def archive_legacy_reference_image(
    *,
    image_base64: str,
    user_id: str,
    category: str,
    task_id: str,
    item_id: str = "reference-1",
) -> list[ImageAssetReference]:
    """One-time compatibility bridge for old clients still sending base64."""
    raw = (image_base64 or "").strip()
    if not raw:
        return []
    stored = await asset_storage.store_generated_image(
        image_base64=raw,
        user_id=user_id,
        conversation_id=None,
        task_id=task_id,
        item_id=item_id,
        category=category,
        prompt="legacy reference image import",
    )
    if not stored:
        raise ImageAssetReferenceError("参考图归档失败，无法建立固定图片资产")
    return [ImageAssetReference(asset_id=stored.id, role="reference", index=1)]


async def canonicalize_image_asset_references(
    *,
    references: Sequence[ImageAssetReference | dict[str, Any]] | None,
    legacy_image_base64: str,
    user_id: str,
    category: str,
    task_id: str,
) -> list[ImageAssetReference]:
    """Return canonical references, migrating legacy base64 only once."""
    normalized = normalize_image_asset_references(references)
    if normalized:
        return normalized
    return await archive_legacy_reference_image(
        image_base64=legacy_image_base64,
        user_id=user_id,
        category=category,
        task_id=task_id,
    )


async def load_original_reference_bytes(
    references: Sequence[ImageAssetReference | dict[str, Any]] | None,
    *,
    user_id: str,
) -> list[bytes]:
    """Load only the durable original variant for model execution."""
    images: list[bytes] = []
    for reference in normalize_image_asset_references(references):
        try:
            image, _mime_type = await asset_storage.fetch_image_asset_variant(
                reference.asset_id,
                user_id,
                variant="original",
            )
        except Exception as exc:
            label = "主图" if reference.role == "source" else f"参考图 {reference.index}"
            raise ImageAssetReferenceError(f"{label}无法读取，请重新上传后再试") from exc
        if not image:
            label = "主图" if reference.role == "source" else f"参考图 {reference.index}"
            raise ImageAssetReferenceError(f"{label}为空，请重新上传后再试")
        images.append(image)
    return images


async def load_original_reference_data_urls(
    references: Sequence[ImageAssetReference | dict[str, Any]] | None,
    *,
    user_id: str,
) -> list[str]:
    """Adapter for legacy workers that still consume data URLs internally."""
    data_urls: list[str] = []
    for reference in normalize_image_asset_references(references):
        try:
            image, mime_type = await asset_storage.fetch_image_asset_variant(
                reference.asset_id,
                user_id,
                variant="original",
            )
        except Exception as exc:
            label = "主图" if reference.role == "source" else f"参考图 {reference.index}"
            raise ImageAssetReferenceError(f"{label}无法读取，请重新上传后再试") from exc
        if not image:
            label = "主图" if reference.role == "source" else f"参考图 {reference.index}"
            raise ImageAssetReferenceError(f"{label}为空，请重新上传后再试")
        data_urls.append(f"data:{mime_type or 'image/png'};base64,{base64.b64encode(image).decode('ascii')}")
    return data_urls
