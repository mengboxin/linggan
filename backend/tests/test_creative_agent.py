from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from models.schemas import SubTask
from services.agents.creative_agent import CreativeAgent, CreativeSkillRegistry, DeepPlanRequest, _questions_for
from services.agents.intent_router import IntentRoute


@pytest.mark.asyncio
async def test_deep_creative_agent_returns_visible_plan_without_reasking_explicit_reference_direction():
    route = IntentRoute(
        module="image_edit",
        action="edit",
        input_modalities=["text", "image"],
        desired_artifact="edited_image",
        constraints=[],
        confidence=0.92,
        needs_clarification=False,
        missing_information=[],
        workflow="image_edit",
        intent_summary="把当前狐狸改成图1的低碳角色风格",
    )
    tasks = [
        SubTask(sequence=1, operation="inpaint", target="角色主体"),
        SubTask(sequence=2, operation="inpaint", target="服装细节"),
        SubTask(sequence=3, operation="inpaint", target="光影"),
    ]

    with patch(
        "services.agents.creative_agent.resolve_intent_route",
        new=AsyncMock(return_value=route),
    ), patch(
        "services.agents.creative_agent.plan_node",
        new=AsyncMock(return_value=("plan-1", tasks)),
    ):
        response = await CreativeAgent().plan(DeepPlanRequest(
            instruction="把当前狐狸改成图1的低碳角色风格",
            context={
                "current_module": "image_edit",
                "source_node_id": "node-1",
                "has_current_artifact": True,
                "additional_reference_count": 2,
            },
            has_images=True,
        ))

    assert response.module == "image_edit"
    assert [step["operation"] for step in response.steps] == [
        "inspect_source_artifact",
        "inspect_additional_references",
        "plan_edit_strategy",
        "execute_image_edit",
        "verify_edit_result",
    ]
    assert len({step["operation"] for step in response.steps}) == len(response.steps)
    assert "references.bind" in [skill.id for skill in response.skills]
    assert response.questions == []
    assert response.execution_context["agent_mode"] == "deep"
    assert response.execution_context["source_node_id"] == "node-1"
    assert len(response.execution_context["planner_operations"]) == 3
    assert response.delivery_contract["artifact_type"] == "edited_image"


def test_reference_priority_ignores_the_workflow_source_with_one_extra_reference():
    route = IntentRoute(
        module="image_edit",
        action="edit",
        input_modalities=["text", "image"],
        desired_artifact="edited_image",
        constraints=[],
        confidence=0.92,
        needs_clarification=False,
        missing_information=[],
        workflow="image_edit",
        intent_summary="edit image",
    )
    request = DeepPlanRequest(
        instruction="turn the current icon into a 3d mascot using image 1",
        context={
            "source_node_id": "node-1",
            "has_current_artifact": True,
            "additional_reference_count": 1,
            "reference_count": 1,
            "total_input_image_count": 2,
        },
        has_images=True,
    )

    assert _questions_for(route, request) == []


def test_reference_priority_is_asked_only_for_ambiguous_multiple_references():
    route = IntentRoute(
        module="image_edit",
        action="edit",
        input_modalities=["text", "image"],
        desired_artifact="edited_image",
        constraints=[],
        confidence=0.92,
        needs_clarification=False,
        missing_information=[],
        workflow="image_edit",
        intent_summary="edit image",
    )
    request = DeepPlanRequest(
        instruction="把当前画面改得更高级一些",
        context={
            "source_node_id": "node-1",
            "has_current_artifact": True,
            "additional_reference_count": 2,
        },
        has_images=True,
    )

    assert [question.id for question in _questions_for(route, request)] == ["reference-priority"]


def test_creative_skill_registry_loads_module_scoped_configuration():
    config_payload = """{
          \"skills\": [
            {
              \"id\": \"poster.brand.review\",
              \"modules\": [\"poster\"],
              \"label\": \"Brand review\",
              \"description\": \"Check the approved visual system.\",
              \"executor\": \"specialist\"
            }
          ]
        }"""

    with patch.object(Path, "read_text", return_value=config_payload):
        registry = CreativeSkillRegistry("configured-creative-skills.json")

        assert [skill.id for skill in registry.for_module("poster")] == ["poster.brand.review"]
        assert registry.for_module("image_edit") == []


def test_canvas_flow_contract_requires_runnable_storyboard_graph():
    from services.agents.creative_contract import build_delivery_contract

    contract = build_delivery_contract(
        module="canvas_flow",
        action="create",
        instruction="末世 intern 觉醒系统，当众召雷救人。",
    )

    assert contract.artifact_type == "canvas_flow"
    assert "compile_shot_graph" in contract.execution_strategy
    assert any("无环图" in item for item in contract.acceptance_criteria)
    assert contract.revision_scope == "canvas"


def test_presentation_contract_requires_native_structure_and_visual_asset_planning():
    from services.agents.creative_contract import build_delivery_contract

    contract = build_delivery_contract(
        module="ppt",
        action="create",
        instruction="Create an editable teaching deck with warm illustrations.",
    )

    assert contract.artifact_type == "presentation"
    assert "plan_visual_assets" in contract.execution_strategy
    assert any("原生可编辑" in item for item in contract.acceptance_criteria)


def test_chat_command_router_keeps_a_single_slide_revision_narrow():
    from services.agents.creative_contract import propose_creative_command

    proposal = propose_creative_command(
        module="ppt",
        content="把第 3 页改成更克制的绿色信息图",
        scope={"slide_index": 2},
    )

    assert proposal.kind == "revise_slide"
    assert proposal.requires_confirmation is False
    assert "只修改指定页面" in proposal.assistant_message


def test_chat_command_router_requires_confirmation_for_a_deck_wide_change():
    from services.agents.creative_contract import propose_creative_command

    proposal = propose_creative_command(module="ppt", content="整套 PPT 改成绿色低碳风格")

    assert proposal.kind == "revise_outline"
    assert proposal.requires_confirmation is True
