import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from repositories import storage_repo
from scripts import storage_policy_job
from services import asset_storage


def test_web_history_assets_are_permanent_but_temporary_assets_expire(monkeypatch):
    monkeypatch.setattr(asset_storage.settings, "WEB_HISTORY_RETENTION_DAYS", 0)
    monkeypatch.setattr(asset_storage.settings, "TEMP_ASSET_RETENTION_DAYS", 3)
    monkeypatch.setattr(asset_storage.settings, "EXPORTED_FILE_RETENTION_DAYS", 7)

    assert asset_storage.retention_days("web_history") == 0
    assert asset_storage.expiry_for_retention("web_history", "web") == ""

    temporary_expiry = asset_storage.expiry_for_retention("temporary", "web")
    export_expiry = asset_storage.expiry_for_retention("export", "web")
    assert datetime.fromisoformat(temporary_expiry) > datetime.now(timezone.utc)
    assert datetime.fromisoformat(export_expiry) > datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_storage_policy_cli_defaults_to_retrying_explicit_cleanup_only(monkeypatch):
    retry_cleanup = AsyncMock(return_value={"record_cleanup_processed": 0, "objects_deleted": 0})
    delete_expired = AsyncMock(return_value={"items": 0})

    monkeypatch.setattr(storage_policy_job, "retry_pending_cleanup", retry_cleanup, raising=False)
    monkeypatch.setattr(storage_policy_job, "cleanup_expired", delete_expired)
    monkeypatch.setattr(storage_policy_job, "init_pool", AsyncMock())
    monkeypatch.setattr(storage_policy_job, "close_pool", AsyncMock())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "storage_policy_job.py",
            "--skip-notices",
            "--skip-admin-reminder",
            "--skip-admin-warning",
        ],
    )

    await storage_policy_job.main()

    retry_cleanup.assert_awaited_once_with(False, 2000)
    delete_expired.assert_not_awaited()


@pytest.mark.asyncio
async def test_storage_policy_cli_requires_explicit_delete_expired_flag(monkeypatch):
    retry_cleanup = AsyncMock(return_value={"record_cleanup_processed": 0, "objects_deleted": 0})
    delete_expired = AsyncMock(return_value={"items": 0})

    monkeypatch.setattr(storage_policy_job, "retry_pending_cleanup", retry_cleanup, raising=False)
    monkeypatch.setattr(storage_policy_job, "cleanup_expired", delete_expired)
    monkeypatch.setattr(storage_policy_job, "init_pool", AsyncMock())
    monkeypatch.setattr(storage_policy_job, "close_pool", AsyncMock())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "storage_policy_job.py",
            "--delete-expired",
            "--skip-notices",
            "--skip-admin-reminder",
            "--skip-admin-warning",
        ],
    )

    await storage_policy_job.main()

    delete_expired.assert_awaited_once_with(False, 2000)
    retry_cleanup.assert_not_awaited()


@pytest.mark.asyncio
async def test_expired_record_deletion_keeps_image_reference_checks_enabled(monkeypatch):
    delete_records = AsyncMock(return_value={"image_records_deleted": 0})
    monkeypatch.setattr(storage_repo, "_delete_item_records", delete_records)

    result = await storage_repo.delete_expired_item_records("user-1", [{"id": "image-1", "kind": "image"}])

    assert result == {"image_records_deleted": 0}
    delete_records.assert_awaited_once_with(
        "user-1",
        [{"id": "image-1", "kind": "image"}],
        check_image_references=True,
    )
