import sys
import types
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException

redis_stub = types.ModuleType("core.redis")
redis_stub.get_redis = lambda: None
sys.modules.setdefault("core.redis", redis_stub)

auth_stub = types.ModuleType("routers.auth")
auth_stub.get_current_user = lambda: {"id": "00000000-0000-0000-0000-000000000001"}
sys.modules.setdefault("routers.auth", auth_stub)

from routers.workspace import (
    SaveSnapshotBody,
    _compact_snapshot_value,
    _task_rows_with_preview,
    get_snapshot,
    save_snapshot,
)


def test_workspace_preview_key_is_resolved_as_an_object_key(monkeypatch):
    delivery_url = "https://cdn.example/assets/users/user-1/workspace/preview.webp?signed=1"
    resolver = Mock(return_value=delivery_url)

    def resolve(key: str) -> str:
        return resolver(key)

    monkeypatch.setattr("routers.workspace.asset_storage.asset_delivery_url", resolve)

    tasks = _task_rows_with_preview([{
        "id": "task-1",
        "preview_key": "assets/users/user-1/workspace/preview.webp",
        "has_snapshot": True,
    }])

    assert tasks[0]["meta"]["thumbnail_url"] == delivery_url
    assert tasks[0]["meta"]["preview_url"] == delivery_url
    resolver.assert_called_once_with("assets/users/user-1/workspace/preview.webp")


@pytest.mark.asyncio
async def test_workspace_snapshot_compaction_replaces_inline_images_with_asset_urls():
    inline_image = "data:image/png;base64," + "a" * 300
    stored = types.SimpleNamespace(to_meta=lambda: {
        "asset_id": "asset-1",
        "image_url": "/api/assets/asset-1/original",
        "preview_url": "/api/assets/asset-1/preview",
        "thumbnail_url": "/api/assets/asset-1/thumb",
    })

    with patch("routers.workspace.asset_storage.store_generated_image", new=AsyncMock(return_value=stored)):
        compacted = await _compact_snapshot_value(
            {
                "layers": [{"id": "layer-1", "imageBase64": inline_image, "maskData": inline_image}],
                "workflow_snapshot": {
                    "nodes": [{
                        "id": "node-1",
                        "imageBase64": inline_image,
                        "thumbnailBase64": inline_image,
                        "refImages": [inline_image],
                    }],
                    "arrows": [],
                },
                "gen_cards": [{"id": "card-1", "imageBase64": inline_image}],
            },
            user_id="00000000-0000-0000-0000-000000000001",
            task_id="task-1",
            path="workspace",
            cache={},
        )

    text = str(compacted)
    assert "base64" not in text
    assert "a" * 300 not in text
    assert "/api/assets/asset-1/original" in text
    assert "/api/assets/asset-1/thumb" in text


@pytest.mark.asyncio
async def test_workspace_snapshot_compaction_prefers_asset_id_over_expiring_delivery_urls():
    compacted = await _compact_snapshot_value(
        {
            "workflow_snapshot": {
                "nodes": [{
                    "id": "result-1",
                    "assetId": "asset-result-1",
                    "imageUrl": "https://image.example.test/cdn-assets/result/original.png?expires=1&signature=old",
                    "previewUrl": "https://image.example.test/cdn-assets/result/preview.webp?expires=1&signature=old",
                    "thumbnailUrl": "https://image.example.test/cdn-assets/result/thumb.webp?expires=1&signature=old",
                }],
            },
        },
        user_id="00000000-0000-0000-0000-000000000001",
        task_id="task-1",
        path="workspace",
        cache={},
    )

    text = str(compacted)
    assert "cdn-assets" not in text
    assert "/api/assets/asset-result-1/original" in text
    assert "/api/assets/asset-result-1/preview" in text
    assert "/api/assets/asset-result-1/thumb" in text


@pytest.mark.asyncio
async def test_snapshot_save_cleans_assets_if_workflow_was_deleted_during_upload():
    class Connection:
        async def fetchrow(self, query, *_args):
            assert "status != 'deleted'" in query
            return {"id": "task-1", "workflow_kind": "image_edit", "snapshot_key": None, "meta": {}}

        async def fetchval(self, query, *_args):
            assert "status != 'deleted'" in query
            return None

    cleanup = AsyncMock()
    @asynccontextmanager
    async def acquire():
        yield Connection()

    with patch("routers.workspace.acquire", new=acquire), patch(
        "routers.workspace.workspace_cleanup.delete_workspace_tasks", new=cleanup,
    ), patch(
        "routers.workspace.workspace_snapshot.has_snapshot_key_column",
        new=AsyncMock(return_value=True),
    ), patch(
        "routers.workspace.workspace_snapshot.persist_workspace_snapshot_document",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await save_snapshot(
                task_id="11111111-1111-1111-1111-111111111111",
                body=SaveSnapshotBody(layers=[]),
                user={"id": "00000000-0000-0000-0000-000000000001"},
            )

    assert exc_info.value.status_code == 409
    cleanup.assert_awaited_once_with(
        user_id="00000000-0000-0000-0000-000000000001",
        task_ids=["11111111-1111-1111-1111-111111111111"],
    )


@pytest.mark.asyncio
async def test_snapshot_restore_includes_owning_project_id():
    class Connection:
        async def fetchrow(self, query, *_args):
            assert "project_id" in query
            assert "snapshot_key" in query
            return {
                "id": "11111111-1111-1111-1111-111111111111",
                "project_id": "22222222-2222-2222-2222-222222222222",
                "workflow_kind": "image_edit",
                "snapshot_key": None,
                "meta": {"layers": []},
            }

    @asynccontextmanager
    async def acquire():
        yield Connection()

    with patch("routers.workspace.acquire", new=acquire), patch(
        "routers.workspace.workspace_snapshot.has_snapshot_key_column",
        new=AsyncMock(return_value=True),
    ):
        snapshot = await get_snapshot(
            task_id="11111111-1111-1111-1111-111111111111",
            user={"id": "00000000-0000-0000-0000-000000000001"},
        )

    assert snapshot["project_id"] == "22222222-2222-2222-2222-222222222222"


@pytest.mark.asyncio
async def test_snapshot_restore_reads_object_storage_when_pointer_exists():
    class Connection:
        async def fetchrow(self, query, *_args):
            assert "snapshot_key" in query
            return {
                "id": "11111111-1111-1111-1111-111111111111",
                "project_id": "22222222-2222-2222-2222-222222222222",
                "workflow_kind": "canvas_flow",
                "snapshot_key": "assets/users/u1/workspace-snapshot/task/files/snapshot.json",
                "meta": {"workflow_kind": "canvas_flow", "snapshot_key": "assets/users/u1/workspace-snapshot/task/files/snapshot.json"},
            }

    @asynccontextmanager
    async def acquire():
        yield Connection()

    async def load_document(meta, snapshot_key=""):
        assert snapshot_key.endswith("snapshot.json")
        return {
            "layers": [],
            "workflow_snapshot": {"nodes": [{"id": "n1"}]},
            "saved_at": "2026-08-23T00:00:00+00:00",
        }

    with patch("routers.workspace.acquire", new=acquire), patch(
        "routers.workspace.workspace_snapshot.load_workspace_snapshot_document",
        new=load_document,
    ), patch(
        "routers.workspace.workspace_snapshot.has_snapshot_key_column",
        new=AsyncMock(return_value=True),
    ):
        snapshot = await get_snapshot(
            task_id="11111111-1111-1111-1111-111111111111",
            user={"id": "00000000-0000-0000-0000-000000000001"},
        )

    assert snapshot["workflow_kind"] == "canvas_flow"
    assert snapshot["workflow_snapshot"]["nodes"][0]["id"] == "n1"
