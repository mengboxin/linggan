"""Attachment parsing endpoints shared by PPT and scientific figure workflows."""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from routers.auth import get_current_user
from services.attachment_parser import parse_attachment_bytes

router = APIRouter(prefix="/api/attachments", tags=["attachments"])
logger = logging.getLogger(__name__)

MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENT_COUNT = 8
MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024


async def _auth(
    token: Optional[str] = Query(default=None),
    user: Optional[dict] = Depends(get_current_user),
) -> dict:
    if user:
        return user
    if token:
        from core.security import decode_token
        import repositories.user_repo as user_repo

        payload = decode_token(token)
        if payload and payload.get("type") == "access":
            u = await user_repo.get_by_id(payload["sub"])
            if u:
                from routers.auth import _require_current_legal_acceptance
                await _require_current_legal_acceptance(u, payload)
                return u
    raise HTTPException(401, "未登录")


@router.post("/parse")
async def parse_attachments(
    files: list[UploadFile] = File(...),
    user: dict = Depends(_auth),
):
    if not files:
        raise HTTPException(400, "请上传附件")
    if len(files) > MAX_ATTACHMENT_COUNT:
        raise HTTPException(400, f"一次最多上传 {MAX_ATTACHMENT_COUNT} 个附件")

    parsed = []
    total_bytes = 0
    for file in files:
        data = await file.read(MAX_ATTACHMENT_BYTES + 1)
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, f"{file.filename} 超过 25MB，暂不支持解析")
        total_bytes += len(data)
        if total_bytes > MAX_ATTACHMENT_TOTAL_BYTES:
            raise HTTPException(413, "附件总大小不能超过 50MB")
        filename = file.filename or "attachment"
        try:
            parsed.append(parse_attachment_bytes(filename, data, file.content_type or "").to_dict())
        except Exception as exc:
            logger.exception("attachment parse failed filename=%s", filename)
            raise HTTPException(422, f"{filename} 无法读取，请确认文件未损坏后重试") from exc

    return {"attachments": parsed}
