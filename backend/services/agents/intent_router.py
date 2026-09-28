"""Typed intent routing for user-facing generation workflows."""
from __future__ import annotations

import json
import re
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from services import provider_policy
from services.ai_client import call_chat
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call


AgentModule = Literal[
    "image_generate",
    "image_edit",
    "poster",
    "ppt",
    "sci_fig",
    "paper",
    "canvas_flow",
    "unknown",
]
AgentAction = Literal["create", "edit", "analyze", "convert", "export", "continue", "unknown"]


class IntentRouteRequest(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=4000)
    context: dict[str, Any] = Field(default_factory=dict)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    has_images: bool = False
    allow_model_fallback: bool = True
    llm_model_id: str = ""
    client_request_id: str = ""
    user_id: str = Field(default="", exclude=True)


class IntentRoute(BaseModel):
    module: AgentModule
    action: AgentAction
    input_modalities: list[str] = Field(default_factory=list)
    desired_artifact: str = ""
    constraints: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    needs_clarification: bool = False
    missing_information: list[str] = Field(default_factory=list)
    workflow: str = ""
    intent_summary: str = ""
    routing_signals: list[str] = Field(default_factory=list)
    source: Literal["deterministic", "model"] = "deterministic"
    model_id: str = ""


MODULE_KEYWORDS: dict[AgentModule, tuple[tuple[str, int], ...]] = {
    "poster": (
        ("海报", 8), ("宣传海报", 8), ("poster", 8), ("宣传图", 6),
        ("a3", 3), ("展板", 5), ("招贴", 6),
    ),
    "ppt": (
        ("ppt", 9), ("pptx", 9), ("幻灯片", 8), ("演示文稿", 8),
        ("slide", 7), ("deck", 7), ("演示", 4), ("第几页", 2),
    ),
    "paper": (
        ("科研论文", 10), ("论文写作", 9), ("论文", 5), ("research paper", 10),
        ("manuscript", 9), ("journal article", 8), ("文献综述", 7),
    ),
    "sci_fig": (
        ("科研图", 9), ("科学绘图", 9), ("图表", 7), ("柱状图", 8),
        ("折线图", 8), ("散点图", 8), ("误差线", 7), ("机制图", 7),
        ("流程图", 6), ("架构图", 6), ("chart", 7), ("plot", 7),
        ("scientific figure", 9), ("实验数据", 4),
    ),
    "image_edit": (
        ("修图", 8), ("修改图片", 8), ("编辑图片", 8), ("局部重绘", 8),
        ("抠图", 8), ("去背景", 7), ("删除背景", 7), ("换背景", 7),
        ("替换图中", 6), ("图层", 5), ("inpaint", 8), ("image edit", 8),
    ),
    "image_generate": (
        ("生成图片", 8), ("生成一张图", 8), ("画一张", 7), ("生图", 8),
        ("文生图", 9), ("illustration", 5), ("image generation", 8),
        ("封面图", 5), ("插画", 5),
    ),
    "canvas_flow": (
        ("漫剧", 10), ("短剧", 9), ("分镜", 8), ("九宫格", 9),
        ("storyboard", 8), ("comic drama", 8), ("自由画布", 7),
        ("画布流", 8), ("剧本转视频", 8),
    ),
    "unknown": (),
}

ACTION_KEYWORDS: dict[AgentAction, tuple[str, ...]] = {
    "edit": ("修改", "调整", "优化", "精修", "改成", "换成", "替换", "删除", "增加", "继续编辑", "再高级", "再改"),
    "analyze": ("分析", "识别", "提取", "总结", "读取", "看看"),
    "convert": ("转换", "导入", "转成", "上传现有", "解析现有"),
    "export": ("导出", "下载", "保存为"),
    "continue": ("继续", "接着", "沿用", "基于上一版"),
    "create": ("生成", "制作", "创建", "做一", "画一", "新建"),
    "unknown": (),
}

WORKFLOWS: dict[tuple[AgentModule, AgentAction], str] = {
    ("poster", "create"): "poster_create",
    ("poster", "edit"): "poster_refine",
    ("poster", "continue"): "poster_refine",
    ("ppt", "create"): "ppt_create",
    ("ppt", "edit"): "ppt_slide_edit",
    ("ppt", "continue"): "ppt_slide_edit",
    ("ppt", "convert"): "ppt_import",
    ("ppt", "export"): "ppt_export",
    ("paper", "create"): "paper_create",
    ("paper", "edit"): "paper_revise",
    ("paper", "continue"): "paper_continue",
    ("paper", "export"): "paper_export",
    ("sci_fig", "create"): "sci_fig_create",
    ("sci_fig", "edit"): "sci_fig_refine",
    ("sci_fig", "continue"): "sci_fig_refine",
    ("image_generate", "create"): "image_generate",
    ("image_generate", "continue"): "image_generate",
    ("image_edit", "edit"): "image_edit",
    ("image_edit", "continue"): "image_edit",
    ("image_edit", "analyze"): "image_analyze",
    ("canvas_flow", "create"): "canvas_flow_direct",
    ("canvas_flow", "continue"): "canvas_flow_direct",
    ("canvas_flow", "edit"): "canvas_flow_revise",
}

ARTIFACTS: dict[AgentModule, str] = {
    "poster": "poster",
    "ppt": "presentation",
    "paper": "research_paper",
    "sci_fig": "scientific_figure",
    "image_generate": "image",
    "image_edit": "edited_image",
    "canvas_flow": "canvas_flow",
    "unknown": "",
}

MODEL_ROUTE_SYSTEM = """You route creative-production requests to one workflow.
Return JSON only with: module, action, desired_artifact, intent_summary, constraints, missing_information, confidence.
Allowed modules: image_generate, image_edit, poster, ppt, sci_fig, paper, canvas_flow, unknown.
Allowed actions: create, edit, analyze, convert, export, continue, unknown.
Use conversation context and attachment metadata. Do not invent unavailable files or current artifacts.
Do not include hidden reasoning or chain-of-thought."""


def _normalize_module(value: object) -> AgentModule:
    normalized = str(value or "").strip().lower().replace("-", "_")
    aliases = {
        "image": "image_generate",
        "generate": "image_generate",
        "image_generation": "image_generate",
        "edit": "image_edit",
        "scientific_figure": "sci_fig",
        "scifig": "sci_fig",
        "presentation": "ppt",
        "canvas": "canvas_flow",
        "drama": "canvas_flow",
        "mandrama": "canvas_flow",
    }
    normalized = aliases.get(normalized, normalized)
    return normalized if normalized in ARTIFACTS else "unknown"  # type: ignore[return-value]


def _normalize_action(value: object) -> AgentAction:
    normalized = str(value or "").strip().lower().replace("-", "_")
    aliases = {"generate": "create", "refine": "edit", "update": "edit", "import": "convert"}
    normalized = aliases.get(normalized, normalized)
    allowed = {"create", "edit", "analyze", "convert", "export", "continue", "unknown"}
    return normalized if normalized in allowed else "unknown"  # type: ignore[return-value]


def _attachment_modalities(attachments: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    modalities: set[str] = set()
    signals: list[str] = []
    for item in attachments:
        filename = str(item.get("filename") or "").strip()
        kind = str(item.get("kind") or "").strip().lower()
        suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else kind
        if suffix in {"csv", "xlsx", "xls", "json"} or kind in {"csv", "xlsx", "xls", "json"}:
            modalities.add("data")
        elif suffix in {"pdf", "doc", "docx", "ppt", "pptx", "txt", "md"}:
            modalities.add("document")
        else:
            modalities.add("file")
        if filename:
            signals.append(f"attachment:{filename}")
    return sorted(modalities), signals


def _extract_constraints(instruction: str) -> list[str]:
    constraints: list[str] = []
    patterns = (
        r"\bA[0-5]\b",
        r"\b\d+\s*[:：]\s*\d+\b",
        r"\b\d+\s*页\b",
        r"\b(?:PNG|JPG|JPEG|SVG|PDF|PPTX)\b",
    )
    for pattern in patterns:
        for match in re.findall(pattern, instruction, flags=re.IGNORECASE):
            value = str(match).strip()
            if value and value not in constraints:
                constraints.append(value)
    for clause in re.split(r"[，。；;\n]", instruction):
        cleaned = clause.strip()
        if 2 <= len(cleaned) <= 48 and any(marker in cleaned for marker in ("保持", "不要", "必须", "沿用", "不能", "只改")):
            if cleaned not in constraints:
                constraints.append(cleaned)
    return constraints[:8]


def _detect_action(text: str) -> AgentAction:
    for action in ("edit", "analyze", "convert", "export", "continue", "create"):
        if any(keyword in text for keyword in ACTION_KEYWORDS[action]):
            return action  # type: ignore[return-value]
    return "unknown"


def route_intent_deterministic(request: IntentRouteRequest) -> IntentRoute:
    instruction = request.instruction.strip()
    text = instruction.casefold()
    action = _detect_action(text)
    scores: dict[AgentModule, int] = {module: 0 for module in ARTIFACTS}
    signals: list[str] = []

    for module, rules in MODULE_KEYWORDS.items():
        for keyword, weight in rules:
            if keyword.casefold() in text:
                scores[module] += weight
                signals.append(f"keyword:{keyword}")

    context_module = _normalize_module(request.context.get("current_module"))
    has_current_artifact = bool(request.context.get("has_current_artifact"))
    if context_module != "unknown":
        scores[context_module] += 7
        signals.append(f"context:{context_module}")

    modalities, attachment_signals = _attachment_modalities(request.attachments)
    signals.extend(attachment_signals)
    attachment_kinds = {
        str(item.get("kind") or item.get("filename") or "").lower()
        for item in request.attachments
    }
    if any("ppt" in value for value in attachment_kinds):
        scores["ppt"] += 4
    if "data" in modalities:
        scores["sci_fig"] += 3
    if request.has_images:
        modalities.append("image")
        signals.append("input:image")
        if action in {"edit", "continue", "analyze"}:
            scores["image_edit"] += 5
    if instruction:
        modalities.insert(0, "text")
    modalities = list(dict.fromkeys(modalities))

    ranked = sorted(
        ((module, score) for module, score in scores.items() if module != "unknown"),
        key=lambda item: item[1],
        reverse=True,
    )
    module, top_score = ranked[0] if ranked else ("unknown", 0)
    second_score = ranked[1][1] if len(ranked) > 1 else 0
    if top_score <= 0:
        module = "unknown"

    if action == "unknown" and module != "unknown":
        action = "edit" if has_current_artifact else "create"
    if action == "continue" and not has_current_artifact and context_module == "unknown":
        action = "unknown"
    if module == "image_generate" and action == "edit":
        module = "image_edit"
    if module == "image_edit" and action == "create":
        module = "image_generate"

    margin = max(0, top_score - second_score)
    confidence = 0.25 if module == "unknown" else min(0.98, 0.46 + top_score * 0.045 + margin * 0.025)
    missing: list[str] = []
    if module == "unknown":
        missing.append("需要确认要生成或编辑的产物类型")
    if action == "unknown":
        missing.append("需要确认本次是新建、继续编辑还是导出")
    if module == "image_edit" and not request.has_images and not has_current_artifact:
        missing.append("需要提供待编辑图片或当前图片任务")
    if action in {"edit", "continue"} and not has_current_artifact and context_module == "unknown" and not request.has_images:
        missing.append("需要确认要继续编辑的历史任务")

    workflow = WORKFLOWS.get((module, action), "clarify_intent" if missing else f"{module}_{action}")
    return IntentRoute(
        module=module,
        action=action,
        input_modalities=modalities,
        desired_artifact=ARTIFACTS[module],
        constraints=_extract_constraints(instruction),
        confidence=round(confidence, 3),
        needs_clarification=bool(missing) or confidence < 0.56,
        missing_information=list(dict.fromkeys(missing)),
        workflow=workflow,
        intent_summary=instruction[:160],
        routing_signals=signals[:12],
    )


def _json_object(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("router model did not return JSON")
    data = json.loads(raw[start:end])
    if not isinstance(data, dict):
        raise ValueError("router model returned a non-object")
    return data


async def resolve_intent_route(request: IntentRouteRequest) -> IntentRoute:
    base = route_intent_deterministic(request)
    if not request.allow_model_fallback or (base.confidence >= 0.72 and not base.needs_clarification):
        return base

    model_id = await provider_policy.choose_llm_model_id(request.llm_model_id or None)
    if not model_id:
        return base

    attachment_summary = [
        {
            "filename": str(item.get("filename") or "")[:160],
            "kind": str(item.get("kind") or "")[:40],
            "text_excerpt": str(item.get("text") or "")[:800],
        }
        for item in request.attachments[:8]
    ]
    user_payload = {
        "instruction": request.instruction,
        "context": request.context,
        "has_images": request.has_images,
        "attachments": attachment_summary,
        "deterministic_route": base.model_dump(),
    }
    try:
        async def invoke() -> str:
            return await call_chat(
                model_id=model_id,
                system=MODEL_ROUTE_SYSTEM,
                user=json.dumps(user_payload, ensure_ascii=False),
                max_tokens=700,
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
                description="Agent intent routing",
                idempotency_key=model_billing_operation_key(
                    namespace="agent-intent-route",
                    user_id=request.user_id,
                    operation_scope=operation_scope,
                    material={
                        "model_id": model_id,
                        "instruction": request.instruction,
                        "context": request.context,
                        "attachments": request.attachments,
                        "has_images": request.has_images,
                    },
                ),
                invoke=invoke,
            )
            if request.user_id
            else await invoke()
        )
        data = _json_object(raw)
        module = _normalize_module(data.get("module"))
        action = _normalize_action(data.get("action"))
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.7))))
        constraints = [str(item).strip() for item in data.get("constraints", []) if str(item).strip()]
        missing = [str(item).strip() for item in data.get("missing_information", []) if str(item).strip()]
        if module == "unknown":
            return base
        if action == "unknown":
            action = base.action
        workflow = WORKFLOWS.get((module, action), f"{module}_{action}")
        return IntentRoute(
            module=module,
            action=action,
            input_modalities=base.input_modalities,
            desired_artifact=str(data.get("desired_artifact") or ARTIFACTS[module]),
            constraints=list(dict.fromkeys([*base.constraints, *constraints]))[:10],
            confidence=round(confidence, 3),
            needs_clarification=bool(missing) or confidence < 0.56,
            missing_information=missing,
            workflow=workflow,
            intent_summary=str(data.get("intent_summary") or request.instruction)[:200],
            routing_signals=[*base.routing_signals, "classifier:model"][:12],
            source="model",
            model_id=model_id,
        )
    except HTTPException:
        raise
    except Exception:
        return base
