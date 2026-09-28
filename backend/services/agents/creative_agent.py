"""Reusable deep-planning graph for all creative modules.

The graph deliberately exposes a concise work plan and decision points instead
of a model's private reasoning. Specialist agents remain the execution owners.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any, Literal, TypedDict

from fastapi import HTTPException
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.agents.intent_router import IntentRoute, IntentRouteRequest, resolve_intent_route
from services.agents.nodes.plan import plan_node
from services.agents.creative_contract import build_delivery_contract
from services.ai_client import call_chat_with_images
from services.billing_operation import model_billing_operation_key
from services import provider_policy
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)

SUPPORTED_MODULES = frozenset({"image_edit", "image_generate", "poster", "ppt", "sci_fig", "paper"})
DEFAULT_SKILLS_CONFIG = Path(__file__).resolve().parents[2] / "config" / "creative_skills.json"


class AgentSkill(BaseModel):
    """A declared capability. Configuration cannot carry executable commands."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][a-z0-9_.-]+$")
    modules: list[str] = Field(min_length=1)
    label: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=240)
    executor: Literal["builtin", "specialist"] = "specialist"

    @field_validator("modules")
    @classmethod
    def validate_modules(cls, modules: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(str(module).strip() for module in modules if str(module).strip()))
        unsupported = sorted(set(normalized) - SUPPORTED_MODULES)
        if not normalized or unsupported:
            raise ValueError(f"unsupported skill modules: {', '.join(unsupported) or 'none'}")
        return normalized


class AgentQuestionOption(BaseModel):
    value: str
    label: str


class AgentQuestion(BaseModel):
    id: str
    prompt: str
    options: list[AgentQuestionOption] = Field(default_factory=list)
    allow_custom: bool = True


class DeepPlanRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)
    context: dict[str, Any] = Field(default_factory=dict)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    # Image payloads are transient input for this request. They are decoded by
    # the router and are intentionally never written into an Agent Run.
    image_data_urls: list[str] = Field(default_factory=list, exclude=True, max_length=8)
    image_roles: list[str] = Field(default_factory=list, exclude=True, max_length=8)
    image_bytes: list[bytes] = Field(default_factory=list, exclude=True)
    has_images: bool = False
    llm_model_id: str = ""
    client_request_id: str = ""
    user_id: str = Field(default="", exclude=True)
    workflow_snapshot: dict[str, Any] = Field(default_factory=dict)
    snapshot_fingerprint: str = Field(default="", max_length=128)


class DeepPlanResponse(BaseModel):
    run_id: str = ""
    status: str = "awaiting_confirmation"
    module: str
    action: str
    summary: str
    skills: list[AgentSkill]
    steps: list[dict[str, Any]]
    questions: list[AgentQuestion] = Field(default_factory=list)
    needs_confirmation: bool = True
    execution_context: dict[str, Any] = Field(default_factory=dict)
    delivery_contract: dict[str, Any] = Field(default_factory=dict)
    timeline: list[dict[str, Any]] = Field(default_factory=list)
    snapshot_fingerprint: str = ""


FALLBACK_SKILLS = (
    AgentSkill(
        id="assets.inspect",
        modules=["image_edit", "image_generate", "poster", "ppt", "sci_fig", "paper"],
        label="素材检查",
        description="识别附件、当前作品、尺寸与可复用视觉参考。",
    ),
    AgentSkill(
        id="references.bind",
        modules=["image_edit", "image_generate", "poster", "ppt"],
        label="参考图绑定",
        description="锁定当前图和编号参考图的顺序与作用。",
    ),
    AgentSkill(
        id="documents.extract",
        modules=["poster", "ppt", "sci_fig", "paper"],
        label="文档提炼",
        description="从 PDF、PPT、表格中提炼事实、数据与素材。",
    ),
    AgentSkill(
        id="visual.plan",
        modules=["image_edit", "image_generate", "poster", "ppt", "sci_fig", "paper"],
        label="创作规划",
        description="组织信息层级、视觉方向、尺寸约束与交付标准。",
    ),
    AgentSkill(
        id="quality.verify",
        modules=["image_edit", "image_generate", "poster", "ppt", "sci_fig", "paper"],
        label="结果校验",
        description="核验参考图遵循、文本完整性、尺寸和交付文件。",
    ),
)


class CreativeSkillRegistry:
    """Loads an allowlisted skill catalog that can grow without code changes."""

    def __init__(self, config_path: str | Path | None = None) -> None:
        configured_path = config_path or os.getenv("CREATIVE_SKILLS_CONFIG") or DEFAULT_SKILLS_CONFIG
        self._config_path = Path(configured_path)

    def for_module(self, module: str) -> list[AgentSkill]:
        return [skill for skill in self._load() if module in skill.modules]

    def _load(self) -> list[AgentSkill]:
        try:
            raw = json.loads(self._config_path.read_text(encoding="utf-8"))
            items = raw.get("skills") if isinstance(raw, dict) else raw
            if not isinstance(items, list):
                raise ValueError("skills must be a list")
            skills = [AgentSkill.model_validate(item) for item in items]
            if not skills:
                raise ValueError("skills must not be empty")
            ids = [skill.id for skill in skills]
            if len(ids) != len(set(ids)):
                raise ValueError("skill ids must be unique")
            return skills
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            logger.warning("creative skill config unavailable path=%s error=%s; using built-ins", self._config_path, exc)
            return list(FALLBACK_SKILLS)


class CreativeAgentState(TypedDict, total=False):
    request: DeepPlanRequest
    frozen_workflow: dict[str, Any]
    route: IntentRoute
    skills: list[AgentSkill]
    steps: list[dict[str, Any]]
    raw_steps: list[dict[str, Any]]
    delivery_contract: dict[str, Any]
    material_analysis: dict[str, Any]
    material_roles: dict[str, Any]
    questions: list[AgentQuestion]
    response: DeepPlanResponse


def _skills_for_module(module: str) -> list[AgentSkill]:
    return CreativeSkillRegistry().for_module(module)


def _context_count(context: dict[str, Any], key: str) -> int:
    try:
        return max(0, int(context.get(key) or 0))
    except (TypeError, ValueError):
        return 0


def _additional_reference_count(request: DeepPlanRequest) -> int:
    """Only count user-added references; the workflow source is not a reference."""
    return _context_count(request.context, "additional_reference_count")


def _stage(sequence: int, operation: str, target: str, **params: Any) -> dict[str, Any]:
    return {
        "sequence": sequence,
        "operation": operation,
        "target": target,
        "params": params,
        "status": "pending",
    }


def _module_plan_steps(route: IntentRoute, request: DeepPlanRequest) -> list[dict[str, Any]]:
    """Create a user-facing plan from the routed creative job, not raw tool calls."""
    instruction = " ".join(request.instruction.split())[:180]
    source_locked = bool(request.context.get("source_node_id") or request.context.get("has_current_artifact"))
    additional_references = _additional_reference_count(request)

    if route.module == "image_edit":
        steps = []
        if source_locked:
            steps.append(("inspect_source_artifact", "Analyze the locked source image and preserve the intended subject."))
        if additional_references:
            steps.append(("inspect_additional_references", "Identify what each user-added reference contributes to this edit."))
        steps.extend([
            ("plan_edit_strategy", f"Translate the requested change into one coherent visual direction: {instruction}"),
            ("execute_image_edit", "Create the edited image from the locked source and approved references."),
            ("verify_edit_result", "Check subject continuity, reference adherence, and visual completeness."),
        ])
    elif route.module == "image_generate":
        steps = [
            ("extract_generation_constraints", f"Extract subject, style, composition, and delivery constraints: {instruction}"),
        ]
        if additional_references:
            steps.append(("inspect_additional_references", "Extract reusable style and composition signals from the supplied references."))
        steps.extend([
            ("compose_generation_direction", "Set the visual direction and output constraints before generation."),
            ("generate_image", "Generate the requested image."),
            ("verify_delivery", "Check the result against the requested visual direction and output requirements."),
        ])
    elif route.module == "poster":
        steps = [
            ("extract_poster_brief", f"Extract audience, message hierarchy, and format requirements: {instruction}"),
            ("plan_poster_layout", "Plan information hierarchy, focal point, and visual system."),
            ("create_poster", "Create the poster in the approved direction."),
            ("verify_delivery", "Check copy, layout, readability, and delivery size."),
        ]
    elif route.module == "ppt":
        steps = [
            ("extract_presentation_brief", f"Extract audience, structure, and presentation goal: {instruction}"),
            ("plan_presentation_structure", "Plan slide narrative, page roles, and visual rhythm."),
            ("create_presentation", "Create the presentation from the approved outline."),
            ("verify_delivery", "Check content coverage, consistency, and export readiness."),
        ]
    elif route.module == "paper":
        steps = [
            ("build_evidence_ledger", "Extract traceable facts, data, figures, and source boundaries from the supplied materials."),
            ("confirm_paper_outline", "Propose the paper structure, figure plan, and delivery contract for user confirmation."),
            ("write_manuscript", "Write only evidence-grounded sections after the outline is confirmed."),
            ("typeset_and_verify", "Prepare editable paper source and verify citation traceability and page layout."),
        ]
    else:
        steps = [
            ("extract_scientific_brief", f"Extract data, variables, and figure objective: {instruction}"),
            ("plan_scientific_figure", "Choose a figure structure that makes the intended conclusion legible."),
            ("create_scientific_figure", "Create the scientific figure."),
            ("verify_delivery", "Check data expression, labels, and publication readiness."),
        ]

    return [_stage(index, operation, target, module=route.module) for index, (operation, target) in enumerate(steps, 1)]


def _has_explicit_reference_direction(instruction: str) -> bool:
    normalized = instruction.replace(" ", "").lower()
    return (
        ("图1" in normalized and "图2" in normalized)
        or any(marker in normalized for marker in ("优先", "分别", "主体", "风格", "构图", "配色", "材质"))
    )


def _questions_for(
    route: IntentRoute,
    request: DeepPlanRequest,
    material_analysis: dict[str, Any] | None = None,
) -> list[AgentQuestion]:
    """Ask only for a decision that cannot be inferred from this edit.

    The deterministic router has generic missing-information messages for
    ambiguous requests. Showing those after a source image and a concrete edit
    instruction made the assistant look inattentive, so image edits use
    material-aware questions instead.
    """
    questions: list[AgentQuestion] = []
    source_present = bool(request.context.get("has_current_artifact")) or any(
        str(item.get("role") or "") == "source" for item in request.attachments
    )
    if route.module == "image_edit" and not source_present and not request.has_images:
        questions.append(AgentQuestion(
            id="source-image",
            prompt="这次需要编辑哪一张图片？请先在工作流中选择源图，或上传待编辑图片。",
            allow_custom=False,
        ))
    elif route.module != "image_edit":
        questions.extend(
            AgentQuestion(id=f"missing-{index}", prompt=missing)
            for index, missing in enumerate(route.missing_information)
        )

    additional_reference_count = _additional_reference_count(request)
    answered = request.context.get("clarification_answers")
    answered_values = answered if isinstance(answered, dict) else {}
    if (
        route.module == "image_edit"
        and additional_reference_count > 1
        and not str(answered_values.get("reference-priority") or "").strip()
        and not _has_explicit_reference_direction(request.instruction)
    ):
        questions.append(AgentQuestion(
            id="reference-priority",
            prompt="多张参考图需要优先遵循哪一种信息？",
            options=[
                AgentQuestionOption(value="identity", label="主体与识别特征"),
                AgentQuestionOption(value="style", label="风格、材质与配色"),
                AgentQuestionOption(value="layout", label="构图与版式"),
            ],
        ))
    return questions[:3]


async def _route_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    route = await resolve_intent_route(IntentRouteRequest(
        instruction=request.instruction,
        context=request.context,
        attachments=request.attachments,
        has_images=request.has_images,
        llm_model_id=request.llm_model_id,
        user_id=request.user_id,
    ))
    return {"route": route}


def _freeze_workflow_node(state: CreativeAgentState) -> dict[str, Any]:
    """Freeze only serializable metadata; raw image bytes never enter a Run."""
    request = state["request"]
    snapshot = request.workflow_snapshot if isinstance(request.workflow_snapshot, dict) else {}
    return {
        "frozen_workflow": {
            "snapshot": snapshot,
            "fingerprint": request.snapshot_fingerprint,
            "source_node_id": str(request.context.get("source_node_id") or ""),
        },
    }


def _fallback_material_analysis(request: DeepPlanRequest) -> dict[str, Any]:
    source_count = sum(1 for item in request.attachments if str(item.get("role") or "") == "source")
    additional_count = sum(1 for item in request.attachments if str(item.get("role") or "") == "reference")
    return {
        "summary": "Material roles are ready for planning.",
        "source_count": source_count,
        "additional_reference_count": additional_count,
        "vision_available": False,
    }


def _json_object(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("material analysis did not return JSON")
    value = json.loads(raw[start:end])
    return value if isinstance(value, dict) else {}


async def _analyze_materials_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    fallback = _fallback_material_analysis(request)
    if not request.image_bytes:
        return {"material_analysis": fallback}

    model_id = await provider_policy.choose_llm_model_id(request.llm_model_id or None)
    if not model_id:
        return {"material_analysis": fallback}

    roles = request.image_roles[:len(request.image_bytes)] or [
        str(item.get("role") or "reference") for item in request.attachments[:len(request.image_bytes)]
    ]
    role_lines = [f"Image {index + 1}: {role}" for index, role in enumerate(roles)]
    prompt = (
        "Analyze the supplied image materials for a creative image-editing run. "
        "Do not reveal private reasoning. Return JSON only with: "
        "summary, source_observations, reference_observations, possible_conflicts, missing_information.\n"
        "Image roles:\n"
        + "\n".join(role_lines)
        + f"\nUser request:\n{request.instruction}"
    )
    try:
        async def invoke() -> str:
            return await call_chat_with_images(
                model_id=model_id,
                system="You are a precise visual art director. Describe visible material facts and actionable constraints only.",
                user=prompt,
                images=request.image_bytes[:8],
                max_tokens=900,
                temperature=0.1,
            )

        operation_scope = request.client_request_id or next((
            str(request.context.get(key) or "").strip()
            for key in ("client_request_id", "request_id", "agent_run_id", "task_id", "turn_id", "message_id")
            if str(request.context.get(key) or "").strip()
        ), "")
        raw = (
            await execute_billed_model_call(
                user_id=request.user_id,
                model_id=model_id,
                expected_category="llm",
                description="Agent visual material analysis",
                idempotency_key=model_billing_operation_key(
                    namespace="agent-material-analysis",
                    user_id=request.user_id,
                    operation_scope=operation_scope,
                    material={
                        "model_id": model_id,
                        "instruction": request.instruction,
                        "context": request.context,
                        "attachments": request.attachments,
                        "image_roles": roles,
                        "images": request.image_bytes[:8],
                    },
                ),
                invoke=invoke,
            )
            if request.user_id
            else await invoke()
        )
        analysis = _json_object(raw)
        analysis["vision_available"] = True
        analysis["source_count"] = fallback["source_count"]
        analysis["additional_reference_count"] = fallback["additional_reference_count"]
        return {"material_analysis": analysis}
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("creative material analysis unavailable, using role metadata: %s", exc)
        return {"material_analysis": fallback}


def _identify_material_roles_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    source = next((item for item in request.attachments if str(item.get("role") or "") == "source"), None)
    references = [
        item for item in request.attachments
        if str(item.get("role") or "") == "reference"
    ]
    return {
        "material_roles": {
            "source": source or {},
            "additional_references": references,
            "target": request.instruction[:240],
        },
    }


def _assess_information_node(state: CreativeAgentState) -> dict[str, Any]:
    return {
        "questions": _questions_for(
            state["route"],
            state["request"],
            state.get("material_analysis"),
        ),
    }


def _planning_branch(state: CreativeAgentState) -> str:
    return "clarify" if state.get("questions") else "select_skills"


def _skills_node(state: CreativeAgentState) -> dict[str, Any]:
    return {"skills": _skills_for_module(state["route"].module)}


async def _plan_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    route = state["route"]
    context = {
        **request.context,
        "attachments": request.attachments,
        "intent_route": route.model_dump(),
        "skills": [skill.id for skill in state["skills"]],
        "llm_model_id": request.llm_model_id,
        "material_analysis": state.get("material_analysis", {}),
        "material_roles": state.get("material_roles", {}),
    }
    raw_steps: list[dict[str, Any]] = []
    try:
        _, sub_tasks = await plan_node(
            request.instruction,
            context,
            user_id=request.user_id,
        )
        raw_steps = [task.model_dump() for task in sub_tasks]
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("creative deep planner using routed fallback module=%s error=%s", route.module, exc)
    return {
        "steps": _module_plan_steps(route, request),
        "raw_steps": raw_steps,
    }


def _contract_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    route = state["route"]
    contract = build_delivery_contract(
        module=route.module,
        action=route.action,
        instruction=request.instruction,
        context=request.context,
    )
    return {"delivery_contract": contract.model_dump()}


def _clarify_node(state: CreativeAgentState) -> dict[str, Any]:
    request = state["request"]
    route = state["route"]
    questions = state.get("questions", [])
    summary = route.intent_summary or request.instruction[:180]
    execution_context = {
        "agent_mode": "deep",
        "route": route.model_dump(),
        "skills": [skill.id for skill in state.get("skills", [])],
        "source_node_id": str(request.context.get("source_node_id") or ""),
        "has_current_artifact": bool(request.context.get("has_current_artifact")),
        "additional_reference_count": _additional_reference_count(request),
        "reference_count": _additional_reference_count(request),
        "planner_operations": state.get("raw_steps", []),
        "material_analysis": state.get("material_analysis", {}),
        "material_roles": state.get("material_roles", {}),
        "snapshot_fingerprint": request.snapshot_fingerprint,
        "workflow_snapshot": request.workflow_snapshot,
        "delivery_contract": state.get("delivery_contract", {}),
    }
    return {
        "questions": questions,
        "response": DeepPlanResponse(
            module=route.module,
            action=route.action,
            summary=summary,
            skills=state.get("skills", []),
            # A clarification response still explains the next high-level
            # stages, but deliberately avoids pretending that an unconfirmed
            # detail has already been planned.
            steps=state.get("steps") or _module_plan_steps(route, request),
            questions=questions,
            execution_context=execution_context,
            delivery_contract=state.get("delivery_contract", {}),
            snapshot_fingerprint=request.snapshot_fingerprint,
        ),
    }


class CreativeAgent:
    """LangGraph entry point shared by all specialist creative agents."""

    def __init__(self) -> None:
        graph = StateGraph(CreativeAgentState)
        graph.add_node("freeze_workflow", _freeze_workflow_node)
        graph.add_node("route", _route_node)
        graph.add_node("analyze_materials", _analyze_materials_node)
        graph.add_node("identify_material_roles", _identify_material_roles_node)
        graph.add_node("assess_information", _assess_information_node)
        graph.add_node("select_skills", _skills_node)
        graph.add_node("plan", _plan_node)
        graph.add_node("contract", _contract_node)
        graph.add_node("clarify", _clarify_node)
        graph.add_edge(START, "freeze_workflow")
        graph.add_edge("freeze_workflow", "route")
        graph.add_edge("route", "analyze_materials")
        graph.add_edge("analyze_materials", "identify_material_roles")
        graph.add_edge("identify_material_roles", "contract")
        graph.add_edge("contract", "assess_information")
        graph.add_conditional_edges(
            "assess_information",
            _planning_branch,
            {"clarify": "clarify", "select_skills": "select_skills"},
        )
        graph.add_edge("select_skills", "plan")
        graph.add_edge("plan", "clarify")
        graph.add_edge("clarify", END)
        self._graph = graph.compile()

    async def plan(self, request: DeepPlanRequest) -> DeepPlanResponse:
        state = await self._graph.ainvoke({"request": request})
        return state["response"]


def decode_image_data_urls(values: list[str]) -> list[bytes]:
    """Decode bounded browser data URLs for temporary visual analysis only."""
    images: list[bytes] = []
    for value in values[:8]:
        raw = str(value or "").strip()
        if not raw:
            continue
        encoded = raw.split(",", 1)[1] if raw.startswith("data:") and "," in raw else raw
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            continue
        if 0 < len(decoded) <= 10 * 1024 * 1024:
            images.append(decoded)
    return images
