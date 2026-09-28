from __future__ import annotations

import mimetypes
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from fastapi.responses import RedirectResponse, Response

from core.security import decode_token
from repositories import image_asset_repo, user_repo
from services import asset_storage
from services.image_upload_validation import decode_base64_image

router = APIRouter(prefix="/api/assets", tags=["assets"])

VARIANT_TO_KEY = {
    "original": "original_key",
    "preview": "preview_key",
    "thumb": "thumb_key",
    "thumbnail": "thumb_key",
}


class UploadImageBody(BaseModel):
    image_base64: str
    task_id: str = ""
    prompt: str = ""
    model_id: str = ""
    category: str = "workspace"
    item_id: str = ""


async def _auth_token(token: Optional[str]) -> dict:
    if not token:
        raise HTTPException(401, "未登录")
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "token 无效或已过期")
    user = await user_repo.get_by_id(payload["sub"])
    if not user:
        raise HTTPException(401, "用户不存在")
    if user["status"] == "banned":
        raise HTTPException(403, "账号已被封禁")
    from routers.auth import _require_current_legal_acceptance

    await _require_current_legal_acceptance(user, payload)
    return user


async def _resolve_user(request: Request, token: Optional[str]) -> dict:
    auth = request.headers.get("authorization") or ""
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    return await _auth_token(bearer or token)


@router.post("/images")
async def upload_image_asset(
    request: Request,
    body: UploadImageBody,
):
    user = await _resolve_user(request, None)
    if not body.image_base64.strip():
        raise HTTPException(400, "图片为空")

    image_bytes = decode_base64_image(body.image_base64)

    stored = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id=user["id"],
        conversation_id=None,
        task_id=body.task_id or "workspace",
        prompt=body.prompt[:2000],
        model_id=body.model_id,
        category=body.category or "workspace",
        item_id=body.item_id,
    )
    if not stored:
        raise HTTPException(503, "图片资产存储未配置或上传失败")

    meta = stored.to_meta()
    return {
        **meta,
        "assetId": meta.get("asset_id", ""),
        "imageUrl": meta.get("image_url", ""),
        "previewUrl": meta.get("preview_url", ""),
        "thumbnailUrl": meta.get("thumbnail_url", ""),
    }


@router.get("/files/by-key")
async def get_file_by_key(
    request: Request,
    key: str,
    token: Optional[str] = Query(default=None),
    filename: str = Query(default=""),
):
    user = await _resolve_user(request, token)
    prefix = asset_storage.user_asset_prefix(user["id"])
    normalized_key = key.strip().lstrip("/")
    if not normalized_key.startswith(prefix + "/"):
        raise HTTPException(403, "无权访问该文件")

    try:
        data = await asset_storage.fetch_asset_key_bytes(normalized_key)
    except Exception as exc:
        raise HTTPException(404, f"文件读取失败: {exc}")

    media_type = mimetypes.guess_type(filename or normalized_key)[0] or "application/octet-stream"
    headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
    }
    if filename:
        headers["Content-Disposition"] = f'inline; filename="{filename}"'
    return Response(content=data, media_type=media_type, headers=headers)


@router.get("/{asset_id}/{variant}")
async def get_asset_variant(
    request: Request,
    asset_id: str,
    variant: str,
    token: Optional[str] = Query(default=None),
    direct: bool = False,
):
    user = await _resolve_user(request, token)
    key_field = VARIANT_TO_KEY.get(variant)
    if not key_field:
        raise HTTPException(404, "资源不存在")

    asset = await image_asset_repo.get_image_asset(asset_id, user["id"])
    if not asset:
        raise HTTPException(404, "资源不存在或无权访问")

    key = asset.get(key_field) or asset.get("original_key")
    if not key:
        raise HTTPException(404, "资源文件不存在")

    delivery_url = "" if direct else asset_storage.asset_delivery_url(key)
    if delivery_url:
        return RedirectResponse(
            delivery_url,
            status_code=307,
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Asset-Delivery": "edge-redirect",
                "X-Content-Type-Options": "nosniff",
            },
        )

    try:
        data = await asset_storage.fetch_asset_key_bytes(key)
    except Exception as exc:
        raise HTTPException(404, f"资源读取失败: {exc}")

    media_type = (
        mimetypes.guess_type(key)[0]
        or asset.get("mime_type")
        or "application/octet-stream"
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )
