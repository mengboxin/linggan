from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from repositories import conversation_repo


class _FakeConnection:
    def __init__(self, rows):
        self.rows = rows

    async def fetch(self, *_args, **_kwargs):
        return self.rows


def _asset(asset_id: str, suffix: str) -> dict:
    return {
        "id": asset_id,
        "original_key": f"assets/users/user-1/images/task-1/{suffix}/original.png",
        "preview_key": f"assets/users/user-1/images/task-1/{suffix}/preview.webp",
        "thumb_key": f"assets/users/user-1/images/task-1/{suffix}/thumb.webp",
    }


@pytest.mark.asyncio
async def test_message_asset_scope_includes_all_assets_from_the_same_generation_task(monkeypatch):
    rows = [{"id": "message-1", "meta": {"task_id": "task-1", "asset_id": "asset-1"}}]

    @asynccontextmanager
    async def fake_acquire():
        yield _FakeConnection(rows)

    by_task = AsyncMock(return_value=[_asset("asset-2", "variant-2")])
    monkeypatch.setattr(conversation_repo, "acquire", fake_acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", AsyncMock(return_value=(True, False)))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_message_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_ids", AsyncMock(return_value=[_asset("asset-1", "variant-1")]))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_task_ids", by_task, raising=False)
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_conversation_id", AsyncMock(return_value=[]), raising=False)

    scope = await conversation_repo._load_message_asset_scope(
        user_id="user-1",
        conversation_id="conversation-1",
        message_id="message-1",
    )

    by_task.assert_awaited_once_with(["task-1"], "user-1")
    assert scope["asset_ids"] == {"asset-1", "asset-2"}


@pytest.mark.asyncio
async def test_conversation_asset_scope_includes_unattached_assets(monkeypatch):
    rows = [{"id": "message-1", "meta": {"task_id": "task-1", "asset_id": "asset-1"}}]

    @asynccontextmanager
    async def fake_acquire():
        yield _FakeConnection(rows)

    by_conversation = AsyncMock(return_value=[_asset("asset-3", "variant-3")])
    monkeypatch.setattr(conversation_repo, "acquire", fake_acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", AsyncMock(return_value=(True, False)))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_message_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_ids", AsyncMock(return_value=[_asset("asset-1", "variant-1")]))
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_task_ids", AsyncMock(return_value=[]), raising=False)
    monkeypatch.setattr(conversation_repo.image_asset_repo, "list_assets_by_conversation_id", by_conversation, raising=False)

    scope = await conversation_repo._load_message_asset_scope(
        user_id="user-1",
        conversation_id="conversation-1",
    )

    by_conversation.assert_awaited_once_with("conversation-1", "user-1")
    assert scope["asset_ids"] == {"asset-1", "asset-3"}
