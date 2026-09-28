from unittest.mock import AsyncMock

import pytest


def test_routes_poster_creation_with_document_materials():
    from services.agents.intent_router import IntentRouteRequest, route_intent_deterministic

    route = route_intent_deterministic(IntentRouteRequest(
        instruction="根据这份 PDF 做三张 A3 绿色低碳海报",
        attachments=[{"filename": "brief.pdf", "kind": "pdf"}],
    ))

    assert route.module == "poster"
    assert route.action == "create"
    assert route.workflow == "poster_create"
    assert "document" in route.input_modalities
    assert any("A3" in item for item in route.constraints)
    assert route.needs_clarification is False


def test_routes_contextual_ppt_slide_edit():
    from services.agents.intent_router import IntentRouteRequest, route_intent_deterministic

    route = route_intent_deterministic(IntentRouteRequest(
        instruction="把第二页改成最新季度数据，保持原来的版式",
        context={"current_module": "ppt", "has_current_artifact": True},
        attachments=[{"filename": "q2.csv", "kind": "csv"}],
    ))

    assert route.module == "ppt"
    assert route.action == "edit"
    assert route.workflow == "ppt_slide_edit"
    assert "data" in route.input_modalities
    assert route.confidence >= 0.7


def test_routes_scientific_chart_from_data_attachment():
    from services.agents.intent_router import IntentRouteRequest, route_intent_deterministic

    route = route_intent_deterministic(IntentRouteRequest(
        instruction="用这组实验数据画一张带误差线的对比柱状图",
        attachments=[{"filename": "experiment.xlsx", "kind": "xlsx"}],
    ))

    assert route.module == "sci_fig"
    assert route.action == "create"
    assert route.workflow == "sci_fig_create"
    assert route.desired_artifact == "scientific_figure"


def test_routes_mandrama_topic_to_canvas_flow():
    from services.agents.intent_router import IntentRouteRequest, route_intent_deterministic

    route = route_intent_deterministic(IntentRouteRequest(
        instruction="根据这个题材做一部漫剧，自动写分镜并铺到自由画布",
    ))

    assert route.module == "canvas_flow"
    assert route.action == "create"
    assert route.workflow == "canvas_flow_direct"
    assert route.desired_artifact == "canvas_flow"


def test_ambiguous_request_asks_for_clarification():
    from services.agents.intent_router import IntentRouteRequest, route_intent_deterministic

    route = route_intent_deterministic(IntentRouteRequest(instruction="帮我优化一下"))

    assert route.module == "unknown"
    assert route.needs_clarification is True
    assert route.missing_information


@pytest.mark.asyncio
async def test_low_confidence_route_can_use_model_fallback(monkeypatch):
    from services.agents import intent_router

    monkeypatch.setattr(
        intent_router.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-router"),
    )
    monkeypatch.setattr(
        intent_router,
        "call_chat",
        AsyncMock(return_value='''{
          "module": "poster",
          "action": "edit",
          "desired_artifact": "poster",
          "intent_summary": "继续修改当前宣传海报",
          "constraints": ["保持品牌色"],
          "missing_information": [],
          "confidence": 0.91
        }'''),
    )

    route = await intent_router.resolve_intent_route(intent_router.IntentRouteRequest(
        instruction="这个再高级一点",
        context={"has_current_artifact": True},
        allow_model_fallback=True,
    ))

    assert route.module == "poster"
    assert route.action == "edit"
    assert route.source == "model"
    assert route.model_id == "llm-router"


@pytest.mark.asyncio
async def test_agent_plan_receives_typed_route_context(monkeypatch):
    from models.schemas import AgentPlanRequest, SubTask
    from routers import agent

    plan_node = AsyncMock(return_value=(
        "plan-1",
        [SubTask(sequence=1, operation="ppt_slide_edit", target="slide 2")],
    ))
    monkeypatch.setattr(agent, "rate_limit", AsyncMock())
    monkeypatch.setattr(agent, "plan_node", plan_node)
    agent._plans.clear()

    result = await agent.create_plan(
        AgentPlanRequest(
            instruction="把第二页换成新的季度数据",
            context={"current_module": "ppt", "has_current_artifact": True},
        ),
        {"id": "user-1"},
    )

    assert result.routing["module"] == "ppt"
    assert result.routing["workflow"] == "ppt_slide_edit"
    assert plan_node.await_args.kwargs["context"]["intent_route"]["module"] == "ppt"
