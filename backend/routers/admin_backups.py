"""Admin database backup endpoints."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from routers.admin import require_admin
from services import backup_service

router = APIRouter(prefix="/api/admin/backups", tags=["admin-backups"])


class BackupStorageBody(BaseModel):
    endpoint: str = ""
    region: str = "auto"
    bucket: str = ""
    key_prefix: str = "database-backups"
    access_key_id: str = ""
    secret_access_key: str = ""


class BackupSettingsBody(BaseModel):
    enabled: bool = False
    cron: str = Field(default="0 2 * * *", max_length=64)
    retention_days: int = Field(default=30, ge=1, le=3650)
    max_backup_count: int = Field(default=30, ge=1, le=500)
    storage: BackupStorageBody = Field(default_factory=BackupStorageBody)


class RestoreBackupBody(BaseModel):
    confirm: str = ""


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


@router.get("/settings")
async def get_backup_settings(_: bool = Depends(require_admin)):
    return await backup_service.load_backup_settings(public=True)


@router.put("/settings")
async def update_backup_settings(body: BackupSettingsBody, _: bool = Depends(require_admin)):
    return await backup_service.save_backup_settings(_model_dump(body))


@router.post("/test")
async def test_backup_storage(_: bool = Depends(require_admin)):
    try:
        return await backup_service.test_backup_storage()
    except Exception as exc:
        raise HTTPException(400, str(exc))


@router.get("")
async def list_backups(limit: int = 50, _: bool = Depends(require_admin)):
    return {"items": await backup_service.list_backup_records(limit=limit)}


@router.post("/create")
async def create_backup(_: bool = Depends(require_admin)):
    try:
        record = await backup_service.start_backup("manual")
        return {"ok": True, "record": record}
    except Exception as exc:
        raise HTTPException(400, str(exc))


@router.get("/{record_id}/download")
async def download_backup(record_id: str, _: bool = Depends(require_admin)):
    try:
        record, data = await backup_service.read_backup_bytes(record_id)
    except Exception as exc:
        raise HTTPException(404, str(exc))
    return Response(
        content=data,
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{record["filename"]}"'},
    )


@router.post("/{record_id}/restore")
async def restore_backup(record_id: str, body: RestoreBackupBody, _: bool = Depends(require_admin)):
    try:
        return await backup_service.restore_backup(record_id, body.confirm)
    except Exception as exc:
        raise HTTPException(400, str(exc))


@router.delete("/{record_id}")
async def delete_backup(record_id: str, _: bool = Depends(require_admin)):
    try:
        await backup_service.delete_backup_record(record_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(400, str(exc))
