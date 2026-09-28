from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from routers.sci_fig import _run_ai_generate, _run_code_render


async def _execute_billed(**kwargs):
    return await kwargs["invoke"]()


@pytest.mark.asyncio
async def test_code_render_keeps_first_result_and_automatically_repairs_once_after_qa():
    state = {
        "job_id": "sci-one-shot",
        "user_id": "user-1",
        "description": "绘制细胞信号通路图",
        "category": "flow_diagram",
        "style_preset": "science",
        "chart_params": {},
        "attachment_context": "",
        "llm_model_id": "",
        "agent_steps": [],
        "artifact_versions": [],
    }
    plan = {
        "generation_prompt": "publication-ready cell signaling pathway",
        "intent_summary": "细胞信号通路",
        "quality_checks": [],
    }
    qa = {
        "pass": False,
        "score": 0.45,
        "issues": ["图例层级需要更清晰"],
        "repair_prompt": "增强图例层级并提高标签可读性",
    }

    repaired_qa = {"pass": True, "score": 0.88, "issues": [], "repair_prompt": ""}

    with patch("routers.sci_fig._sci_save_step", new=AsyncMock()), patch(
        "routers.sci_fig._save_state", new=AsyncMock()
    ), patch("routers.sci_fig._plan_sci_figure", new=AsyncMock(return_value=plan)), patch(
        "routers.sci_fig._resolve_plan_choices"
    ), patch("routers.sci_fig.provider_policy.choose_llm_model_id", new=AsyncMock(return_value="")), patch(
        "routers.sci_fig.generate_code", new=AsyncMock(side_effect=["<svg />", "<svg repaired />"])
    ) as generate_mock, patch("routers.sci_fig.execute_code", new=AsyncMock(side_effect=[
        (b"png", "<svg/>"),
        (b"repaired", "<svg repaired/>"),
    ])) as render_mock, patch(
        "routers.sci_fig._qa_sci_figure", new=AsyncMock(side_effect=[qa, repaired_qa])
    ), patch("routers.sci_fig.fix_code", new=AsyncMock()) as fix_mock, patch(
        "routers.sci_fig._store_sci_rendered_asset", new=AsyncMock()
    ), patch("routers.sci_fig._append_artifact_version"), patch(
        "routers.sci_fig._save_artifact_message", new=AsyncMock()
    ):
        await _run_code_render(state)

    assert generate_mock.await_count == 2
    assert render_mock.await_count == 2
    fix_mock.assert_not_awaited()
    assert state["status"] == "preview"
    assert state["rendered_b64"]
    assert state["quality_review"] == {}


@pytest.mark.asyncio
async def test_image2_generation_preserves_first_version_and_automatically_repairs_once():
    state = {
        "job_id": "sci-image2-repair",
        "user_id": "user-1",
        "description": "Create a publication-ready signaling pathway figure",
        "category": "flow_diagram",
        "style_preset": "science",
        "chart_params": {},
        "attachment_context": "",
        "reference_assets": [],
        "image_model_id": "image-1",
        "vision_model_id": "vision-1",
        "output_resolution": "1k",
        "image_quality": "auto",
        "agent_steps": [],
        "artifact_versions": [],
    }
    plan = {
        "figure_goal": "Show the pathway clearly",
        "visual_plan": "Use a clear left-to-right pathway",
        "generation_prompt": "Draw a clean publication pathway diagram",
    }
    failed_qa = {
        "pass": False,
        "score": 0.44,
        "issues": ["Labels need stronger hierarchy"],
        "repair_prompt": "Improve label hierarchy and legibility",
    }
    passed_qa = {"pass": True, "score": 0.91, "issues": [], "repair_prompt": ""}
    billed = AsyncMock(side_effect=_execute_billed)

    with patch("routers.sci_fig._sci_save_step", new=AsyncMock()), patch(
        "routers.sci_fig._save_state", new=AsyncMock()
    ), patch("routers.sci_fig._plan_sci_figure", new=AsyncMock(return_value=plan)), patch(
        "routers.sci_fig._resolve_plan_choices"
    ), patch("routers.sci_fig.provider_policy.choose_image_model_id", new=AsyncMock(return_value="image-1")), patch(
        "routers.sci_fig.load_original_reference_bytes", new=AsyncMock(return_value=[])
    ), patch("routers.sci_fig.execute_billed_model_call", new=billed
    ), patch(
        "routers.sci_fig.get_task_reservation",
        new=AsyncMock(return_value=SimpleNamespace(user_id="user-1")),
    ), patch("services.ai_client.call_image", new=AsyncMock(side_effect=[b"first", b"repaired"])) as call_image_mock, patch(
        "routers.sci_fig._qa_sci_figure", new=AsyncMock(side_effect=[failed_qa, passed_qa])
    ), patch("routers.sci_fig._store_sci_rendered_asset", new=AsyncMock()) as store_asset, patch(
        "routers.sci_fig._append_artifact_version"
    ) as append_version, patch("routers.sci_fig._save_artifact_message", new=AsyncMock()):
        await _run_ai_generate(state)

    assert call_image_mock.await_count == 2
    assert store_asset.await_count == 2
    assert append_version.call_count == 2
    assert state["status"] == "preview"
    assert state["quality_review"] == {}
    billing_keys = [call.kwargs["idempotency_key"] for call in billed.await_args_list]
    assert len(set(billing_keys)) == 2
    assert all(key.startswith("model:sci-fig:") for key in billing_keys)
    assert all(call.kwargs["expected_category"] == "generate" for call in billed.await_args_list)
    assert all(call.kwargs["related_task_id"] is None for call in billed.await_args_list)
    assert all(
        call.kwargs["reservation_task_id"] == "sci-image2-repair"
        for call in billed.await_args_list
    )


@pytest.mark.asyncio
async def test_image2_repair_does_not_hide_a_post_provider_billing_failure():
    state = {
        "job_id": "sci-image2-settlement-failure",
        "user_id": "user-1",
        "description": "Create a publication-ready signaling pathway figure",
        "category": "flow_diagram",
        "style_preset": "science",
        "chart_params": {},
        "attachment_context": "",
        "reference_assets": [],
        "image_model_id": "image-1",
        "vision_model_id": "vision-1",
        "output_resolution": "1k",
        "image_quality": "auto",
        "agent_steps": [],
        "artifact_versions": [],
    }
    plan = {
        "figure_goal": "Show the pathway clearly",
        "visual_plan": "Use a clear left-to-right pathway",
        "generation_prompt": "Draw a clean publication pathway diagram",
    }
    failed_qa = {
        "pass": False,
        "score": 0.44,
        "issues": ["Labels need stronger hierarchy"],
        "repair_prompt": "Improve label hierarchy and legibility",
    }
    invocation_count = 0

    async def billed_then_fail_settlement(**kwargs):
        nonlocal invocation_count
        invocation_count += 1
        result = await kwargs["invoke"]()
        if invocation_count == 2:
            raise HTTPException(503, "Platform credit settlement is temporarily unavailable")
        return result

    with patch("routers.sci_fig._sci_save_step", new=AsyncMock()), patch(
        "routers.sci_fig._save_state", new=AsyncMock()
    ), patch("routers.sci_fig._plan_sci_figure", new=AsyncMock(return_value=plan)), patch(
        "routers.sci_fig._resolve_plan_choices"
    ), patch(
        "routers.sci_fig.provider_policy.choose_image_model_id",
        new=AsyncMock(return_value="image-1"),
    ), patch(
        "routers.sci_fig.load_original_reference_bytes",
        new=AsyncMock(return_value=[]),
    ), patch(
        "routers.sci_fig.execute_billed_model_call",
        new=AsyncMock(side_effect=billed_then_fail_settlement),
    ), patch(
        "routers.sci_fig.get_task_reservation",
        new=AsyncMock(return_value=SimpleNamespace(user_id="user-1")),
    ), patch(
        "services.ai_client.call_image",
        new=AsyncMock(side_effect=[b"first", b"repaired"]),
    ) as call_image_mock, patch(
        "routers.sci_fig._qa_sci_figure",
        new=AsyncMock(return_value=failed_qa),
    ), patch(
        "routers.sci_fig._store_sci_rendered_asset",
        new=AsyncMock(),
    ), patch(
        "routers.sci_fig._append_artifact_version"
    ), patch(
        "routers.sci_fig._save_artifact_message",
        new=AsyncMock(),
    ):
        await _run_ai_generate(state)

    assert invocation_count == 2
    assert call_image_mock.await_count == 2
    assert state["status"] == "failed"
    assert "settlement" in state["error"]
