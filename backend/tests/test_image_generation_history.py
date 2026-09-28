from unittest.mock import AsyncMock, patch

import pytest

from services.agents.image_generation_agent import _persist_generation_history


@pytest.mark.asyncio
async def test_persist_generation_history_writes_image_messages_once():
    get_messages = AsyncMock(return_value=[])
    add_message = AsyncMock()
    with patch("services.agents.image_generation_agent.conversation_repo.get_conversation_messages", new=get_messages), patch(
        "services.agents.image_generation_agent.conversation_repo.add_message", new=add_message
    ):
        await _persist_generation_history(
            task_id="task-1",
            user_id="user-1",
            conversation_id="conv-1",
            source="mobile",
            prompt="draw ice pet",
            model_id="image-model",
            llm_model_id="llm-model",
            vision_model_id="vision-model",
            size="1024x1024",
            ref_count=0,
            image_base64="abc123",
        )

    assert add_message.await_count == 2
    user_call = add_message.await_args_list[0].kwargs
    assistant_call = add_message.await_args_list[1].kwargs
    assert user_call["role"] == "user"
    assert user_call["meta"]["task_id"] == "task-1"
    assert assistant_call["role"] == "assistant"
    assert assistant_call["meta"]["image_url"] == "data:image/png;base64,abc123"
    assert assistant_call["meta"]["source"] == "mobile"


@pytest.mark.asyncio
async def test_persist_generation_history_adds_result_when_request_snapshot_exists():
    get_messages = AsyncMock(return_value=[{"role": "user", "meta": {"task_id": "task-1"}}])
    add_message = AsyncMock()
    with patch("services.agents.image_generation_agent.conversation_repo.get_conversation_messages", new=get_messages), patch(
        "services.agents.image_generation_agent.conversation_repo.add_message", new=add_message
    ):
        await _persist_generation_history(
            task_id="task-1",
            user_id="user-1",
            conversation_id="conv-1",
            source="mobile",
            prompt="draw ice pet",
            model_id="image-model",
            llm_model_id=None,
            vision_model_id=None,
            size="1024x1024",
            ref_count=0,
            image_base64="abc123",
        )

    get_messages.assert_not_awaited()
    assert add_message.await_count == 2
    assistant_call = add_message.await_args_list[1].kwargs
    assert assistant_call["role"] == "assistant"
    assert assistant_call["meta"]["image_b64"] == "abc123"


@pytest.mark.asyncio
async def test_persist_generation_history_uses_idempotent_upserts_when_result_already_exists():
    get_messages = AsyncMock(return_value=[
        {"role": "user", "meta": {"task_id": "task-1"}},
        {"role": "assistant", "meta": {"task_id": "task-1", "type": "image_result"}},
    ])
    add_message = AsyncMock()
    with patch("services.agents.image_generation_agent.conversation_repo.get_conversation_messages", new=get_messages), patch(
        "services.agents.image_generation_agent.conversation_repo.add_message", new=add_message
    ):
        await _persist_generation_history(
            task_id="task-1",
            user_id="user-1",
            conversation_id="conv-1",
            source="mobile",
            prompt="draw ice pet",
            model_id="image-model",
            llm_model_id=None,
            vision_model_id=None,
            size="1024x1024",
            ref_count=0,
            image_base64="abc123",
        )

    get_messages.assert_not_awaited()
    assert add_message.await_count == 2


@pytest.mark.asyncio
async def test_persist_generation_history_attaches_every_generated_asset():
    get_messages = AsyncMock(return_value=[])
    add_message = AsyncMock(side_effect=[{"id": "request-1"}, {"id": "result-1"}])
    attach_message = AsyncMock()
    assets = [
        {
            "asset_id": f"asset-{index}",
            "image_url": f"/api/assets/asset-{index}/original",
            "preview_url": f"/api/assets/asset-{index}/preview",
            "thumbnail_url": f"/api/assets/asset-{index}/thumb",
            "asset_original_key": f"users/u/task/variant-{index}/original.png",
        }
        for index in range(1, 4)
    ]

    with patch("services.agents.image_generation_agent.conversation_repo.get_conversation_messages", new=get_messages), patch(
        "services.agents.image_generation_agent.conversation_repo.add_message", new=add_message
    ), patch(
        "services.agents.image_generation_agent.asset_storage.attach_message", new=attach_message
    ):
        await _persist_generation_history(
            task_id="task-multi",
            user_id="user-1",
            conversation_id="conv-1",
            source="web",
            prompt="draw three",
            model_id="image-model",
            llm_model_id=None,
            vision_model_id=None,
            size="1024x1024",
            ref_count=0,
            image_asset_metas=assets,
        )

    assistant_meta = add_message.await_args_list[1].kwargs["meta"]
    assert assistant_meta["asset_id"] == "asset-1"
    assert assistant_meta["images"] == assets
    assert [call.args for call in attach_message.await_args_list] == [
        ("asset-1", "result-1"),
        ("asset-2", "result-1"),
        ("asset-3", "result-1"),
    ]
