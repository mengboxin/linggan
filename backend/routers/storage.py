from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from core import cache as ui_cache
from repositories import storage_repo
from routers.auth import get_current_user
from services import asset_storage
from services import workspace_cleanup

router = APIRouter(prefix="/api/storage", tags=["storage"])
logger = logging.getLogger(__name__)
STORAGE_ITEMS_CACHE_TTL_SECONDS = 20


class CleanupRequest(BaseModel):
    item_ids: list[str] = Field(default_factory=list, max_length=200)


async def _delete_storage_keys_background(
    *,
    keys: set[str],
    user_id: str,
    items: list[dict],
    deleted_records: dict[str, int],
) -> None:
    try:
        storage_result = await asset_storage.delete_asset_keys_with_queue(
            keys,
            user_id=user_id,
            reason="manual-storage-cleanup",
        )
        cleanup = {
            **deleted_records,
            "object_keys_requested": len(keys),
            "object_keys_deleted": storage_result.get("deleted", 0),
            "object_delete_failed": storage_result.get("failed", []),
            "bytes_estimated": sum(int(item.get("size_bytes") or 0) for item in items),
        }
        status = "completed_with_errors" if cleanup["object_delete_failed"] else "completed"
        await storage_repo.log_cleanup_run(mode="manual", user_id=user_id, items=items, cleanup=cleanup, status=status)
    except Exception as exc:
        logger.warning("storage cleanup object deletion failed user_id=%s error=%s", user_id, exc)
        cleanup = {
            **deleted_records,
            "object_keys_requested": len(keys),
            "object_keys_deleted": 0,
            "object_delete_failed": [{"key": "*", "error": str(exc)}],
            "bytes_estimated": sum(int(item.get("size_bytes") or 0) for item in items),
        }
        try:
            await storage_repo.log_cleanup_run(mode="manual", user_id=user_id, items=items, cleanup=cleanup, status="failed")
        except Exception as log_exc:
            logger.warning("storage cleanup log failed user_id=%s error=%s", user_id, log_exc)


@router.get("/summary")
async def get_storage_summary(user: dict = Depends(get_current_user)):
    try:
        return await storage_repo.storage_summary(user["id"])
    except RuntimeError as exc:
        logger.exception("storage summary schema/runtime error user_id=%s", user.get("id"))
        raise HTTPException(500, str(exc))
    except Exception:
        logger.exception("storage summary failed user_id=%s", user.get("id"))
        raise


@router.get("/items")
async def list_storage_items(
    kind: Literal[
        "all",
        "image",
        "text_image",
        "workspace",
        "sci_fig",
        "poster",
        "ppt",
        "ppt_file",
        "ppt_slide",
        "presentation_upload",
    ] = "all",
    sort: Literal["size_desc", "size_asc", "time_desc", "time_asc", "expires_asc"] = "size_desc",
    older_than_days: int | None = Query(default=None, ge=1, le=3650),
    expiring_within_days: int | None = Query(default=None, ge=1, le=365),
    limit: int = Query(default=80, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    version = await ui_cache.get_user_cache_version(user["id"], "storage")
    cache_key = ui_cache.user_cache_key(
        user["id"],
        "storage-items",
        version,
        kind,
        sort,
        older_than_days or "",
        expiring_within_days or "",
        limit,
        offset,
    )
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached

    items = await storage_repo.list_cleanup_items(
        user["id"],
        kind=kind,
        sort=sort,
        older_than_days=older_than_days,
        expiring_within_days=expiring_within_days,
        limit=limit,
        offset=offset,
    )
    total = await storage_repo.count_cleanup_items(
        user["id"],
        kind=kind,
        older_than_days=older_than_days,
        expiring_within_days=expiring_within_days,
    )
    payload = {"items": items, "total": total, "limit": limit, "offset": offset}
    await ui_cache.set_json(cache_key, payload, STORAGE_ITEMS_CACHE_TTL_SECONDS)
    return payload


@router.post("/cleanup")
async def cleanup_storage_items(
    body: CleanupRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    item_ids = [item.strip() for item in body.item_ids if item and item.strip()]
    if not item_ids:
        raise HTTPException(400, "请选择要清理的文件")
    items = await storage_repo.get_cleanup_items_by_ids(user["id"], item_ids)
    if not items:
        raise HTTPException(404, "未找到可清理的文件")

    user_id = user["id"]
    selected_workspace_ids = storage_repo.workspace_task_ids(item_ids)
    workspace_result = await workspace_cleanup.delete_workspace_tasks(
        user_id=user_id,
        task_ids=selected_workspace_ids,
    )
    generic_items = [item for item in items if not str(item.get("id") or "").startswith("workspace:")]
    candidate_keys = {key for item in generic_items for key in item.get("object_keys", [])}
    await storage_repo.enqueue_asset_object_deletions(
        candidate_keys,
        user_id=user_id,
        reason="manual-storage-cleanup",
    )
    deleted_records = await storage_repo.delete_item_records(user_id, generic_items)
    keys = storage_repo.object_keys_for_deleted_records(generic_items, deleted_records)
    cleanup = {
        **deleted_records,
        "workspace_records_deleted": int(workspace_result.get("workspace_records_deleted") or 0),
        "workspace_task_ids_deleted": list(workspace_result.get("deleted_task_ids") or []),
        "image_records_deleted": int(deleted_records.get("image_records_deleted") or 0)
        + int(workspace_result.get("image_records_deleted") or 0),
        "file_records_deleted": int(deleted_records.get("file_records_deleted") or 0)
        + int(workspace_result.get("file_records_deleted") or 0),
        "object_keys_requested": len(keys) + int(workspace_result.get("object_keys_requested") or 0),
        "object_keys_delete_queued": len(keys),
        "object_keys_deleted": int(workspace_result.get("object_keys_deleted") or 0),
        "object_delete_failed": list(workspace_result.get("object_delete_failed") or []),
        "bytes_estimated": sum(int(item.get("size_bytes") or 0) for item in items),
    }
    if keys:
        background_tasks.add_task(
            _delete_storage_keys_background,
            keys=keys,
            user_id=user_id,
            items=generic_items,
            deleted_records=deleted_records,
        )
    return {"success": True, "cleanup": cleanup, "summary": await storage_repo.storage_summary(user_id, use_cache=False)}


@router.get("/bucket")
async def bucket_usage(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(403, "需要管理员权限")
    return await storage_repo.bucket_usage_estimate()
