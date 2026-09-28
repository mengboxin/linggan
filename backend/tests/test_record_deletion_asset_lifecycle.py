from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest


USER_ID = "00000000-0000-0000-0000-000000000001"
CONVERSATION_ID = "11111111-1111-1111-1111-111111111111"
MESSAGE_ID = "22222222-2222-2222-2222-222222222222"


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _ConversationConnection:
    async def execute(self, query: str, *_args):
        if "DELETE FROM conversation_messages" in query:
            return "DELETE 1"
        if "DELETE FROM conversations" in query:
            return "DELETE 1"
        return "UPDATE 1"

    def transaction(self):
        return _Transaction()


@pytest.mark.asyncio
@pytest.mark.parametrize("delete_kind", ["message", "conversation"])
async def test_conversation_deletes_release_assets_through_lifecycle(monkeypatch, delete_kind):
    from repositories import conversation_repo

    scope = {
        "asset_ids": {"33333333-3333-3333-3333-333333333333"},
        "direct_message_asset_ids": {"33333333-3333-3333-3333-333333333333"},
        "file_asset_ids": {"44444444-4444-4444-4444-444444444444"},
        "keys": {"assets/users/u1/result.png"},
        "task_ids": {"job-1"},
    }

    @asynccontextmanager
    async def acquire():
        yield _ConversationConnection()

    load_scope = AsyncMock(return_value=scope)
    stage_intent = AsyncMock(return_value="cleanup-intent-1")
    process_intent = AsyncMock(return_value={"object_keys_deleted": 2, "deferred": False})
    monkeypatch.setattr(conversation_repo, "acquire", acquire)
    monkeypatch.setattr(conversation_repo, "_load_message_asset_scope", load_scope)
    monkeypatch.setattr(conversation_repo.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(conversation_repo.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(conversation_repo.ui_cache, "bump_user_cache_version", AsyncMock())

    if delete_kind == "message":
        result = await conversation_repo.delete_message(CONVERSATION_ID, MESSAGE_ID, USER_ID)
        load_scope.assert_awaited_once_with(
            user_id=USER_ID,
            conversation_id=CONVERSATION_ID,
            message_id=MESSAGE_ID,
        )
    else:
        result = await conversation_repo.delete_conversation(CONVERSATION_ID, USER_ID)
        load_scope.assert_awaited_once_with(
            user_id=USER_ID,
            conversation_id=CONVERSATION_ID,
        )

    assert result["success"] is True
    stage_intent.assert_awaited_once_with(
        stage_intent.await_args.args[0],
        user_id=USER_ID,
        records=scope,
        reason="conversation-record-delete",
    )
    assert isinstance(stage_intent.await_args.args[0], _ConversationConnection)
    process_intent.assert_awaited_once_with("cleanup-intent-1")


@pytest.mark.asyncio
async def test_presentation_upload_delete_releases_source_and_slide_objects(monkeypatch):
    from routers import ppt

    upload_id = "55555555-5555-5555-5555-555555555555"
    record = {
        "id": upload_id,
        "source_key": "assets/users/u1/presentation/source.pptx",
        "slides": [
            {"storage_key": "assets/users/u1/presentation/slide-1.webp"},
            {"source_key": "assets/users/u1/presentation/slide-2.webp"},
        ],
    }
    class Connection:
        def transaction(self):
            return _Transaction()

    @asynccontextmanager
    async def acquire():
        yield Connection()

    delete_upload = AsyncMock(return_value=record)
    monkeypatch.setattr(ppt, "acquire", acquire)
    monkeypatch.setattr(ppt.ppt_upload_repo, "delete_upload", delete_upload)
    monkeypatch.setattr(ppt.ui_cache, "bump_user_cache_version", AsyncMock())
    stage_intent = AsyncMock(return_value="cleanup-intent-2")
    process_intent = AsyncMock(return_value={"file_records_deleted": 3, "object_keys_deleted": 3})
    monkeypatch.setattr(ppt.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(ppt.asset_lifecycle, "process_record_cleanup_intent", process_intent)

    result = await ppt.delete_uploaded_presentation(upload_id, {"id": USER_ID})

    assert result["success"] is True
    assert delete_upload.await_args.kwargs["conn"] is not None
    stage_intent.assert_awaited_once()
    call = stage_intent.await_args.kwargs
    assert call["user_id"] == USER_ID
    assert call["reason"] == "presentation-upload-delete"
    assert call["records"]["task_id"] == upload_id
    assert set(call["records"]["object_keys"]) == {
        "assets/users/u1/presentation/source.pptx",
        "assets/users/u1/presentation/slide-1.webp",
        "assets/users/u1/presentation/slide-2.webp",
    }
    process_intent.assert_awaited_once_with("cleanup-intent-2")


@pytest.mark.asyncio
async def test_workspace_project_delete_routes_every_task_through_workspace_cleanup(monkeypatch):
    from routers import workspace

    project_id = "66666666-6666-6666-6666-666666666666"
    task_ids = [
        "77777777-7777-7777-7777-777777777777",
        "88888888-8888-8888-8888-888888888888",
    ]

    class Connection:
        async def fetchrow(self, _query, *_args):
            return {"id": project_id, "thumbnail": ""}

        async def fetch(self, _query, *_args):
            return [{"id": task_id} for task_id in task_ids]

        async def execute(self, query, *_args):
            assert "UPDATE projects" in query or "DELETE FROM projects" in query
            return "UPDATE 1" if "UPDATE projects" in query else "DELETE 1"

        def transaction(self):
            return _Transaction()

    conn = Connection()

    @asynccontextmanager
    async def acquire():
        yield conn

    cleanup = AsyncMock(return_value={"object_keys_deleted": 4})
    stage_intent = AsyncMock(return_value="cleanup-intent-3")
    process_intent = AsyncMock(return_value={"object_keys_deleted": 0})
    monkeypatch.setattr(workspace.workspace_cleanup, "delete_workspace_tasks", cleanup)
    monkeypatch.setattr(workspace.asset_lifecycle, "stage_record_cleanup_intent", stage_intent)
    monkeypatch.setattr(workspace.asset_lifecycle, "process_record_cleanup_intent", process_intent)
    monkeypatch.setattr(workspace, "acquire", acquire)

    result = await workspace.delete_project(project_id, {"id": USER_ID})

    assert result["ok"] is True
    cleanup.assert_awaited_once_with(user_id=USER_ID, task_ids=task_ids)
    stage_intent.assert_awaited_once_with(
        stage_intent.await_args.args[0],
        user_id=USER_ID,
        records={"project_id": project_id, "thumbnail": ""},
        reason="workspace-project-delete",
    )
    process_intent.assert_awaited_once_with("cleanup-intent-3")
