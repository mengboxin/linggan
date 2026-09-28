import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks

from repositories import storage_repo
from routers import storage
from routers import workspace
from services import workspace_cleanup


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _Connection:
    def __init__(self, *, session_meta=None):
        self.executed: list[tuple[str, tuple]] = []
        self.fetched: list[tuple[str, tuple]] = []
        self.session_meta = session_meta

    async def fetch(self, query: str, *args):
        self.fetched.append((query, args))
        if "FROM sessions" in query and "AS task_id" in query:
            return [{
                "task_id": "11111111-1111-1111-1111-111111111111",
                "preview_key": "users/workflow/cover.webp",
                "snapshot_key": "users/workflow/snapshot.json",
                "meta": self.session_meta,
            }]
        if "FROM image_assets" in query:
            return [
                {
                    "id": "asset-1",
                    "task_id": "11111111-1111-1111-1111-111111111111",
                    "size_bytes": 10,
                    "original_key": "users/workflow/original.png",
                    "preview_key": "users/workflow/preview.webp",
                    "thumb_key": "users/workflow/thumb.webp",
                },
                {
                    "id": "asset-2",
                    "task_id": "11111111-1111-1111-1111-111111111111",
                    "size_bytes": 20,
                    "original_key": "users/workflow/old-original.png",
                    "preview_key": "",
                    "thumb_key": "",
                },
            ]
        if "FROM file_assets" in query:
            return [{"id": "file-1", "task_id": "11111111-1111-1111-1111-111111111111", "size_bytes": 5, "storage_key": "users/workflow/source.psd"}]
        return []

    async def execute(self, query: str, *args):
        self.executed.append((query, args))
        return "DELETE 1"

    def transaction(self):
        return _Transaction()


@pytest.mark.asyncio
async def test_delete_workspace_task_is_idempotent_when_task_is_already_missing(monkeypatch):
    class MissingTaskConnection:
        async def fetchrow(self, _query: str, *_args):
            return None

    @asynccontextmanager
    async def acquire():
        yield MissingTaskConnection()

    monkeypatch.setattr(workspace, "acquire", acquire)
    result = await workspace.delete_task(
        "11111111-1111-1111-1111-111111111111",
        {"id": "00000000-0000-0000-0000-000000000001"},
    )

    assert result == {"ok": True, "already_deleted": True}


@pytest.mark.asyncio
async def test_delete_workspace_task_defers_asset_cleanup_until_after_response_path(monkeypatch):
    class ExistingTaskConnection:
        async def fetchrow(self, _query: str, *_args):
            return {"id": "11111111-1111-1111-1111-111111111111"}

    @asynccontextmanager
    async def acquire():
        yield ExistingTaskConnection()

    delete_tasks = AsyncMock(return_value={
        "workspace_records_deleted": 1,
        "cleanup_intent_id": "cleanup-intent-async",
        "cleanup_deferred": True,
    })
    process_intent = AsyncMock(return_value={"deferred": False})
    real_create_task = asyncio.create_task
    scheduled: list[asyncio.Task] = []

    def schedule(coro):
        task = real_create_task(coro)
        scheduled.append(task)
        return task

    monkeypatch.setattr(workspace, "acquire", acquire)
    monkeypatch.setattr(workspace.workspace_cleanup, "delete_workspace_tasks", delete_tasks)
    monkeypatch.setattr(workspace.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(workspace.asyncio, "create_task", schedule)

    result = await workspace.delete_task(
        "11111111-1111-1111-1111-111111111111",
        {"id": "00000000-0000-0000-0000-000000000001"},
    )

    delete_tasks.assert_awaited_once_with(
        user_id="00000000-0000-0000-0000-000000000001",
        task_ids=["11111111-1111-1111-1111-111111111111"],
        process_assets=False,
    )
    assert result["cleanup"]["cleanup_deferred"] is True
    await scheduled[0]
    process_intent.assert_awaited_once_with("cleanup-intent-async")


@pytest.mark.asyncio
async def test_delete_project_releases_thumbnail_after_removing_its_reference(monkeypatch):
    thumbnail = "/api/assets/11111111-1111-1111-1111-111111111111/preview"

    class ProjectConnection:
        def __init__(self):
            self.executed: list[tuple[str, tuple]] = []

        async def fetchrow(self, query: str, *_args):
            if "SELECT id, thumbnail FROM projects" in query:
                return {"id": "project-1", "thumbnail": thumbnail}
            assert "SELECT id FROM projects" in query
            return {"id": "project-1"}

        async def fetch(self, query: str, *_args):
            assert "FROM sessions" in query
            return []

        async def execute(self, query: str, *args):
            self.executed.append((query, args))
            return "UPDATE 1" if "UPDATE projects" in query else "DELETE 1"

        def transaction(self):
            return _Transaction()

    conn = ProjectConnection()
    @asynccontextmanager
    async def acquire():
        yield conn

    delete_tasks = AsyncMock(return_value={"workspace_records_deleted": 0})
    stage_intent = AsyncMock(return_value="cleanup-intent-1")
    process_intent = AsyncMock(return_value={"asset_rows_deleted": 1, "object_keys_deleted": 3})
    monkeypatch.setattr(workspace.workspace_cleanup, "delete_workspace_tasks", delete_tasks)
    monkeypatch.setattr(workspace.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(workspace.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(workspace, "acquire", acquire)

    result = await workspace.delete_project(
        "33333333-3333-3333-3333-333333333333",
        {"id": "00000000-0000-0000-0000-000000000001"},
    )

    queries = [query for query, _ in conn.executed]
    assert "UPDATE projects SET thumbnail = NULL" in queries[0]
    assert "DELETE FROM projects" in queries[1]
    stage_intent.assert_awaited_once_with(
        conn,
        user_id="00000000-0000-0000-0000-000000000001",
        records={
            "project_id": "33333333-3333-3333-3333-333333333333",
            "thumbnail": thumbnail,
        },
        reason="workspace-project-delete",
    )
    process_intent.assert_awaited_once_with("cleanup-intent-1")
    assert result["project_asset_cleanup"]["object_keys_deleted"] == 3


@pytest.mark.asyncio
async def test_delete_workspace_task_removes_all_records_and_bucket_objects(monkeypatch):
    conn = _Connection()

    @asynccontextmanager
    async def acquire():
        yield conn

    process_intent = AsyncMock(return_value={
        "image_records_deleted": 2,
        "image_record_ids_deleted": ["asset-1", "asset-2"],
        "image_records_preserved": 0,
        "file_records_deleted": 1,
        "file_record_ids_deleted": ["file-1"],
        "file_records_preserved": 0,
        "object_keys_requested": 6,
        "object_keys_deleted": 6,
        "object_keys_preserved": 0,
        "object_delete_failed": [],
        "bytes_estimated": 35,
    })
    stage_intent = AsyncMock(return_value="cleanup-intent-2")
    invalidate = AsyncMock()
    monkeypatch.setattr(workspace_cleanup, "acquire", acquire)
    monkeypatch.setattr(workspace_cleanup.workspace_snapshot, "has_snapshot_key_column", AsyncMock(return_value=True))
    monkeypatch.setattr(workspace_cleanup.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(workspace_cleanup.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(workspace_cleanup.storage_repo, "invalidate_user_storage_and_history_cache", invalidate)

    result = await workspace_cleanup.delete_workspace_tasks(
        user_id="00000000-0000-0000-0000-000000000001",
        task_ids=["11111111-1111-1111-1111-111111111111"],
    )

    executed_sql = "\n".join(query for query, _ in conn.fetched + conn.executed)
    assert "DELETE FROM image_assets" not in executed_sql
    assert "DELETE FROM file_assets" not in executed_sql
    assert "DELETE FROM edit_history" in executed_sql
    assert "UPDATE sessions" in executed_sql
    stage_intent.assert_awaited_once()
    assert stage_intent.await_args.args[0] is conn
    assert stage_intent.await_args.kwargs["user_id"] == "00000000-0000-0000-0000-000000000001"
    assert stage_intent.await_args.kwargs["records"]["task_ids"] == [
        "11111111-1111-1111-1111-111111111111"
    ]
    assert "sessions" not in stage_intent.await_args.kwargs["records"]
    process_intent.assert_awaited_once_with("cleanup-intent-2")
    assert result["workspace_records_deleted"] == 1
    assert result["image_records_deleted"] == 2
    assert result["file_records_deleted"] == 1
    assert result["bytes_estimated"] == 35
    invalidate.assert_awaited_once()


@pytest.mark.asyncio
async def test_workspace_cleanup_parses_json_string_session_meta_before_staging_intent(monkeypatch):
    image_asset_id = "22222222-2222-2222-2222-222222222222"
    file_asset_id = "33333333-3333-3333-3333-333333333333"
    conn = _Connection(session_meta=(
        '{"source_asset_id": "' + image_asset_id + '", '
        '"pptx_file_asset_id": "' + file_asset_id + '", '
        '"asset_original_key": "/users/workflow/meta-original.png"}'
    ))

    @asynccontextmanager
    async def acquire():
        yield conn

    stage_intent = AsyncMock(return_value="cleanup-intent-meta")
    process_intent = AsyncMock(return_value={})
    monkeypatch.setattr(workspace_cleanup, "acquire", acquire)
    monkeypatch.setattr(workspace_cleanup.workspace_snapshot, "has_snapshot_key_column", AsyncMock(return_value=True))
    monkeypatch.setattr(workspace_cleanup.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(workspace_cleanup.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(workspace_cleanup.storage_repo, "invalidate_user_storage_and_history_cache", AsyncMock())

    await workspace_cleanup.delete_workspace_tasks(
        user_id="00000000-0000-0000-0000-000000000001",
        task_ids=["11111111-1111-1111-1111-111111111111"],
    )

    records = stage_intent.await_args.kwargs["records"]
    assert records["image_asset_ids"] == [image_asset_id]
    assert records["file_asset_ids"] == [file_asset_id]
    assert records["object_keys"] == [
        "users/workflow/cover.webp",
        "users/workflow/meta-original.png",
        "users/workflow/snapshot.json",
    ]


def test_workspace_cleanup_ignores_invalid_json_string_session_meta():
    assert workspace_cleanup._parse_session_meta("{not-json") == {}


def test_workspace_storage_item_is_one_group_for_all_assets():
    item = storage_repo._workspace_item_from_group_row({
        "task_id": "11111111-1111-1111-1111-111111111111",
        "title": "产品主视觉",
        "size_bytes": 5_242_880,
        "asset_count": 8,
        "preview_url": "/api/assets/asset-1/thumb",
        "created_at": "2026-07-14T16:18:00+00:00",
        "updated_at": "2026-07-14T16:19:00+00:00",
        "expires_at": "2026-09-12T16:18:00+00:00",
    })

    assert item["id"] == "workspace:11111111-1111-1111-1111-111111111111"
    assert item["source_type"] == "workspace"
    assert item["title"] == "产品主视觉"
    assert item["asset_count"] == 8
    assert item["size_bytes"] == 5_242_880


@pytest.mark.asyncio
async def test_workspace_storage_listing_returns_one_item_per_task(monkeypatch):
    class GroupConnection:
        async def fetch(self, query: str, *args):
            assert "GROUP BY ia.task_id" in query
            return [{
                "task_id": "11111111-1111-1111-1111-111111111111",
                "title": "产品主视觉",
                "size_bytes": 5_242_880,
                "asset_count": 8,
                "preview_url": "/api/assets/asset-1/thumb",
                "created_at": "2026-07-14T16:18:00+00:00",
                "updated_at": "2026-07-14T16:19:00+00:00",
                "expires_at": "2026-09-12T16:18:00+00:00",
            }]

    @asynccontextmanager
    async def acquire():
        yield GroupConnection()

    monkeypatch.setattr(storage_repo, "acquire", acquire)
    items = await storage_repo.list_cleanup_items(
        "00000000-0000-0000-0000-000000000001",
        kind="workspace",
        limit=20,
    )

    assert [item["id"] for item in items] == ["workspace:11111111-1111-1111-1111-111111111111"]
    assert items[0]["asset_count"] == 8


def test_workspace_virtual_ids_only_accept_uuids():
    assert storage_repo.workspace_task_ids([
        "workspace:11111111-1111-1111-1111-111111111111",
        "workspace:not-a-uuid",
        "asset-id",
    ]) == ["11111111-1111-1111-1111-111111111111"]


@pytest.mark.asyncio
async def test_storage_cleanup_routes_workspace_group_to_project_deletion(monkeypatch):
    item_id = "workspace:11111111-1111-1111-1111-111111111111"
    group_item = {
        "id": item_id,
        "kind": "image",
        "source_type": "workspace",
        "size_bytes": 35,
    }
    monkeypatch.setattr(storage.storage_repo, "get_cleanup_items_by_ids", AsyncMock(return_value=[group_item]))
    delete_generic = AsyncMock(return_value={"image_records_deleted": 0, "file_records_deleted": 0})
    monkeypatch.setattr(storage.storage_repo, "delete_item_records", delete_generic)
    monkeypatch.setattr(storage.storage_repo, "object_keys_for_deleted_records", lambda *_args: set())
    monkeypatch.setattr(storage.storage_repo, "storage_summary", AsyncMock(return_value={"used_bytes": 0}))
    delete_workspace = AsyncMock(return_value={
        "workspace_records_deleted": 1,
        "deleted_task_ids": ["11111111-1111-1111-1111-111111111111"],
        "image_records_deleted": 2,
        "file_records_deleted": 1,
        "object_keys_requested": 6,
        "object_keys_deleted": 6,
        "object_delete_failed": [],
    })
    monkeypatch.setattr(storage.workspace_cleanup, "delete_workspace_tasks", delete_workspace)

    result = await storage.cleanup_storage_items(
        storage.CleanupRequest(item_ids=[item_id]),
        BackgroundTasks(),
        {"id": "00000000-0000-0000-0000-000000000001"},
    )

    delete_workspace.assert_awaited_once()
    assert delete_generic.await_args.args[1] == []
    assert result["cleanup"]["workspace_records_deleted"] == 1
    assert result["cleanup"]["image_records_deleted"] == 2
    assert result["cleanup"]["file_records_deleted"] == 1
    assert result["cleanup"]["object_keys_deleted"] == 6
