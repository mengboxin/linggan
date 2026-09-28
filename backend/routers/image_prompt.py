"""Image-to-prompt analysis for recreatable visual directions."""
from __future__ import annotations

import json
import hashlib
import hmac
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from repositories import conversation_repo, creative_style_repo
from core.config import settings
from routers.auth import get_current_user
from services import asset_storage, provider_policy
from services.ai_client import call_vision
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call


router = APIRouter(prefix="/api/image-prompt", tags=["提示词反推"])
logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 12 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/avif"}


class ImagePromptAnalysis(BaseModel):
    title: str = Field(default="视觉配方")
    visual_summary: str = Field(default="")
    prompt: str = Field(default="")
    negative_prompt: str = Field(default="")
    style_tags: list[str] = Field(default_factory=list)
    subject: str = Field(default="")
    composition: str = Field(default="")
    lighting: str = Field(default="")
    palette: list[str] = Field(default_factory=list)
    materials: str = Field(default="")
    camera: str = Field(default="")
    aspect_ratio: str = Field(default="auto")
    confidence: int = Field(default=0, ge=0, le=100)
    notes: list[str] = Field(default_factory=list)


class ImagePromptAnalysisResponse(BaseModel):
    ok: bool = True
    analysis: ImagePromptAnalysis
    model_id: str = ""
    conversation_id: str = ""
    message_id: str = ""
    source_asset: dict[str, Any] = Field(default_factory=dict)
    history_saved: bool = False


class ImagePromptRecipeCreateBody(BaseModel):
    name: str = Field(default="", max_length=80)


def _analysis_provenance_payload(
    *,
    user_id: str,
    conversation_id: str,
    client_request_id: str,
    analysis: dict[str, Any],
) -> bytes:
    return json.dumps(
        {
            "v": 1,
            "user_id": str(user_id),
            "conversation_id": str(conversation_id),
            "client_request_id": str(client_request_id),
            "analysis": analysis,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _create_analysis_provenance(
    *,
    user_id: str,
    conversation_id: str,
    client_request_id: str,
    analysis: dict[str, Any],
    secret: str | None = None,
) -> str:
    key = str(secret if secret is not None else settings.SECRET_KEY).encode("utf-8")
    if not key:
        raise RuntimeError("SECRET_KEY is required for image prompt provenance")
    return hmac.new(
        key,
        _analysis_provenance_payload(
            user_id=user_id,
            conversation_id=conversation_id,
            client_request_id=client_request_id,
            analysis=analysis,
        ),
        hashlib.sha256,
    ).hexdigest()


def _verify_analysis_provenance(
    *,
    user_id: str,
    conversation_id: str,
    client_request_id: str,
    analysis: dict[str, Any],
    signature: str,
    secret: str | None = None,
) -> bool:
    try:
        expected = _create_analysis_provenance(
            user_id=user_id,
            conversation_id=conversation_id,
            client_request_id=client_request_id,
            analysis=analysis,
            secret=secret,
        )
    except RuntimeError:
        return False
    return bool(signature) and hmac.compare_digest(str(signature), expected)


async def _persist_analysis_history(
    *,
    user_id: str,
    client_request_id: str,
    filename: str,
    image_bytes: bytes,
    mode: str,
    model_id: str,
    analysis: ImagePromptAnalysis,
) -> tuple[str, str, dict[str, Any]]:
    conversation = await conversation_repo.create_conversation(
        user_id=user_id,
        conv_type="image-prompt",
        title=analysis.title[:80] or "视觉配方",
        creation_key=f"image-prompt:{client_request_id}",
    )
    conversation_id = str(conversation.get("id") or "")
    if conversation.get("title") != analysis.title[:80]:
        await conversation_repo.update_conversation_title(conversation_id, user_id, analysis.title[:80])

    asset_id = str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"pixelscribe:image-prompt:{user_id}:{client_request_id}",
    ))
    stored = await asset_storage.store_generated_image_best_effort(
        image_bytes=image_bytes,
        user_id=user_id,
        conversation_id=conversation_id,
        task_id=f"image-prompt-{client_request_id}",
        prompt=analysis.prompt,
        model_id=model_id,
        category="image-prompt-reference",
        asset_id=asset_id,
        item_id="reference",
        retention_class="web_history",
        source_client="web",
    )
    source_asset = stored.to_meta() if stored else {}
    meta: dict[str, Any] = {
        "type": "image_prompt_analysis",
        "history_key": f"image-prompt-analysis:{client_request_id}",
        "client_request_id": client_request_id,
        "mode": mode,
        "vision_model_id": model_id,
        "filename": filename,
        "analysis": analysis.model_dump(),
        **source_asset,
    }
    meta["server_provenance"] = _create_analysis_provenance(
        user_id=user_id,
        conversation_id=conversation_id,
        client_request_id=client_request_id,
        analysis=analysis.model_dump(),
    )
    message = await conversation_repo.add_message(
        conversation_id=conversation_id,
        role="assistant",
        content=analysis.visual_summary or analysis.title,
        meta=meta,
    )
    message_id = str(message.get("id") or "")
    if stored and message_id:
        await asset_storage.attach_message(stored.id, message_id)
    return conversation_id, message_id, source_asset


def _latest_message(messages: list[dict], message_type: str) -> dict:
    return next(
        (
            message
            for message in reversed(messages)
            if isinstance(message.get("meta"), dict)
            and message["meta"].get("type") == message_type
        ),
        {},
    )


def _latest_recreate_request(messages: list[dict]) -> dict:
    return next(
        (
            message
            for message in reversed(messages)
            if isinstance(message.get("meta"), dict)
            and message["meta"].get("type") == "image_request"
            and message["meta"].get("source") == "image_prompt_recreate"
        ),
        {},
    )


@router.get("/history")
async def list_image_prompt_history(
    limit: int = Query(default=30, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    conversations = await conversation_repo.list_conversations(
        user["id"], "image-prompt", limit, 0,
    )
    conversation_ids = [str(item.get("id") or "") for item in conversations]
    grouped = await conversation_repo.list_messages_for_conversations(
        conversation_ids, user["id"], light=False,
    )
    grouped = await asset_storage.prepare_image_asset_payload(grouped, user["id"])

    items: list[dict[str, Any]] = []
    for conversation in conversations:
        conversation_id = str(conversation.get("id") or "")
        messages = grouped.get(conversation_id, []) if isinstance(grouped, dict) else []
        analysis_message = _latest_message(messages, "image_prompt_analysis")
        request_message = _latest_recreate_request(messages) or _latest_message(messages, "image_request")
        result_message = _latest_message(messages, "image_result")
        recipe_message = _latest_message(messages, "image_prompt_recipe")
        analysis_meta = analysis_message.get("meta") if isinstance(analysis_message.get("meta"), dict) else {}
        request_meta = request_message.get("meta") if isinstance(request_message.get("meta"), dict) else {}
        result_meta = result_message.get("meta") if isinstance(result_message.get("meta"), dict) else {}
        recipe_meta = recipe_message.get("meta") if isinstance(recipe_message.get("meta"), dict) else {}
        analysis = dict(analysis_meta.get("analysis") or {})
        edited_prompt = str(request_meta.get("user_prompt") or "").strip()
        if edited_prompt:
            analysis["prompt"] = edited_prompt
        request_created_at = str(request_message.get("created_at") or "")
        result_created_at = str(result_message.get("created_at") or "")
        result_is_current = bool(result_meta) and result_created_at >= request_created_at
        result_status = str(result_meta.get("status") or "") if result_is_current else ("running" if request_meta else "")
        items.append({
            "id": conversation_id,
            "title": conversation.get("title") or "视觉配方",
            "mode": analysis_meta.get("mode") or "combined",
            "analysis": analysis,
            "vision_model_id": analysis_meta.get("vision_model_id") or "",
            "source_asset_id": analysis_meta.get("asset_id") or "",
            "source_image_url": analysis_meta.get("image_url") or "",
            "source_preview_url": analysis_meta.get("preview_url") or "",
            "source_thumbnail_url": analysis_meta.get("thumbnail_url") or "",
            "result_asset_id": result_meta.get("asset_id") or "",
            "result_image_url": result_meta.get("image_url") or "",
            "result_preview_url": result_meta.get("preview_url") or "",
            "result_thumbnail_url": result_meta.get("thumbnail_url") or "",
            "result_task_id": (result_meta if result_is_current else request_meta).get("task_id") or "",
            "result_status": result_status,
            "recipe_id": recipe_meta.get("recipe_id") or "",
            "recipe_name": recipe_meta.get("recipe_name") or "",
            "recipe_saved": bool(recipe_meta.get("recipe_id")),
            "created_at": conversation.get("created_at") or "",
            "updated_at": conversation.get("updated_at") or "",
        })
    return {"items": items}


def _parse_json_object(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    start = text.find("{")
    end = text.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("视觉模型没有返回结构化分析")
    value = json.loads(text[start:end])
    if not isinstance(value, dict):
        raise ValueError("视觉模型返回格式不正确")
    return value


def _normalize_analysis(value: dict[str, Any]) -> ImagePromptAnalysis:
    def text(key: str, limit: int = 4000) -> str:
        return str(value.get(key) or "").strip()[:limit]

    def string_list(key: str, limit: int) -> list[str]:
        raw = value.get(key)
        values = raw if isinstance(raw, list) else str(raw or "").split(",")
        return [str(item).strip()[:80] for item in values if str(item).strip()][:limit]

    return ImagePromptAnalysis(
        title=text("title", 80) or "视觉配方",
        visual_summary=text("visual_summary", 600),
        prompt=text("prompt", 6000),
        negative_prompt=text("negative_prompt", 1200),
        style_tags=string_list("style_tags", 8),
        subject=text("subject", 300),
        composition=text("composition", 500),
        lighting=text("lighting", 300),
        palette=string_list("palette", 8),
        materials=text("materials", 300),
        camera=text("camera", 300),
        aspect_ratio=text("aspect_ratio", 20) or "auto",
        confidence=max(0, min(100, int(value.get("confidence") or 0))),
        notes=string_list("notes", 4),
    )


def _analysis_instruction(_mode: str = "") -> str:
    return """你是一名资深视觉导演和提示词工程师。分析用户上传的图片，同时完成画面复现提示词与可迁移风格模板的提炼。

你只需描述可观察到的画面特征：主体、构图、视角、镜头感、光线、色彩、材质、排版留白和氛围。输出的是可用于新图生成的视觉配方，不要把分析写成笼统评价。

只返回一个 JSON 对象，字段必须完整：
{{
  "title": "中文短标题",
  "visual_summary": "2-3 句中文视觉分析",
  "prompt": "可直接用于文生图的中文完整提示词，包含主体、构图、光影、色彩、材质、画面限制",
  "negative_prompt": "中文负面约束，逗号分隔",
  "style_tags": ["中文风格标签"],
  "subject": "主体分析",
  "composition": "构图和视线分析",
  "lighting": "光线分析",
  "palette": ["主色 1", "主色 2"],
  "materials": "材质与纹理",
  "camera": "视角、焦段或景别",
  "aspect_ratio": "例如 4:5、1:1、16:9 或 auto",
  "confidence": 0,
  "notes": ["可复现建议或不确定项"]
}}

提示词不要出现模型名、网页链接或“照抄/复刻”等表达。风格字段必须抽离图片中的具体人物、品牌、文字和一次性主题，能够迁移到新的主体。"""


@router.post("/analyze", response_model=ImagePromptAnalysisResponse)
async def analyze_image_prompt(
    image: UploadFile = File(...),
    model_id: str = Form(""),
    mode: str = Form(""),
    client_request_id: str = Form(""),
    user: dict = Depends(get_current_user),
):
    if image.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, "请上传 JPG、PNG、WebP 或 AVIF 图片")

    image_bytes = await image.read(MAX_IMAGE_BYTES + 1)
    if not image_bytes:
        raise HTTPException(400, "图片为空")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "图片不能超过 12MB")

    resolved_model_id = await provider_policy.choose_vision_model_id(model_id)
    if not resolved_model_id:
        raise HTTPException(503, "暂未配置可用的视觉模型，请在管理端启用视觉模型后再试")

    request_id = (client_request_id or str(uuid.uuid4())).strip()[:160]
    analysis_system = _analysis_instruction()
    analysis_prompt = "请开始分析这张图片，并按约定 JSON 返回。"
    analysis_max_tokens = 2200

    async def invoke_analysis() -> str:
        return await call_vision(
            model_id=resolved_model_id,
            image_bytes=image_bytes,
            system=analysis_system,
            prompt=analysis_prompt,
            max_tokens=analysis_max_tokens,
        )

    try:
        raw = await execute_billed_model_call(
            user_id=user["id"],
            model_id=resolved_model_id,
            expected_category="vision",
            description="提示词反推",
            related_task_id=None,
            idempotency_key=model_billing_operation_key(
                namespace="image-prompt",
                user_id=user["id"],
                operation_scope=f"analyze:{request_id}",
                material={
                    "model_id": resolved_model_id,
                    "image": image_bytes,
                    "system": analysis_system,
                    "prompt": analysis_prompt,
                    "max_tokens": analysis_max_tokens,
                    "mode": mode,
                },
            ),
            invoke=invoke_analysis,
        )
        analysis = _normalize_analysis(_parse_json_object(raw))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"图片分析失败：{str(exc)[:180]}") from exc

    conversation_id = ""
    message_id = ""
    source_asset: dict[str, Any] = {}
    try:
        conversation_id, message_id, source_asset = await _persist_analysis_history(
            user_id=user["id"],
            client_request_id=request_id,
            filename=str(image.filename or "reference-image"),
            image_bytes=image_bytes,
            mode="combined",
            model_id=resolved_model_id,
            analysis=analysis,
        )
        source_asset = await asset_storage.prepare_image_asset_payload(source_asset, user["id"])
    except Exception as exc:
        logger.warning("failed to persist image prompt history user_id=%s error=%s", user["id"], exc)
    return ImagePromptAnalysisResponse(
        analysis=analysis,
        model_id=resolved_model_id,
        conversation_id=conversation_id,
        message_id=message_id,
        source_asset=source_asset,
        history_saved=bool(conversation_id and message_id),
    )


@router.post("/{conversation_id}/recipe", status_code=201)
async def confirm_image_prompt_recipe(
    conversation_id: str,
    body: ImagePromptRecipeCreateBody,
    user: dict = Depends(get_current_user),
):
    """Confirm the server-owned analysis as an idempotent personal recipe."""
    if not await conversation_repo.conversation_belongs_to_user_of_type(
        conversation_id,
        str(user["id"]),
        "image-prompt",
    ):
        raise HTTPException(404, "提示词反推记录不存在或无权访问")
    try:
        messages = await conversation_repo.get_conversation_messages(
            conversation_id,
            str(user["id"]),
            light=False,
        )
    except ValueError as exc:
        raise HTTPException(404, "提示词反推记录不存在或无权访问") from exc
    analysis_message = _latest_message(messages, "image_prompt_analysis")
    meta = analysis_message.get("meta") if isinstance(analysis_message.get("meta"), dict) else {}
    raw_analysis = meta.get("analysis") if isinstance(meta.get("analysis"), dict) else {}
    if not raw_analysis:
        raise HTTPException(404, "该记录没有可保存的风格模板")
    if not _verify_analysis_provenance(
        user_id=str(user["id"]),
        conversation_id=conversation_id,
        client_request_id=str(meta.get("client_request_id") or ""),
        analysis=raw_analysis,
        signature=str(meta.get("server_provenance") or ""),
    ):
        raise HTTPException(409, "该历史记录缺少可信分析凭证，请重新分析图片后再保存配方")

    # Only the optional display name comes from this request. Transferable
    # rules always come from the authenticated, server-persisted analysis.
    analysis = {
        key: raw_analysis.get(key)
        for key in (
            "visual_summary", "style_tags", "composition", "lighting", "palette",
            "materials", "camera", "negative_prompt",
        )
    }
    analysis["name"] = body.name.strip() or str(raw_analysis.get("title") or "我的灵感配方")[:80]
    source_asset_id = str(meta.get("asset_id") or "").strip()
    try:
        stable_asset_id = str(uuid.UUID(source_asset_id)) if source_asset_id else ""
    except ValueError:
        stable_asset_id = ""
    if stable_asset_id:
        analysis["preview_url"] = f"/api/assets/{stable_asset_id}/preview"
    analysis["source_name"] = "灵感反推"
    item, created = await creative_style_repo.create_personal_style_recipe_idempotent(
        user_id=str(user["id"]),
        analysis=analysis,
    )
    await conversation_repo.add_message(
        conversation_id=conversation_id,
        role="assistant",
        content=f"已加入灵感配方：{item.get('name') or analysis['name']}",
        meta={
            "type": "image_prompt_recipe",
            "history_key": f"image-prompt-recipe:{conversation_id}",
            "recipe_id": str(item.get("id") or ""),
            "recipe_name": str(item.get("name") or analysis["name"]),
        },
    )
    return {"item": item, "created": created, "duplicate": not created}
