import json
from unittest.mock import AsyncMock

import pytest

from services import workspace_snapshot


@pytest.mark.asyncio
async def test_load_workspace_snapshot_falls_back_to_previous_key(monkeypatch):
    async def fetch(key: str) -> bytes:
        if key.endswith("current.json"):
            raise RuntimeError("missing current snapshot")
        assert key.endswith("previous.json")
        return json.dumps({"layers": [], "workflow_snapshot": {"nodes": [{"id": "prev"}]}}).encode("utf-8")

    monkeypatch.setattr(workspace_snapshot.asset_storage, "fetch_asset_key_bytes", fetch)

    document = await workspace_snapshot.load_workspace_snapshot_document(
        {
            "snapshot_key": "assets/users/u1/workspace-snapshot/task/files/current.json",
            "previous_snapshot_key": "assets/users/u1/workspace-snapshot/task/files/previous.json",
        },
        snapshot_key="assets/users/u1/workspace-snapshot/task/files/current.json",
    )

    assert document["workflow_snapshot"]["nodes"][0]["id"] == "prev"


@pytest.mark.asyncio
async def test_persist_workspace_snapshot_keeps_previous_and_rotates_stale(monkeypatch):
    stored = {
        "id": "file-2",
        "key": "assets/users/u1/workspace-snapshot/task/files/new.json",
        "sha256": "abc",
        "size_bytes": 12,
    }
    monkeypatch.setattr(workspace_snapshot.asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(workspace_snapshot.asset_storage, "store_file_bytes", AsyncMock(return_value=stored))
    delete = AsyncMock(return_value={"deleted": 1})
    monkeypatch.setattr(workspace_snapshot.asset_storage, "delete_asset_keys", delete)

    pointer = await workspace_snapshot.persist_workspace_snapshot_document(
        user_id="user-1",
        task_id="task-1",
        document={"layers": []},
        previous_key="assets/users/u1/workspace-snapshot/task/files/current.json",
        stale_key="assets/users/u1/workspace-snapshot/task/files/old.json",
    )

    assert pointer["snapshot_key"].endswith("new.json")
    assert pointer["previous_snapshot_key"].endswith("current.json")
    delete.assert_awaited_once()
    assert delete.await_args.kwargs["reason"] == "workspace-snapshot-rotate"
