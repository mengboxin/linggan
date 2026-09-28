"""Authenticated user notification routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from routers.auth import get_current_user
from repositories import notification_repo

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
async def list_user_notifications(
    limit: int = Query(default=30, ge=1, le=80),
    user: dict = Depends(get_current_user),
):
    return await notification_repo.list_notifications(user_id=user["id"], limit=limit)


@router.post("/{notification_id}/read")
async def mark_user_notification_read(
    notification_id: str,
    user: dict = Depends(get_current_user),
):
    item = await notification_repo.mark_notification_read(
        user_id=user["id"],
        notification_id=notification_id,
    )
    if not item:
        raise HTTPException(404, "通知不存在")
    return {"ok": True, "item": item}


@router.post("/read-all")
async def mark_all_user_notifications_read(user: dict = Depends(get_current_user)):
    updated = await notification_repo.mark_all_notifications_read(user_id=user["id"])
    return {"ok": True, "updated": updated}


@router.get("/announcement")
async def get_current_announcement(_: dict = Depends(get_current_user)):
    return {"announcement": await notification_repo.get_global_announcement()}
