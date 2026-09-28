"""
PPT generation routes.

The PPT workflow has two paid phases:
- preview image generation, handled inside PPTAgent while each slide image is produced
- PPTX conversion, charged once when the user confirms a checkpoint
"""
import asyncio
import base64
import hashlib
import json
import tempfile
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, quote, urlparse

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from core import cache as ui_cache, ppt_workspace
from core.config import settings
from core.generation_execution import (
    claim_submit_key,
    forget_submit_key,
    module_submit_idempotency_key,
    remember_submit_key,
)
from core.pool import acquire
from core.queue import enqueue
from repositories import conversation_repo, ppt_upload_repo
import repositories.credit_repo as credit_repo
import repositories.model_repo as model_repo
from routers.auth import get_current_user
from services.agents.ppt_agent import (
    DEFAULT_PPT_CONVERSION_MODE,
    PPTAgent,
    _save_state as save_ppt_state,
    _decode_ppt_base64,
    append_ppt_artifact,
    get_ppt_job_lock,
    get_ppt_conversion_cost,
    normalize_ppt_conversion_mode,
    store_ppt_slide_image_asset,
)
from services.attachment_parser import build_attachment_context, merge_attachment_state
from services import asset_lifecycle, asset_storage
from services.ai_client import get_default_model_id
from services.image_asset_contract import (
    ImageAssetReference,
    ImageAssetReferenceError,
    canonicalize_image_asset_references,
    load_original_reference_data_urls,
)
from services.image_output import image_output_size, normalize_image_quality, normalize_output_resolution
from services.model_billing import execute_billed_model_call
from services.agents.creative_runtime import create_module_run
from services.agents.agent_run_store import AgentRunTransitionError, resume_run
from services.agents.creative_contract import build_delivery_contract
from services.agents.specialist_graph import run_specialist_graph
from services.presentation_renderer import PresentationRenderError, render_presentation_pages
from services.ppt_template_catalog import get_ppt_template, list_ppt_templates, resolve_ppt_template_id

router = APIRouter(prefix="/api/ppt", tags=["PPT generation"])
_agent = PPTAgent()
PPT_RECENT_CACHE_TTL_SECONDS = 30
PPT_WORKSPACE_CACHE_TTL_SECONDS = 45


def _safe_ppt_download_filename(value: str, fallback: str = "presentation") -> str:
    cleaned = asset_storage.safe_file_name((value or "").strip(), fallback)
    if cleaned.lower().endswith(".pptx"):
        return cleaned
    return f"{cleaned}.pptx"


async def _sync_pptx_filename(state: dict, job_id: str, user_id: str, filename: str) -> str:
    safe_name = _safe_ppt_download_filename(filename or state.get("pptx_filename") or state.get("topic") or "presentation")
    if state.get("pptx_key"):
        try:
            row = await asset_storage.update_task_file_asset_filename(
                user_id=user_id,
                task_id=job_id,
                category="ppt",
                filename=safe_name,
            )
            if row:
                state["pptx_file_asset_id"] = row.get("id", state.get("pptx_file_asset_id", ""))
                state["pptx_url"] = row.get("storage_url") or state.get("pptx_url", "")
                state["pptx_key"] = row.get("storage_key") or state.get("pptx_key", "")
                state["pptx_filename"] = row.get("filename") or safe_name
                await save_ppt_state(job_id, state)
                await ui_cache.bump_user_cache_version(user_id, "storage", "history")
                return state["pptx_filename"]
        except Exception:
            pass
    state["pptx_filename"] = safe_name
    try:
        await save_ppt_state(job_id, state)
    except Exception:
        pass
    return safe_name


async def _recover_ppt_download_state(job_id: str, user_id: str) -> dict | None:
    messages = await conversation_repo.find_messages_by_job_id(job_id, user_id, conv_type="ppt")
    if not messages:
        return None
    conversation_id = str(messages[-1].get("conversation_id") or messages[0].get("conversation_id") or "")
    state = _workspace_state_from_messages(messages, conversation_id)
    if not state:
        return None
    state["user_id"] = user_id
    return state


async def _load_ppt_download_state(job_id: str, user_id: str) -> dict | None:
    state = await _agent.get_state(job_id)
    if state:
        if state.get("user_id") and state.get("user_id") != user_id:
            raise HTTPException(403, "无权访问")
        return await _restore_legacy_quality_blocked_export(state, job_id)
    recovered = await _recover_ppt_download_state(job_id, user_id)
    return await _restore_legacy_quality_blocked_export(recovered, job_id) if recovered else None


async def _restore_legacy_quality_blocked_export(state: dict, job_id: str) -> dict:
    """Make pre-advisory QA exports downloadable again when their file remains."""
    if state.get("status") != "quality_blocked":
        return state
    candidate = Path(str(state.get("quality_candidate_path") or ""))
    if not candidate.exists():
        return state
    state["status"] = "done"
    state["progress"] = 100
    state["pptx_path"] = str(candidate)
    state["message"] = "演示文稿已生成，可直接下载；导出检查建议仅供参考。"
    state["quality_review"] = {
        "kind": "quality_review",
        "phase": "delivery",
        "current_result_available": True,
        "message": "导出检查建议仅供参考，当前 PPT 已保留并可直接下载。",
        "issues": (state.get("quality_review") or {}).get("issues", []),
        "actions": ["keep_current", "request_revision"],
    }
    state.pop("intervention", None)
    await save_ppt_state(job_id, state)
    return state


async def _resolve_ppt_image_bytes(value: str, user_id: str) -> bytes:
    raw = (value or "").strip()
    if not raw:
        return b""
    if raw.startswith("/api/assets/"):
        parts = raw.split("?")[0].strip("/").split("/")
        if len(parts) >= 4:
            data, _ = await asset_storage.fetch_image_asset_variant(parts[2], user_id, parts[3] or "original")
            return data
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    return _decode_ppt_base64(raw, "PPT 图片")


async def _auth(
    token: Optional[str] = Query(default=None),
    user: Optional[dict] = Depends(get_current_user),
) -> dict:
    if user:
        return user
    if token:
        from core.security import decode_token
        import repositories.user_repo as user_repo

        payload = decode_token(token)
        if payload and payload.get("type") == "access":
            u = await user_repo.get_by_id(payload["sub"])
            if u:
                from routers.auth import _require_current_legal_acceptance
                await _require_current_legal_acceptance(u, payload)
                return u
    raise HTTPException(401, "未登录")


class PPTBriefRequest(BaseModel):
    """Optional user-controlled presentation contract for a generation run."""
    audience: str = Field(default="", max_length=360)
    purpose: str = Field(default="", max_length=360)
    desired_action: str = Field(default="", max_length=360)
    duration_minutes: int = Field(default=0, ge=0, le=240)
    language: str = Field(default="", max_length=80)
    tone: str = Field(default="", max_length=160)
    must_include: list[str] = Field(default_factory=list, max_length=8)
    must_avoid: list[str] = Field(default_factory=list, max_length=8)


class StartRequest(BaseModel):
    topic: str
    style_hint: str = ""
    page_count: int = 0
    slide_prompts: list[str] = Field(default_factory=list)
    brief: PPTBriefRequest = Field(default_factory=PPTBriefRequest)
    reference_assets: list[ImageAssetReference] = Field(default_factory=list)
    # Compatibility only. The route archives this before the agent starts.
    ref_image_b64: str = ""
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""
    image_model_id: str = ""
    vision_model_id: str = ""
    llm_model_id: str = ""
    conversion_mode: str = DEFAULT_PPT_CONVERSION_MODE
    # Commercial/competition presentation mode defaults to presentation-grade
    # source materials. Users can still reduce these controls deliberately for
    # a faster draft, but the default must not silently choose square/auto art.
    output_resolution: str = "2k"
    image_quality: str = "high"
    template_id: str = ""
    client_request_id: str = ""


class ConfirmRequest(BaseModel):
    selected_indices: Optional[list[int]] = None
    selected_slide_images: Optional[list[str]] = None
    selected_slide_prompts: Optional[list[str]] = None
    conversion_mode: Optional[str] = None


class ConfirmOutlineRequest(BaseModel):
    outline: Optional[dict] = None


class OptimizeRequest(BaseModel):
    topic: str
    style_hint: str = ""
    llm_model_id: str = ""
    client_request_id: str = ""


class SlideOptimizeRequest(BaseModel):
    topic: str = ""
    style_hint: str = ""
    slide_prompt: str
    slide_index: int = 0
    llm_model_id: str = ""
    client_request_id: str = ""


class RollbackRequest(BaseModel):
    checkpoint: str


class ResumeRequest(BaseModel):
    image_model_id: str = ""
    vision_model_id: str = ""
    llm_model_id: str = ""


class SlideRenderRequest(BaseModel):
    prompt: str
    slide_index: Optional[int] = None
    source_image_b64: str = ""
    source_svg_b64: str = ""
    title: str = ""
    insert_after_index: Optional[int] = None
    rebuild: bool = False
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""


class DirectSlideSyncRequest(BaseModel):
    slides: list[dict] = Field(default_factory=list)
    rebuild: bool = True


class ImageSlideSyncRequest(BaseModel):
    slides: list[dict] = Field(default_factory=list)


def _slide_render_payload(body: SlideRenderRequest) -> dict:
    return {
        "prompt": body.prompt,
        "slide_index": body.slide_index,
        "source_image_b64": body.source_image_b64,
        "source_svg_b64": body.source_svg_b64,
        "title": body.title,
        "insert_after_index": body.insert_after_index,
        "rebuild": body.rebuild,
        "attachments": body.attachments,
        "attachment_context": body.attachment_context,
    }


async def run_ppt_start_from_queue(job_id: str) -> None:
    await run_specialist_graph(
        module="ppt",
        job_id=job_id,
        load_state=lambda: _agent.get_state(job_id),
        execute=lambda: _agent._run_pipeline_limited(job_id),
    )


async def run_ppt_confirm_outline_direct_from_queue(job_id: str) -> None:
    await run_specialist_graph(
        module="ppt",
        job_id=job_id,
        load_state=lambda: _agent.get_state(job_id),
        execute=lambda: _agent._run_ppt_master_direct_limited(job_id),
    )


async def run_ppt_confirm_outline_images_from_queue(job_id: str) -> None:
    await run_specialist_graph(
        module="ppt",
        job_id=job_id,
        load_state=lambda: _agent.get_state(job_id),
        execute=lambda: _agent._run_pipeline_from_images(job_id),
    )


async def run_ppt_post_checkpoint_from_queue(job_id: str) -> None:
    await run_specialist_graph(
        module="ppt",
        job_id=job_id,
        load_state=lambda: _agent.get_state(job_id),
        execute=lambda: _agent._run_post_checkpoint_limited(job_id),
        force_execute=True,
    )


async def run_ppt_slide_render_from_queue(job_id: str, payload: dict, user_id: str) -> None:
    await _run_image_slide_render_background(job_id, payload, user_id)


async def run_ppt_direct_slide_render_from_queue(job_id: str, payload: dict) -> None:
    await _run_direct_slide_render_background(job_id, payload)


def _clean_agent_steps_for_ui(steps: object) -> list[dict]:
    if not isinstance(steps, list):
        return []
    completed_names = {
        str(step.get("name") or "")
        for step in steps
        if isinstance(step, dict) and step.get("status") == "completed"
    }
    cleaned: list[dict] = []
    seen: set[tuple[str, int | str]] = set()
    for step in steps:
        if not isinstance(step, dict):
            continue
        name = str(step.get("name") or "")
        error = str(step.get("error") or step.get("message") or "")
        if step.get("status") == "failed" and "qa_result" in error and name in completed_names:
            continue
        attempt = step.get("attempt", 1)
        key = (name, attempt)
        if key in seen:
            cleaned = [item for item in cleaned if (str(item.get("name") or ""), item.get("attempt", 1)) != key]
        seen.add(key)
        cleaned.append(step)
    return cleaned


MODE_LABELS = {
    "ppt_master_direct": "可编辑演示文稿",
    "image_only": "纯图片 PPT",
    "editable_overlay": "文字可修改版",
    "native_svg": "可编辑演示文稿",
}


@router.get("/templates")
async def list_professional_ppt_templates(user: dict = Depends(_auth)):
    return {"items": list_ppt_templates()}


@router.post("/optimize")
async def optimize_topic(body: OptimizeRequest, user: dict = Depends(_auth)):
    if not body.topic.strip():
        raise HTTPException(400, "主题不能为空")
    model_id = body.llm_model_id or await get_default_model_id("llm") or ""
    cost = 0.0
    if model_id:
        model = await model_repo.get_model(model_id)
        if not model:
            raise HTTPException(404, f"模型 {model_id!r} 不存在或已禁用")
        if model.get("category") != "llm":
            raise HTTPException(400, "PPT 优化请选择文本模型")
        cost = float(model.get("price_credits", 0) or 0)
    optimized = await _agent.optimize_prompt(
        body.topic,
        body.style_hint or None,
        model_id or None,
        user_id=user["id"],
        operation_scope=body.client_request_id.strip() or str(uuid.uuid4()),
    )
    return {"optimized": optimized, "cost": cost}


@router.post("/optimize-slide")
async def optimize_slide_prompt(body: SlideOptimizeRequest, user: dict = Depends(_auth)):
    if not body.slide_prompt.strip() and not body.topic.strip():
        raise HTTPException(400, "请先填写 PPT 主题，或输入该页要求")
    model_id = body.llm_model_id or await get_default_model_id("llm") or ""
    cost = 0.0
    if model_id:
        model = await model_repo.get_model(model_id)
        if not model:
            raise HTTPException(404, f"模型 {model_id!r} 不存在或已禁用")
        if model.get("category") != "llm":
            raise HTTPException(400, "PPT 单页优化请选择文本模型")
        cost = float(model.get("price_credits", 0) or 0)
    optimized = await _agent.optimize_slide_prompt(
        slide_prompt=body.slide_prompt,
        topic=body.topic,
        style_requirement=body.style_hint or None,
        slide_index=body.slide_index,
        llm_model_id=model_id or None,
        user_id=user["id"],
        operation_scope=body.client_request_id.strip() or str(uuid.uuid4()),
    )
    return {"optimized": optimized, "cost": cost}


@router.post("/start")
async def start_ppt(body: StartRequest, user: dict = Depends(_auth)):
    submit_key = module_submit_idempotency_key(
        module="ppt",
        user_id=user["id"],
        client_request_id=body.client_request_id,
    )
    if not submit_key:
        return await _start_ppt(body, user)

    duplicate = await claim_submit_key(submit_key)
    if duplicate:
        return duplicate
    try:
        result = await _start_ppt(body, user)
    except Exception:
        await forget_submit_key(submit_key)
        raise
    await remember_submit_key(submit_key, result)
    return result


async def _start_ppt(body: StartRequest, user: dict):
    # 速率限制：每分钟最多 3 次（PPT 生成资源消耗大）
    from core.rate_limit import rate_limit, RateLimitExceeded
    try:
        await rate_limit(user["id"], "batch")  # 复用 batch 的 5min 3 次限制
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    if not body.topic.strip():
        raise HTTPException(400, "主题不能为空")

    resolved_template_id = resolve_ppt_template_id(
        body.template_id,
        topic=body.topic,
        style_hint=body.style_hint,
        attachment_context=body.attachment_context,
    )
    selected_template = get_ppt_template(resolved_template_id)
    if body.template_id.strip() and not selected_template:
        raise HTTPException(422, "所选 PPT 模板不存在或当前不可用")

    conversion_mode = normalize_ppt_conversion_mode(body.conversion_mode)
    output_resolution = normalize_output_resolution(body.output_resolution)
    image_quality = normalize_image_quality(body.image_quality)

    if body.llm_model_id:
        model = await model_repo.get_model(body.llm_model_id)
        if not model:
            raise HTTPException(404, f"文本模型 {body.llm_model_id!r} 不存在或已禁用")
        if model.get("category") != "llm":
            raise HTTPException(400, "PPT 大纲请选择文本模型")

    resolved_image_model_id = body.image_model_id
    if conversion_mode == "ppt_master_direct":
        if resolved_image_model_id:
            image_model = await model_repo.get_model(resolved_image_model_id)
            if not image_model:
                raise HTTPException(404, f"图片素材模型 {resolved_image_model_id!r} 不存在或已禁用")
            if image_model.get("category") != "generate":
                raise HTTPException(400, "可编辑演示文稿请选择图片生成模型")
        else:
            from services.ai_client import get_default_model_id
            resolved_image_model_id = await get_default_model_id("generate") or ""

    resolved_vision_model_id = body.vision_model_id
    if conversion_mode == "ppt_master_direct":
        if resolved_vision_model_id:
            vision_model = await model_repo.get_model(resolved_vision_model_id)
            if not vision_model:
                raise HTTPException(404, f"视觉模型 {resolved_vision_model_id!r} 不存在或已禁用")
            if vision_model.get("category") != "vision":
                raise HTTPException(400, "可编辑演示文稿请选择视觉模型")
        else:
            from services.ai_client import get_default_model_id
            resolved_vision_model_id = await get_default_model_id("vision") or ""

    job_id = str(uuid.uuid4())
    try:
        reference_assets = await canonicalize_image_asset_references(
            references=body.reference_assets,
            legacy_image_base64=body.ref_image_b64,
            user_id=user["id"],
            category="ppt-reference",
            task_id=job_id,
        )
        if len(reference_assets) > 1:
            raise ImageAssetReferenceError("PPT 当前一次只能使用一张参考图")
        reference_data_urls = await load_original_reference_data_urls(
            reference_assets,
            user_id=user["id"],
        )
    except ImageAssetReferenceError as exc:
        raise HTTPException(422, str(exc)) from exc
    attachment_context = (body.attachment_context or "").strip() or build_attachment_context(body.attachments or [])

    conversation_title = body.topic[:15]

    conversation_id = None
    try:
        conversation = await conversation_repo.create_conversation(
            user_id=user["id"],
            conv_type="ppt",
            title=conversation_title,
            creation_key=(f"ppt:{body.client_request_id.strip()[:128]}" if body.client_request_id.strip() else None),
        )
        conversation_id = conversation["id"]

        user_msg = f"主题：{body.topic}"
        if body.style_hint:
            user_msg += f"\n风格：{body.style_hint}"
        if body.page_count:
            user_msg += f"\n页数：{body.page_count}"
        if body.attachments:
            names = "、".join(str(item.get("filename") or "附件") for item in body.attachments[:6])
            user_msg += f"\n附件：{names}"
        if body.brief.audience:
            user_msg += f"\n受众：{body.brief.audience}"
        if body.brief.purpose:
            user_msg += f"\n目标：{body.brief.purpose}"
        if body.brief.desired_action:
            user_msg += f"\n期望行动：{body.brief.desired_action}"
        await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="user",
            content=user_msg,
            meta={
                "type": "ppt_request",
                "job_id": job_id,
                "topic": body.topic,
                "style_hint": body.style_hint,
                "slide_prompts": body.slide_prompts,
                "brief": body.brief.model_dump(),
                "attachments": body.attachments,
                "output_resolution": output_resolution,
                "image_quality": image_quality,
                "template_id": resolved_template_id or "",
            },
        )
    except Exception:
        conversation_id = None

    delivery_contract = build_delivery_contract(
        module="ppt",
        action="create",
        instruction=body.topic,
        context={
            "page_count": body.page_count,
            "conversion_mode": conversion_mode,
            "attachment_count": len(body.attachments or []),
            "reference_count": len(reference_assets),
            "template_id": resolved_template_id or "",
            "brief": body.brief.model_dump(),
        },
    )
    agent_run_id = ""
    try:
        agent_run = await create_module_run(
            user_id=user["id"],
            module="ppt",
            action="create",
            instruction=body.topic,
            context={
                "page_count": body.page_count,
                "conversion_mode": conversion_mode,
                "attachment_count": len(body.attachments or []),
                "reference_count": len(reference_assets),
                "template_id": resolved_template_id or "",
                "brief": body.brief.model_dump(),
            },
            conversation_id=conversation_id or "",
            contract=delivery_contract,
        )
        agent_run_id = str(agent_run.get("run_id") or "")
    except Exception as exc:
        logger.warning("failed to create top-level PPT agent run job_id=%s error=%s", job_id, exc)

    state = await _agent.start(
        job_id=job_id,
        topic=body.topic,
        style_hint=body.style_hint,
        page_count=body.page_count,
        slide_prompts=body.slide_prompts,
        brief=body.brief.model_dump(),
        ref_image_b64=reference_data_urls[0] if reference_data_urls else "",
        reference_asset_id=reference_assets[0].asset_id if reference_assets else "",
        attachments=body.attachments,
        attachment_context=attachment_context,
        user_id=user["id"],
        image_model_id=resolved_image_model_id,
        vision_model_id=resolved_vision_model_id,
        llm_model_id=body.llm_model_id,
        conversion_mode=conversion_mode,
        output_resolution=output_resolution,
        image_quality=image_quality,
        agent_run_id=agent_run_id,
        delivery_contract=delivery_contract.model_dump(),
        template_id=resolved_template_id or "",
    )
    if conversation_id:
        state["conversation_id"] = conversation_id
        await save_ppt_state(job_id, state)

    await enqueue(
        task_type="ppt-start",
        task_id=f"{job_id}:start",
        payload={"job_id": job_id, "user_id": user["id"]},
        priority="normal",
        user_id=user["id"],
    )

    return {
        "job_id": job_id,
        "status": state["status"],
        "agent_run_id": agent_run_id,
        "template_id": resolved_template_id or "",
        "template_name": str(selected_template.get("localized_name") or selected_template.get("name") or "") if selected_template else "",
    }


@router.get("/status/{job_id}")
async def get_status(job_id: str, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    state = await _restore_legacy_quality_blocked_export(state, job_id)
    outline = state.get("outline") or {}
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
    if mode == "ppt_master_direct":
        raw_direct_decks = state.get("direct_slide_decks") or []
        workspace_decks = [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(raw_direct_decks)]
        slide_count = len(workspace_decks)
    else:
        workspace_decks = _serialize_image_slide_decks(state)
        slide_count = len([b for b in state.get("slide_images_b64", []) if b])
    return {
        "status": state["status"],
        "progress": state["progress"],
        "message": state["message"],
        "error": state.get("error", ""),
        "outline": outline or None,
        "brief": state.get("brief") or {},
        "content_quality": (outline.get("content_quality") if isinstance(outline, dict) else {}) or {},
        "quality_review": state.get("quality_review") or {},
        "pending_slide_task": state.get("pending_slide_task") or {},
        "slide_count": slide_count,
        "slide_total": len(outline_slides or []),
        "agent_steps": _clean_agent_steps_for_ui(state.get("agent_steps", [])),
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "agent_run_id": state.get("agent_run_id", ""),
        "intervention": state.get("intervention") or {},
        "delivery_contract": state.get("delivery_contract") or {},
        "visual_asset_count": len(state.get("visual_assets") or []),
        "visual_asset_warnings": state.get("visual_asset_warnings") or [],
        "artifacts": [
            artifact for artifact in state.get("artifacts", [])
            if isinstance(artifact, dict) and artifact.get("type") == "visual_asset"
        ],
        "workspace": {
            "slide_decks": [] if mode == "ppt_master_direct" else workspace_decks,
            "direct_slide_decks": workspace_decks if mode == "ppt_master_direct" else [],
            "pptx_url": state.get("pptx_url", ""),
            "pptx_path": state.get("pptx_path", ""),
            "conversion_mode": mode,
            "output_resolution": state.get("output_resolution", "1k"),
            "image_quality": state.get("image_quality", "auto"),
        },
    }


@router.get("/slides/{job_id}")
async def get_slides(job_id: str, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    if state["status"] not in ("generating_images", "checkpoint", "quality_blocked", "done"):
        raise HTTPException(400, "页面尚未生成完成")

    mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
    slide_decks = _serialize_image_slide_decks(state)
    slide_count = len([s for s in state.get("slide_images_b64", []) if s])
    return {
        "outline": state.get("outline"),
        "slides": state.get("slide_images_b64", []),
        "slide_decks": slide_decks,
        "slide_count": slide_count,
        "status": state.get("status"),
        "message": state.get("message", ""),
        "error": state.get("error", ""),
        "pending_slide_task": state.get("pending_slide_task"),
        "conversion_mode": mode,
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "conversion_costs": {
            key: get_ppt_conversion_cost(key, slide_count)
            for key in ("image_only", "native_svg", "editable_overlay")
        },
    }


def _serialize_direct_slide(deck: dict, idx: int) -> dict:
    versions = [v for v in (deck.get("versions") or []) if isinstance(v, str) and v]
    selected = deck.get("selected_version_index", deck.get("selectedVersionIndex", 0))
    try:
        selected = int(selected)
    except Exception:
        selected = 0
    selected = min(max(selected, 0), max(len(versions) - 1, 0))
    return {
        "id": deck.get("id") or f"direct-slide-{idx + 1}",
        "title": deck.get("title") or f"第 {idx + 1} 页",
        "prompt": deck.get("prompt") or "",
        "kind": "svg",
        "versions": versions,
        "selectedVersionIndex": selected,
        "slide": deck.get("slide") or {},
        "slide_index": idx,
        "svg_b64": versions[selected] if versions else "",
    }


def _strip_data_url(raw: object) -> str:
    value = str(raw or "").strip()
    if value.startswith("data:") and "," in value:
        value = value.split(",", 1)[1]
    return value


def _image_decks_to_outline(state: dict, decks: list[dict]) -> dict:
    outline = dict(state.get("outline") or {})
    outline.setdefault("title", state.get("topic") or "PPT")
    outline.setdefault("style", state.get("style_hint") or "")
    outline.setdefault("color_scheme", "")
    slides: list[dict] = []
    for idx, deck in enumerate(decks):
        slide_info = dict(deck.get("slide") or {})
        title = str(deck.get("title") or slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(deck.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        slide_info.setdefault("type", "cover" if idx == 0 else "content")
        slide_info.setdefault("points", [prompt] if prompt else [])
        if prompt:
            slide_info["prompt"] = prompt
            slide_info.setdefault("layout_hint", prompt)
        slides.append(slide_info)
    outline["slides"] = slides
    return outline


def _selected_images_from_decks(decks: list[dict]) -> list[str]:
    selected_images: list[str] = []
    for deck in decks:
        versions = deck.get("versions") or []
        if not versions:
            continue
        selected = deck.get("selectedVersionIndex", deck.get("selected_version_index", 0))
        try:
            selected_idx = int(selected)
        except Exception:
            selected_idx = 0
        selected_idx = min(max(selected_idx, 0), max(len(versions) - 1, 0))
        selected_images.append(versions[selected_idx])
    return selected_images


def _pptx_ready_from_state(state: dict) -> bool:
    pptx_path = str(state.get("pptx_path") or "").strip()
    return bool(
        (Path(pptx_path).exists() if pptx_path else False)
        or state.get("pptx_key")
        or state.get("pptx_url")
    )


def _pptx_versions_from_artifacts(state: dict, job_id: str, default_slide_count: int) -> list[dict]:
    versions: list[dict] = []
    for artifact in state.get("artifacts", []) or []:
        if not isinstance(artifact, dict) or artifact.get("type") != "pptx_done":
            continue
        versions.append({
            "version": len(versions) + 1,
            "slide_count": int(artifact.get("slide_count") or default_slide_count or 0),
            "created_at": str(artifact.get("created_at") or ""),
            "job_id": str(artifact.get("job_id") or job_id),
            "pptx_filename": str(artifact.get("pptx_filename") or state.get("pptx_filename") or ""),
        })
    return versions[-1:] if versions else []


def _chat_messages_from_history(messages: list[dict], limit: int = 12) -> list[dict]:
    ignored_types = {
        "slides_preview",
        "selected_slides",
        "pptx_done",
        "slide_version",
        "slide_added",
        "direct_slide_version",
        "direct_slide_added",
        "slides_sync",
        "direct_slides_sync",
    }
    chat: list[dict] = []
    for msg in messages:
        meta = msg.get("meta") or {}
        if isinstance(meta, dict) and str(meta.get("type") or "") in ignored_types:
            continue
        role = "user" if msg.get("role") == "user" else "ai"
        chat.append({
            "role": role,
            "content": msg.get("content") or "",
            "time": msg.get("created_at") or "",
        })
    return chat[-limit:]


def _slide_decks_from_meta(meta: dict) -> list[dict]:
    decks = meta.get("slide_decks") or meta.get("direct_slide_decks") or meta.get("slides")
    if isinstance(decks, list) and all(isinstance(item, dict) for item in decks):
        return decks
    versions = meta.get("versions")
    if isinstance(versions, list) and versions:
        return [{
            "id": str(meta.get("id") or "slide-1"),
            "title": str(meta.get("title") or "第 1 页"),
            "prompt": str(meta.get("prompt") or ""),
            "kind": "svg" if meta.get("svg_b64") else "image",
            "versions": versions,
            "selectedVersionIndex": int(meta.get("selectedVersionIndex") or meta.get("selected_version_index") or 0),
            "slide": meta.get("slide") if isinstance(meta.get("slide"), dict) else {},
        }]
    return []


def _apply_direct_artifacts_to_decks(decks: list[dict], artifacts: list[dict], outline: dict) -> list[dict]:
    merged = [dict(deck) for deck in decks if isinstance(deck, dict)]
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        artifact_type = str(artifact.get("type") or "")
        if artifact_type not in ("direct_slide_version", "direct_slide_added"):
            continue
        svg = _strip_data_url(artifact.get("svg_b64") or artifact.get("image_b64") or artifact.get("preview_b64"))
        if not svg:
            continue
        try:
            slide_index = int(artifact.get("slide_index", len(merged)))
        except Exception:
            slide_index = len(merged)
        prompt = str(artifact.get("prompt") or "")
        if artifact_type == "direct_slide_version" and 0 <= slide_index < len(merged):
            versions = [_strip_data_url(v) for v in (merged[slide_index].get("versions") or [])]
            versions = [v for v in versions if v]
            if svg not in versions:
                versions.append(svg)
            merged[slide_index] = {
                **merged[slide_index],
                "prompt": prompt or str(merged[slide_index].get("prompt") or ""),
                "versions": versions,
                "selected_version_index": len(versions) - 1,
            }
        elif artifact_type == "direct_slide_added":
            if any(svg in [_strip_data_url(v) for v in (deck.get("versions") or [])] for deck in merged):
                continue
            insert_at = min(max(slide_index, 0), len(merged))
            slide_info = (
                dict(outline_slides[insert_at])
                if insert_at < len(outline_slides) and isinstance(outline_slides[insert_at], dict)
                else {}
            )
            title = str(artifact.get("title") or slide_info.get("title") or f"新增页 {insert_at + 1}")
            merged.insert(insert_at, {
                "id": str(artifact.get("id") or f"direct-slide-added-{insert_at + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "svg",
                "versions": [svg],
                "selected_version_index": 0,
                "slide": {
                    **slide_info,
                    "page": insert_at + 1,
                    "title": title,
                    "prompt": prompt or slide_info.get("prompt") or slide_info.get("layout_hint") or "",
                },
            })

    for idx, deck in enumerate(merged):
        slide_info = dict(deck.get("slide") or {})
        title = str(deck.get("title") or slide_info.get("title") or f"第 {idx + 1} 页")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        merged[idx] = {**deck, "title": title, "kind": "svg", "slide": slide_info}
    return merged


def _workspace_state_from_messages(messages: list[dict], conversation_id: str) -> dict | None:
    job_id = ""
    outline: dict = {}
    conversion_mode = "image_only"
    status = "checkpoint"
    progress = 50
    message = "已从历史记录恢复 PPT 工作区。"
    artifacts: list[dict] = []
    image_decks: list[dict] = []
    direct_decks: list[dict] = []
    slide_images: list[str] = []
    pptx_path = ""
    pptx_url = ""
    pptx_key = ""
    latest_slide_count = 0

    for msg in messages:
        meta = msg.get("meta") or {}
        if not isinstance(meta, dict):
            continue
        job_id = _extract_job_id_from_meta(meta) or job_id
        if isinstance(meta.get("outline"), dict):
            outline = meta["outline"]
        conversion_mode = str(meta.get("conversion_mode") or conversion_mode or "image_only")

        nested_artifacts = meta.get("artifacts")
        if isinstance(nested_artifacts, list):
            artifacts.extend([item for item in nested_artifacts if isinstance(item, dict)])
        if meta.get("type"):
            artifacts.append(meta)

        meta_type = str(meta.get("type") or "")
        decks = _slide_decks_from_meta(meta)
        if decks:
            is_direct = (
                conversion_mode == "ppt_master_direct"
                or meta_type.startswith("direct_")
                or any(deck.get("kind") == "svg" for deck in decks)
            )
            is_full_snapshot = (
                meta_type in {"slides_preview", "selected_slides", "slides_sync", "direct_slides_sync", "pptx_done", "ppt_master_direct"}
                or bool(meta.get("slide_decks") or meta.get("direct_slide_decks") or meta.get("slides"))
                or len(decks) > 1
            )
            if is_direct:
                if is_full_snapshot and (not direct_decks or len(decks) >= len(direct_decks)):
                    direct_decks = decks
                conversion_mode = "ppt_master_direct"
            else:
                if is_full_snapshot and (not image_decks or len(decks) >= len(image_decks)):
                    image_decks = decks
        images = meta.get("preview_b64_list")
        if isinstance(images, list) and images:
            candidate_images = [str(item) for item in images if str(item or "").strip()]
            if meta_type == "selected_slides" or not slide_images or len(candidate_images) >= len(slide_images):
                slide_images = candidate_images
        elif isinstance(meta.get("preview_b64"), str) and meta.get("preview_b64") and not slide_images:
            slide_images = [str(meta["preview_b64"])]
        try:
            latest_slide_count = max(latest_slide_count, int(meta.get("slide_count") or 0))
        except Exception:
            pass
        if meta_type == "pptx_done":
            status = "done"
            progress = 100
            message = "PPTX 已生成完成。"
            pptx_path = str(meta.get("pptx_path") or pptx_path or "")
            pptx_url = str(meta.get("pptx_url") or pptx_url or "")
            pptx_key = str(meta.get("pptx_key") or pptx_key or "")

    if not job_id:
        return None
    if not direct_decks and conversion_mode == "ppt_master_direct":
        direct_decks = _direct_decks_from_artifacts(artifacts, outline)
    if direct_decks:
        direct_decks = _apply_direct_artifacts_to_decks(direct_decks, artifacts, outline)
    if not image_decks and slide_images:
        image_decks = _image_decks_from_images(slide_images, outline)
    has_workspace = bool(direct_decks or image_decks or slide_images or latest_slide_count or pptx_path or pptx_url or pptx_key)
    if not has_workspace:
        return None
    return {
        "job_id": job_id,
        "conversation_id": conversation_id,
        "status": status,
        "progress": progress,
        "message": message,
        "outline": outline,
        "conversion_mode": "ppt_master_direct" if direct_decks else conversion_mode,
        "direct_slide_decks": direct_decks,
        "image_slide_decks": image_decks,
        "slide_images_b64": slide_images,
        "artifacts": artifacts,
        "pptx_path": pptx_path,
        "pptx_url": pptx_url,
        "pptx_key": pptx_key,
    }


def _image_decks_from_images(images: list[str], outline: dict) -> list[dict]:
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    decks: list[dict] = []
    for idx, image in enumerate(images):
        raw = _strip_data_url(image)
        if not raw:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        title = str(slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        decks.append({
            "id": f"slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "image",
            "versions": [raw],
            "selectedVersionIndex": 0,
            "slide": {**slide_info, "page": idx + 1, "title": title},
        })
    return decks


def _direct_decks_from_artifacts(artifacts: list[dict], outline: dict) -> list[dict]:
    latest = next(
        (
            artifact for artifact in reversed(artifacts)
            if isinstance(artifact, dict)
            and artifact.get("conversion_mode") == "ppt_master_direct"
            and isinstance(artifact.get("project_dir"), str)
        ),
        None,
    )
    if not latest:
        return []
    project_dir = Path(str(latest.get("project_dir") or ""))
    svg_dir = project_dir / "svg_output"
    if not svg_dir.exists():
        return []
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    decks: list[dict] = []
    for idx, svg_path in enumerate(sorted(svg_dir.glob("*.svg"))):
        try:
            svg_b64 = base64.b64encode(svg_path.read_bytes()).decode("ascii")
        except Exception:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        slide_info["page"] = idx + 1
        title = str(slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        decks.append({
            "id": f"direct-slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "svg",
            "versions": [svg_b64],
            "selected_version_index": 0,
            "slide": slide_info,
        })
    return decks


def _workspace_payload_from_state(state: dict, job_id: str, messages: list[dict] | None = None) -> dict:
    mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
    if mode == "ppt_master_direct":
        slide_decks = [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(state.get("direct_slide_decks") or [])]
        selected_images: list[str] = []
    else:
        slide_decks = _serialize_image_slide_decks(state)
        selected_images = _selected_images_from_decks(slide_decks)
    slide_count = len(slide_decks) if mode == "ppt_master_direct" else len(selected_images)
    outline = state.get("outline") or {}
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    pptx_ready = _pptx_ready_from_state(state)
    return {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id"),
        "status": state.get("status") or ("done" if pptx_ready else "checkpoint"),
        "phase": _workspace_phase(str(state.get("status") or "")),
        "progress": state.get("progress", 100 if pptx_ready else 50),
        "message": state.get("message") or "已加载 PPT 工作区。",
        "error": state.get("error", ""),
        "outline": outline or None,
        "conversion_mode": mode,
        "slide_decks": slide_decks,
        "direct_slide_decks": slide_decks if mode == "ppt_master_direct" else [],
        "slide_images": selected_images,
        "slide_count": slide_count,
        "slide_total": len(outline_slides or []) or slide_count,
        "agent_steps": _clean_agent_steps_for_ui(state.get("agent_steps", [])),
        "artifacts": state.get("artifacts", []),
        "pptx_ready": pptx_ready,
        "pptx_path": state.get("pptx_path", "") if pptx_ready else "",
        "pptx_url": state.get("pptx_url", "") if pptx_ready else "",
        "pptx_filename": state.get("pptx_filename", "") if pptx_ready else "",
        "pptx_versions": _pptx_versions_from_artifacts(state, job_id, slide_count),
        "messages": messages or [],
        "chat_messages": _chat_messages_from_history(messages or []),
    }


def _workspace_payload_has_renderable_slides(payload: dict | None) -> bool:
    if not isinstance(payload, dict):
        return False
    return bool(
        payload.get("slide_decks")
        or payload.get("direct_slide_decks")
        or payload.get("slide_images")
    )


def _serialize_image_slide_decks(state: dict) -> list[dict]:
    outline = state.get("outline") or {}
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    raw_decks = state.get("image_slide_decks")
    decks: list[dict] = []

    if isinstance(raw_decks, list) and raw_decks:
        for idx, item in enumerate(raw_decks):
            if not isinstance(item, dict):
                continue
            versions = [_strip_data_url(v) for v in (item.get("versions") or [])]
            versions = [v for v in versions if v]
            if not versions:
                continue
            slide_info = item.get("slide") if isinstance(item.get("slide"), dict) else {}
            if not slide_info and idx < len(outline_slides) and isinstance(outline_slides[idx], dict):
                slide_info = dict(outline_slides[idx])
            selected = item.get("selectedVersionIndex", item.get("selected_version_index", 0))
            try:
                selected_idx = int(selected)
            except Exception:
                selected_idx = 0
            selected_idx = min(max(selected_idx, 0), max(len(versions) - 1, 0))
            title = str(item.get("title") or slide_info.get("title") or f"第 {idx + 1} 页")
            prompt = str(item.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
            decks.append({
                "id": str(item.get("id") or f"slide-{idx + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "image",
                "versions": versions,
                "selectedVersionIndex": selected_idx,
                "slide": {**dict(slide_info), "page": idx + 1, "title": title},
            })
        if decks:
            return decks

    for idx, raw in enumerate(state.get("slide_images_b64", []) or []):
        img = _strip_data_url(raw)
        if not img:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        title = str(slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        decks.append({
            "id": f"slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "image",
            "versions": [img],
            "selectedVersionIndex": 0,
            "slide": {**slide_info, "page": idx + 1, "title": title},
        })

    for artifact in state.get("artifacts", []) or []:
        if not isinstance(artifact, dict):
            continue
        artifact_type = artifact.get("type")
        if artifact_type not in ("slide_version", "slide_added"):
            continue
        img = _strip_data_url(artifact.get("image_b64") or artifact.get("preview_b64"))
        if not img:
            continue
        try:
            slide_index = int(artifact.get("slide_index", len(decks)))
        except Exception:
            slide_index = len(decks)
        if artifact_type == "slide_version" and 0 <= slide_index < len(decks):
            versions = list(decks[slide_index].get("versions") or [])
            if img not in versions:
                versions.append(img)
            decks[slide_index] = {
                **decks[slide_index],
                "prompt": str(artifact.get("prompt") or decks[slide_index].get("prompt") or ""),
                "versions": versions,
                "selectedVersionIndex": len(versions) - 1,
            }
        elif artifact_type == "slide_added":
            if any(img in (deck.get("versions") or []) for deck in decks):
                continue
            insert_at = min(max(slide_index, 0), len(decks))
            title = str(artifact.get("title") or f"新增页 {insert_at + 1}")
            prompt = str(artifact.get("prompt") or "")
            decks.insert(insert_at, {
                "id": str(artifact.get("id") or f"slide-added-{insert_at + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "image",
                "versions": [img],
                "selectedVersionIndex": 0,
                "slide": {
                    "page": insert_at + 1,
                    "type": "content",
                    "title": title,
                    "points": [prompt] if prompt else [],
                    "layout_hint": prompt,
                    "prompt": prompt,
                },
            })

    for idx, deck in enumerate(decks):
        slide_info = dict(deck.get("slide") or {})
        slide_info["page"] = idx + 1
        decks[idx] = {**deck, "slide": slide_info}
    return decks


def _workspace_phase(status: str) -> str:
    if status == "done":
        return "done"
    if status == "failed":
        return "failed"
    if status == "quality_blocked":
        # The editable pages remain available for correction, but no candidate
        # export may be presented as a downloadable deliverable.
        return "checkpoint"
    if status == "checkpoint":
        return "checkpoint"
    if status == "outline_done":
        return "outline_review"
    if status == "generating_images":
        return "generating"
    if status in ("pending", "confirmed", "analyzing", "building"):
        return "building"
    return "generating"


def _presentation_src(value: object, kind: str = "image") -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if (
        raw.startswith("data:")
        or raw.startswith("/api/assets/")
        or raw.startswith("http://")
        or raw.startswith("https://")
        or raw.startswith("file:")
        or raw.startswith("blob:")
    ):
        return raw
    mime = "image/svg+xml" if kind == "svg" else "image/png"
    return f"data:{mime};base64,{_strip_data_url(raw)}"


def _asset_key_from_url(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    parts = parsed.path.strip("/").split("/")
    if len(parts) >= 4 and parts[0] == "api" and parts[1] == "assets" and parts[2] == "files" and parts[3] == "by-key":
        return (parse_qs(parsed.query).get("key") or [""])[0].strip().lstrip("/")
    return ""


def _upload_storage_keys(record: dict) -> list[str]:
    keys = {str(record.get("source_key") or "").strip().lstrip("/")}
    key_from_url = _asset_key_from_url(record.get("source_url"))
    if key_from_url:
        keys.add(key_from_url)
    for slide in record.get("slides") or []:
        if not isinstance(slide, dict):
            continue
        for field in ("storage_key", "source_key", "file_key", "key"):
            value = str(slide.get(field) or "").strip().lstrip("/")
            if value:
                keys.add(value)
        key_from_url = _asset_key_from_url(slide.get("src") or slide.get("url"))
        if key_from_url:
            keys.add(key_from_url)
    return sorted(key for key in keys if key)


def _slides_from_decks(decks: list[dict]) -> list[dict]:
    slides: list[dict] = []
    for idx, deck in enumerate(decks or []):
        if not isinstance(deck, dict):
            continue
        versions = deck.get("versions") or []
        if not versions:
            candidate = deck.get("svg_b64") or deck.get("image_b64") or deck.get("preview_b64")
            versions = [candidate] if candidate else []
        if not versions:
            continue
        kind = "svg" if deck.get("kind") == "svg" or deck.get("svg_b64") else "image"
        selected = deck.get("selectedVersionIndex", deck.get("selected_version_index", 0))
        try:
            selected_idx = int(selected)
        except Exception:
            selected_idx = 0
        selected_idx = min(max(selected_idx, 0), max(len(versions) - 1, 0))
        src = _presentation_src(versions[selected_idx], kind)
        if not src:
            continue
        slide_info = deck.get("slide") if isinstance(deck.get("slide"), dict) else {}
        slides.append({
            "id": str(deck.get("id") or f"slide-{idx + 1}"),
            "index": idx,
            "title": str(deck.get("title") or slide_info.get("title") or f"第 {idx + 1} 页"),
            "kind": kind,
            "src": src,
        })
    return slides


def _slides_from_images(images: list[object], outline: dict | None = None) -> list[dict]:
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    slides: list[dict] = []
    for idx, image in enumerate(images or []):
        src = _presentation_src(image, "image")
        if not src:
            continue
        slide_info = outline_slides[idx] if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        slides.append({
            "id": f"slide-{idx + 1}",
            "index": idx,
            "title": str(slide_info.get("title") or f"第 {idx + 1} 页"),
            "kind": "image",
            "src": src,
        })
    return slides


async def _presentation_from_state(job_id: str, user: dict) -> dict:
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    if state.get("user_id") and state.get("user_id") != user["id"]:
        raise HTTPException(404, "任务不存在")

    mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
    if mode == "ppt_master_direct":
        state, direct_decks = await _agent.get_ppt_master_direct_slides(job_id)
        decks = [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(direct_decks)]
        slides = _slides_from_decks(decks)
    else:
        decks = _serialize_image_slide_decks(state)
        slides = _slides_from_decks(decks)
        if not slides:
            slides = _slides_from_images(state.get("slide_images_b64", []), state.get("outline") or {})

    if not slides:
        raise HTTPException(404, "还没有可演示的幻灯片")

    outline = state.get("outline") if isinstance(state.get("outline"), dict) else {}
    return {
        "source": "generated",
        "job_id": job_id,
        "conversation_id": state.get("conversation_id", ""),
        "title": outline.get("title") or state.get("topic") or "PPT 演示",
        "conversion_mode": mode,
        "slide_count": len(slides),
        "slides": slides,
        "pptx_ready": bool(state.get("pptx_path") or state.get("pptx_url")),
    }


def _extract_job_id_from_meta(meta: dict) -> str:
    if not isinstance(meta, dict):
        return ""
    job_id = meta.get("job_id")
    if isinstance(job_id, str) and job_id:
        return job_id
    artifacts = meta.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in reversed(artifacts):
            if isinstance(artifact, dict) and isinstance(artifact.get("job_id"), str) and artifact.get("job_id"):
                return artifact["job_id"]
    return ""


def _presentation_from_messages(messages: list[dict], title: str, conversation_id: str = "") -> dict | None:
    restored = _workspace_state_from_messages(messages, conversation_id)
    if restored:
        mode = normalize_ppt_conversion_mode(restored.get("conversion_mode"))
        decks = (
            [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(restored.get("direct_slide_decks") or [])]
            if mode == "ppt_master_direct"
            else _serialize_image_slide_decks(restored)
        )
        slides = _slides_from_decks(decks)
        if not slides and mode != "ppt_master_direct":
            slides = _slides_from_images(restored.get("slide_images_b64", []), restored.get("outline") or {})
        if slides:
            outline = restored.get("outline") if isinstance(restored.get("outline"), dict) else {}
            return {
                "source": "generated",
                "conversation_id": conversation_id,
                "job_id": str(restored.get("job_id") or ""),
                "title": title or str(outline.get("title") or "PPT 演示"),
                "conversion_mode": mode,
                "slide_count": len(slides),
                "slides": slides,
                "pptx_ready": bool(restored.get("pptx_path") or restored.get("pptx_url") or restored.get("pptx_key")),
            }

    for message in reversed(messages):
        meta = message.get("meta") or {}
        if not isinstance(meta, dict):
            continue
        decks = meta.get("slide_decks") or meta.get("direct_slide_decks") or meta.get("slides")
        if isinstance(decks, list) and decks and all(isinstance(item, dict) for item in decks):
            slides = _slides_from_decks(decks)
            if slides:
                return {
                    "source": "generated",
                    "conversation_id": conversation_id,
                    "job_id": _extract_job_id_from_meta(meta),
                    "title": title or "PPT 演示",
                    "conversion_mode": str(meta.get("conversion_mode") or ""),
                    "slide_count": len(slides),
                    "slides": slides,
                    "pptx_ready": bool(meta.get("pptx_path") or meta.get("pptx_url")),
                }
        images = meta.get("preview_b64_list")
        if isinstance(images, list) and images:
            slides = _slides_from_images(images, meta.get("outline") if isinstance(meta.get("outline"), dict) else {})
            if slides:
                return {
                    "source": "generated",
                    "conversation_id": conversation_id,
                    "job_id": _extract_job_id_from_meta(meta),
                    "title": title or str((meta.get("outline") or {}).get("title") if isinstance(meta.get("outline"), dict) else "") or "PPT 演示",
                    "conversion_mode": str(meta.get("conversion_mode") or ""),
                    "slide_count": len(slides),
                    "slides": slides,
                    "pptx_ready": bool(meta.get("pptx_path") or meta.get("pptx_url")),
                }
        single = meta.get("preview_b64") or meta.get("image_b64") or meta.get("svg_b64")
        if isinstance(single, str) and single:
            kind = "svg" if meta.get("svg_b64") else "image"
            return {
                "source": "generated",
                "conversation_id": conversation_id,
                "job_id": _extract_job_id_from_meta(meta),
                "title": title or "PPT 演示",
                "conversion_mode": str(meta.get("conversion_mode") or ""),
                "slide_count": 1,
                "slides": [{
                    "id": "slide-1",
                    "index": 0,
                    "title": str(meta.get("title") or "第 1 页"),
                    "kind": kind,
                    "src": _presentation_src(single, kind),
                }],
                "pptx_ready": bool(meta.get("pptx_path") or meta.get("pptx_url")),
            }
    return None


_strip_data_url = ppt_workspace.strip_data_url
_serialize_direct_slide = ppt_workspace.serialize_direct_slide
_image_decks_to_outline = ppt_workspace.image_decks_to_outline
_selected_images_from_decks = ppt_workspace.selected_images_from_decks
_pptx_ready_from_state = ppt_workspace.pptx_ready_from_state
_pptx_versions_from_artifacts = ppt_workspace.pptx_versions_from_artifacts
_slide_decks_from_meta = ppt_workspace.slide_decks_from_meta
_apply_direct_artifacts_to_decks = ppt_workspace.apply_direct_artifacts_to_decks
_workspace_state_from_messages = ppt_workspace.workspace_state_from_messages
_image_decks_from_images = ppt_workspace.image_decks_from_images
_direct_decks_from_artifacts = ppt_workspace.direct_decks_from_artifacts
_serialize_image_slide_decks = ppt_workspace.serialize_image_slide_decks
_extract_job_id_from_meta = ppt_workspace.extract_job_id_from_meta
_workspace_payload_has_renderable_slides = ppt_workspace.workspace_payload_has_renderable_slides


def _workspace_payload_from_state(
    state: dict,
    job_id: str,
    messages: list[dict] | None = None,
    *,
    include_direct_slide_content: bool = True,
) -> dict:
    return ppt_workspace.workspace_payload_from_state(
        state,
        job_id,
        messages,
        clean_agent_steps=_clean_agent_steps_for_ui,
        workspace_phase=_workspace_phase,
        chat_messages_from_history=_chat_messages_from_history,
        include_direct_slide_content=include_direct_slide_content,
    )


@router.get("/presentation/recent")
async def list_presentable_ppts(
    limit: int = Query(default=30, ge=1, le=80),
    user: dict = Depends(_auth),
):
    requested_limit = max(1, min(limit, 80))
    version = await ui_cache.get_user_cache_version(user["id"], "history")
    cache_key = ui_cache.user_cache_key(user["id"], "ppt-recent", version, requested_limit)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached

    conversations = await conversation_repo.list_conversations(user["id"], "ppt", requested_limit, 0)
    messages_by_conversation = await conversation_repo.list_messages_for_conversations(
        [conv["id"] for conv in conversations],
        user["id"],
        light=True,
    )
    items = []
    for conv in conversations:
        job_id = ""
        slide_count = 0
        pptx_ready = False
        try:
            messages = messages_by_conversation.get(conv["id"], [])
            for message in reversed(messages):
                meta = message.get("meta") or {}
                if not isinstance(meta, dict):
                    continue
                job_id = job_id or _extract_job_id_from_meta(meta)
                if meta.get("type") == "pptx_done":
                    pptx_ready = True
                try:
                    slide_count = max(slide_count, int(meta.get("slide_count") or 0))
                except Exception:
                    pass
                for key in ("preview_b64_list_count", "slide_decks_count", "slides_count", "versions_count"):
                    try:
                        count = int(meta.get(key) or 0)
                    except Exception:
                        count = 0
                    if count:
                        slide_count = max(slide_count, count)
                if job_id and slide_count:
                    break
        except Exception:
            pass
        items.append({
            "conversation_id": conv["id"],
            "job_id": job_id,
            "title": conv["title"],
            "updated_at": conv["updated_at"],
            "message_count": conv.get("message_count", 0),
            "slide_count": slide_count,
            "pptx_ready": pptx_ready,
        })
    payload = {"items": items}
    await ui_cache.set_json(cache_key, payload, PPT_RECENT_CACHE_TTL_SECONDS)
    return payload


@router.get("/presentation/uploads")
async def list_uploaded_presentations(
    limit: int = Query(default=30, ge=1, le=80),
    user: dict = Depends(_auth),
):
    records = await ppt_upload_repo.list_uploads(user["id"], limit, 0)
    return {"items": records}


@router.get("/presentation/jobs/{job_id}")
async def get_job_presentation(job_id: str, user: dict = Depends(_auth)):
    payload = await _presentation_from_state(job_id, user)
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


@router.get("/presentation/uploads/{upload_id}")
async def get_uploaded_presentation(upload_id: str, user: dict = Depends(_auth)):
    record = await ppt_upload_repo.get_upload(upload_id, user["id"])
    if not record:
        raise HTTPException(404, "上传记录不存在")
    slides = record.get("slides") or []
    if not slides:
        raise HTTPException(404, "这份上传 PPT 还没有可演示的幻灯片")
    return {
        "source": "upload",
        "upload_id": record["id"],
        "title": record["title"],
        "file": {
            "key": record.get("source_key", ""),
            "url": record.get("source_url", ""),
            "mime_type": record.get("source_mime", ""),
            "size_bytes": record.get("source_size", 0),
            "sha256": record.get("source_sha256", ""),
            "filename": record.get("filename", ""),
        },
        "slide_count": len(slides),
        "slides": slides,
        "pptx_ready": False,
    }


@router.delete("/presentation/uploads/{upload_id}")
async def delete_uploaded_presentation(upload_id: str, user: dict = Depends(_auth)):
    async with acquire() as conn:
        async with conn.transaction():
            record = await ppt_upload_repo.delete_upload(upload_id, user["id"], conn=conn)
            if not record:
                raise HTTPException(404, "upload record not found")
            cleanup_records = {
                "task_id": upload_id,
                "object_keys": _upload_storage_keys(record),
                "upload": record,
            }
            cleanup_intent_id = await asset_lifecycle.stage_record_cleanup_intent(
                conn,
                user_id=user["id"],
                records=cleanup_records,
                reason="presentation-upload-delete",
            )
    await ui_cache.bump_user_cache_version(user["id"], "history", "storage")
    cleanup = await asset_lifecycle.process_record_cleanup_intent(
        cleanup_intent_id,
    )
    return {"success": True, "cleanup": cleanup}


@router.get("/presentation/conversations/{conversation_id}")
async def get_conversation_presentation(conversation_id: str, user: dict = Depends(_auth)):
    messages = await conversation_repo.get_conversation_messages(conversation_id, user["id"], light=False)
    conversation_title = ""
    try:
        conversations = await conversation_repo.list_conversations(user["id"], "ppt", 80, 0)
        conversation_title = next((item["title"] for item in conversations if item["id"] == conversation_id), "")
    except Exception:
        conversation_title = ""

    history_payload = _presentation_from_messages(messages, conversation_title, conversation_id)
    for message in reversed(messages):
        job_id = _extract_job_id_from_meta(message.get("meta") or {})
        if not job_id:
            continue
        try:
            state_payload = await _presentation_from_state(job_id, user)
            if history_payload and int(history_payload.get("slide_count") or 0) > int(state_payload.get("slide_count") or 0):
                return await asset_storage.prepare_image_asset_payload(history_payload, user["id"])
            return await asset_storage.prepare_image_asset_payload(state_payload, user["id"])
        except HTTPException:
            continue

    if not history_payload:
        raise HTTPException(404, "这份 PPT 还没有可演示的幻灯片")
    return await asset_storage.prepare_image_asset_payload(history_payload, user["id"])


@router.post("/presentation/upload")
async def upload_presentation_for_slideshow(
    file: UploadFile = File(...),
    user: dict = Depends(_auth),
):
    if not asset_storage.is_asset_storage_enabled():
        raise HTTPException(503, "对象存储未配置，暂时不能上传 PPT")

    filename = file.filename or "presentation.pptx"
    suffix = Path(filename).suffix.lower()
    if suffix not in {".ppt", ".pptx", ".pdf"}:
        raise HTTPException(400, "仅支持上传 PPT、PPTX 或 PDF 文件")

    max_bytes = max(settings.MAX_FILE_SIZE_MB, 1) * 1024 * 1024
    upload_id = str(uuid.uuid4())
    with tempfile.TemporaryDirectory(prefix="ppt-upload-") as tmp:
        path = Path(tmp) / f"upload{suffix}"
        size = 0
        with path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"文件不能超过 {settings.MAX_FILE_SIZE_MB}MB")
                out.write(chunk)
        if size <= 0:
            raise HTTPException(400, "上传文件为空")
        source_asset = await asset_storage.store_file_asset(
            file_path=path,
            user_id=user["id"],
            category="presentation_uploads",
            task_id=upload_id,
            filename=filename,
            content_type=file.content_type or "",
            retention_class="web_history",
        )
        if not source_asset:
            raise HTTPException(502, "PPT 上传对象存储失败，请稍后重试")
        uploaded_keys = [str(source_asset.get("key") or "").strip()]
        try:
            rendered_pages = await asyncio.to_thread(render_presentation_pages, path)
        except PresentationRenderError as e:
            await asset_storage.delete_asset_keys_with_queue(
                uploaded_keys,
                user_id=user["id"],
                reason="ppt-upload-render-rollback",
            )
            raise HTTPException(422, str(e))
        except Exception as e:
            await asset_storage.delete_asset_keys_with_queue(
                uploaded_keys,
                user_id=user["id"],
                reason="ppt-upload-render-rollback",
            )
            raise HTTPException(500, f"文件转换失败：{e}")

        slide_items = []
        for idx, page in enumerate(rendered_pages):
            page_asset = await asset_storage.store_file_bytes(
                data=page.data,
                user_id=user["id"],
                category="presentation_uploads",
                task_id=upload_id,
                filename=f"slide-{idx + 1:03d}{page.extension}",
                content_type=page.mime_type,
                retention_class="web_history",
            )
            if not page_asset:
                await asset_storage.delete_asset_keys_with_queue(
                    uploaded_keys,
                    user_id=user["id"],
                    reason="ppt-upload-slide-rollback",
                )
                raise HTTPException(502, f"PPT slide {idx + 1} preview upload failed")
            uploaded_keys.append(str(page_asset.get("key") or "").strip())
            slide_items.append({
                "id": f"upload-slide-{idx + 1}",
                "index": idx,
                "title": f"第 {idx + 1} 页",
                "kind": "image",
                "src": page_asset["url"],
                "storage_key": page_asset["key"],
                "size_bytes": page_asset.get("size_bytes", len(page.data)),
                "width": page.width,
                "height": page.height,
            })
    title = Path(filename).stem or "上传 PPT"
    try:
        record = await ppt_upload_repo.create_upload(
            upload_id=upload_id,
            user_id=user["id"],
            title=title,
            filename=filename,
            source_asset=source_asset,
            slides=slide_items,
            expires_at=source_asset.get("expires_at", ""),
            storage_provider=getattr(settings, "STORAGE_PROVIDER", "s3"),
        )
    except Exception:
        await asset_storage.delete_asset_keys_with_queue(
            uploaded_keys,
            user_id=user["id"],
            reason="ppt-upload-record-rollback",
        )
        raise
    await ui_cache.bump_user_cache_version(user["id"], "history", "storage")
    return {
        "source": "upload",
        "upload_id": record["id"],
        "title": record["title"],
        "file": source_asset,
        "slide_count": len(slide_items),
        "slides": slide_items,
        "pptx_ready": False,
    }


@router.post("/presentation/desktop-convert")
async def convert_presentation_for_desktop(
    file: UploadFile = File(...),
    user: dict = Depends(_auth),
):
    """Temporarily render a PPT/PPTX/PDF for the desktop app.

    This endpoint intentionally does not write to object storage or create a
    cloud upload record. The desktop client saves the returned pages locally.
    """
    filename = file.filename or "presentation.pptx"
    suffix = Path(filename).suffix.lower()
    if suffix not in {".ppt", ".pptx", ".pdf"}:
        raise HTTPException(400, "仅支持上传 PPT、PPTX 或 PDF 文件")

    max_bytes = max(settings.MAX_FILE_SIZE_MB, 1) * 1024 * 1024
    upload_id = str(uuid.uuid4())
    with tempfile.TemporaryDirectory(prefix="ppt-desktop-convert-") as tmp:
        path = Path(tmp) / f"upload{suffix}"
        size = 0
        with path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"文件不能超过 {settings.MAX_FILE_SIZE_MB}MB")
                out.write(chunk)
        if size <= 0:
            raise HTTPException(400, "上传文件为空")
        try:
            rendered_pages = await asyncio.to_thread(render_presentation_pages, path)
        except PresentationRenderError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            raise HTTPException(500, f"文件转换失败：{e}")

        slide_items = []
        for idx, page in enumerate(rendered_pages):
            encoded = base64.b64encode(page.data).decode("ascii")
            slide_items.append({
                "id": f"desktop-slide-{idx + 1}",
                "index": idx,
                "title": f"第 {idx + 1} 页",
                "kind": "image",
                "src": f"data:{page.mime_type};base64,{encoded}",
                "mime_type": page.mime_type,
                "extension": page.extension,
                "size_bytes": len(page.data),
                "width": page.width,
                "height": page.height,
            })

    title = Path(filename).stem or "上传 PPT"
    return {
        "source": "desktop_temp",
        "upload_id": upload_id,
        "title": title,
        "file": {
            "filename": filename,
            "mime_type": file.content_type or "",
            "size_bytes": size,
        },
        "slide_count": len(slide_items),
        "slides": slide_items,
        "pptx_ready": False,
    }


@router.get("/direct-slides/{job_id}")
async def get_direct_slides(job_id: str, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    decks = state.get("direct_slide_decks") or []
    if not isinstance(decks, list) or not decks:
        # Only legacy jobs without durable direct decks need the expensive
        # artifact/file backfill. Current workspaces must not rewrite every
        # SVG just because a client opens its history.
        try:
            state, decks = await _agent.get_ppt_master_direct_slides(job_id)
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
    return {
        "job_id": job_id,
        "outline": state.get("outline"),
        "slides": [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(decks)],
        "slide_count": len(decks),
        "status": state.get("status"),
        "message": state.get("message", ""),
        "error": state.get("error", ""),
        "pending_slide_task": state.get("pending_slide_task"),
        "conversion_mode": "ppt_master_direct",
    }


@router.get("/workspace/conversations/{conversation_id}")
async def get_workspace_by_conversation(conversation_id: str, user: dict = Depends(_auth)):
    # Direct SVG histories are opened from a compact manifest. The individual
    # pages are requested afterwards, so a single large deck cannot block the
    # whole workbench (especially on mobile networks).
    version = await ui_cache.get_user_cache_version(user["id"], "history")
    cache_key = ui_cache.user_cache_key(user["id"], "ppt-workspace-manifest", version, conversation_id)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return await asset_storage.prepare_image_asset_payload(cached, user["id"])

    messages = await conversation_repo.get_conversation_messages(conversation_id, user["id"], light=True)
    history_state = _workspace_state_from_messages(messages, conversation_id)
    history_payload = (
        _workspace_payload_from_state(
            history_state,
            str(history_state.get("job_id") or ""),
            messages,
            include_direct_slide_content=False,
        )
        if history_state else None
    )
    for message in reversed(messages):
        job_id = _extract_job_id_from_meta(message.get("meta") or {})
        if not job_id:
            continue
        state = await _agent.get_state(job_id)
        if state:
            state = await _restore_legacy_quality_blocked_export(state, job_id)
            mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
            if mode == "ppt_master_direct" and not state.get("direct_slide_decks"):
                try:
                    state, direct_decks = await _agent.get_ppt_master_direct_slides(job_id)
                    state["direct_slide_decks"] = direct_decks
                except ValueError:
                    pass
            state_payload = _workspace_payload_from_state(
                state,
                job_id,
                messages,
                include_direct_slide_content=mode != "ppt_master_direct",
            )
            if (
                _workspace_payload_has_renderable_slides(history_payload)
                and int(history_payload.get("slide_count") or 0) > int(state_payload.get("slide_count") or 0)
            ):
                prepared_history = await asset_storage.prepare_image_asset_payload(history_payload, user["id"])
                await ui_cache.set_json(cache_key, prepared_history, PPT_WORKSPACE_CACHE_TTL_SECONDS)
                return prepared_history
            prepared_state = await asset_storage.prepare_image_asset_payload(state_payload, user["id"])
            await ui_cache.set_json(cache_key, prepared_state, PPT_WORKSPACE_CACHE_TTL_SECONDS)
            return prepared_state

    if _workspace_payload_has_renderable_slides(history_payload):
        prepared_history = await asset_storage.prepare_image_asset_payload(history_payload, user["id"])
        await ui_cache.set_json(cache_key, prepared_history, PPT_WORKSPACE_CACHE_TTL_SECONDS)
        return prepared_history

    # Old image2 PPT records may only have inline base64 payloads. Keep the fast
    # path above for R2-backed records, and only pay the full-message cost here.
    full_messages = await conversation_repo.get_conversation_messages(conversation_id, user["id"], light=False)
    full_state = _workspace_state_from_messages(full_messages, conversation_id)
    if not full_state:
        raise HTTPException(404, "这条 PPT 记录还没有可恢复的工作区")
    payload = _workspace_payload_from_state(full_state, str(full_state.get("job_id") or ""), full_messages)
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


@router.get("/workspace/{job_id}")
async def get_workspace(job_id: str, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    state = await _restore_legacy_quality_blocked_export(state, job_id)

    mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
    if mode == "ppt_master_direct" and not state.get("direct_slide_decks"):
        state, direct_decks = await _agent.get_ppt_master_direct_slides(job_id)
        state["direct_slide_decks"] = direct_decks
    payload = _workspace_payload_from_state(
        state,
        job_id,
        include_direct_slide_content=mode != "ppt_master_direct",
    )
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


@router.get("/workspace/{job_id}/slides")
async def get_workspace_direct_slides(
    job_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=1, ge=1, le=3),
    user: dict = Depends(_auth),
):
    """Fetch a bounded direct-SVG page batch after a workspace manifest."""
    try:
        decks, slide_total = await _agent.get_ppt_master_direct_slide_batch(job_id, offset, limit)
    except ValueError as e:
        status_code = 400 if str(e) == "当前任务不是可编辑演示文稿" else 404
        raise HTTPException(status_code, str(e)) from e
    start = min(offset, slide_total)
    end = start + len(decks)
    slides = []
    # ``get_ppt_master_direct_slide_batch`` already applies the requested
    # offset.  Slicing this bounded result a second time makes every page
    # after offset 0 appear as a successful-but-empty response.
    for idx, deck in enumerate(decks, start=start):
        slide = _serialize_direct_slide(deck, idx)
        # ``versions`` already contains the selected SVG. Keeping a second
        # ``svg_b64`` copy doubles the payload for every large direct page.
        slide.pop("svg_b64", None)
        slides.append(slide)
    return {
        "job_id": job_id,
        "slides": slides,
        "slide_total": slide_total,
        "next_offset": end if end < slide_total else None,
    }


@router.post("/direct-slides-sync/{job_id}")
async def sync_direct_slides(job_id: str, body: DirectSlideSyncRequest, user: dict = Depends(_auth)):
    try:
        state = await _agent.sync_ppt_master_direct_slides(
            job_id,
            body.slides,
            rebuild=body.rebuild,
        )
        decks = state.get("direct_slide_decks", [])
        if state.get("conversation_id"):
            try:
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="assistant",
                    content=(
                        f"已同步可编辑页面的顺序与版本选择，共 {len(decks)} 页，并重建 PPT。"
                        if body.rebuild else
                        f"已同步可编辑页面的顺序与版本选择，共 {len(decks)} 页，请重新导出 PPT。"
                    ),
                    meta={
                        "type": "direct_slides_sync",
                        "job_id": job_id,
                        "slide_count": len(decks),
                        "conversion_mode": "ppt_master_direct",
                    },
                )
            except Exception:
                pass
        return {
            "ok": True,
            "outline": state.get("outline"),
            "slides": [_serialize_direct_slide(deck, idx) for idx, deck in enumerate(decks)],
            "slide_count": len(decks),
            "status": state.get("status"),
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"可编辑页面同步失败：{e}")


@router.post("/slides-sync/{job_id}")
async def sync_image_slides(job_id: str, body: ImageSlideSyncRequest, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    if normalize_ppt_conversion_mode(state.get("conversion_mode")) == "ppt_master_direct":
        raise HTTPException(400, "可编辑演示文稿请使用对应的页面同步接口")
    if not body.slides:
        raise HTTPException(400, "没有可同步的幻灯片")

    decks: list[dict] = []
    for idx, item in enumerate(body.slides):
        if not isinstance(item, dict):
            continue
        versions = [_strip_data_url(v) for v in (item.get("versions") or [])]
        versions = [v for v in versions if v]
        if not versions:
            continue
        selected = item.get("selectedVersionIndex", item.get("selected_version_index", 0))
        try:
            selected_idx = int(selected)
        except Exception:
            selected_idx = 0
        selected_idx = min(max(selected_idx, 0), max(len(versions) - 1, 0))
        slide_info = item.get("slide") if isinstance(item.get("slide"), dict) else {}
        title = str(item.get("title") or slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(item.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info = dict(slide_info)
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        if prompt:
            slide_info["prompt"] = prompt
            slide_info.setdefault("layout_hint", prompt)
        decks.append({
            "id": str(item.get("id") or f"slide-{idx + 1}"),
            "title": title,
            "prompt": prompt,
            "kind": "image",
            "versions": versions,
            "selected_version_index": selected_idx,
            "slide": slide_info,
        })

    if not decks:
        raise HTTPException(400, "没有有效的幻灯片")

    state["image_slide_decks"] = decks
    state["slide_images_b64"] = _selected_images_from_decks(decks)
    state["outline"] = _image_decks_to_outline(state, decks)
    if state.get("status") == "done":
        state["status"] = "checkpoint"
        state["progress"] = 50
        state["pptx_path"] = ""
        state["message"] = "幻灯片已调整，请重新确认生成 PPTX"
    state.setdefault("snapshots", {})["after_images"] = {
        "outline": state.get("outline"),
        "slide_images_b64": state["slide_images_b64"],
        "image_slide_decks": decks,
    }
    await save_ppt_state(job_id, state)
    if state.get("conversation_id"):
        try:
            await conversation_repo.add_message(
                conversation_id=state["conversation_id"],
                role="assistant",
                content=f"已同步幻灯片顺序与版本选择，共 {len(decks)} 页。",
                meta={
                    "type": "slides_sync",
                    "job_id": job_id,
                    "slide_count": len(decks),
                    "conversion_mode": normalize_ppt_conversion_mode(state.get("conversion_mode")),
                },
            )
        except Exception:
            pass
    return {
        "ok": True,
        "outline": state.get("outline"),
        "slides": _serialize_image_slide_decks(state),
        "slide_count": len(decks),
        "status": state.get("status"),
    }


async def _run_direct_slide_render_background(job_id: str, payload: dict) -> None:
    try:
        result = await _agent.render_ppt_master_direct_slide(
            job_id,
            prompt=payload.get("prompt") or "",
            slide_index=payload.get("slide_index"),
            source_svg_b64=payload.get("source_svg_b64") or payload.get("source_image_b64") or "",
            title=payload.get("title") or "",
            insert_after_index=payload.get("insert_after_index"),
            rebuild=bool(payload.get("rebuild")),
        )
        state = await _agent.get_state(job_id)
        if not state:
            return
        state.pop("pending_slide_task", None)
        state["error"] = ""
        await save_ppt_state(job_id, state)
        if not state.get("conversation_id"):
            return
        try:
            is_add = payload.get("insert_after_index") is not None and not (
                payload.get("source_svg_b64") or payload.get("source_image_b64")
            )
            slide_index = int(result.get("slide_index", payload.get("slide_index") or 0))
            deck = result.get("slide") or {}
            versions = deck.get("versions") or []
            selected = deck.get("selected_version_index", deck.get("selectedVersionIndex", len(versions) - 1))
            try:
                selected_idx = int(selected)
            except Exception:
                selected_idx = len(versions) - 1
            selected_svg = versions[selected_idx] if versions and 0 <= selected_idx < len(versions) else ""
            prompt = str(payload.get("prompt") or "").strip()
            await conversation_repo.add_message(
                conversation_id=state["conversation_id"],
                role="user",
                content=f"{'新增' if is_add else '修改'}第 {slide_index + 1} 页：{prompt}",
                meta={
                    "type": "user_action",
                    "action": "direct_slide_add" if is_add else "direct_slide_edit",
                    "job_id": job_id,
                    "slide_index": slide_index,
                },
            )
            await conversation_repo.add_message(
                conversation_id=state["conversation_id"],
                role="assistant",
                content=f"第 {slide_index + 1} 页已生成，工作区预览已更新。",
                meta={
                    "type": "direct_slide_added" if is_add else "direct_slide_version",
                    "job_id": job_id,
                    "slide_index": slide_index,
                    "svg_b64": selected_svg,
                    "prompt": prompt,
                    "conversion_mode": "ppt_master_direct",
                },
            )
        except Exception:
            pass
    except Exception as e:
        async with get_ppt_job_lock(job_id):
            state = await _agent.get_state(job_id)
            if state:
                state["status"] = "checkpoint"
                state["progress"] = 100
                state["message"] = f"单页生成失败：{e}"
                state["error"] = str(e)
                state.pop("pending_slide_task", None)
                await save_ppt_state(job_id, state)


@router.post("/direct-slide-render/{job_id}")
async def queue_direct_slide_render(job_id: str, body: SlideRenderRequest, user: dict = Depends(_auth)):
    """Queue one PPT Master direct SVG slide update and return immediately."""
    from core.rate_limit import rate_limit, RateLimitExceeded

    try:
        await rate_limit(user["id"], "generate")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(400, "提示词不能为空")

    async with get_ppt_job_lock(job_id):
        state = await _agent.get_state(job_id)
        if not state:
            raise HTTPException(404, "任务不存在")
        if normalize_ppt_conversion_mode(state.get("conversion_mode")) != "ppt_master_direct":
            raise HTTPException(400, "当前任务不是可编辑演示文稿")
        decks = state.get("direct_slide_decks") or []
        if not decks and not state.get("outline"):
            raise HTTPException(400, "没有可编辑的 PPT 页面")
        merge_attachment_state(state, body.attachments, body.attachment_context)
        is_add = body.insert_after_index is not None and not (body.source_svg_b64 or body.source_image_b64)
        if is_add:
            insert_after = body.insert_after_index if body.insert_after_index is not None else len(decks) - 1
            target_index = min(max(insert_after + 1, 0), len(decks))
        else:
            target_index = min(max(body.slide_index or 0, 0), max(len(decks) - 1, 0))
        state["status"] = "checkpoint"
        state["progress"] = 100
        state["message"] = f"正在{'新增' if is_add else '编辑'}第 {target_index + 1} 页..."
        state["error"] = ""
        for key in ("pptx_path", "pptx_url", "pptx_key", "pptx_filename", "pptx_file_asset_id"):
            state[key] = ""
        state["pending_slide_task"] = {
            "type": "direct_slide_add" if is_add else "direct_slide_edit",
            "slide_index": target_index,
            "prompt": prompt,
        }
        await save_ppt_state(job_id, state)

    await enqueue(
        task_type="ppt-direct-slide-render",
        task_id=f"{job_id}:direct-slide:{uuid.uuid4().hex[:8]}",
        payload={"job_id": job_id, "slide_payload": _slide_render_payload(body), "user_id": user["id"]},
        priority="normal",
        user_id=user["id"],
    )
    return {
        "ok": True,
        "accepted": True,
        "status": "queued",
        "slide_index": target_index,
        "insert_after_index": body.insert_after_index,
        "progress": state["progress"],
        "message": state["message"],
    }


@router.post("/direct-slide-render-sync/{job_id}")
async def render_direct_slide(job_id: str, body: SlideRenderRequest, user: dict = Depends(_auth)):
    """Generate or edit one PPT Master direct SVG slide, optionally rebuilding the PPTX."""
    return await queue_direct_slide_render(job_id, body, user)

    from core.rate_limit import rate_limit, RateLimitExceeded

    try:
        await rate_limit(user["id"], "generate")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    try:
        result = await _agent.render_ppt_master_direct_slide(
            job_id,
            prompt=body.prompt,
            slide_index=body.slide_index,
            source_svg_b64=body.source_svg_b64 or body.source_image_b64,
            title=body.title,
            insert_after_index=body.insert_after_index,
            rebuild=body.rebuild,
        )
        state = await _agent.get_state(job_id)
        if state and state.get("conversation_id"):
            try:
                is_add = body.insert_after_index is not None and not (body.source_svg_b64 or body.source_image_b64)
                slide_index = int(result.get("slide_index", body.slide_index or 0))
                deck = result.get("slide") or {}
                versions = deck.get("versions") or []
                selected = deck.get("selected_version_index", deck.get("selectedVersionIndex", len(versions) - 1))
                try:
                    selected_idx = int(selected)
                except Exception:
                    selected_idx = len(versions) - 1
                selected_svg = versions[selected_idx] if versions and 0 <= selected_idx < len(versions) else ""
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="user",
                    content=(
                        f"新增第 {slide_index + 1} 页：{body.prompt.strip()}"
                        if is_add else f"修改第 {slide_index + 1} 页：{body.prompt.strip()}"
                    ),
                    meta={
                        "type": "user_action",
                        "action": "direct_slide_add" if is_add else "direct_slide_edit",
                        "job_id": job_id,
                        "slide_index": slide_index,
                    },
                )
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="assistant",
                    content=(
                        (
                            f"已新增第 {slide_index + 1} 页，并重建 PPTX。"
                            if body.rebuild else
                            f"已新增第 {slide_index + 1} 页预览，请重新生成 PPTX。"
                        )
                        if is_add else
                        (
                            f"第 {slide_index + 1} 页已生成新版本，并重建 PPTX。"
                            if body.rebuild else
                            f"第 {slide_index + 1} 页预览已更新，请重新生成 PPTX。"
                        )
                    ),
                    meta={
                        "type": "direct_slide_added" if is_add else "direct_slide_version",
                        "job_id": job_id,
                        "slide_index": slide_index,
                        "svg_b64": selected_svg,
                        "prompt": body.prompt.strip(),
                        "conversion_mode": "ppt_master_direct",
                    },
                )
            except Exception:
                pass
        return {
            "ok": True,
            "slide_index": result.get("slide_index"),
            "slide": _serialize_direct_slide(result.get("slide") or {}, int(result.get("slide_index") or 0)),
            "slides": [
                _serialize_direct_slide(deck, idx)
                for idx, deck in enumerate(result.get("slides") or [])
            ],
            "outline": result.get("outline"),
            "pptx_path": result.get("pptx_path", ""),
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"可编辑页面生成失败：{e}")


@router.get("/artifacts/{job_id}")
async def get_artifacts(job_id: str, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    return {
        "job_id": job_id,
        "artifacts": state.get("artifacts", []),
        "slide_count": len([s for s in state.get("slide_images_b64", []) if s]),
        "outline": state.get("outline"),
    }


async def _run_image_slide_render_background(job_id: str, payload: dict, user_id: str) -> None:
    try:
        await render_slide(job_id, SlideRenderRequest(**payload), {"id": user_id})
        async with get_ppt_job_lock(job_id):
            state = await _agent.get_state(job_id)
            if state:
                state.pop("pending_slide_task", None)
                state["error"] = ""
                await save_ppt_state(job_id, state)
    except Exception as e:
        detail = getattr(e, "detail", None) or str(e)
        async with get_ppt_job_lock(job_id):
            state = await _agent.get_state(job_id)
            if state:
                state["status"] = "checkpoint"
                state["progress"] = 50
                state["message"] = f"单页生成失败：{detail}"
                state["error"] = str(detail)
                state.pop("pending_slide_task", None)
                await save_ppt_state(job_id, state)


@router.post("/slide-render/{job_id}")
async def queue_slide_render(job_id: str, body: SlideRenderRequest, user: dict = Depends(_auth)):
    """Queue one image-based PPT preview slide update and return immediately."""
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(400, "提示词不能为空")
    async with get_ppt_job_lock(job_id):
        state = await _agent.get_state(job_id)
        if not state:
            raise HTTPException(404, "任务不存在")
        if state["status"] not in ("checkpoint", "done"):
            raise HTTPException(400, "请先生成预览图后再编辑单页")
        merge_attachment_state(state, body.attachments, body.attachment_context)
        decks = _serialize_image_slide_decks(state)
        is_add = body.insert_after_index is not None and not body.source_image_b64
        if is_add:
            insert_after = body.insert_after_index if body.insert_after_index is not None else len(decks) - 1
            target_index = min(max(insert_after + 1, 0), len(decks))
        else:
            target_index = min(max(body.slide_index or 0, 0), max(len(decks) - 1, 0))
        state["status"] = "checkpoint"
        state["progress"] = 88
        state["message"] = f"正在{'新增' if is_add else '编辑'}第 {target_index + 1} 页..."
        state["error"] = ""
        state["pptx_path"] = ""
        state["pending_slide_task"] = {
            "type": "slide_add" if is_add else "slide_edit",
            "slide_index": target_index,
            "prompt": prompt,
        }
        await save_ppt_state(job_id, state)

    await enqueue(
        task_type="ppt-slide-render",
        task_id=f"{job_id}:slide:{uuid.uuid4().hex[:8]}",
        payload={"job_id": job_id, "slide_payload": _slide_render_payload(body), "user_id": str(user["id"])},
        priority="normal",
        user_id=user["id"],
    )
    return {
        "ok": True,
        "accepted": True,
        "status": "queued",
        "slide_index": target_index,
        "insert_after_index": body.insert_after_index,
        "message": state["message"],
    }


@router.post("/slide-render-sync/{job_id}")
async def render_slide(job_id: str, body: SlideRenderRequest, user: dict = Depends(_auth)):
    """Generate or edit a single PPT preview slide image."""
    from core.rate_limit import rate_limit, RateLimitExceeded
    from services.ai_client import call_image, get_default_model_id
    from services.agents.ppt_agent import _build_slide_prompt, _image_call_sem

    try:
        await rate_limit(user["id"], "generate")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(400, "提示词不能为空")

    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")
    if state["status"] not in ("checkpoint", "done"):
        raise HTTPException(400, "请先生成预览图后再编辑单页")
    merge_attachment_state(state, body.attachments, body.attachment_context)

    image_model_id = state.get("image_model_id") or await get_default_model_id("generate")
    if not image_model_id:
        raise HTTPException(400, "未找到可用的图像生成模型")

    try:
        outline = state.get("outline") or {}
        outline_slides = outline.get("slides", []) or []
        slide_index = body.slide_index if body.slide_index is not None else len(outline_slides)
        source_slide = (
            dict(outline_slides[slide_index])
            if 0 <= slide_index < len(outline_slides) and isinstance(outline_slides[slide_index], dict)
            else {}
        )
        slide_info = {
            **source_slide,
            "page": slide_index + 1,
            "title": body.title.strip() or source_slide.get("title") or (prompt[:40] if prompt else f"第 {slide_index + 1} 页"),
            "type": source_slide.get("type") or ("cover" if slide_index == 0 else "content"),
            "points": source_slide.get("points") or [prompt],
            "layout_hint": prompt,
            "prompt": prompt,
        }
        full_prompt = _build_slide_prompt(
            slide_info,
            outline.get("style") or state.get("style_hint") or "简洁商务风",
            outline.get("color_scheme") or "深蓝配金色",
            reference_guidance=state.get("reference_image_guidance", ""),
            attachment_context=state.get("attachment_context", ""),
        )

        ref_images: list[bytes] = []
        if body.source_image_b64:
            ref_images.append(await _resolve_ppt_image_bytes(body.source_image_b64, str(user["id"])))
            full_prompt += (
                "\n\nEdit the provided slide image according to the user requirement. "
                "Keep the same 16:9 canvas, preserve useful layout continuity, and return one complete slide."
            )
        elif state.get("ref_image_b64"):
            ref_images.append(await _resolve_ppt_image_bytes(state["ref_image_b64"], str(user["id"])))

        operation_digest = hashlib.sha256(
            f"{slide_index}|{body.insert_after_index}|{prompt}|{body.source_image_b64}|{body.source_svg_b64}".encode("utf-8")
        ).hexdigest()[:20]
        async with _image_call_sem:
            img_bytes = await execute_billed_model_call(
                user_id=user["id"],
                model_id=image_model_id,
                expected_category="generate",
                description=f"PPT 单页预览图生成 · {body.title or f'第 {slide_index + 1} 页'}",
                related_task_id=None,
                idempotency_key=f"ppt:{job_id}:slide-render:{slide_index + 1}:{operation_digest}:attempt:1",
                invoke=lambda: call_image(
                    model_id=image_model_id,
                    prompt=full_prompt,
                    ref_images=ref_images or None,
                    size=image_output_size("16:9", state.get("output_resolution")),
                    quality=state.get("image_quality", "auto"),
                    force_size=True,
                ),
            )

        image_b64 = await store_ppt_slide_image_asset(
            state,
            job_id,
            img_bytes,
            prompt=full_prompt,
            model_id=image_model_id,
            slide_index=slide_index,
            item_id=f"slide-{slide_index + 1}-version-{uuid.uuid4().hex[:8]}",
        )
        artifact_type = "slide_added" if body.insert_after_index is not None and not body.source_image_b64 else "slide_version"
        decks = _serialize_image_slide_decks(state)
        if artifact_type == "slide_version":
            if 0 <= slide_index < len(decks):
                versions = list(decks[slide_index].get("versions") or [])
                if image_b64 not in versions:
                    versions.append(image_b64)
                decks[slide_index] = {
                    **decks[slide_index],
                    "title": slide_info.get("title") or decks[slide_index].get("title") or f"第 {slide_index + 1} 页",
                    "prompt": prompt,
                    "versions": versions,
                    "selectedVersionIndex": len(versions) - 1,
                    "slide": slide_info,
                }
            else:
                decks.append({
                    "id": f"slide-{slide_index + 1}",
                    "title": slide_info.get("title") or f"第 {slide_index + 1} 页",
                    "prompt": prompt,
                    "kind": "image",
                    "versions": [image_b64],
                    "selectedVersionIndex": 0,
                    "slide": slide_info,
                })
        else:
            insert_at = min(max(slide_index, 0), len(decks))
            decks.insert(insert_at, {
                "id": f"slide-new-{uuid.uuid4().hex[:8]}",
                "title": slide_info.get("title") or f"新增页 {insert_at + 1}",
                "prompt": prompt,
                "kind": "image",
                "versions": [image_b64],
                "selectedVersionIndex": 0,
                "slide": slide_info,
            })
        for idx, deck in enumerate(decks):
            deck["selected_version_index"] = deck.pop("selectedVersionIndex", deck.get("selected_version_index", 0))
            slide = dict(deck.get("slide") or {})
            slide["page"] = idx + 1
            deck["slide"] = slide
        state["image_slide_decks"] = decks
        state["slide_images_b64"] = _selected_images_from_decks(decks)
        state["outline"] = _image_decks_to_outline(state, decks)
        if state.get("status") == "done":
            state["status"] = "checkpoint"
            state["progress"] = 50
            state["pptx_path"] = ""
            state["message"] = "幻灯片已调整，请重新确认生成 PPTX"
        append_ppt_artifact(
            state,
            artifact_type,
            slide_index=slide_index,
            insert_after_index=body.insert_after_index,
            image_b64=image_b64,
            prompt=prompt,
            title=slide_info.get("title"),
        )
        await save_ppt_state(job_id, state)
        if state.get("conversation_id"):
            try:
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="assistant",
                    content=(
                        f"第 {slide_index + 1} 页已生成新版本"
                        if artifact_type == "slide_version"
                        else f"已新增第 {slide_index + 1} 页"
                    ),
                    meta={
                        "type": artifact_type,
                        "job_id": job_id,
                        "slide_index": slide_index,
                        "preview_b64": image_b64,
                        "prompt": prompt,
                    },
                )
            except Exception:
                pass

        return {
            "ok": True,
            "image_b64": image_b64,
            "slide": slide_info,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"单页生成失败：{e}")


@router.post("/confirm-outline/{job_id}")
async def confirm_outline(
    job_id: str,
    body: ConfirmOutlineRequest | None = None,
    user: dict = Depends(_auth),
):
    """用户确认大纲后，按模式生成全部页面并进入预览确认。"""
    async with get_ppt_job_lock(job_id):
        state = await _agent.get_state(job_id)
        if not state:
            raise HTTPException(404, "任务不存在")
        mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))
        if state["status"] == "generating_images":
            return {"ok": True, "status": "generating_images", "deduped": True}
        if state["status"] in ("confirmed", "analyzing", "building"):
            return {"ok": True, "status": state["status"], "deduped": True}
        if state["status"] in ("checkpoint", "done"):
            return {"ok": True, "status": state["status"], "deduped": True}
        if state["status"] != "outline_done":
            raise HTTPException(400, f"任务不在大纲确认状态（当前：{state['status']}）")

        if body and body.outline:
            outline = dict(body.outline)
            slides = outline.get("slides") or []
            if not isinstance(slides, list) or not slides:
                raise HTTPException(400, "大纲至少需要 1 页")
            cleaned_slides = []
            for idx, slide in enumerate(slides):
                if not isinstance(slide, dict):
                    continue
                title = str(slide.get("title") or f"第 {idx + 1} 页").strip()
                points = slide.get("points") or []
                if isinstance(points, str):
                    points = [p.strip() for p in points.splitlines() if p.strip()]
                cleaned_slides.append({
                    **slide,
                    "page": int(slide.get("page") or idx + 1),
                    "title": title,
                    "points": [str(p).strip() for p in points if str(p).strip()],
                    "layout_hint": str(slide.get("layout_hint") or slide.get("prompt") or "").strip(),
                    "prompt": str(slide.get("prompt") or slide.get("layout_hint") or "").strip(),
                })
            if not cleaned_slides:
                raise HTTPException(400, "大纲至少需要 1 页有效页面")
            outline["slides"] = cleaned_slides
            outline["title"] = str(outline.get("title") or state.get("topic") or "PPT 大纲").strip()
            state["outline"] = outline
            state["page_count"] = len(cleaned_slides)

        # 记录用户确认操作
        if state.get("conversation_id"):
            try:
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="user",
                    content="确认大纲，开始生成可编辑演示文稿" if mode == "ppt_master_direct" else "确认大纲，开始生成图片页面",
                    meta={"type": "user_action", "action": "confirm_outline", "job_id": job_id, "conversion_mode": mode},
                )
            except Exception:
                pass

        if mode == "ppt_master_direct":
            state["status"] = "confirmed"
            state["progress"] = max(int(state.get("progress") or 15), 18)
            state["message"] = "确认大纲，开始生成可编辑演示文稿..."
            await save_ppt_state(job_id, state)
            await enqueue(
                task_type="ppt-confirm-outline-direct",
                task_id=f"{job_id}:confirm-direct",
                payload={"job_id": job_id, "user_id": user["id"]},
                priority="normal",
                user_id=user["id"],
            )
            return {"ok": True, "status": "confirmed"}

        state["status"] = "generating_images"
        state["progress"] = max(int(state.get("progress") or 15), 16)
        state["slide_images_b64"] = []
        state["message"] = "确认大纲，开始逐页生成幻灯片图片..."
        await save_ppt_state(job_id, state)

        # Queue preview slide generation; each slide is saved as it finishes.
        await enqueue(
            task_type="ppt-confirm-outline-images",
            task_id=f"{job_id}:confirm-images",
            payload={"job_id": job_id, "user_id": user["id"]},
            priority="normal",
            user_id=user["id"],
        )
        return {"ok": True, "status": "generating_images"}


@router.post("/confirm/{job_id}")
async def confirm_checkpoint(
    job_id: str,
    body: ConfirmRequest,
    user: dict = Depends(_auth),
):
    try:
        charged = {"cost": 0.0, "slide_count": 0, "conversion_mode": ""}

        async def precheck_and_reserve(state: dict, slide_count: int, conversion_mode: str):
            """在 checkpoint 状态切换前做预检，避免状态切换后扣费失败卡死"""
            cost = get_ppt_conversion_cost(conversion_mode, slide_count)
            charged.update({
                "cost": cost,
                "slide_count": slide_count,
                "conversion_mode": conversion_mode,
            })
            if cost <= 0:
                return
            # 用预留机制，防止并发绕过
            from core.credit_reserve import reserve_for_task, get_available_balance
            ok = await reserve_for_task(user["id"], f"ppt-convert:{job_id}", cost)
            if not ok:
                avail = await get_available_balance(user["id"])
                raise HTTPException(
                    402,
                    f"积分不足，PPT 转换需要 {cost} 积分，可用余额 {avail:.2f}（可能有进行中的任务占用）",
                )

        async def consume_after_confirm(state: dict, slide_count: int, conversion_mode: str):
            """状态切换成功后真实扣费并释放预留。若扣费失败，释放预留并回滚状态"""
            cost = charged["cost"]
            if cost <= 0:
                return
            try:
                from core import credit_reserve
                from repositories import credit_repo
                reservation = await credit_reserve.get_task_reservation(f"ppt-convert:{job_id}")
                await credit_repo.consume_credits(
                    user_id=user["id"],
                    amount=cost,
                    description=f"PPT 转换 · {MODE_LABELS.get(conversion_mode, conversion_mode)} · {slide_count} 页",
                    related_task_id=None,
                    idempotency_key=f"ppt-convert:{job_id}",
                    funding_source=reservation.funding_source if reservation else None,
                    subscription_id=reservation.subscription_id if reservation else None,
                )
                await credit_reserve.release_task_reservation(f"ppt-convert:{job_id}")
            except Exception as e:
                # 扣费失败：释放预留并标记 job 回到 checkpoint 状态（避免卡死）
                from core.credit_reserve import release_task_reservation
                await release_task_reservation(f"ppt-convert:{job_id}")
                state["status"] = "checkpoint"
                state["progress"] = 50
                state["message"] = f"扣费失败已回退：{e}"
                await save_ppt_state(job_id, state)
                raise HTTPException(402, f"扣费失败已回退：{e}")

        current_state = await _agent.get_state(job_id)
        requested_mode = normalize_ppt_conversion_mode(
            body.conversion_mode or (current_state or {}).get("conversion_mode")
        )
        if requested_mode == "ppt_master_direct":
            state = await _agent.export_ppt_master_direct(job_id)
            decks = state.get("direct_slide_decks") or []
            slide_count = len(decks)
            export_version = 1
            is_deliverable = state.get("status") == "done" and _pptx_ready_from_state(state)
            if is_deliverable and state.get("conversation_id"):
                try:
                    existing = await conversation_repo.get_conversation_messages(state["conversation_id"], user["id"])
                    export_count = sum(1 for m in existing if (m.get("meta") or {}).get("type") == "pptx_done")
                    export_version = export_count + 1
                    await conversation_repo.add_message(
                        conversation_id=state["conversation_id"],
                        role="assistant",
                        content=f"已导出 PPT 第 {export_count + 1} 版，共 {slide_count} 页。",
                        meta={
                            "type": "pptx_done",
                            "job_id": job_id,
                            "status": "done",
                            "version": export_count + 1,
                            "slide_count": slide_count,
                            "pptx_path": state.get("pptx_path", ""),
                            "pptx_url": state.get("pptx_url", ""),
                            "pptx_key": state.get("pptx_key", ""),
                            "pptx_filename": state.get("pptx_filename", ""),
                            "conversion_mode": "ppt_master_direct",
                            "direct_slide_decks": decks,
                        },
                    )
                except Exception:
                    pass
            return {
                "ok": is_deliverable,
                "status": state["status"],
                "conversion_mode": "ppt_master_direct",
                "cost": 0,
                "slide_count": slide_count,
                "pptx_path": state.get("pptx_path", ""),
                "pptx_url": state.get("pptx_url", ""),
                "pptx_filename": state.get("pptx_filename", ""),
                "version": export_version,
                "conversation_id": state.get("conversation_id", ""),
                "quality_review": state.get("quality_review") or {},
            }

        state = await _agent.confirm_checkpoint_once(
            job_id,
            body.selected_indices,
            conversion_mode=body.conversion_mode,
            selected_slide_images=body.selected_slide_images,
            selected_slide_prompts=body.selected_slide_prompts,
            before_save=precheck_and_reserve,
            after_save=consume_after_confirm,
        )
        conversion_mode = charged["conversion_mode"] or normalize_ppt_conversion_mode(state.get("conversion_mode"))
        cost = float(charged["cost"])

        if state.get("conversation_id"):
            try:
                mode_label = MODE_LABELS.get(conversion_mode, "文字可修改版")
                selected_preview = body.selected_slide_images or state.get("slide_images_b64", [])
                selected_count = len([img for img in selected_preview if img])
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="user",
                    content=f"确认幻灯片预览，开始生成 PPTX（{mode_label}）",
                    meta={
                        "type": "user_action",
                        "action": "confirm",
                        "job_id": job_id,
                        "conversion_mode": conversion_mode,
                        "cost": cost,
                        "selected_slide_count": selected_count,
                    },
                )
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="assistant",
                    content=f"已锁定 {selected_count} 张最终幻灯片版本，开始生成 PPTX",
                    meta={
                        "type": "selected_slides",
                        "job_id": job_id,
                        "preview_b64": next((img for img in selected_preview if img), ""),
                        "preview_b64_list": selected_preview,
                        "slide_count": selected_count,
                        "conversion_mode": conversion_mode,
                    },
                )
            except Exception:
                pass

        await enqueue(
            task_type="ppt-post-checkpoint",
            task_id=f"{job_id}:post-checkpoint:{uuid.uuid4().hex[:8]}",
            payload={"job_id": job_id, "user_id": user["id"]},
            priority="normal",
            user_id=user["id"],
        )

        return {"ok": True, "status": state["status"], "conversion_mode": conversion_mode, "cost": cost}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/rollback/{job_id}")
async def rollback(
    job_id: str,
    body: RollbackRequest,
    user: dict = Depends(_auth),
):
    checkpoint = body.checkpoint
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在")

    snapshots = state.get("snapshots", {})
    snap = snapshots.get(checkpoint)
    if not snap:
        raise HTTPException(400, f"快照 {checkpoint!r} 不存在")

    if checkpoint == "after_outline":
        state["outline"] = snap["outline"]
        state["slide_images_b64"] = []
        state["pptx_path"] = ""
        state["status"] = "outline_done"
        state["progress"] = 15
        state["message"] = "已回退到大纲阶段，重新生成图片..."
        state["error"] = ""
        await save_ppt_state(job_id, state)
        if state.get("conversation_id"):
            try:
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="user",
                    content="回退到大纲阶段，重新生成幻灯片图片",
                    meta={"type": "user_action", "action": "rollback", "checkpoint": checkpoint, "job_id": job_id},
                )
            except Exception:
                pass
        await enqueue(
            task_type="ppt-confirm-outline-images",
            task_id=f"{job_id}:rollback-images:{uuid.uuid4().hex[:8]}",
            payload={"job_id": job_id, "user_id": user["id"]},
            priority="normal",
            user_id=user["id"],
        )

    elif checkpoint == "after_images":
        state["slide_images_b64"] = snap["slide_images_b64"]
        state["outline"] = snap["outline"]
        state["pptx_path"] = ""
        state["status"] = "checkpoint"
        state["progress"] = 50
        state["message"] = "已回退到图片确认阶段"
        state["error"] = ""
        await save_ppt_state(job_id, state)
        if state.get("conversation_id"):
            try:
                await conversation_repo.add_message(
                    conversation_id=state["conversation_id"],
                    role="user",
                    content="回退到图片确认阶段，重新生成 PPTX",
                    meta={"type": "user_action", "action": "rollback", "checkpoint": checkpoint, "job_id": job_id},
                )
            except Exception:
                pass
    else:
        raise HTTPException(400, "不支持的回退快照")

    return {"ok": True, "status": state["status"], "checkpoint": checkpoint}


@router.post("/resume/{job_id}")
async def resume_from_slides(job_id: str, body: ResumeRequest, user: dict = Depends(_auth)):
    state = await _agent.get_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")

    intervention = state.get("intervention") if isinstance(state.get("intervention"), dict) else {}
    phase = str(intervention.get("phase") or "")
    if body.image_model_id:
        state["image_model_id"] = body.image_model_id
    if body.vision_model_id:
        state["vision_model_id"] = body.vision_model_id
    if body.llm_model_id:
        state["llm_model_id"] = body.llm_model_id

    if phase == "outline":
        state["status"] = "pending"
        state["progress"] = 0
        state["error"] = ""
        state["message"] = "正在继续已保存的演示文稿需求。"
        state["intervention"] = {}
        await save_ppt_state(job_id, state)
        if state.get("agent_run_id"):
            try:
                await resume_run(state["agent_run_id"], user_id=user["id"])
            except AgentRunTransitionError:
                pass
        await enqueue(
            task_type="ppt-start",
            task_id=f"{job_id}:resume-outline:{uuid.uuid4().hex[:8]}",
            payload={"job_id": job_id, "user_id": user["id"]},
            priority="normal",
            user_id=user["id"],
        )
        return {"ok": True, "job_id": job_id, "status": state["status"], "resumed_phase": "outline"}

    if phase == "slides":
        if not state.get("outline"):
            raise HTTPException(409, "The saved PPT outline is unavailable. Edit the brief and plan again.")
        state["status"] = "confirmed"
        state["progress"] = max(16, int(state.get("progress") or 16))
        state["error"] = ""
        state["message"] = "Resuming only the missing slide visuals. Completed slides are preserved."
        state["intervention"] = {}
        await save_ppt_state(job_id, state)
        if state.get("agent_run_id"):
            try:
                await resume_run(state["agent_run_id"], user_id=user["id"])
            except AgentRunTransitionError:
                pass
        await enqueue(
            task_type="ppt-confirm-outline-images",
            task_id=f"{job_id}:resume-slides:{uuid.uuid4().hex[:8]}",
            payload={"job_id": job_id, "user_id": user["id"]},
            priority="normal",
            user_id=user["id"],
        )
        return {"ok": True, "job_id": job_id, "status": state["status"], "resumed_phase": "slides"}

    slides = state.get("slide_images_b64", [])
    if not any(slides):
        raise HTTPException(400, "该任务没有已生成的幻灯片图片")

    if body.vision_model_id:
        state["vision_model_id"] = body.vision_model_id
    if body.llm_model_id:
        state["llm_model_id"] = body.llm_model_id

    state["status"] = "checkpoint"
    state["progress"] = 50
    state["message"] = "已恢复到图片确认阶段，可重新生成 PPTX"
    state["error"] = ""
    state["pptx_path"] = ""
    state.setdefault("snapshots", {})["after_images"] = {
        "outline": state.get("outline"),
        "slide_images_b64": slides,
    }
    await save_ppt_state(job_id, state)

    return {
        "ok": True,
        "job_id": job_id,
        "status": "checkpoint",
        "slide_count": len([s for s in slides if s]),
        "outline": state.get("outline"),
    }


@router.get("/download/{job_id}")
async def download_pptx(
    job_id: str,
    filename: str = Query(default=""),
    user: dict = Depends(_auth),
):
    state = await _load_ppt_download_state(job_id, user["id"])
    if not state:
        raise HTTPException(404, "任务不存在")
    if not _pptx_ready_from_state(state):
        if state.get("status") != "done":
            raise HTTPException(400, "PPTX 尚未生成完成")
        raise HTTPException(404, "文件不存在，可能已过期")

    download_name = await _sync_pptx_filename(state, job_id, user["id"], filename)
    disposition = f"attachment; filename=\"presentation.pptx\"; filename*=UTF-8''{quote(download_name)}"
    pptx_path_value = str(state.get("pptx_path") or "").strip()
    pptx_path = Path(pptx_path_value) if pptx_path_value else None
    if not (pptx_path and pptx_path.exists()):
        pptx_key = state.get("pptx_key") or ""
        if pptx_key:
            data = await asset_storage.fetch_asset_key_bytes(pptx_key)
            return Response(
                content=data,
                media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                headers={"Content-Disposition": disposition},
            )
        pptx_url = state.get("pptx_url") or ""
        if pptx_url:
            parsed = urlparse(pptx_url)
            query_key = (parse_qs(parsed.query).get("key") or [""])[0]
            data = await asset_storage.fetch_asset_key_bytes(query_key) if query_key else await asset_storage.fetch_asset_bytes(pptx_url)
            return Response(
                content=data,
                media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                headers={"Content-Disposition": disposition},
            )
        raise HTTPException(404, "文件不存在，可能已过期")

    return FileResponse(
        path=str(pptx_path),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=download_name,
    )
