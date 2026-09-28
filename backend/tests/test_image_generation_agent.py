import json
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from services.agents.image_generation_agent import (
    AgentSafetyRejectedError,
    _generation_recovery,
    _humanize_generation_error,
    _plan_prompt,
    _reference_image_contract,
    _review_candidate,
    _run_image_variant_react,
    _workflow_edit_instruction,
    run_image_generation_agent,
)


def test_generation_recovery_offers_safe_alternatives_after_a_safety_rejection():
    recovery = _generation_recovery(AgentSafetyRejectedError("content safety blocked"), "request was rejected")

    assert recovery["kind"] == "safety_block"
    assert [item["id"] for item in recovery["suggestions"]] == [
        "safe_original", "abstract_concept", "rewrite",
    ]


def test_empty_image_result_with_a_safety_word_is_not_reclassified_as_an_upstream_rejection():
    error = "Responses image_generation did not return image data, output_text: safety-related internal error"

    assert _humanize_generation_error(error) == "图像服务这次没有返回有效图片数据，请稍后再试或调整提示词。"


@pytest.mark.asyncio
async def test_plan_prompt_includes_reasoned_visual_context():
    planned = {
        "safe": True,
        "violation_reason": "",
        "intent_summary": "洛克王国喵喵角色图",
        "subject_understanding": "用户要的是洛克王国里的喵喵，而不是普通猫。",
        "composition_plan": "游戏角色资料卡构图，角色居中，左侧中文信息栏。",
        "style_plan": "明亮童话游戏美术，清晰轮廓，柔和高饱和配色。",
        "final_prompt": "生成一张洛克王国喵喵主题的精致角色资料卡。",
        "negative_prompt": "不要生成真实猫照片",
        "quality_checks": ["角色可爱", "中文排版清晰"],
    }

    with patch(
        "services.agents.image_generation_agent.call_chat",
        new=AsyncMock(return_value=json.dumps(planned, ensure_ascii=False)),
    ) as call_chat:
        result, model_id = await _plan_prompt(
            original_prompt="生成一个洛克王国喵喵的图片",
            mode="TEXT_TO_IMAGE",
            ref_count=0,
            model_id="llm-1",
        )

    assert model_id == "llm-1"
    final_prompt = result["final_prompt"]
    assert "Subject understanding:" in final_prompt
    assert "Composition plan:" in final_prompt
    assert "Style plan:" in final_prompt
    assert "洛克王国里的喵喵" in final_prompt
    assert "不要生成真实猫照片" in final_prompt
    call_chat.assert_awaited_once()


@pytest.mark.asyncio
async def test_plan_prompt_observes_ordered_reference_images_and_contract():
    planned = {
        "safe": True,
        "violation_reason": "",
        "intent_summary": "reference-aware edit",
        "final_prompt": "apply image 1 visual language to the current fox icon",
        "negative_prompt": "",
        "quality_checks": [],
    }
    contract = _reference_image_contract(2, is_workflow_edit=True)

    with patch(
        "services.agents.image_generation_agent.call_chat_with_images",
        new=AsyncMock(return_value=json.dumps(planned)),
    ) as call_with_images, patch(
        "services.agents.image_generation_agent.call_chat",
        new=AsyncMock(),
    ) as call_chat:
        result, _ = await _plan_prompt(
            original_prompt="turn the current fox into a 3D IP using 图1",
            mode="IMAGE_EDIT",
            ref_count=2,
            ref_images=[b"current", b"uploaded-ref"],
            reference_contract=contract,
            model_id="llm-1",
        )

    assert result["final_prompt"].startswith("apply image 1")
    call_with_images.assert_awaited_once()
    assert call_with_images.await_args.kwargs["images"] == [b"current", b"uploaded-ref"]
    assert "Input image 2 is user-uploaded reference image 1" in call_with_images.await_args.kwargs["user"]
    call_chat.assert_not_awaited()


@pytest.mark.asyncio
async def test_image_variant_react_graph_preserves_first_version_after_visual_review_failure():
    with patch("services.agents.image_generation_agent.task_repo._update", new=AsyncMock()), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ) as charge_mock, patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"first")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._review_candidate",
        new=AsyncMock(return_value={
            "passed": False,
            "score": 0.45,
            "issues": ["主体需要更居中", "减少背景干扰"],
            "repair_prompt": "主体需要更居中，减少背景干扰",
        }),
    ) as review_mock:
        result = await _run_image_variant_react(
            task_id="task-react",
            model_id="image-model",
            user_id="user-1",
            agent_run_id="",
            source_prompt="制作一个产品主视觉",
            final_prompt="a product hero visual",
            ref_images=[],
            reference_contract="",
            vision_model_id="vision-1",
            llm_model_id="llm-1",
            size="1024x1024",
            image_quality="auto",
            force_size=True,
            variant_index=1,
            output_count=1,
            completed_variants=0,
            max_attempts=2,
            deep_visual_review=True,
            billing_discount_rate=1.0,
            task_state={"agent_steps": []},
            state_lock=None,
        )

    assert result["candidate_image"] == b"first"
    assert result["initial_candidate_image"] == b"first"
    assert result["outcome"] == "awaiting_user"
    assert result["quality_review"]["repair_prompt"] == "主体需要更居中，减少背景干扰"
    generate_mock.assert_awaited_once()
    review_mock.assert_awaited_once()
    image_charge = charge_mock.await_args
    assert image_charge.kwargs["idempotency_key"] == "image-generation:task-react:variant:1:attempt:1"
    assert any(step["name"] == "visual_review" and step["status"] == "completed" for step in result["task_state"]["agent_steps"])
    assert not any(step["name"] == "image_repair" for step in result["task_state"]["agent_steps"])


@pytest.mark.asyncio
async def test_visual_review_uses_success_only_billing_with_stable_variant_key():
    async def execute(**kwargs):
        return await kwargs["invoke"]()

    billed_call = AsyncMock(side_effect=execute)
    review_payload = json.dumps({
        "pass": True,
        "score": 0.91,
        "issues": [],
        "repair_prompt": "",
    })
    with patch(
        "services.agents.image_generation_agent.provider_policy.choose_llm_model_id",
        new=AsyncMock(return_value="review-model"),
    ), patch(
        "services.agents.image_generation_agent.call_text_messages",
        new=AsyncMock(return_value=review_payload),
    ), patch(
        "services.agents.image_generation_agent.execute_billed_model_call",
        new=billed_call,
    ):
        result = await _review_candidate(
            enabled=True,
            review_model_id="review-model",
            review_model_category="llm",
            image_bytes=b"candidate",
            ref_images=[b"reference"],
            user_request="draw a clean product hero",
            reference_contract="Image 1 is the source.",
            user_id="user-1",
            task_id="task-review",
            variant_index=2,
        )

    assert result["passed"] is True
    billing = billed_call.await_args.kwargs
    assert billing["model_id"] == "review-model"
    assert billing["expected_category"] == "llm"
    assert billing["related_task_id"] is None
    assert billing["reservation_task_id"] == "task-review"
    assert billing["idempotency_key"] == "image-generation:task-review:variant:2:visual-review"


@pytest.mark.asyncio
async def test_visual_review_never_swallows_billing_failures():
    with patch(
        "services.agents.image_generation_agent.provider_policy.choose_llm_model_id",
        new=AsyncMock(return_value="review-model"),
    ), patch(
        "services.agents.image_generation_agent.execute_billed_model_call",
        new=AsyncMock(side_effect=HTTPException(402, "insufficient credits")),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await _review_candidate(
                enabled=True,
                review_model_id="review-model",
                review_model_category="llm",
                image_bytes=b"candidate",
                ref_images=[],
                user_request="draw",
                reference_contract="",
                user_id="user-1",
                task_id="task-review-billing-error",
                variant_index=1,
            )

    assert exc_info.value.status_code == 402


@pytest.mark.asyncio
async def test_image_variant_react_graph_does_not_depend_on_a_second_image_call_for_review_suggestions():
    with patch("services.agents.image_generation_agent.task_repo._update", new=AsyncMock()), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"first")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._review_candidate",
        new=AsyncMock(return_value={
            "passed": False,
            "score": 0.45,
            "issues": ["主体需要更居中"],
            "repair_prompt": "让主体更居中并减少背景干扰",
        }),
    ):
        result = await _run_image_variant_react(
            task_id="task-repair-failure",
            model_id="image-model",
            user_id="user-1",
            agent_run_id="",
            source_prompt="制作一张产品主视觉",
            final_prompt="a product hero visual",
            ref_images=[],
            reference_contract="",
            vision_model_id="vision-1",
            llm_model_id="llm-1",
            size="1024x1024",
            image_quality="auto",
            force_size=True,
            variant_index=1,
            output_count=1,
            completed_variants=0,
            deep_visual_review=True,
            billing_discount_rate=1.0,
            task_state={"agent_steps": []},
            state_lock=None,
        )

    generate_mock.assert_awaited_once()
    assert result["candidate_image"] == b"first"
    assert result["outcome"] == "awaiting_user"
    assert result["quality_review"]["current_result_available"] is True


@pytest.mark.asyncio
async def test_run_image_generation_agent_does_not_retry_transient_failures():
    plan = {
        "safe": True,
        "violation_reason": "",
        "intent_summary": "test",
        "final_prompt": "draw once",
        "negative_prompt": "",
        "quality_checks": [],
    }

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_failed", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock(return_value=(plan, "llm-1"))
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image",
        new=AsyncMock(side_effect=RuntimeError("Responses image_generation failed (503): temporarily unavailable")),
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.asyncio.sleep", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-1",
            model_id="image-model",
            prompt="draw",
            ref_images=[],
            params={"user_id": "user-1"},
            llm_model_id="llm-1",
            vision_model_id="vision-1",
        )

    assert generate_mock.await_count == 1


@pytest.mark.asyncio
async def test_run_image_generation_agent_does_not_locally_reject_planner_safe_false():
    plan = {
        "safe": False,
        "violation_reason": "planner policy marker",
        "intent_summary": "test",
        "final_prompt": "draw the requested scene",
        "negative_prompt": "",
        "quality_checks": [],
    }

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock(return_value=(plan, "llm-1"))
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"png")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-planner-safe-false",
            model_id="image-model",
            prompt="draw",
            ref_images=[],
            params={"user_id": "user-1"},
            llm_model_id="llm-1",
            vision_model_id="",
        )

    generate_mock.assert_awaited_once()
    completed_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_run_image_generation_agent_fast_mode_skips_planning_and_qa_by_default():
    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock()
    ) as plan_mock, patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"png")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-fast",
            model_id="image-model",
            prompt="draw directly",
            ref_images=[],
            params={
                "user_id": "user-1",
                "size": "3840x2160",
                "output_resolution": "4k",
                "image_quality": "high",
            },
            llm_model_id="",
            vision_model_id="",
        )

    plan_mock.assert_not_awaited()
    generate_mock.assert_awaited_once_with(
        model_id="image-model",
        prompt="draw directly",
        ref_images=[],
        size="3840x2160",
        quality="high",
        force_size=True,
    )
    completed_mock.assert_awaited_once()
    completed_payload = completed_mock.await_args.args[1]
    assert completed_payload["final_prompt"] == "draw directly"


@pytest.mark.asyncio
async def test_run_image_generation_agent_workflow_edit_auto_plans_without_selected_llm():
    plan = {
        "safe": True,
        "violation_reason": "",
        "intent_summary": "major edit",
        "final_prompt": "turn the car into a futuristic orange concept vehicle",
        "negative_prompt": "",
        "quality_checks": [],
    }

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock(return_value=(plan, "default-llm"))
    ) as plan_mock, patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"png")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-workflow-edit",
            model_id="image-model",
            prompt="make it look like a futuristic orange concept car",
            ref_images=[b"source-image"],
            params={"user_id": "user-1", "source": "workflow_edit"},
            llm_model_id="",
            vision_model_id="",
        )

    plan_mock.assert_awaited_once()
    plan_kwargs = plan_mock.await_args.kwargs
    assert plan_kwargs["mode"] == "IMAGE_EDIT"
    assert plan_kwargs["ref_count"] == 1
    assert plan_kwargs["ref_images"] == [b"source-image"]
    assert "editable source material" in plan_kwargs["original_prompt"]
    assert "Do not protect the original image structure by default" in plan_kwargs["original_prompt"]
    assert "User edit request: make it look like a futuristic orange concept car" in plan_kwargs["original_prompt"]
    generate_mock.assert_awaited_once()
    completed_payload = completed_mock.await_args.args[1]
    assert completed_payload["final_prompt"].startswith("turn the car into a futuristic orange concept vehicle")
    assert "Input image 1 is the current workflow image" in completed_payload["final_prompt"]


@pytest.mark.asyncio
async def test_run_image_generation_agent_returns_multiple_creative_variations():
    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock()
    ) as plan_mock, patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image",
        new=AsyncMock(side_effect=[b"png-1", b"png-2", b"png-3"]),
    ) as generate_mock, patch(
        "services.agents.image_generation_agent.asset_storage.store_generated_image_best_effort", new=AsyncMock(return_value=None)
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-creative",
            model_id="image-model",
            prompt="make three creative product redesigns",
            ref_images=[],
            params={"user_id": "user-1", "n": 3},
            llm_model_id="",
            vision_model_id="",
        )

    plan_mock.assert_not_awaited()
    assert generate_mock.await_count == 3
    prompts = [call.kwargs["prompt"] for call in generate_mock.await_args_list]
    assert "Creative divergent variation 1 of 3" in prompts[0]
    assert "Creative divergent variation 2 of 3" in prompts[1]
    assert "Creative divergent variation 3 of 3" in prompts[2]
    completed_payload = completed_mock.await_args.args[1]
    assert len(completed_payload["images"]) == 3
    assert completed_payload["imageBase64"] == "cG5nLTE="


@pytest.mark.asyncio
async def test_run_image_generation_agent_respects_variation_concurrency_limit(monkeypatch):
    from core.config import settings

    monkeypatch.setattr(settings, "TASK_FANOUT_CONCURRENCY", 1)
    started = 0
    active = 0
    max_active = 0

    async def generate_image(**_kwargs):
        nonlocal started, active, max_active
        started += 1
        active += 1
        max_active = max(max_active, active)
        try:
            await asyncio.sleep(0.01)
            return f"png-{started}".encode()
        finally:
            active -= 1

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=generate_image
    ), patch(
        "services.agents.image_generation_agent.asset_storage.store_generated_image_best_effort", new=AsyncMock(return_value=None)
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-real-parallel",
            model_id="image-model",
            prompt="make three variants",
            ref_images=[],
            params={"user_id": "user-1", "n": 3},
            llm_model_id="",
            vision_model_id="",
        )

    assert started == 3
    assert max_active == 1


@pytest.mark.asyncio
async def test_run_image_generation_agent_keeps_successful_variations_when_one_fails():
    async def generate_image(**kwargs):
        prompt = kwargs["prompt"]
        if "Creative divergent variation 2 of 3" in prompt:
            raise RuntimeError("variant 2 upstream failure")
        if "Creative divergent variation 1 of 3" in prompt:
            return b"png-1"
        return b"png-3"

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent.task_repo.set_failed", new=AsyncMock()
    ) as failed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=generate_image
    ), patch(
        "services.agents.image_generation_agent.asset_storage.store_generated_image_best_effort", new=AsyncMock(return_value=None)
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-partial-success",
            model_id="image-model",
            prompt="make three variants",
            ref_images=[],
            params={"user_id": "user-1", "n": 3},
            llm_model_id="",
            vision_model_id="",
        )

    failed_mock.assert_not_awaited()
    completed_mock.assert_awaited_once()
    completed_payload = completed_mock.await_args.args[1]
    assert [image["variantIndex"] for image in completed_payload["images"]] == [1, 3]
    assert completed_payload["partial"] is True
    assert completed_payload["requested_count"] == 3
    assert completed_payload["completed_count"] == 2
    assert completed_payload["failed_variants"] == [2]


def test_workflow_edit_instruction_is_user_intent_first():
    instruction = _workflow_edit_instruction("replace the product with a glass perfume bottle", ref_count=2)

    assert "editable source material" in instruction
    assert "Do not protect the original image structure by default" in instruction
    assert "Input image 2 is user-uploaded reference image 1" in instruction
    assert "When the user says 图N" in instruction
    assert "User edit request: replace the product with a glass perfume bottle" in instruction


@pytest.mark.asyncio
async def test_run_image_generation_agent_does_not_regenerate_after_failed_qa_by_default():
    plan = {
        "safe": True,
        "violation_reason": "",
        "intent_summary": "test",
        "final_prompt": "draw once",
        "negative_prompt": "",
        "quality_checks": [],
    }

    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._plan_prompt", new=AsyncMock(return_value=(plan, "llm-1"))
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"png")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-2",
            model_id="image-model",
            prompt="draw",
            ref_images=[],
            params={"user_id": "user-1"},
            llm_model_id="llm-1",
            vision_model_id="vision-1",
        )

    assert generate_mock.await_count == 1
    completed_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_fast_mobile_generation_never_silently_creates_a_repaired_second_image():
    """A single mobile submit must map to exactly one paid upstream image call."""
    with patch("services.agents.image_generation_agent.task_repo.set_processing", new=AsyncMock()), patch(
        "services.agents.image_generation_agent.task_repo._update", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent.task_repo.set_completed", new=AsyncMock()
    ) as completed_mock, patch(
        "services.agents.image_generation_agent._check_next_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._generate_image", new=AsyncMock(return_value=b"png")
    ) as generate_mock, patch(
        "services.agents.image_generation_agent._review_candidate",
        new=AsyncMock(return_value={
            "passed": False,
            "score": 0.5,
            "issues": ["composition could improve"],
            "repair_prompt": "improve composition",
        }),
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        await run_image_generation_agent(
            task_id="task-mobile-single-call",
            model_id="image-model",
            prompt="draw a 3d game character",
            ref_images=[],
            params={
                "user_id": "user-1",
                "source": "mobile",
                "agent_mode": "fast",
                # Reproduces the route's currently queued payload.
                "enable_visual_review": True,
            },
            llm_model_id="",
            vision_model_id="",
        )

    generate_mock.assert_awaited_once()
    completed_mock.assert_awaited_once()
    result_payload = completed_mock.await_args.args[1]
    assert result_payload.get("quality_review") is None


def test_humanize_generation_error_for_responses_empty_image_payload():
    message = _humanize_generation_error(
        "Responses image_generation did not return image data, output types: ['message']"
    )

    assert "没有返回有效图片数据" in message
    assert "调整提示词" in message
