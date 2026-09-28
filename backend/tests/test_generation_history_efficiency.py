from unittest.mock import AsyncMock

import pytest

from services.agents import image_generation_agent


@pytest.mark.asyncio
async def test_generation_history_uses_idempotent_upserts_without_full_history_read(monkeypatch):
    history_read = AsyncMock(side_effect=AssertionError("full history must not be read"))
    add_message = AsyncMock(side_effect=[{"id": "user-message"}, {"id": "assistant-message"}])
    attach_message = AsyncMock()
    monkeypatch.setattr(
        image_generation_agent.conversation_repo,
        "get_conversation_messages",
        history_read,
    )
    monkeypatch.setattr(image_generation_agent.conversation_repo, "add_message", add_message)
    monkeypatch.setattr(image_generation_agent.asset_storage, "attach_message", attach_message)

    await image_generation_agent._persist_generation_history(
        task_id="task-1",
        user_id="user-1",
        conversation_id="conversation-1",
        source="web",
        prompt="prompt",
        model_id="image2",
        llm_model_id=None,
        vision_model_id=None,
        size="1024x1024",
        ref_count=0,
        image_asset_meta={"asset_id": "asset-1", "image_url": "/api/assets/asset-1/original"},
    )

    history_read.assert_not_awaited()
    assert add_message.await_count == 2
    attach_message.assert_awaited_once_with("asset-1", "assistant-message")
