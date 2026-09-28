"""Public image gallery routes."""
from __future__ import annotations

from pydantic import BaseModel, Field
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from core.config import settings
from routers.auth import get_current_user
from repositories import public_gallery_repo
from services import asset_storage, public_gallery_reactions

router = APIRouter(prefix="/api/public-gallery", tags=["创作广场"])

_HOSTED_GALLERY_ASSET_RE = re.compile(r"^meigen-(?:00[1-9]|0[1-9][0-9]|[12][0-9]{2}|300)\.webp$")


class SubmitExistingPublicGenerationBody(BaseModel):
    module: str = "TEXT_TO_IMAGE"
    prompt: str = Field(default="", max_length=20000)
    final_prompt: str = Field(default="", max_length=20000)
    title: str = Field(default="", max_length=200)
    subtitle: str = Field(default="", max_length=500)
    source: str = "history_manual"
    task_id: str = ""
    source_task_id: str = ""
    variant_index: int = 0
    asset_id: str = ""
    image_url: str = ""
    preview_url: str = ""
    thumbnail_url: str = ""
    tags: list[str] = Field(default_factory=list)
    meta: dict = Field(default_factory=dict)


class GalleryReactionQueryBody(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=200)


class SetGalleryReactionBody(BaseModel):
    active: bool


@router.get("/assets/{filename}")
async def public_gallery_asset(filename: str):
    """Serve reviewed public artwork without depending on private edge signing."""
    if not _HOSTED_GALLERY_ASSET_RE.fullmatch(filename):
        raise HTTPException(404, "公开素材不存在")
    try:
        data = await asset_storage.fetch_asset_key_bytes(f"gallery/meigen-hosted/{filename}")
    except Exception as exc:
        raise HTTPException(503, "公开素材暂不可用") from exc
    return Response(
        content=data,
        media_type="image/webp",
        headers={
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _gallery_reaction_validation_error(
    exc: public_gallery_reactions.GalleryReactionValidationError,
) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"code": exc.code, "message": str(exc)},
    )


@router.get("")
async def list_public_gallery(
    limit: int = Query(default=80, ge=1, le=120),
    offset: int = Query(default=0, ge=0),
    module: str = Query(default="all"),
    reaction: str = Query(default="all"),
    owner: bool = Query(default=False),
    user: dict = Depends(get_current_user),
):
    from services import asset_storage

    items = await public_gallery_repo.list_public_generations(
        limit=limit,
        offset=offset,
        user_id=user["id"],
        module=module,
        reaction=reaction,
        owner_only=owner,
    )
    # 清除过期的 CDN 签名 URL，改用后端代理（自动 307 重定向到新鲜签名 URL）
    for item in items:
        asset_id = (item.get("asset_id") or "").strip()
        if asset_id:
            original = f"/api/assets/{asset_id}/original"
            preview = f"/api/assets/{asset_id}/preview"
            thumb = f"/api/assets/{asset_id}/thumb"
            item["image_url"] = item.get("image_url") or original
            item["preview_url"] = item.get("preview_url") or preview
            item["thumbnail_url"] = item.get("thumbnail_url") or thumb
            # 清除 meta 中可能存在的过期 CDN URL
            meta = item.get("meta") or {}
            if isinstance(meta, dict):
                for field in ("image_url", "imageUrl", "preview_url", "previewUrl",
                              "thumbnail_url", "thumbnailUrl", "original_url", "originalUrl"):
                    val = meta.get(field)
                    if isinstance(val, str) and val.startswith(("https://", "http://")):
                        meta[field] = ""
    return {"items": items}


@router.post("/reactions/query")
async def query_public_gallery_reactions(
    body: GalleryReactionQueryBody,
    user: dict = Depends(get_current_user),
):
    try:
        items = await public_gallery_reactions.get_reaction_states(
            user_id=user["id"],
            item_ids=body.item_ids,
        )
    except public_gallery_reactions.GalleryReactionValidationError as exc:
        raise _gallery_reaction_validation_error(exc) from exc
    return {"items": items}


@router.post("/submit-existing")
async def submit_existing_public_gallery_item(
    body: SubmitExistingPublicGenerationBody,
    user: dict = Depends(get_current_user),
):
    if not settings.PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED:
        raise HTTPException(403, "用户投稿功能当前已关闭")
    item = await public_gallery_repo.submit_existing_generation(
        user_id=user["id"],
        prompt=body.prompt,
        final_prompt=body.final_prompt,
        title=body.title,
        subtitle=body.subtitle,
        module=body.module,
        source=body.source or "history_manual",
        task_id=body.task_id,
        source_task_id=body.source_task_id,
        variant_index=body.variant_index,
        asset_id=body.asset_id,
        image_url=body.image_url,
        preview_url=body.preview_url,
        thumbnail_url=body.thumbnail_url,
        tags=body.tags,
        meta=body.meta,
    )
    if not item:
        raise HTTPException(400, "缺少可公开的图片或提示词，请确认作品已生成并包含可访问的图片地址。")
    return {
        "ok": True,
        "item": item,
        "duplicate": bool(item.get("duplicate")),
    }


@router.post("/{generation_id}/withdraw")
async def withdraw_public_gallery_item(
    generation_id: str,
    user: dict = Depends(get_current_user),
):
    item = await public_gallery_repo.withdraw_public_generation(
        user_id=user["id"],
        generation_id=generation_id,
    )
    if not item:
        raise HTTPException(404, "作品不存在或无权撤回")
    return {"ok": True, "item": item}


async def _toggle_public_gallery_reaction(
    *,
    item_id: str,
    reaction: str,
    user_id: str,
):
    try:
        item = await public_gallery_reactions.toggle_reaction(
            user_id=user_id,
            item_id=item_id,
            reaction=reaction,
        )
    except public_gallery_reactions.GalleryReactionValidationError as exc:
        raise _gallery_reaction_validation_error(exc) from exc
    if not item:
        raise HTTPException(404, "作品不存在或不可互动")
    return {"ok": True, "item": item}


async def _set_public_gallery_reaction(
    *,
    item_id: str,
    reaction: str,
    active: bool,
    user_id: str,
):
    try:
        item = await public_gallery_reactions.set_reaction(
            user_id=user_id,
            item_id=item_id,
            reaction=reaction,
            active=active,
        )
    except public_gallery_reactions.GalleryReactionValidationError as exc:
        raise _gallery_reaction_validation_error(exc) from exc
    if not item:
        raise HTTPException(404, "作品不存在或不可互动")
    return {"ok": True, "item": item}


@router.put("/{item_id}/like")
async def set_public_gallery_like(
    item_id: str,
    body: SetGalleryReactionBody,
    user: dict = Depends(get_current_user),
):
    return await _set_public_gallery_reaction(
        user_id=user["id"],
        item_id=item_id,
        reaction="like",
        active=body.active,
    )


@router.put("/{item_id}/favorite")
async def set_public_gallery_favorite(
    item_id: str,
    body: SetGalleryReactionBody,
    user: dict = Depends(get_current_user),
):
    return await _set_public_gallery_reaction(
        user_id=user["id"],
        item_id=item_id,
        reaction="favorite",
        active=body.active,
    )


@router.post("/{item_id}/like")
async def toggle_public_gallery_like(
    item_id: str,
    user: dict = Depends(get_current_user),
):
    return await _toggle_public_gallery_reaction(
        user_id=user["id"],
        item_id=item_id,
        reaction="like",
    )


@router.post("/{item_id}/favorite")
async def toggle_public_gallery_favorite(
    item_id: str,
    user: dict = Depends(get_current_user),
):
    return await _toggle_public_gallery_reaction(
        user_id=user["id"],
        item_id=item_id,
        reaction="favorite",
    )
