import pytest
from pydantic import ValidationError

import json
import types
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from routers.workspace import (
    CreateTaskBody,
    SaveSnapshotBody,
    _task_rows_with_preview,
    create_task,
    list_all_tasks,
    save_snapshot,
)


def test_canvas_flow_is_an_explicit_workspace_task_kind():
    assert CreateTaskBody(name="画布流", workflow_kind="canvas_flow").workflow_kind == "canvas_flow"
    assert CreateTaskBody(name="旧工作流").workflow_kind == "image_edit"

    with pytest.raises(ValidationError):
        CreateTaskBody(name="未知", workflow_kind="other")


def test_workspace_task_list_keeps_canvas_flow_kind():
    tasks = _task_rows_with_preview([{
        "id": "task-1",
        "name": "画布流",
        "workflow_kind": "canvas_flow",
        "preview_base64": None,
        "preview_base64_fallback": None,
        "saved_at": None,
        "has_snapshot": False,
    }])

    assert tasks[0]["workflow_kind"] == "canvas_flow"


@pytest.mark.asyncio
async def test_create_canvas_flow_task_persists_kind_in_session_meta():
    class FakeConnection:
        inserted_args = None

        async def fetchval(self, *_args):
            return None

        async def fetchrow(self, sql, *args):
            if "SELECT id FROM projects" in sql:
                return {"id": "project-1"}
            self.inserted_args = args
            return {
                "id": "task-1",
                "name": "测试画布",
                "source_width": None,
                "source_height": None,
                "workflow_kind": "canvas_flow",
                "status": "active",
                "created_at": "2026-08-08T00:00:00Z",
                "updated_at": "2026-08-08T00:00:00Z",
            }

    conn = FakeConnection()
    result = await create_task(
        "project-1",
        CreateTaskBody(name="测试画布", workflow_kind="canvas_flow"),
        user={"id": "user-1"},
        conn=conn,
    )

    assert result["workflow_kind"] == "canvas_flow"
    assert conn.inserted_args[-2] == "canvas_flow"
    assert json.loads(conn.inserted_args[-1]) == {"workflow_kind": "canvas_flow"}


@pytest.mark.asyncio
async def test_workspace_task_list_does_not_decompress_session_meta():
    executed: list[str] = []

    class FakeConnection:
        async def fetch(self, sql, *_args):
            executed.append(sql)
            return []

    @asynccontextmanager
    async def acquire():
        yield FakeConnection()

    with patch("routers.workspace.acquire", new=acquire), patch(
        "routers.workspace.asset_storage.prepare_image_asset_payload",
        new=AsyncMock(side_effect=lambda rows, _user_id: rows),
    ), patch(
        "routers.workspace.workspace_snapshot.has_snapshot_key_column",
        new=AsyncMock(return_value=True),
    ):
        result = await list_all_tasks(
            limit=8,
            offset=0,
            workflow_kind="image_edit",
            user={"id": "user-1"},
        )

    assert result == {"tasks": []}
    assert executed
    sql = executed[0]
    assert "s.workflow_kind" in sql
    assert "meta->>'workflow_kind'" not in sql
    assert "s.meta" not in sql


@pytest.mark.asyncio
async def test_canvas_flow_save_returns_the_compacted_document():
    inline_image = "data:image/png;base64," + "a" * 300

    class FakeConnection:
        def __init__(self):
            self.last_meta = None

        async def fetchrow(self, *_args):
            return {
                "id": "task-1",
                "workflow_kind": "canvas_flow",
                "snapshot_key": None,
                "meta": {"workflow_kind": "canvas_flow"},
            }

        async def fetchval(self, query, *args):
            if "UPDATE sessions" in query:
                self.last_meta = args[1]
            return "task-1"

    conn = FakeConnection()

    @asynccontextmanager
    async def acquire():
        yield conn

    stored = types.SimpleNamespace(to_meta=lambda: {
        "asset_id": "asset-1",
        "image_url": "/api/assets/asset-1/original",
        "preview_url": "/api/assets/asset-1/preview",
        "thumbnail_url": "/api/assets/asset-1/thumb",
    })
    document = {
        "kind": "canvas_flow",
        "version": 1,
        "nodes": [{"id": "image-1", "data": {"kind": "image", "imageBase64": inline_image}}],
        "edges": [],
    }

    persist = AsyncMock(return_value={"snapshot_key": "assets/users/u1/workspace-snapshot/task/files/snapshot.json"})
    with patch("routers.workspace.acquire", new=acquire), patch(
        "routers.workspace.asset_storage.store_generated_image",
        new=AsyncMock(return_value=stored),
    ), patch(
        "routers.workspace.workspace_snapshot.persist_workspace_snapshot_document",
        new=persist,
    ), patch(
        "routers.workspace.workspace_snapshot.has_snapshot_key_column",
        new=AsyncMock(return_value=True),
    ):
        result = await save_snapshot(
            task_id="11111111-1111-1111-1111-111111111111",
            body=SaveSnapshotBody(layers=[], workflow_snapshot=document),
            user={"id": "00000000-0000-0000-0000-000000000001"},
        )

    saved_image = result["workflow_snapshot"]["nodes"][0]["data"]
    assert saved_image["imageBase64"] == "/api/assets/asset-1/original"
    assert inline_image not in str(result)
    persist.assert_awaited_once()
    stored_meta = json.loads(conn.last_meta)
    assert stored_meta["snapshot_key"].endswith("snapshot.json")
    assert "workflow_snapshot" not in stored_meta
    assert "layers" not in stored_meta
