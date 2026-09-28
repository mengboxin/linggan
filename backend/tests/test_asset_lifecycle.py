from contextlib import asynccontextmanager
import json
from unittest.mock import AsyncMock

import pytest


USER_ID = "00000000-0000-0000-0000-000000000001"
IMAGE_ID = "11111111-1111-1111-1111-111111111111"
FILE_ID = "22222222-2222-2222-2222-222222222222"


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _LifecycleConnection:
    def __init__(self, *, referenced_tokens: set[str] | None = None):
        self.referenced_tokens = referenced_tokens or set()
        self.fetched: list[tuple[str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

    def transaction(self):
        return _Transaction()

    async def fetch(self, query: str, *args):
        self.fetched.append((query, args))
        if "FROM image_assets" in query and "FOR UPDATE" in query:
            return [{
                "id": IMAGE_ID,
                "task_id": "image-task-1",
                "size_bytes": 30,
                "original_key": "users/u1/images/original.png",
                "preview_key": "users/u1/images/preview.webp",
                "thumb_key": "users/u1/images/thumb.webp",
            }]
        if "FROM file_assets" in query and "FOR UPDATE" in query:
            if not any(args[1:]):
                return []
            return [{
                "id": FILE_ID,
                "task_id": "image-task-1",
                "size_bytes": 20,
                "storage_key": "users/u1/files/result.pptx",
            }]
        if "WITH candidates(token)" in query:
            # The survivor scan itself is part of the regression: public gallery
            # references must participate in the decision.
            assert "public_generations" in query
            tokens = set(args[0])
            return [{"token": token} for token in sorted(tokens & self.referenced_tokens)]
        if "DELETE FROM image_assets" in query:
            return [{"id": IMAGE_ID}]
        if "DELETE FROM file_assets" in query:
            return [{"id": FILE_ID}]
        return []

    async def execute(self, query: str, *args):
        self.executed.append((query, args))
        return "INSERT 0 1"


@pytest.mark.asyncio
async def test_public_gallery_reference_preserves_shared_asset_and_objects(monkeypatch):
    from services import asset_lifecycle

    referenced = {
        IMAGE_ID,
        "users/u1/images/original.png",
        "users/u1/images/preview.webp",
        "users/u1/images/thumb.webp",
    }
    conn = _LifecycleConnection(referenced_tokens=referenced)

    @asynccontextmanager
    async def acquire():
        yield conn

    delete_objects = AsyncMock(return_value={"requested": 0, "deleted": 0, "failed": []})
    monkeypatch.setattr(asset_lifecycle, "acquire", acquire)
    monkeypatch.setattr(asset_lifecycle.asset_storage, "delete_asset_keys", delete_objects)
    monkeypatch.setattr(asset_lifecycle.storage_repo, "mark_asset_object_deletions_deleted", AsyncMock())
    monkeypatch.setattr(asset_lifecycle.storage_repo, "mark_asset_object_deletions_failed", AsyncMock())
    monkeypatch.setattr(asset_lifecycle.storage_repo, "invalidate_user_storage_and_history_cache", AsyncMock())

    result = await asset_lifecycle.release_record_assets(
        user_id=USER_ID,
        records={"assetId": IMAGE_ID},
        reason="history-delete",
    )

    sql = "\n".join(query for query, _ in conn.fetched)
    assert "linked_message.id = ia.message_id" in sql
    assert "NOT (ia.id = ANY($3::uuid[]))" in sql
    assert "DELETE FROM image_assets" not in sql
    assert result["image_records_deleted"] == 0
    assert result["image_records_preserved"] == 1
    assert result["object_keys_deleted"] == 0
    delete_objects.assert_not_awaited()


@pytest.mark.asyncio
async def test_unreferenced_image_and_file_records_delete_bucket_objects(monkeypatch):
    from services import asset_lifecycle

    conn = _LifecycleConnection()

    @asynccontextmanager
    async def acquire():
        yield conn

    delete_objects = AsyncMock(return_value={"requested": 4, "deleted": 4, "failed": []})
    mark_deleted = AsyncMock()
    mark_failed = AsyncMock()
    invalidate = AsyncMock()
    monkeypatch.setattr(asset_lifecycle, "acquire", acquire)
    monkeypatch.setattr(asset_lifecycle.asset_storage, "delete_asset_keys", delete_objects)
    monkeypatch.setattr(asset_lifecycle.storage_repo, "mark_asset_object_deletions_deleted", mark_deleted)
    monkeypatch.setattr(asset_lifecycle.storage_repo, "mark_asset_object_deletions_failed", mark_failed)
    monkeypatch.setattr(asset_lifecycle.storage_repo, "invalidate_user_storage_and_history_cache", invalidate)

    result = await asset_lifecycle.release_record_assets(
        user_id=USER_ID,
        records={
            "assetId": IMAGE_ID,
            "pptx_file_asset_id": FILE_ID,
            "taskId": "image-task-1",
        },
        reason="history-delete",
    )

    sql = "\n".join(query for query, _ in conn.fetched + conn.executed)
    assert "DELETE FROM image_assets" in sql
    assert "DELETE FROM file_assets" in sql
    assert "asset_object_deletion_queue" in sql
    assert set(delete_objects.await_args.args[0]) == {
        "users/u1/images/original.png",
        "users/u1/images/preview.webp",
        "users/u1/images/thumb.webp",
        "users/u1/files/result.pptx",
    }
    assert result["image_records_deleted"] == 1
    assert result["file_records_deleted"] == 1
    assert result["object_keys_deleted"] == 4
    assert result["bytes_estimated"] == 50
    mark_deleted.assert_awaited_once()
    mark_failed.assert_awaited_once_with([])
    invalidate.assert_awaited_once_with(USER_ID)


def test_asset_reference_collection_understands_stable_urls_keys_and_file_ids():
    from services.asset_lifecycle import collect_asset_references

    refs = collect_asset_references({
        "imageUrl": f"/api/assets/{IMAGE_ID}/original",
        "pptx_file_asset_id": FILE_ID,
        "slides": [{"storage_key": "/users/u1/slides/1.webp"}],
        "taskId": "task-1",
    })

    assert refs.image_asset_ids == {IMAGE_ID}
    assert refs.file_asset_ids == {FILE_ID}
    assert refs.object_keys == {"users/u1/slides/1.webp"}
    assert refs.task_ids == {"task-1"}


@pytest.mark.asyncio
async def test_record_cleanup_intent_replays_the_serialized_scope(monkeypatch):
    from services import asset_lifecycle

    class IntentConnection:
        def __init__(self):
            self.fetchval_args = None
            self.executed: list[tuple[str, tuple]] = []

        def transaction(self):
            return _Transaction()

        async def fetchval(self, _query: str, *args):
            self.fetchval_args = args
            return "33333333-3333-3333-3333-333333333333"

        async def fetchrow(self, _query: str, *_args):
            return {
                "id": "33333333-3333-3333-3333-333333333333",
                "user_id": USER_ID,
                "reason": "conversation-record-delete",
                "records": {
                    "asset_ids": [IMAGE_ID],
                    "direct_message_asset_ids": [IMAGE_ID],
                },
            }

        async def execute(self, query: str, *args):
            self.executed.append((query, args))
            return "DELETE 1"

    conn = IntentConnection()

    @asynccontextmanager
    async def acquire():
        yield conn

    release_assets = AsyncMock(return_value={"object_keys_deleted": 3})
    monkeypatch.setattr(asset_lifecycle, "acquire", acquire)
    monkeypatch.setattr(asset_lifecycle, "release_record_assets", release_assets)

    intent_id = await asset_lifecycle.stage_record_cleanup_intent(
        conn,
        user_id=USER_ID,
        records={"asset_ids": {IMAGE_ID}},
        reason="conversation-record-delete",
    )
    result = await asset_lifecycle.process_record_cleanup_intent(intent_id)

    assert intent_id == "33333333-3333-3333-3333-333333333333"
    assert json.loads(conn.fetchval_args[2]) == {"asset_ids": [IMAGE_ID]}
    release_assets.assert_awaited_once_with(
        user_id=USER_ID,
        records={"asset_ids": [IMAGE_ID], "direct_message_asset_ids": [IMAGE_ID]},
        reason="conversation-record-delete",
        ignore_conversation_links_for_image_ids={IMAGE_ID},
    )
    assert result["deferred"] is False
    assert any("DELETE FROM asset_record_cleanup_intents" in query for query, _ in conn.executed)
