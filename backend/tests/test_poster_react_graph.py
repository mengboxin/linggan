import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from routers.poster import _run_poster_variant_react


async def _execute_billed(**kwargs):
    return await kwargs["invoke"]()


@pytest.mark.asyncio
async def test_poster_variant_react_automatically_repairs_once_before_requesting_user_confirmation():
    state = {
        "job_id": "poster-react-task",
        "user_id": "user-1",
        "description": "为低碳空气净化机器人制作 A3 海报",
        "size": "a3_portrait",
        "output_resolution": "1k",
        "image_quality": "auto",
        "posters": [],
        "agent_steps": [],
    }
    plan = {"source_findings": [], "reference_style": {}, "posters": []}
    poster_plan = {
        "title": "主动净化",
        "content_focus": "主动巡航净化",
        "layout_archetype": "scenario map",
        "visual_plan": "路径和场景面板",
        "generation_prompt": "绿色低碳 A3 信息海报",
    }
    review = {
        "pass": False,
        "score": 0.48,
        "issues": ["主体层级不够清晰"],
        "repair_prompt": "突出机器人主体，减少背景装饰并增强标题层级",
    }
    billed = AsyncMock(side_effect=_execute_billed)

    with patch("routers.poster._save_state", new=AsyncMock()), patch(
        "routers.poster.execute_billed_model_call", new=billed
    ), patch(
        "routers.poster.get_task_reservation",
        new=AsyncMock(return_value=SimpleNamespace(user_id="user-1")),
    ), patch(
        "routers.poster.call_image", new=AsyncMock(return_value=b"first-poster")
    ) as generate_mock, patch(
        "routers.poster.call_vision", new=AsyncMock(return_value=json.dumps(review, ensure_ascii=False))
    ) as review_mock:
        result = await _run_poster_variant_react(
            state=state,
            plan=plan,
            poster_plan=poster_plan,
            poster_index=0,
            poster_count=1,
            model_id="image-model",
            review_model_id="vision-model",
            ref_images=[],
            state_lock=None,
        )

    assert result["candidate_image"] == b"first-poster"
    assert result["outcome"] == "awaiting_user"
    assert result["quality_review"]["repair_prompt"] == "突出机器人主体，减少背景装饰并增强标题层级"
    assert generate_mock.await_count == 2
    assert review_mock.await_count == 2
    assert [call.kwargs["expected_category"] for call in billed.await_args_list] == [
        "generate", "vision", "generate", "vision",
    ]
    billing_keys = [call.kwargs["idempotency_key"] for call in billed.await_args_list]
    assert len(set(billing_keys)) == 4
    assert all(key.startswith("model:poster:") for key in billing_keys)
    assert all(call.kwargs["related_task_id"] is None for call in billed.await_args_list)
    assert all(
        call.kwargs["reservation_task_id"] == "poster-react-task"
        for call in billed.await_args_list
    )
