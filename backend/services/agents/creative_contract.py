"""Shared delivery contracts for top-level creative agents.

The contract is intentionally declarative.  It tells a specialist sub-agent
what has to be delivered and how success is checked without giving a model
unbounded execution authority.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CreativeCheckpoint(BaseModel):
    id: str
    label: str
    required: bool = True
    reason: str = ""


class CreativeDeliveryContract(BaseModel):
    artifact_type: str
    summary: str
    execution_strategy: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    checkpoints: list[CreativeCheckpoint] = Field(default_factory=list)
    revision_scope: str = "artifact"


class CreativeCommandProposal(BaseModel):
    """A safe, user-visible interpretation of a module chat message."""

    kind: str
    assistant_message: str
    requires_confirmation: bool = False
    scope: dict[str, Any] = Field(default_factory=dict)
    questions: list[str] = Field(default_factory=list)


def propose_creative_command(
    *,
    module: str,
    content: str,
    scope: dict[str, Any] | None = None,
) -> CreativeCommandProposal:
    """Map chat language to an allowlisted specialist action.

    This intentionally does not execute work.  A specialist owns execution
    after its screen has confirmed the proposal and supplied module-specific
    identifiers such as slide or poster indexes.
    """
    text = " ".join(str(content or "").split())
    normalized = text.lower().replace(" ", "")
    requested_scope = dict(scope or {})
    if any(token in normalized for token in ("继续", "恢复", "重试", "再试", "resume", "retry")):
        return CreativeCommandProposal(
            kind="continue_paused_run",
            assistant_message="我会保留已完成内容，只继续尚未完成的步骤。",
            scope=requested_scope,
        )
    if any(token in normalized for token in ("导出", "下载", "export", "download")):
        return CreativeCommandProposal(
            kind="export",
            assistant_message="我会使用当前已确认的版本准备导出。",
            scope=requested_scope,
        )
    if module == "ppt":
        has_slide_scope = bool(requested_scope.get("slide_id") or requested_scope.get("slide_index"))
        if has_slide_scope:
            return CreativeCommandProposal(
                kind="revise_slide",
                assistant_message="我会只修改指定页面，其他页面保持不变。",
                scope=requested_scope,
            )
        return CreativeCommandProposal(
            kind="revise_outline",
            assistant_message="这项修改会影响多页结构。我会先给出变更范围，确认后再重建受影响页面。",
            requires_confirmation=True,
            scope=requested_scope,
        )
    if module == "poster":
        return CreativeCommandProposal(
            kind="revise_poster",
            assistant_message="我会保留系列编号和已确认内容，只调整你指定的海报方向。",
            scope=requested_scope,
        )
    if module == "paper":
        return CreativeCommandProposal(
            kind="revise_paper_outline",
            assistant_message="我会先标出将受影响的章节、图表和资料来源，确认后只重写相关内容并保留当前版本。",
            requires_confirmation=True,
            scope=requested_scope,
        )
    if module == "sci_fig":
        return CreativeCommandProposal(
            kind="revise_figure",
            assistant_message="我会保持数据结论可追溯，只修改图形结构、视觉编码或标注。",
            scope=requested_scope,
        )
    if module == "canvas_flow":
        return CreativeCommandProposal(
            kind="revise_canvas_flow",
            assistant_message="我会按新的题材或分镜要求重新设计画布流，已生成的结果先保留。",
            requires_confirmation=True,
            scope=requested_scope,
        )
    if module == "image_edit":
        return CreativeCommandProposal(
            kind="revise_image",
            assistant_message="我会沿用已绑定的源图和参考图角色，按这条修改要求生成新版本。",
            scope=requested_scope,
        )
    return CreativeCommandProposal(
        kind="revise_image",
        assistant_message="我会按这条要求生成一个新版本，并保留当前结果可回退。",
        scope=requested_scope,
    )


def build_delivery_contract(
    *,
    module: str,
    action: str,
    instruction: str,
    context: dict[str, Any] | None = None,
) -> CreativeDeliveryContract:
    """Build a module-owned contract before handing work to a sub-agent."""
    context = context or {}
    brief = " ".join(str(instruction or "").split())[:220]
    if module == "image_edit":
        return CreativeDeliveryContract(
            artifact_type="edited_image",
            summary=f"基于已选源图完成编辑：{brief}",
            execution_strategy=["inspect_source", "bind_references", "compile_edit_direction", "generate", "visual_review"],
            acceptance_criteria=["目标修改清晰可见", "源图与参考图角色被正确遵循", "成图完整可用"],
            checkpoints=[CreativeCheckpoint(id="plan", label="确认编辑方向", required=True)],
            revision_scope="image",
        )
    if module == "image_generate":
        return CreativeDeliveryContract(
            artifact_type="generated_image",
            summary=f"围绕需求生成图片：{brief}",
            execution_strategy=["extract_constraints", "bind_references", "compile_visual_brief", "generate", "visual_review"],
            acceptance_criteria=["主体与构图符合需求", "参考图仅按声明角色使用", "输出满足尺寸与格式要求"],
            checkpoints=[CreativeCheckpoint(id="plan", label="确认创作方向", required=True)],
            revision_scope="image",
        )
    if module == "poster":
        return CreativeDeliveryContract(
            artifact_type="poster_series",
            summary=f"围绕需求创作海报或系列海报：{brief}",
            execution_strategy=["extract_facts", "plan_message_hierarchy", "plan_series", "generate_visuals", "ocr_and_visual_review"],
            acceptance_criteria=["文字清晰可读", "尺寸正确", "系列中每张海报有不同内容与版式角色"],
            checkpoints=[CreativeCheckpoint(id="brief", label="确认海报需求", required=True)],
            revision_scope="poster",
        )
    if module == "sci_fig":
        return CreativeDeliveryContract(
            artifact_type="scientific_figure",
            summary=f"围绕需求创作科研图：{brief}",
            execution_strategy=["classify_figure", "validate_evidence", "select_renderer", "render", "publication_review"],
            acceptance_criteria=["数据结论可追溯", "标签与单位清晰可读", "格式满足发表或汇报要求"],
            checkpoints=[CreativeCheckpoint(id="figure_spec", label="确认科研图规格", required=True)],
            revision_scope="figure",
        )
    if module == "canvas_flow":
        return CreativeDeliveryContract(
            artifact_type="canvas_flow",
            summary=f"围绕题材设计可运行的漫剧画布流：{brief}",
            execution_strategy=[
                "extract_logline",
                "write_script_card",
                "break_storyboard",
                "design_character_anchors",
                "compile_shot_graph",
                "write_image_and_motion_prompts",
            ],
            acceptance_criteria=[
                "画布是可运行的无环图，而不是一张说明",
                "有人物的镜头接到角色锚点结果",
                "视频节点上游有静帧参考",
            ],
            checkpoints=[CreativeCheckpoint(id="plan", label="确认分镜与画布结构", required=True)],
            revision_scope="canvas",
        )
    if module == "paper":
        return CreativeDeliveryContract(
            artifact_type="research_paper",
            summary=f"围绕需求生成可编辑科研论文：{brief}",
            execution_strategy=[
                "extract_evidence_ledger",
                "clarify_research_scope",
                "confirm_outline",
                "write_evidence_grounded_draft",
                "plan_scientific_figures",
                "typeset_editable_source",
                "citation_and_layout_review",
            ],
            acceptance_criteria=[
                "每个事实、数据和图表计划均能追溯到用户资料或明确标记为待补充",
                "不生成未经核验的作者、期刊、DOI 或实验结论",
                "正文、Typst 源稿、图表计划和 PDF 交付状态可追溯",
            ],
            checkpoints=[
                CreativeCheckpoint(id="research_scope", label="确认研究范围与资料边界", required=True),
                CreativeCheckpoint(id="outline", label="确认论文提纲与图表计划", required=True),
            ],
            revision_scope="paper",
        )
    return CreativeDeliveryContract(
        artifact_type="presentation",
        summary=f"围绕需求创作可编辑 PPT：{brief}",
        execution_strategy=[
            "extract_materials",
            "build_storyline",
            "build_slide_manifests",
            "plan_visual_assets",
            "generate_image_assets",
            "assemble_native_ppt",
            "presentation_review",
        ],
        acceptance_criteria=[
            "页面叙事覆盖目标内容",
            "文本、卡片、图示与图表保持原生可编辑",
            "图片素材只增强视觉表达，不承载必要文字",
            "整套页面风格统一，可直接导出",
        ],
        checkpoints=[
            CreativeCheckpoint(id="outline", label="确认叙事结构与页面角色", required=True),
            CreativeCheckpoint(id="preview", label="确认预览后导出", required=True),
        ],
        revision_scope="slide",
    )
