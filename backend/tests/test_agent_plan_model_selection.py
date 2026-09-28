from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_plan_node_uses_configured_llm_model(monkeypatch):
    from services.agents.nodes import plan

    choose_model = AsyncMock(return_value="llm-current")
    call_model = AsyncMock(return_value='{"tasks":[{"operation":"edit","target":"slide"}]}')
    monkeypatch.setattr(plan.provider_policy, "choose_llm_model_id", choose_model)
    monkeypatch.setattr(plan, "call_chat_messages", call_model)

    _, tasks = await plan.plan_node("修改第二页", {"llm_model_id": "llm-requested"})

    choose_model.assert_awaited_once_with("llm-requested")
    assert call_model.await_args.kwargs["model_id"] == "llm-current"
    assert tasks[0].operation == "edit"


@pytest.mark.asyncio
async def test_plan_node_requires_an_enabled_llm_model(monkeypatch):
    from services.agents.nodes import plan

    monkeypatch.setattr(
        plan.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value=""),
    )

    with pytest.raises(ValueError, match="llm 类型模型"):
        await plan.plan_node("制作一张海报")


def test_plan_parser_handles_closing_brace_inside_task_text():
    from services.agents.nodes.plan import _parse_plan_response

    tasks = _parse_plan_response(
        '{"tasks":[{"sequence":1,"operation":"replace_text","target":"把 } 改为 ]","params":{}}]}'
    )

    assert tasks[0].target == "把 } 改为 ]"
