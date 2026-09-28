from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from routers import generate


USER = {"id": "creative-skill-user"}
MODEL = {
    "enabled": True,
    "category": "generate",
    "name": "Image Model",
    "price_type": "free",
}


class StubUpload:
    filename = "reference.png"
    content_type = "image/png"

    async def read(self, _size=-1):
        return b"creative-skill-reference"


def _skill(**overrides):
    skill = {
        "id": "skill-cinematic-reference",
        "name": "电影参考图技能",
        "module": "TEXT_TO_IMAGE",
        "enabled": True,
        "schema_version": 2,
        "revision": 7,
        "execution_adapter": "image_generate",
        "execution_instructions": "根据参考图生成电影叙事画面。",
        "input_contract": {
            "prompt": {"required": False, "max_length": 4000},
            "images": {"min": 1, "max": 1, "roles": ["reference"]},
        },
        "constraints": {},
        "default_params": {"output_resolution": "2k", "count": 1},
    }
    skill.update(overrides)
    return skill


def _submit_kwargs(**overrides):
    kwargs = {
        "model_id": "image-model",
        "prompt": "",
        "size": "1024x1024",
        "output_resolution": "1k",
        "image_quality": "auto",
        "n": 1,
        "llm_model_id": "",
        "vision_model_id": "",
        "conversation_id": "conversation-skill-1",
        "source": "creative_gallery",
        "client_request_id": "request-skill-1",
        "operation_id": "",
        "make_public": False,
        "agent_plan": "",
        "agent_run_id": "",
        "snapshot_fingerprint": "",
        "skill_id": "skill-cinematic-reference",
        "skill_revision": 7,
        "images": [StubUpload()],
        "user": USER,
    }
    kwargs.update(overrides)
    return kwargs


@pytest.mark.asyncio
async def test_submit_executes_image_only_skill_and_propagates_audit_metadata():
    expected_meta = {
        "skill_id": "skill-cinematic-reference",
        "skill_schema_version": 2,
        "skill_revision": 7,
        "execution_adapter": "image_generate",
        "resolved_params": {"output_resolution": "2k", "count": 1},
    }
    stored_inputs = [{
        "role": "source",
        "file_asset_id": "skill-reference-asset",
        "key": "queue-inputs/skill-reference.png",
    }]

    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill()),
    ) as get_skill, patch(
        "routers.generate.model_repo.get_model", new=AsyncMock(return_value=MODEL)
    ), patch(
        "routers.generate.conversation_repo.conversation_belongs_to_user",
        new=AsyncMock(return_value=True),
    ), patch(
        "routers.generate.conversation_repo.add_message", new=AsyncMock()
    ) as add_message, patch(
        "routers.generate.task_repo.create", new=AsyncMock(return_value="task-skill-1")
    ), patch(
        "routers.generate.task_repo._update", new=AsyncMock()
    ) as update_task, patch(
        "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
    ), patch(
        "routers.generate._remember_submit_key", new=AsyncMock()
    ), patch(
        "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "run-skill-1"})
    ) as create_run, patch(
        "routers.generate.update_run", new=AsyncMock()
    ), patch(
        "routers.generate.queue_assets.persist_queue_inputs",
        new=AsyncMock(return_value=stored_inputs),
    ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue:
        result = await generate.submit(**_submit_kwargs())

    get_skill.assert_awaited_once_with("skill-cinematic-reference")
    assert result["taskId"] == "task-skill-1"
    assert result["creative_skill"] == expected_meta

    update_task.assert_awaited_once_with(
        "task-skill-1",
        {"_creative_skill": expected_meta},
    )
    assert create_run.await_args.kwargs["instruction"] == "根据参考图生成电影叙事画面。"
    assert create_run.await_args.kwargs["context"]["creative_skill"] == expected_meta

    message_call = add_message.await_args.kwargs
    assert message_call["content"] == "使用技能：电影参考图技能"
    assert message_call["meta"]["creative_skill"] == expected_meta
    assert message_call["meta"]["user_prompt"] == ""

    queue_payload = enqueue.await_args.kwargs["payload"]
    assert queue_payload["prompt"] == "根据参考图生成电影叙事画面。"
    assert queue_payload["params"]["creative_skill"] == expected_meta
    assert queue_payload["params"]["output_resolution"] == "2k"
    assert queue_payload["params"]["n"] == 1
    assert queue_payload["image_assets"] == stored_inputs


@pytest.mark.asyncio
async def test_submit_resolves_a_personal_inspiration_recipe_for_its_owner():
    personal_recipe = _skill(
        id="personal-recipe-1",
        name="冷光古典人像",
        schema_version=1,
        revision=1,
        execution_adapter="prompt_append",
        execution_instructions="",
        prompt_template="构图与视线：半身侧身肖像\n光线：窗边冷光",
        input_contract={
            "prompt": {"required": True, "max_length": 4000},
            "images": {"min": 0, "max": 8, "roles": ["reference"]},
        },
        default_params={},
    )

    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=None),
    ), patch(
        "routers.generate.creative_style_repo.get_personal_style_recipe",
        new=AsyncMock(return_value=personal_recipe),
    ) as get_personal_recipe, patch(
        "routers.generate.model_repo.get_model", new=AsyncMock(return_value=MODEL)
    ), patch(
        "routers.generate.conversation_repo.conversation_belongs_to_user",
        new=AsyncMock(return_value=True),
    ), patch(
        "routers.generate.conversation_repo.add_message", new=AsyncMock(),
    ), patch(
        "routers.generate.task_repo.create", new=AsyncMock(return_value="task-personal-recipe"),
    ), patch(
        "routers.generate.task_repo._update", new=AsyncMock(),
    ), patch(
        "routers.generate._claim_submit_key", new=AsyncMock(return_value=None),
    ), patch(
        "routers.generate._remember_submit_key", new=AsyncMock(),
    ), patch(
        "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "run-personal-recipe"}),
    ), patch(
        "routers.generate.update_run", new=AsyncMock(),
    ), patch(
        "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=[]),
    ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue:
        result = await generate.submit(**_submit_kwargs(
            prompt="雨夜里的都市人像",
            skill_id="personal-recipe-1",
            skill_revision=1,
            images=[],
        ))

    get_personal_recipe.assert_awaited_once_with(
        user_id=USER["id"],
        style_id="personal-recipe-1",
    )
    assert result["taskId"] == "task-personal-recipe"
    assert enqueue.await_args.kwargs["payload"]["prompt"] == (
        "雨夜里的都市人像\n\n构图与视线：半身侧身肖像\n光线：窗边冷光"
    )


@pytest.mark.asyncio
async def test_submit_rejects_stale_skill_revision_before_task_creation():
    create_task = AsyncMock()
    enqueue = AsyncMock()
    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(revision=8)),
    ), patch(
        "routers.generate.model_repo.get_model", new=AsyncMock()
    ) as get_model, patch(
        "routers.generate.task_repo.create", new=create_task
    ), patch("routers.generate.enqueue", new=enqueue):
        with pytest.raises(HTTPException) as caught:
            await generate.submit(**_submit_kwargs(skill_revision=7))

    assert caught.value.status_code == 409
    assert "已更新" in str(caught.value.detail)
    get_model.assert_not_awaited()
    create_task.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_submit_rejects_skill_input_contract_before_task_creation():
    create_task = AsyncMock()
    enqueue = AsyncMock()
    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill()),
    ), patch(
        "routers.generate.model_repo.get_model", new=AsyncMock()
    ) as get_model, patch(
        "routers.generate.task_repo.create", new=create_task
    ), patch("routers.generate.enqueue", new=enqueue):
        with pytest.raises(HTTPException) as caught:
            await generate.submit(**_submit_kwargs(prompt="补充电影光线", images=[]))

    assert caught.value.status_code == 400
    assert "image count" in str(caught.value.detail)
    get_model.assert_not_awaited()
    create_task.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_submit_safely_rejects_unavailable_skill_adapter():
    create_task = AsyncMock()
    enqueue = AsyncMock()
    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(execution_adapter="shell")),
    ), patch(
        "routers.generate.model_repo.get_model", new=AsyncMock()
    ) as get_model, patch(
        "routers.generate.task_repo.create", new=create_task
    ), patch("routers.generate.enqueue", new=enqueue):
        with pytest.raises(HTTPException) as caught:
            await generate.submit(**_submit_kwargs())

    assert caught.value.status_code == 400
    assert "unsupported" in str(caught.value.detail)
    get_model.assert_not_awaited()
    create_task.assert_not_awaited()
    enqueue.assert_not_awaited()
