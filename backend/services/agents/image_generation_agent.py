"""Agentic image generation and editing workflow.

The flow mirrors ChatGPT-style image generation more closely than a direct
prompt pass-through:
1. understand intent and rewrite a production prompt
2. run a safety/feasibility pass
3. generate with Responses image_generation and return the upstream result
"""
from __future__ import annotations

import base64
import asyncio
import json
import logging
from typing import Literal, Optional, TypedDict

import repositories.task_repo as task_repo
from core import credit_reserve
from core.concurrency import gather_limited
from core.config import settings
from core.task_errors import NonRetryableTaskError
from repositories import conversation_repo
from services import asset_storage
from services.ai_client import (
    ImageSafetyBlockedError,
    call_chat,
    call_chat_with_images,
    call_image,
    call_text_messages,
)
from services.agents.workflow_agent import set_agent_step
from services.agents.agent_run_store import AgentRunTransitionError, transition_run
from services.image_output import normalize_image_quality, normalize_output_resolution
from services.model_billing import (
    ModelCallAuthorization,
    authorize_model_call,
    charge_model_call,
    execute_billed_model_call,
)
from services import provider_policy
from langgraph.graph import END, START, StateGraph

logger = logging.getLogger(__name__)


class AgentSafetyRejectedError(RuntimeError):
    """The planner or image provider rejected the request on safety grounds."""


IMAGE_AGENT_SYSTEM = """You are an expert image generation director.
First think like ChatGPT's image generation planner, then rewrite user requests into precise image-generation instructions.
Return valid JSON only with this shape:
{
  "safe": true,
  "violation_reason": "",
  "intent_summary": "short Chinese summary",
  "subject_understanding": "entities, IP/game/brand/character references, likely visual identity, and any uncertainty",
  "composition_plan": "camera, layout, background, UI/text treatment, aspect-aware framing",
  "style_plan": "rendering style, lighting, palette, texture, finish",
  "final_prompt": "production prompt",
  "negative_prompt": "things to avoid",
  "quality_checks": ["check 1", "check 2"]
}
Rules:
- Do not simply copy the user prompt.
- Preserve the user's language and intent.
- Expand short prompts aggressively when they contain known proper nouns, game names, character names, product names, or cultural references.
- For game/character requests, infer a polished asset type when the user is vague: character card, splash art, collectible profile sheet, game UI poster, or mascot illustration.
- If the prompt mentions a known IP-style subject, include recognizable visual traits and setting cues in the final prompt, but avoid claiming exact facts you are unsure about.
- For Chinese prompts, keep important display text in Chinese and specify clean, legible typography when text is requested or implied.
- If reference images are provided, describe how to use them.
- For image editing, act like an editing director: infer the user's desired outcome, then turn it into a direct image_generation instruction.
- In image editing modes, reference images are editable source material, visual context, or optional guidance. They do not define a default structure to keep.
- The user's edit request decides what changes and what remains. Do not keep original subjects, pose, composition, background, color, style, or layout by default.
- Keep source-image details only when the user asks for them or when they clearly support the requested result.
- If the user asks for a major transformation, redesign, evolution, replacement, restyle, extension, or complete change, allow large changes to subject identity, pose, composition, background, color, and style.
- Keep the final prompt concrete, visual, and testable: subject, pose, background, composition, style, lighting, color palette, material details, and quality bar.
- Do not include markdown fences."""


def _json_from_text(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end <= start:
        raise ValueError("model did not return JSON")
    return json.loads(raw[start:end])


async def _save_task_state(task_id: str, state: dict) -> None:
    patch = {
        "progress": state.get("progress", 0),
        "agent_steps": state.get("agent_steps", []),
        "message": state.get("message", ""),
    }
    await task_repo._update(task_id, patch)


def _to_image_url(image_base64: str) -> str:
    return image_base64 if image_base64.startswith("data:") else f"data:image/png;base64,{image_base64}"


def _is_workflow_edit_source(source: str) -> bool:
    return source.endswith("workflow_edit")


def _reference_image_contract(ref_count: int, is_workflow_edit: bool) -> str:
    if ref_count <= 0:
        return ""

    roles: list[str] = []
    if is_workflow_edit:
        roles.append("- Input image 1 is the current workflow image (CURRENT), the editable source material.")
        first_uploaded_index = 2
    else:
        first_uploaded_index = 1

    for image_index in range(first_uploaded_index, ref_count + 1):
        prompt_reference_number = image_index - first_uploaded_index + 1
        roles.append(
            f"- Input image {image_index} is user-uploaded reference image {prompt_reference_number} (图{prompt_reference_number})."
        )

    if first_uploaded_index > ref_count:
        roles.append("- There are no additional user-uploaded reference images in this request.")

    return (
        "REFERENCE IMAGE CONTRACT (must follow):\n"
        + "\n".join(roles)
        + "\n- When the user says 图N, image N, or reference N, it refers exactly to the matching user-uploaded reference above."
        + "\n- When the user asks to use an imported reference, visibly apply the requested identity, style, material, composition, or object traits from that reference; do not silently ignore it."
        + "\n- Preserve the image order. Do not swap, merge, or reinterpret numbered references."
    )


def _workflow_edit_instruction(user_prompt: str, ref_count: int = 1) -> str:
    request = (user_prompt or "").strip()
    return (
        "Image editing request. Treat the first input image as editable source material and visual context for the user "
        "request. Understand what the user wants, then create the image that best satisfies that request. The prompt "
        "decides subject, pose, composition, background, color, style, layout, and how much the source image changes. "
        "Do not protect the original image structure by default. Keep any part of the source image only when the user "
        "asks for it or when it clearly supports the requested edit. If the request implies replacement, transformation, "
        "redesign, restyling, extension, or a new branch concept, make the necessary large changes. Use any extra "
        "reference images only as guidance for style, objects, identity, texture, or mood according to the user request.\n\n"
        f"{_reference_image_contract(ref_count, is_workflow_edit=True)}\n"
        f"User edit request: {request}"
    )


def _approved_plan_context(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    summary = str(value.get("summary") or "").strip()
    answers = value.get("answers") if isinstance(value.get("answers"), dict) else {}
    answer_lines = [
        f"- {str(key)}: {str(answer).strip()}"
        for key, answer in answers.items()
        if str(answer).strip()
    ]
    parts: list[str] = []
    if summary:
        parts.append(f"Approved creative plan: {summary}")
    if answer_lines:
        parts.append("User decisions:\n" + "\n".join(answer_lines))
    return "\n".join(parts)


def _int_or_default(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _humanize_generation_error(error: str) -> str:
    raw = (error or "").strip()
    lowered = raw.lower()
    if "提示词被图像安全系统拦截" in raw or "安全系统拦截" in raw:
        return raw
    if "responses image_generation did not return image data" in lowered:
        return "图像服务这次没有返回有效图片数据，请稍后再试或调整提示词。"
    if "responses 流式响应未返回完成的图像数据" in raw:
        return "图像服务这次没有返回完整图片结果。系统已自动重试过一次，如果仍然失败，请稍后再试。"
    return raw


def _generation_recovery(error: Exception, final_error: str) -> dict[str, object]:
    """Give the UI safe, actionable recovery paths for a terminal run."""
    raw = str(error or "").lower()
    if isinstance(error, (ImageSafetyBlockedError, AgentSafetyRejectedError)):
        return {
            "kind": "safety_block",
            "message": "上游安全系统未接受这次表达。可以保留主题，但需要改为安全、原创、非伤害性的视觉表达。",
            "suggestions": [
                {
                    "id": "safe_original",
                    "label": "改为安全原创表达",
                    "prompt": "请创作一张原创、安全、非伤害性的视觉作品，以积极、克制的方式表达主题，不包含血腥、暴力或对真实人物与受保护角色的复刻。",
                },
                {
                    "id": "abstract_concept",
                    "label": "改为抽象概念海报",
                    "prompt": "请将主题转化为抽象、象征性的概念海报，以几何、光影、色彩和信息图形表达，不包含具体人物、伤害或敏感场景。",
                },
                {"id": "rewrite", "label": "我自己调整描述", "prompt": ""},
            ],
        }
    if "storage" in raw or "存储" in final_error:
        return {
            "kind": "storage_failure",
            "message": "图片已生成或正在生成，但保存服务暂时不可用。请稍后再发起一次创作。",
            "suggestions": [
                {"id": "retry", "label": "稍后按原需求重试", "prompt": ""},
                {"id": "rewrite", "label": "调整需求后再试", "prompt": ""},
            ],
        }
    if "asset" in raw or "参考图" in final_error or "主图" in final_error:
        return {
            "kind": "asset_failure",
            "message": "当前使用的主图或参考图无法读取。请重新选择源节点或重新上传参考图后再试。",
            "suggestions": [
                {"id": "replace_assets", "label": "重新选择图片", "prompt": ""},
                {"id": "retry", "label": "按原需求重新规划", "prompt": ""},
            ],
        }
    return {
        "kind": "provider_failure",
        "message": "图像服务本次未完成响应。原始需求和素材没有丢失，可以重新规划后再提交。",
        "suggestions": [
            {"id": "retry", "label": "按原需求重新规划", "prompt": ""},
            {"id": "simplify", "label": "简化画面要求再试", "prompt": "请保留核心主题，使用更简洁明确的主体、构图和风格要求重新创作。"},
        ],
    }


async def _persist_generation_history(
    *,
    task_id: str,
    user_id: str,
    conversation_id: str,
    source: str,
    prompt: str,
    model_id: str,
    llm_model_id: Optional[str],
    vision_model_id: Optional[str],
    size: str,
    ref_count: int,
    output_resolution: str = "1k",
    image_quality: str = "auto",
    image_base64: Optional[str] = None,
    image_asset_meta: Optional[dict] = None,
    image_asset_metas: Optional[list[dict]] = None,
    result_meta: Optional[dict] = None,
    error: str = "",
) -> None:
    if not user_id or not conversation_id:
        return
    try:
        # add_message uses the durable history key unique index, so this is an
        # idempotent upsert. Avoid reading and materializing the entire message
        # history merely to determine whether this row already exists.
        await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="user",
            content=prompt,
            meta={
                "type": "image_request",
                "task_id": task_id,
                "job_id": task_id,
                "model_id": model_id,
                "llm_model_id": llm_model_id or "",
                "vision_model_id": vision_model_id or "",
                "size": size,
                "output_resolution": output_resolution,
                "image_quality": image_quality,
                "has_reference": ref_count > 0,
                "source": source or "generate",
            },
        )
        asset_metas: list[dict] = []
        for asset_meta in [image_asset_meta, *(image_asset_metas or [])]:
            if not isinstance(asset_meta, dict) or not asset_meta.get("asset_id"):
                continue
            if any(existing.get("asset_id") == asset_meta.get("asset_id") for existing in asset_metas):
                continue
            asset_metas.append(dict(asset_meta))

        if image_base64 or asset_metas:
            meta = {
                "type": "image_result",
                "status": "completed",
                "task_id": task_id,
                "job_id": task_id,
                "model_id": model_id,
                "llm_model_id": llm_model_id or "",
                "vision_model_id": vision_model_id or "",
                "size": size,
                "output_resolution": output_resolution,
                "image_quality": image_quality,
                "source": source or "generate",
            }
            if result_meta:
                meta.update(result_meta)
            if asset_metas:
                meta.update(asset_metas[0])
                meta["images"] = asset_metas
                meta["storage"] = "r2"
            elif image_base64:
                meta.update({
                    "image_b64": image_base64,
                    "image_url": _to_image_url(image_base64),
                    "storage": "database",
                })
            message = await conversation_repo.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content=f"生成完成（模型：{model_id}）",
                meta=meta,
            )
            for asset_meta in asset_metas:
                await asset_storage.attach_message(asset_meta["asset_id"], message["id"])
        else:
            await conversation_repo.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content=f"生成失败：{error or '未知错误'}",
                meta={
                    "type": "image_result",
                    "status": "failed",
                    "task_id": task_id,
                    "job_id": task_id,
                    "model_id": model_id,
                    "error": error,
                    "source": source or "generate",
                },
            )
    except Exception as exc:
        logger.warning(
            "failed to persist image generation history: task_id=%s conversation_id=%s error=%s",
            task_id,
            conversation_id,
            exc,
        )


def _has_image_result(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    if any(str(result.get(key) or '').strip() for key in (
        'imageBase64', 'image_base64', 'imageUrl', 'image_url',
        'previewUrl', 'preview_url', 'thumbnailUrl', 'thumbnail_url',
        'assetId', 'asset_id',
    )):
        return True
    images = result.get('images')
    return isinstance(images, list) and any(isinstance(item, dict) and _has_image_result(item) for item in images)


async def _charge_successful_call(
    *,
    user_id: str,
    model_id: Optional[str],
    category: str,
    description: str,
    task_id: str,
    cost_multiplier: float = 1.0,
    idempotency_key: Optional[str] = None,
    credit_claim: Optional[credit_reserve.ModelCallCreditClaim] = None,
) -> None:
    if not user_id or not model_id:
        return
    await charge_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=category,
        description=description,
        related_task_id=None,
        reservation_task_id=task_id,
        cost_multiplier=cost_multiplier,
        idempotency_key=idempotency_key,
        credit_claim=credit_claim,
    )


async def _check_next_call(
    *,
    user_id: str,
    model_id: Optional[str],
    category: str,
    description: str,
    cost_multiplier: float = 1.0,
    task_id: str = "",
    idempotency_key: Optional[str] = None,
) -> Optional[ModelCallAuthorization]:
    if not user_id or not model_id:
        return None
    authorization = await authorize_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=category,
        description=description,
        cost_multiplier=cost_multiplier,
        idempotency_key=idempotency_key,
        reservation_task_id=task_id or None,
    )
    if authorization.resume_settlement:
        await _charge_successful_call(
            user_id=user_id,
            model_id=model_id,
            category=category,
            description=description,
            task_id=task_id,
            cost_multiplier=cost_multiplier,
            idempotency_key=idempotency_key,
            credit_claim=authorization.claim,
        )
        raise HTTPException(409, "This image model operation already completed settlement")
    if authorization.already_settled:
        raise HTTPException(409, "This image model operation already completed")
    return authorization


async def _plan_prompt(
    *,
    original_prompt: str,
    mode: str,
    ref_count: int,
    ref_images: Optional[list[bytes]] = None,
    reference_contract: str = "",
    model_id: Optional[str] = None,
    user_id: str = "",
    task_id: str = "",
    billing_discount_rate: float = 1.0,
) -> tuple[dict, Optional[str]]:
    llm_model_id = await provider_policy.choose_llm_model_id(model_id)
    if not llm_model_id:
        return {
            "safe": True,
            "violation_reason": "",
            "intent_summary": original_prompt[:120],
            "final_prompt": original_prompt,
            "negative_prompt": "",
            "quality_checks": ["matches user prompt", "clear composition"],
        }, None

    user_msg = (
        f"Mode: {mode}\n"
        f"Reference image count: {ref_count}\n"
        "Planner objective:\n"
        "- Interpret the user's request before drawing, especially proper nouns and short Chinese prompts.\n"
        "- If the request is underspecified, choose a strong ChatGPT-like visual concept instead of a generic literal image.\n"
        "- For workflow image editing, read the first reference image as editable source material; the user prompt decides the edit direction and how much the image changes.\n"
        "- Inspect every supplied reference image in the order listed by the reference contract. Preserve numbered reference bindings in the final prompt.\n"
        "- Prefer a complete, polished asset brief that can stand alone for image_generation.\n\n"
        f"{reference_contract}\n"
        f"User prompt:\n{original_prompt}"
    )
    async def invoke_plan() -> str:
        if ref_images:
            try:
                return await call_chat_with_images(
                    model_id=llm_model_id,
                    system=IMAGE_AGENT_SYSTEM,
                    user=user_msg,
                    images=ref_images,
                    max_tokens=1200,
                    temperature=0.35,
                )
            except Exception as exc:
                logger.warning(
                    "image planner vision input unavailable model_id=%s; falling back to text planning: %s",
                    llm_model_id,
                    exc,
                )
        return await call_chat(
            model_id=llm_model_id,
            system=IMAGE_AGENT_SYSTEM,
            user=user_msg,
            max_tokens=1200,
            temperature=0.35,
        )

    raw = (
        await execute_billed_model_call(
            user_id=user_id,
            model_id=llm_model_id,
            expected_category="llm",
            description="Image generation prompt planning",
            related_task_id=None,
            reservation_task_id=task_id,
            cost_multiplier=billing_discount_rate,
            idempotency_key=f"image-generation:{task_id}:planning",
            invoke=invoke_plan,
        )
        if user_id and task_id
        else await invoke_plan()
    )
    parsed = _json_from_text(raw)
    final_prompt = (parsed.get("final_prompt") or original_prompt).strip()
    subject_understanding = (parsed.get("subject_understanding") or "").strip()
    composition_plan = (parsed.get("composition_plan") or "").strip()
    style_plan = (parsed.get("style_plan") or "").strip()
    context_parts = []
    if subject_understanding:
        context_parts.append(f"Subject understanding: {subject_understanding}")
    if composition_plan:
        context_parts.append(f"Composition plan: {composition_plan}")
    if style_plan:
        context_parts.append(f"Style plan: {style_plan}")
    if context_parts:
        final_prompt = "\n".join(context_parts + [f"Final image prompt: {final_prompt}"])
    negative = (parsed.get("negative_prompt") or "").strip()
    if negative:
        final_prompt = f"{final_prompt}\n\nAvoid: {negative}"
    parsed["final_prompt"] = final_prompt
    parsed["safe"] = parsed.get("safe", True) is not False
    return parsed, llm_model_id


async def _generate_image(
    *,
    model_id: str,
    prompt: str,
    ref_images: list[bytes],
    size: str,
    quality: str = "auto",
    force_size: bool = True,
    aspect_ratio: Optional[str] = None,
    output_resolution: Optional[str] = None,
) -> bytes:
    return await call_image(
        model_id=model_id,
        prompt=prompt,
        ref_images=ref_images or None,
        size=size,
        quality=quality,
        force_size=force_size,
        aspect_ratio=aspect_ratio,
        output_resolution=output_resolution,
    )


def _variant_generation_prompt(final_prompt: str, variant_index: int, total: int) -> str:
    if total <= 1:
        return final_prompt
    return (
        f"{final_prompt}\n\n"
        f"Creative divergent variation {variant_index} of {total}: produce a genuinely different creative direction "
        "for the same user request. Keep the user's core intent and any explicit must-keep constraints, but vary the "
        "concept, composition, visual metaphor, details, color story, styling, and mood so this result is not a minor "
        "duplicate of the other variations."
    )


async def _update_deep_run(
    run_id: str,
    *,
    status: str,
    stage: str,
    message: str,
    detail: str = "",
    **patch,
) -> None:
    if not run_id:
        return
    try:
        await transition_run(
            run_id,
            status=status,
            stage=stage,
            message=message,
            detail=detail,
            **patch,
        )
    except AgentRunTransitionError as exc:
        logger.warning("agent run transition ignored run_id=%s error=%s", run_id, exc)
    except Exception as exc:
        logger.warning("agent run update failed run_id=%s error=%s", run_id, exc)


async def _review_candidate(
    *,
    enabled: bool,
    review_model_id: Optional[str],
    review_model_category: str,
    image_bytes: bytes,
    ref_images: list[bytes],
    user_request: str,
    reference_contract: str,
    user_id: str,
    task_id: str,
    variant_index: int,
) -> dict:
    """Return a compact, actionable visual QA verdict for a deep-agent run."""
    if not enabled:
        return {"passed": True, "skipped": True, "repair_prompt": ""}
    category = "vision" if review_model_category == "vision" else "llm"
    model_id = (
        await provider_policy.choose_vision_model_id(review_model_id or None)
        if category == "vision"
        else await provider_policy.choose_llm_model_id(review_model_id or None)
    )
    if not model_id:
        return {"passed": True, "skipped": True, "repair_prompt": ""}
    prompt = (
        "Review the candidate output against the request and the ordered input images. "
        "Do not expose private reasoning. Return JSON only with pass (boolean), score (0-1), "
        "issues (short list), and repair_prompt (one concise visual correction instruction).\n"
        "Image 1 is the generated candidate. Remaining images are source/reference inputs.\n"
        f"{reference_contract}\nUser request:\n{user_request}"
    )
    class ReviewUnavailable(RuntimeError):
        pass

    async def invoke_review() -> str:
        try:
            content: list[dict] = [{"type": "input_text", "text": prompt}]
            for image in [image_bytes, *ref_images[:7]]:
                content.append({
                    "type": "input_image",
                    "image_url": f"data:image/png;base64,{base64.b64encode(image).decode()}",
                })
            return await call_text_messages(
                model_id=model_id,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a strict but practical visual quality reviewer. Judge visible adherence only.",
                    },
                    {"role": "user", "content": content},
                ],
                max_tokens=500,
                temperature=0.0,
                allowed_categories=(category,),
            )
        except Exception as exc:
            raise ReviewUnavailable(str(exc)) from exc

    try:
        raw = await execute_billed_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=category,
            description=f"Image visual review (variant {variant_index})",
            invoke=invoke_review,
            related_task_id=None,
            reservation_task_id=task_id,
            idempotency_key=(
                f"image-generation:{task_id}:variant:{variant_index}:visual-review"
            ),
        )
    except ReviewUnavailable as exc:
        logger.info("deep visual review unavailable; accepting candidate: %s", exc)
        return {"passed": True, "skipped": True, "repair_prompt": ""}

    try:
        result = _json_from_text(raw)
        score = float(result.get("score") or 0)
        passed = result.get("pass") is True or (result.get("pass") is None and score >= 0.72)
        repair_prompt = str(result.get("repair_prompt") or "").strip()
        issues = result.get("issues") if isinstance(result.get("issues"), list) else []
        return {
            "passed": passed,
            "score": max(0.0, min(1.0, score)),
            "issues": [str(item)[:240] for item in issues[:4]],
            "repair_prompt": repair_prompt[:1200],
        }
    except Exception as exc:
        # The provider call succeeded and has already been billed. A malformed
        # optional QA payload must not discard the generated image.
        logger.info("deep visual review response invalid; accepting candidate: %s", exc)
        return {"passed": True, "skipped": True, "repair_prompt": ""}


class ImageVariantReactState(TypedDict, total=False):
    task_id: str
    model_id: str
    user_id: str
    agent_run_id: str
    source_prompt: str
    final_prompt: str
    ref_images: list[bytes]
    reference_contract: str
    vision_model_id: Optional[str]
    llm_model_id: Optional[str]
    review_model_id: Optional[str]
    review_model_category: str
    size: str
    aspect_ratio: Optional[str]
    output_resolution: Optional[str]
    image_quality: str
    force_size: bool
    variant_index: int
    output_count: int
    completed_variants: int
    deep_visual_review: bool
    billing_discount_rate: float
    task_state: dict
    state_lock: object
    candidate_image: bytes
    initial_candidate_image: bytes
    review: dict
    quality_review: dict
    repair_prompt: str
    repair_attempt: int
    outcome: Literal["review", "accepted", "repair", "awaiting_user"]


async def _set_variant_step(
    state: ImageVariantReactState,
    *,
    status: str,
    message: str,
    progress: int,
    name: str | None = None,
    attempt: int = 1,
    result: dict | None = None,
    error: str = "",
) -> None:
    task_state = state["task_state"]
    output_count = int(state["output_count"])
    variant_index = int(state["variant_index"])
    step_name = name or (f"image_generation_{variant_index}" if output_count > 1 else "image_generation")
    lock = state.get("state_lock")

    async def save() -> None:
        await set_agent_step(
            task_state,
            lambda current: _save_task_state(state["task_id"], current),
            name=step_name,
            status=status,
            message=message,
            progress=progress,
            attempt=attempt,
            result=result,
            error=error,
        )

    if isinstance(lock, asyncio.Lock):
        async with lock:
            await save()
    else:
        await save()


async def _variant_generate_node(state: ImageVariantReactState) -> dict:
    variant_index = int(state["variant_index"])
    output_count = int(state["output_count"])
    completed_variants = int(state.get("completed_variants") or 0)
    variant_prompt = _variant_generation_prompt(
        state["final_prompt"],
        variant_index,
        output_count,
    )
    repair_attempt = max(1, int(state.get("repair_attempt") or 1))
    repair_prompt = str(state.get("repair_prompt") or "").strip()
    is_repair = repair_attempt > 1
    generation_prompt = variant_prompt
    if is_repair and repair_prompt:
        generation_prompt += (
            "\n\nThis is an authorized automatic visual correction. "
            "Keep the user's requested subject and reference-image roles, then correct this review finding: "
            f"{repair_prompt}"
        )

    progress = (
        min(88, 30 + int((completed_variants / output_count) * 55) + 4)
        if output_count > 1
        else min(85, 30 + int((variant_index - 1) / output_count * 55) + 5)
    )
    await _set_variant_step(
        state,
        status="running",
        message=(
            f"正在按检查建议修正第 {variant_index}/{output_count} 张：{repair_prompt}"
            if is_repair and output_count > 1
            else "正在按检查建议修正当前图片。"
            if is_repair
            else f"正在并行生成发散创意 {variant_index}/{output_count}..."
            if output_count > 1
            else "正在调用图像模型生成结果..."
        ),
        progress=progress,
        name=(f"image_repair_{variant_index}" if output_count > 1 else "image_repair") if is_repair else None,
        attempt=repair_attempt,
        result={"reason": repair_prompt, "variant_index": variant_index} if is_repair else None,
    )
    operation_key = (
        f"image-generation:{state['task_id']}:variant:{variant_index}:attempt:{repair_attempt}"
    )
    authorization: Optional[ModelCallAuthorization] = None
    provider_succeeded = False
    try:
        authorization = await _check_next_call(
            user_id=state["user_id"],
            model_id=state["model_id"],
            category="generate",
            description=(
                f"智能生图 image2 自动修正（第 {variant_index}/{output_count} 张）"
                if is_repair
                else f"智能生图 image2 生成（第 {variant_index}/{output_count} 张）"
            ),
            cost_multiplier=float(state["billing_discount_rate"]),
            task_id=state["task_id"],
            idempotency_key=operation_key,
        )
        image_bytes = await _generate_image(
            model_id=state["model_id"],
            prompt=generation_prompt,
            ref_images=state["ref_images"],
            size=state["size"],
            quality=state["image_quality"],
            force_size=bool(state["force_size"]),
            aspect_ratio=state.get("aspect_ratio"),
            output_resolution=state.get("output_resolution"),
        )
        provider_succeeded = True
        await _charge_successful_call(
            user_id=state["user_id"],
            model_id=state["model_id"],
            category="generate",
            description=(
                f"智能生图 image2 自动修正（第 {variant_index}/{output_count} 张）"
                if is_repair
                else f"智能生图 image2 生成（第 {variant_index}/{output_count} 张）"
            ),
            task_id=state["task_id"],
            cost_multiplier=float(state["billing_discount_rate"]),
            idempotency_key=operation_key,
            credit_claim=(
                authorization.claim
                if isinstance(authorization, ModelCallAuthorization)
                else None
            ),
        )
        logger.info(
            "image variant generated task_id=%s variant=%s model_id=%s",
            state["task_id"],
            variant_index,
            state["model_id"],
        )
        return {
            "candidate_image": image_bytes,
            "initial_candidate_image": state.get("initial_candidate_image") or image_bytes,
            "outcome": "review",
        }
    except Exception as exc:
        if (
            not provider_succeeded
            and isinstance(authorization, ModelCallAuthorization)
            and authorization.claim
        ):
            await credit_reserve.release_model_call_claim(authorization.claim)
        last_error = str(exc)
        await _set_variant_step(
            state,
            status="failed",
            message=f"图像生成未返回结果：{last_error}",
            progress=45,
            name=(f"image_repair_{variant_index}" if output_count > 1 else "image_repair") if is_repair else None,
            attempt=repair_attempt,
            result={"reason": repair_prompt, "variant_index": variant_index} if is_repair else None,
            error=last_error,
        )
        if is_repair:
            # The first image was already paid for and passed through visual
            # review. A failed optional correction must never erase it or turn
            # the whole task into a false generation failure.
            return {
                "candidate_image": state.get("initial_candidate_image") or state.get("candidate_image"),
                "outcome": "awaiting_user",
            }
        if isinstance(exc, ImageSafetyBlockedError):
            raise NonRetryableTaskError(last_error) from exc
        if provider_policy.is_non_retryable_image_error(last_error):
            raise NonRetryableTaskError(last_error) from exc
        raise


async def _variant_review_node(state: ImageVariantReactState) -> dict:
    await _update_deep_run(
        state["agent_run_id"],
        status="reviewing",
        stage="visual_review",
        message="正在检查生成结果是否符合源图、参考图和修改要求。",
    )
    review = await _review_candidate(
        enabled=bool(state["deep_visual_review"]),
        review_model_id=(
            state.get("review_model_id")
            or state.get("vision_model_id")
            or state.get("llm_model_id")
        ),
        review_model_category=(
            state.get("review_model_category")
            or ("vision" if state.get("vision_model_id") else "llm")
        ),
        image_bytes=state["candidate_image"],
        ref_images=state["ref_images"],
        user_request=state["source_prompt"],
        reference_contract=state["reference_contract"],
        user_id=state["user_id"],
        task_id=state["task_id"],
        variant_index=int(state["variant_index"]),
    )
    if review.get("passed"):
        return {"outcome": "accepted"}

    repair_prompt = str(review.get("repair_prompt") or "优化主体位置、画面层级和背景干扰。").strip()
    issues = [str(item)[:240] for item in (review.get("issues") or []) if str(item).strip()][:4]
    variant_index = int(state["variant_index"])
    output_count = int(state["output_count"])
    await _set_variant_step(
        state,
        status="completed",
        message=(
            f"第 {variant_index}/{output_count} 张首版已生成，已保留检查建议，等待用户决定是否创建修订版。"
            if output_count > 1
            else "首版已生成，已保留检查建议，等待用户决定是否创建修订版。"
        ),
        progress=75,
        name="visual_review",
        result={"reason": repair_prompt, "issues": issues, "variant_index": variant_index},
    )
    # A review must never turn one submitted task into a second paid image call.
    # The current result is delivered with a user-visible revision suggestion.
    return {"review": review, "outcome": "awaiting_user"}


async def _variant_prepare_revision_request_node(state: ImageVariantReactState) -> dict:
    review = state.get("review") or {}
    repair_prompt = str(review.get("repair_prompt") or "优化主体位置、画面层级和背景干扰。").strip()
    issues = [str(item)[:240] for item in (review.get("issues") or []) if str(item).strip()][:4]
    issue_summary = "；".join(issues) or "当前结果与预期仍有可优化之处"
    quality_review = {
        "kind": "quality_review",
        "message": f"当前结果已经生成。检查发现：{issue_summary}。",
        "current_result_available": True,
        "score": review.get("score"),
        "issues": issues,
        "repair_prompt": repair_prompt,
        "actions": ["keep_current", "create_revision"],
    }
    await _update_deep_run(
        state["agent_run_id"],
        status="awaiting_user",
        stage="quality_review_ready",
        message="当前结果已交付，建议由你决定是否生成修订版。",
        detail=issue_summary,
        intervention=quality_review,
    )
    return {"quality_review": quality_review}


def _after_variant_generate(state: ImageVariantReactState) -> str:
    return "awaiting_user" if state.get("outcome") == "awaiting_user" else "review"


def _after_variant_review(state: ImageVariantReactState) -> str:
    outcome = str(state.get("outcome") or "awaiting_user")
    return outcome if outcome in {"accepted", "repair"} else "awaiting_user"


def _build_image_variant_react_graph():
    graph = StateGraph(ImageVariantReactState)
    graph.add_node("generate_candidate", _variant_generate_node)
    graph.add_node("repair_candidate", _variant_generate_node)
    graph.add_node("review_candidate", _variant_review_node)
    graph.add_node("prepare_revision_request", _variant_prepare_revision_request_node)
    graph.add_node("accepted", lambda _: {})
    graph.add_node("awaiting_user", lambda _: {})
    graph.add_edge(START, "generate_candidate")
    graph.add_conditional_edges(
        "generate_candidate",
        _after_variant_generate,
        {"review": "review_candidate", "awaiting_user": "prepare_revision_request"},
    )
    graph.add_conditional_edges(
        "repair_candidate",
        _after_variant_generate,
        {"review": "review_candidate", "awaiting_user": "prepare_revision_request"},
    )
    graph.add_conditional_edges(
        "review_candidate",
        _after_variant_review,
        {"accepted": "accepted", "repair": "repair_candidate", "awaiting_user": "prepare_revision_request"},
    )
    graph.add_edge("prepare_revision_request", "awaiting_user")
    graph.add_edge("accepted", END)
    graph.add_edge("awaiting_user", END)
    return graph.compile()


_IMAGE_VARIANT_REACT_GRAPH = _build_image_variant_react_graph()


async def _run_image_variant_react(**kwargs) -> ImageVariantReactState:
    return await _IMAGE_VARIANT_REACT_GRAPH.ainvoke({"repair_attempt": 1, **kwargs})


def _result_image_payload(
    *,
    image_base64: str,
    stored_asset,
    model_id: str,
    final_prompt: str,
    variant_index: int,
    quality_review: dict | None = None,
) -> dict:
    payload = {
        "imageBase64": "" if stored_asset else image_base64,
        "imageUrl": stored_asset.original_url if stored_asset else "",
        "previewUrl": stored_asset.preview_url if stored_asset else "",
        "thumbnailUrl": stored_asset.thumb_url if stored_asset else "",
        "assetId": stored_asset.id if stored_asset else "",
        "model_id": model_id,
        "final_prompt": final_prompt,
        "variantIndex": variant_index,
    }
    if quality_review:
        payload["quality_review"] = quality_review
    return payload


async def _store_variant_result(
    *,
    react_state: ImageVariantReactState,
    user_id: str,
    conversation_id: str,
    task_id: str,
    variant_index: int,
    prompt: str,
    final_prompt: str,
    model_id: str,
    source_client: str,
) -> tuple[dict, object | None, str, list[dict]]:
    """Persist the delivered image and, when used, the visible pre-repair version."""
    image_bytes = react_state.get("candidate_image")
    if not image_bytes:
        raise RuntimeError("图像生成未返回结果")

    initial_image = react_state.get("initial_candidate_image") or image_bytes
    repair_reason = str(react_state.get("repair_prompt") or "").strip()
    was_repaired = initial_image != image_bytes
    versions: list[dict] = []
    assets: list[dict] = []

    if was_repaired:
        initial_b64 = base64.b64encode(initial_image).decode()
        initial_asset = await asset_storage.store_generated_image_best_effort(
            image_bytes=initial_image,
            user_id=user_id,
            conversation_id=conversation_id,
            task_id=task_id,
            item_id=f"variant-{variant_index}-v1",
            prompt=prompt,
            model_id=model_id,
            source_client=source_client,
        )
        initial_payload = _result_image_payload(
            image_base64=initial_b64,
            stored_asset=initial_asset,
            model_id=model_id,
            final_prompt=final_prompt,
            variant_index=variant_index,
        )
        initial_payload.update({
            "version_index": 1,
            "status": "superseded",
            "repair_reason": repair_reason,
        })
        versions.append(initial_payload)
        if initial_asset:
            assets.append(initial_asset.to_meta())

    image_base64 = base64.b64encode(image_bytes).decode()
    stored_asset = await asset_storage.store_generated_image_best_effort(
        image_bytes=image_bytes,
        user_id=user_id,
        conversation_id=conversation_id,
        task_id=task_id,
        item_id=f"variant-{variant_index}-v{2 if was_repaired else 1}",
        prompt=prompt,
        model_id=model_id,
        source_client=source_client,
    )
    payload = _result_image_payload(
        image_base64=image_base64,
        stored_asset=stored_asset,
        model_id=model_id,
        final_prompt=final_prompt,
        variant_index=variant_index,
        quality_review=react_state.get("quality_review"),
    )
    if was_repaired:
        repaired_version = dict(payload)
        repaired_version.update({
            "version_index": 2,
            "status": "selected",
            "repair_reason": repair_reason,
        })
        versions.append(repaired_version)
        payload["versions"] = versions
        payload["auto_repair"] = {
            "applied": True,
            "reason": repair_reason,
            "initial_version_index": 1,
            "selected_version_index": 2,
        }
    if stored_asset:
        assets.append(stored_asset.to_meta())
    return payload, stored_asset, image_base64, assets


def _aggregate_quality_reviews(images: list[dict]) -> dict | None:
    """Build the one user decision required after visual QA.

    The generated pixels stay delivered. This object is deliberately data-only
    so every image entry point can render the same keep-or-revise decision.
    """
    items: list[dict] = []
    for image in images:
        review = image.get("quality_review")
        if not isinstance(review, dict):
            continue
        items.append({
            "variant_index": image.get("variantIndex"),
            "issues": review.get("issues") or [],
            "repair_prompt": review.get("repair_prompt") or "",
            "score": review.get("score"),
        })
    if not items:
        return None
    count = len(items)
    return {
        "kind": "quality_review",
        "message": (
            f"当前 {count} 张结果已经生成。检查发现其中存在可优化之处，是否基于建议创建修订版？"
        ),
        "current_result_available": True,
        "items": items,
        "actions": ["keep_current", "create_revision"],
    }


async def _save_partial_generation_result(
    *,
    task_id: str,
    images: list[dict | None],
    model_id: str,
    final_prompt: str,
    state: dict,
) -> None:
    completed_images = [image for image in images if image]
    if not completed_images:
        return
    first_payload = completed_images[0]
    await task_repo._update(task_id, {
        "result": {
            "imageBase64": first_payload.get("imageBase64") or "",
            "imageUrl": first_payload.get("imageUrl") or "",
            "previewUrl": first_payload.get("previewUrl") or "",
            "thumbnailUrl": first_payload.get("thumbnailUrl") or "",
            "assetId": first_payload.get("assetId") or "",
            "images": completed_images,
            "model_id": model_id,
            "final_prompt": final_prompt,
            "agent_steps": state.get("agent_steps", []),
            "partial": True,
        },
        "message": state.get("message", ""),
    })


async def run_image_generation_agent(
    *,
    task_id: str,
    model_id: str,
    prompt: str,
    ref_images: list[bytes],
    params: dict,
    llm_model_id: Optional[str] = None,
    vision_model_id: Optional[str] = None,
) -> None:
    state: dict = {"agent_steps": [], "progress": 0, "message": "智能体正在初始化..."}
    mode = "IMAGE_EDIT" if ref_images else "TEXT_TO_IMAGE"
    size = params.get("size", "1024x1024")
    output_resolution = normalize_output_resolution(str(params.get("output_resolution") or "1k"))
    aspect_ratio = str(params.get("aspect_ratio") or "").strip() or None
    image_quality = normalize_image_quality(str(params.get("image_quality") or "auto"))
    force_size = bool(params.get("force_size", True))
    requested_n = _int_or_default(params.get("n"), 1)
    output_count = max(1, min(requested_n, 3))
    user_id = str(params.get("user_id") or "")
    conversation_id = str(params.get("conversation_id") or "")
    source = str(params.get("source") or "")
    source_client = "desktop" if source.startswith("desktop") else "web"
    billing_discount_rate = 1.0
    is_workflow_edit = _is_workflow_edit_source(source)
    agent_run_id = str(params.get("agent_run_id") or "").strip()
    deep_visual_review = False
    approved_plan_context = _approved_plan_context(params.get("agent_plan"))
    if approved_plan_context:
        prompt = f"{approved_plan_context}\n\nUser request: {(prompt or '').strip()}"
    reference_contract = _reference_image_contract(len(ref_images), is_workflow_edit)
    if is_workflow_edit and ref_images and "User edit request:" not in prompt:
        prompt = _workflow_edit_instruction(prompt, len(ref_images))
    elif ref_images and reference_contract not in prompt:
        prompt = f"{reference_contract}\nUser request: {(prompt or '').strip()}"
    # The provider policy intentionally resolves to one call. Keep the value
    # in the task state for observability, not as a retry loop control.
    max_image_attempts = provider_policy.image_generation_attempts(params)
    use_planning = bool(llm_model_id) or (is_workflow_edit and bool(ref_images))
    resolved_llm_for_history = llm_model_id
    resolved_vision_for_history = vision_model_id
    review_model_id = str(params.get("review_model_id") or "").strip()
    review_model_category = str(params.get("review_model_category") or "").strip()
    logger.info(
        "image_generation_agent start task_id=%s model_id=%s llm_model_id=%s vision_model_id=%s ref_count=%s source=%s conversation_id=%s",
        task_id,
        model_id,
        llm_model_id,
        vision_model_id,
        len(ref_images),
        source,
        conversation_id,
    )
    try:
        await task_repo.set_processing(task_id, 5)
        await _save_task_state(task_id, state)
        await _update_deep_run(
            agent_run_id,
            status="executing",
            stage="execution_started",
            message="正在执行已确认的创作方案。",
            task_id=task_id,
        )

        if ref_images:
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="reference_binding",
                status="completed",
                message=f"已锁定 {len(ref_images)} 张输入图的顺序与参考角色。",
                progress=10,
                result={"reference_count": len(ref_images), "workflow_edit": is_workflow_edit},
            )

        if approved_plan_context:
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="deep_plan",
                status="completed",
                message="已载入你确认的深度创作计划与关键选择。",
                progress=12,
            )

        if use_planning:
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="intent_planning",
                status="running",
                message="智能体正在理解需求并规划提示词...",
                progress=12,
            )
            plan, resolved_llm_model_id = await _plan_prompt(
                original_prompt=prompt,
                mode=mode,
                ref_count=len(ref_images),
                ref_images=ref_images,
                reference_contract=reference_contract,
                model_id=llm_model_id,
                user_id=user_id,
                task_id=task_id,
                billing_discount_rate=billing_discount_rate,
            )
            resolved_llm_for_history = resolved_llm_model_id
            logger.info("image_generation_agent planned task_id=%s resolved_llm_model_id=%s", task_id, resolved_llm_model_id)
            final_prompt = plan.get("final_prompt") or prompt
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="intent_planning",
                status="completed",
                message="提示词规划完成，准备生成图像...",
                progress=25,
                result={"intent_summary": plan.get("intent_summary", ""), "quality_checks": plan.get("quality_checks", [])},
            )
        else:
            final_prompt = prompt
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="intent_planning",
                status="skipped",
                message="已使用快速生图模式，直接调用图像模型。",
                progress=20,
            )

        if reference_contract and reference_contract not in final_prompt:
            final_prompt = f"{final_prompt}\n\n{reference_contract}"

        generated_images: list[dict] = []
        first_stored_asset = None
        first_image_base64 = ""
        if output_count > 1:
            state_lock = asyncio.Lock()
            completed_variants = 0
            generated_slots: list[dict | None] = [None] * output_count

            async def generate_variant(variant_index: int):
                nonlocal completed_variants
                variant_prompt = _variant_generation_prompt(final_prompt, variant_index, output_count)
                react_state = await _run_image_variant_react(
                    task_id=task_id,
                    model_id=model_id,
                    user_id=user_id,
                    agent_run_id=agent_run_id,
                    source_prompt=prompt,
                    final_prompt=final_prompt,
                    ref_images=ref_images,
                    reference_contract=reference_contract,
                    vision_model_id=vision_model_id,
                    llm_model_id=llm_model_id,
                    review_model_id=review_model_id,
                    review_model_category=review_model_category,
                    size=size,
                    aspect_ratio=aspect_ratio,
                    output_resolution=output_resolution,
                    image_quality=image_quality,
                    force_size=force_size,
                    variant_index=variant_index,
                    output_count=output_count,
                    completed_variants=completed_variants,
                    deep_visual_review=deep_visual_review,
                    billing_discount_rate=billing_discount_rate,
                    task_state=state,
                    state_lock=state_lock,
                )
                payload, stored_asset, image_base64, version_asset_metas = await _store_variant_result(
                    react_state=react_state,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    task_id=task_id,
                    variant_index=variant_index,
                    prompt=prompt,
                    final_prompt=variant_prompt,
                    model_id=model_id,
                    source_client=source_client,
                )
                async with state_lock:
                    generated_slots[variant_index - 1] = payload
                    completed_variants += 1
                    await set_agent_step(
                        state,
                        lambda s: _save_task_state(task_id, s),
                        name=f"image_generation_{variant_index}",
                        status="completed",
                        message=f"发散创意 {variant_index}/{output_count} 已完成。",
                        progress=min(95, 30 + int(completed_variants / output_count * 60)),
                    )
                await _save_partial_generation_result(
                    task_id=task_id,
                    images=generated_slots,
                    model_id=model_id,
                    final_prompt=final_prompt,
                    state=state,
                )
                return variant_index, payload, stored_asset, image_base64, version_asset_metas

            parallel_results = await gather_limited(
                range(1, output_count + 1),
                settings.TASK_FANOUT_CONCURRENCY,
                generate_variant,
                return_exceptions=True,
            )
            successful_results = [
                item for item in parallel_results
                if not isinstance(item, BaseException)
            ]
            failed_variants = [
                index
                for index, item in enumerate(parallel_results, start=1)
                if isinstance(item, BaseException)
            ]
            failed_variant_errors = [
                {
                    "variantIndex": index,
                    "error": _humanize_generation_error(str(item)),
                }
                for index, item in enumerate(parallel_results, start=1)
                if isinstance(item, BaseException)
            ]
            if not successful_results:
                errors = "; ".join(item["error"] for item in failed_variant_errors)
                raise RuntimeError(errors or "所有图像变体均生成失败")

            successful_results = sorted(successful_results, key=lambda item: item[0])
            generated_images = [item[1] for item in successful_results]
            first_stored_asset = successful_results[0][2]
            first_image_base64 = successful_results[0][3]
            completed_count = len(successful_results)
            partial = completed_count < output_count
            quality_review = None
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="image_generation",
                status="completed",
                message=(
                    f"已完成 {completed_count}/{output_count} 张图像，{len(failed_variants)} 张未生成。"
                    if partial
                    else f"{output_count} 张图像已并行生成完成，正在保存结果..."
                ),
                progress=96,
            )
            first_payload = generated_images[0]
            await task_repo.set_completed(task_id, {
                "imageBase64": first_payload.get("imageBase64") or first_image_base64,
                "imageUrl": first_payload.get("imageUrl") or "",
                "previewUrl": first_payload.get("previewUrl") or "",
                "thumbnailUrl": first_payload.get("thumbnailUrl") or "",
                "assetId": first_payload.get("assetId") or "",
                "images": generated_images,
                "model_id": model_id,
                "size": size,
                "output_size": size,
                "output_resolution": output_resolution,
                "image_quality": image_quality,
                "final_prompt": final_prompt,
                "agent_steps": state.get("agent_steps", []),
                "partial": partial,
                "requested_count": output_count,
                "completed_count": completed_count,
                "failed_variants": failed_variants,
                "failed_variant_errors": failed_variant_errors,
                "quality_review": quality_review,
            })
            logger.info("image_generation_agent completed task_id=%s model_id=%s", task_id, model_id)
            await _update_deep_run(
                agent_run_id,
                status="completed",
                stage="delivery",
                message="结果已生成并完成交付。",
                delivery={"task_id": task_id, "variant_count": completed_count, "partial": partial},
                intervention=None,
            )
            await _persist_generation_history(
                task_id=task_id,
                user_id=user_id,
                conversation_id=conversation_id,
                source=source,
                prompt=prompt,
                model_id=model_id,
                llm_model_id=resolved_llm_for_history,
                vision_model_id=resolved_vision_for_history,
                size=size,
                output_resolution=output_resolution,
                image_quality=image_quality,
                ref_count=len(ref_images),
                image_base64=None if first_stored_asset else first_image_base64,
                image_asset_metas=[
                    asset_meta
                    for _, _, _, _, version_asset_metas in successful_results
                    for asset_meta in version_asset_metas
                ],
                result_meta={
                    "partial": partial,
                    "requested_count": output_count,
                    "completed_count": completed_count,
                    "failed_variants": failed_variants,
                    "quality_review": quality_review,
                },
            )
            try:
                import repositories.model_repo as model_repo
                await model_repo.increment_calls(model_id, 0)
            except Exception:
                pass
            return
        history_asset_metas: list[dict] = []
        for variant_index in range(1, output_count + 1):
            variant_prompt = _variant_generation_prompt(final_prompt, variant_index, output_count)
            react_state = await _run_image_variant_react(
                task_id=task_id,
                model_id=model_id,
                user_id=user_id,
                agent_run_id=agent_run_id,
                source_prompt=prompt,
                final_prompt=final_prompt,
                ref_images=ref_images,
                reference_contract=reference_contract,
                vision_model_id=vision_model_id,
                llm_model_id=llm_model_id,
                review_model_id=review_model_id,
                review_model_category=review_model_category,
                size=size,
                aspect_ratio=aspect_ratio,
                output_resolution=output_resolution,
                image_quality=image_quality,
                force_size=force_size,
                variant_index=variant_index,
                output_count=output_count,
                completed_variants=variant_index - 1,
                deep_visual_review=deep_visual_review,
                billing_discount_rate=billing_discount_rate,
                task_state=state,
                state_lock=None,
            )
            payload, stored_asset, image_base64, version_asset_metas = await _store_variant_result(
                react_state=react_state,
                user_id=user_id,
                conversation_id=conversation_id,
                task_id=task_id,
                variant_index=variant_index,
                prompt=prompt,
                final_prompt=variant_prompt,
                model_id=model_id,
                source_client=source_client,
            )
            if variant_index == 1:
                first_stored_asset = stored_asset
                first_image_base64 = image_base64
            generated_images.append(payload)
            history_asset_metas.extend(version_asset_metas)
            await set_agent_step(
                state,
                lambda s: _save_task_state(task_id, s),
                name="image_generation",
                status="running" if variant_index < output_count else "completed",
                message=(
                    "图像生成完成，正在保存结果..."
                    if output_count == 1
                    else f"发散创意 {variant_index}/{output_count} 已完成"
                ),
                progress=min(95, 30 + int(variant_index / output_count * 60)),
            )

        first_payload = generated_images[0]
        quality_review = None
        await task_repo.set_completed(task_id, {
            "imageBase64": first_payload.get("imageBase64") or first_image_base64,
            "imageUrl": first_payload.get("imageUrl") or "",
            "previewUrl": first_payload.get("previewUrl") or "",
            "thumbnailUrl": first_payload.get("thumbnailUrl") or "",
            "assetId": first_payload.get("assetId") or "",
            "images": generated_images,
            "model_id": model_id,
            "size": size,
            "output_size": size,
            "output_resolution": output_resolution,
            "image_quality": image_quality,
            "final_prompt": final_prompt,
            "agent_steps": state.get("agent_steps", []),
            "partial": False,
            "quality_review": quality_review,
        })
        logger.info("image_generation_agent completed task_id=%s model_id=%s", task_id, model_id)
        await _update_deep_run(
            agent_run_id,
            status="completed",
            stage="delivery",
            message="结果已生成并完成交付。",
            delivery={"task_id": task_id, "variant_count": len(generated_images), "partial": False},
            intervention=None,
        )
        await _persist_generation_history(
            task_id=task_id,
            user_id=user_id,
            conversation_id=conversation_id,
            source=source,
            prompt=prompt,
            model_id=model_id,
            llm_model_id=resolved_llm_for_history,
            vision_model_id=resolved_vision_for_history,
            size=size,
            output_resolution=output_resolution,
            image_quality=image_quality,
            ref_count=len(ref_images),
            image_base64=None if first_stored_asset else first_image_base64,
            image_asset_metas=history_asset_metas or None,
            result_meta={
                "partial": False,
                "requested_count": output_count,
                "completed_count": len(generated_images),
                "failed_variants": [],
                "quality_review": quality_review,
            },
        )
        try:
            import repositories.model_repo as model_repo
            await model_repo.increment_calls(model_id, 0)
        except Exception:
            pass
    except Exception as exc:
        final_error = _humanize_generation_error(str(exc))
        recovery = _generation_recovery(exc, final_error)
        logger.exception("image_generation_agent failed task_id=%s model_id=%s error=%s", task_id, model_id, final_error)

        # A concurrent variant or a storage callback may have published a
        # usable result before this branch observes its exception. Never add a
        # second failed history row or turn that task back into a failure.
        try:
            existing_task = await task_repo.get(task_id)
        except Exception:
            existing_task = None
        existing_result = existing_task.get("result") if isinstance(existing_task, dict) else None
        if (
            isinstance(existing_task, dict)
            and (
                existing_task.get("status") == "completed"
                or _has_image_result(existing_result)
            )
        ):
            if existing_task.get("status") != "completed" and isinstance(existing_result, dict):
                await task_repo.set_completed(task_id, existing_result)
            logger.warning(
                "image_generation_agent preserving available result task_id=%s status=%s",
                task_id,
                existing_task.get("status"),
            )
            return

        await _update_deep_run(
            agent_run_id,
            status="failed",
            stage="failed",
            message="本次创作没有完成。",
            detail=final_error,
            error=final_error,
            recovery=recovery,
        )
        state["error"] = final_error
        state["agent_recovery"] = recovery
        await _save_task_state(task_id, state)
        await _persist_generation_history(
            task_id=task_id,
            user_id=user_id,
            conversation_id=conversation_id,
            source=source,
            prompt=prompt,
            model_id=model_id,
            llm_model_id=resolved_llm_for_history,
            vision_model_id=resolved_vision_for_history,
            size=size,
            output_resolution=output_resolution,
            image_quality=image_quality,
            ref_count=len(ref_images),
            error=final_error,
        )
        await task_repo.set_failed(task_id, final_error)
