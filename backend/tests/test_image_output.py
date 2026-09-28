from unittest.mock import AsyncMock, patch

import pytest

from services.agents.ppt_agent import PPTAgent
from services.image_output import (
    image_output_size,
    normalize_output_resolution,
    resolve_image_output_options,
)


def test_image_output_size_maps_square_widescreen_and_common_print_ratios():
    assert image_output_size("1:1", "4k") == "2880x2880"
    assert image_output_size("16:9", "4k") == "3840x2160"
    assert image_output_size("16:9", "standard") == "1792x1008"
    assert image_output_size("5:4", "2k") == "2000x1600"
    assert image_output_size("4:3", "4k") == "3264x2448"
    assert image_output_size("3:4", "4k") == "2448x3264"


def test_prompt_resolution_and_ratio_override_selected_output_options():
    resolved = resolve_image_output_options(
        prompt="请按 5：4 比例生成，并使用 4K 清晰度",
        requested_size="1024x1024",
        output_resolution="1k",
    )

    assert resolved.aspect_ratio == "5:4"
    assert resolved.output_resolution == "4k"
    assert resolved.size == "3200x2560"


def test_requested_aspect_ratio_is_used_when_prompt_does_not_override():
    resolved = resolve_image_output_options(
        prompt="draw a cat",
        requested_size="1024x1024",
        output_resolution="1k",
        requested_aspect_ratio="16:9",
    )

    assert resolved.aspect_ratio == "16:9"
    assert resolved.size == "1792x1008"


def test_prompt_resolution_keeps_the_selected_aspect_ratio():
    resolved = resolve_image_output_options(
        prompt="保持构图，输出 2k",
        requested_size="1280x1024",
        output_resolution="1k",
    )

    assert resolved.aspect_ratio == "5:4"
    assert resolved.output_resolution == "2k"
    assert resolved.size == "2000x1600"


def test_standard_resolution_is_a_backwards_compatible_alias_for_1k():
    assert normalize_output_resolution("standard") == "1k"
    assert image_output_size("1:1", "standard") == "1024x1024"


@pytest.mark.asyncio
async def test_ppt_agent_persists_preview_output_settings():
    agent = PPTAgent()
    with patch("services.agents.ppt_agent._save_state", new=AsyncMock()):
        state = await agent.start(
            job_id="ppt-output-job",
            topic="Quarterly review",
            output_resolution="4k",
            image_quality="high",
        )

    assert state["output_resolution"] == "4k"
    assert state["image_quality"] == "high"


@pytest.mark.asyncio
async def test_sci_image2_forwards_output_settings_to_image_generation():
    from routers.sci_fig import _run_ai_generate

    state = {
        "job_id": "sci-output-job",
        "user_id": "user-1",
        "description": "A publication-ready mechanism figure",
        "category": "schematic",
        "gen_mode": "image2",
        "style_preset": "nature",
        "output_resolution": "4k",
        "image_quality": "high",
        "attachment_context": "",
        "ref_image_b64": "",
        "image_model_id": "image-model",
        "agent_steps": [],
        "artifact_versions": [],
    }
    plan = {
        "figure_goal": state["description"],
        "visual_plan": "clean mechanism diagram",
        "generation_prompt": state["description"],
    }

    async def execute_sci_call(*, invoke, **_):
        return await invoke()

    with patch("routers.sci_fig._plan_sci_figure", new=AsyncMock(return_value=plan)), patch(
        "routers.sci_fig.provider_policy.choose_image_model_id", new=AsyncMock(return_value="image-model")
    ), patch("routers.sci_fig._save_state", new=AsyncMock()), patch(
        "routers.sci_fig.check_model_call", new=AsyncMock()
    ), patch("routers.sci_fig._execute_sci_model_call", new=AsyncMock(side_effect=execute_sci_call)), patch(
        "services.ai_client.call_image", new=AsyncMock(return_value=b"png")
    ) as call_image_mock, patch("routers.sci_fig._store_sci_rendered_asset", new=AsyncMock()), patch(
        "routers.sci_fig._save_artifact_message", new=AsyncMock()
    ):
        await _run_ai_generate(state)

    call_image_mock.assert_awaited_once_with(
        model_id="image-model",
        prompt=call_image_mock.await_args.kwargs["prompt"],
        ref_images=[],
        size="3264x2448",
        quality="high",
        force_size=True,
    )
