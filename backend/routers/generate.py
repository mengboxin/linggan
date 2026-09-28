"""Unified image generation routes."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import time
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image

from core import generation_execution
from core.config import settings
from core.credit_reserve import (
    get_available_balance,
    release_task_reservation,
    reserve_for_task,
)
from core.rate_limit import RateLimitExceeded, rate_limit
from core.worker import TASK_TIMEOUT
from models.schemas import TaskStatusResponse
from routers.auth import get_current_user
from services.ai_client import get_default_model_id
from services.image_output import normalize_image_quality, normalize_output_resolution, resolve_image_output_options
from core.queue import UserConcurrencyExceeded, enqueue
import repositories.model_repo as model_repo
import repositories.task_repo as task_repo
from repositories import conversation_repo, creative_style_repo
from services import asset_lifecycle, asset_storage
from services import queue_assets
from services.agents.agent_run_store import (
    AgentRunTransitionError,
    transition_run,
    update_run,
    validate_confirmed_run,
)
from services.agents.creative_runtime import create_module_run
from services.creative_skill_resolver import CreativeSkillResolutionError, resolve_creative_skill_submission

router = APIRouter(prefix="/api/generate", tags=["图像生成"])
logger = logging.getLogger(__name__)

STALE_STATUS_GRACE_SECONDS = 120


async def _get_task_for_user(task_id: str, user_id: str) -> Optional[dict]:
    """Read status from Go during migration, with Redis fallback for availability."""
    if not settings.GO_CONTROL_PLANE_URL or not settings.GO_CONTROL_PLANE_SHARED_SECRET:
        return await task_repo.get(task_id)
    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=1.0)) as client:
            response = await client.get(
                f"{settings.GO_CONTROL_PLANE_URL}/internal/v1/tasks/{task_id}",
                headers={
                    "X-Control-Plane-Secret": settings.GO_CONTROL_PLANE_SHARED_SECRET,
                    "X-Task-User-ID": user_id,
                },
            )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        task = response.json()
        return task if isinstance(task, dict) else None
    except Exception as exc:
        logger.warning("Go task status read failed; falling back to Redis task_id=%s error=%s", task_id, exc)
        return await task_repo.get(task_id)


def _require_task_owner(task: dict, user_id: str) -> None:
    if task.get("_user_id") != user_id:
        raise HTTPException(404, "任务不存在")


def _model_cost(row: Optional[dict]) -> float:
    if not row or row.get("price_type") in ("free", "subscription"):
        return 0.0
    return float(row.get("price_credits", 0) or 0)


def _is_image2_model(model_id: str, model: dict) -> bool:
    meta = model.get("meta") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    identities = (
        model_id,
        model.get("id"),
        model.get("name"),
        meta.get("model_name"),
        meta.get("responses_model"),
    )
    for value in identities:
        compact = "".join(character for character in str(value or "").lower() if character.isalnum())
        if compact == "image2" or compact.endswith("gptimage2"):
            return True
    return False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _submit_idempotency_keys(
    *,
    user_id: str,
    client_request_id: str,
    model_id: str,
    prompt: str,
    size: str,
    n: int,
    llm_model_id: str,
    vision_model_id: str,
    conversation_id: str,
    source: str,
    image_hashes: list[str],
    operation_id: str = "",
    output_resolution: str = "1k",
    image_quality: str = "auto",
    make_public: bool = False,
) -> list[str]:
    return generation_execution.generate_submit_idempotency_keys(
        generation_execution.GenerateSubmitIdentity(
            user_id=user_id,
            client_request_id=client_request_id,
            model_id=model_id,
            prompt=prompt,
            size=size,
            output_resolution=output_resolution,
            image_quality=image_quality,
            n=n,
            llm_model_id=llm_model_id,
            vision_model_id=vision_model_id,
            conversation_id=conversation_id,
            source=source,
            image_hashes=image_hashes,
            operation_id=operation_id,
            make_public=make_public,
        )
    )


async def _read_submit_record(key: str) -> Optional[dict]:
    return await generation_execution.read_submit_record(key)


async def _claim_submit_key(key: str) -> Optional[dict]:
    return await generation_execution.claim_submit_key(key)


async def _claim_submit_keys(keys: list[str]) -> Optional[dict]:
    claimed: list[str] = []
    try:
        for key in keys:
            duplicate = await _claim_submit_key(key)
            if duplicate:
                for claimed_key in claimed:
                    await _forget_submit_key(claimed_key)
                return duplicate
            claimed.append(key)
        return None
    except Exception:
        for claimed_key in claimed:
            await _forget_submit_key(claimed_key)
        raise


async def _remember_submit_key(key: str, record: dict) -> None:
    await generation_execution.remember_submit_key(key, record)


async def _remember_submit_keys(keys: list[str], record: dict) -> None:
    for key in keys:
        await _remember_submit_key(key, record)


async def _forget_submit_key(key: str) -> None:
    await generation_execution.forget_submit_key(key)


async def _forget_submit_keys(keys: list[str]) -> None:
    for key in keys:
        await _forget_submit_key(key)


async def _rollback_unqueued_submission(
    *,
    task_id: str,
    user_id: str,
    payload: dict | None,
    error: str,
) -> None:
    """Finish a task that failed before its stream message was accepted."""
    try:
        await task_repo.set_failed(task_id, error)
    except Exception as rollback_error:
        logger.exception(
            "failed to mark unqueued generate task as failed task_id=%s error=%s",
            task_id,
            rollback_error,
        )
    if payload:
        await queue_assets.release_consumed_queue_inputs(
            user_id=user_id,
            payload=payload,
        )


async def _finalize_if_stale(task_id: str, task: dict) -> dict:
    status = task.get("status")
    if status not in {"pending", "processing"}:
        return task

    updated_ms = int(task.get("_updated_ms") or task.get("_start_ms") or 0)
    timeout_seconds = TASK_TIMEOUT.get("generate", TASK_TIMEOUT["default"])
    stale_after_ms = (timeout_seconds + STALE_STATUS_GRACE_SECONDS) * 1000
    if updated_ms and _now_ms() - updated_ms > stale_after_ms:
        message = (
            f"任务长时间未更新，已按超时结束。超过 {timeout_seconds + STALE_STATUS_GRACE_SECONDS} 秒未收到生成进度，"
            "请重试一次。"
        )
        await task_repo.set_failed(task_id, message)
        refreshed = await task_repo.get(task_id)
        return refreshed or {**task, "status": "failed", "error": message}
    return task


def _status_result(result: dict | None) -> dict | None:
    if not isinstance(result, dict):
        return None
    has_url = any(result.get(key) for key in ("imageUrl", "image_url", "previewUrl", "preview_url"))
    if not has_url:
        return result
    compact = dict(result)
    compact.pop("imageBase64", None)
    compact.pop("image_base64", None)
    return compact


@router.post("/submit")
async def submit(
    model_id: str = Form(...),
    prompt: str = Form(...),
    size: Optional[str] = Form(None),
    output_resolution: str = Form("1k"),
    aspect_ratio: str = Form(""),
    image_quality: str = Form("auto"),
    n: int = Form(1),
    llm_model_id: str = Form(""),
    vision_model_id: str = Form(""),
    conversation_id: str = Form(""),
    source: str = Form(""),
    client_request_id: str = Form(""),
    operation_id: str = Form(""),
    make_public: bool = Form(False),
    agent_plan: str = Form(""),
    agent_run_id: str = Form(""),
    snapshot_fingerprint: str = Form(""),
    skill_id: str = Form(""),
    skill_revision: int = Form(0),
    images: List[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    try:
        await rate_limit(user["id"], "generate")
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)})

    # Route functions are also invoked directly by focused tests and internal
    # callers. FastAPI only unwraps Form defaults on an HTTP request.
    make_public = make_public if isinstance(make_public, bool) else False
    source_clean = source.strip()[:40] if isinstance(source, str) else ""
    operation_id_clean = operation_id.strip()[:160] if isinstance(operation_id, str) else ""
    skill_id_clean = skill_id.strip()[:160] if isinstance(skill_id, str) else ""
    submitted_skill_revision = skill_revision if isinstance(skill_revision, int) else 0
    user_prompt = prompt.strip() if isinstance(prompt, str) else ""
    prompt = user_prompt
    skill_audit_meta: dict[str, object] = {}
    skill_display_name = ""
    # FastAPI resolves Form defaults for HTTP calls, while direct route unit
    # tests receive the Form marker itself. Treat only an actual string as
    # submitted planning context in both cases.
    raw_agent_plan = agent_plan if isinstance(agent_plan, str) else ""
    raw_agent_run_id = agent_run_id.strip() if isinstance(agent_run_id, str) else ""
    raw_snapshot_fingerprint = snapshot_fingerprint.strip() if isinstance(snapshot_fingerprint, str) else ""
    agent_plan_context: dict = {}
    if raw_agent_plan.strip():
        try:
            parsed_agent_plan = json.loads(raw_agent_plan)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, "深度规划数据格式无效") from exc
        if not isinstance(parsed_agent_plan, dict):
            raise HTTPException(400, "深度规划数据格式无效")
        agent_plan_context = parsed_agent_plan
    confirmed_agent_run: dict | None = None
    if raw_agent_run_id:
        try:
            confirmed_agent_run = await validate_confirmed_run(
                raw_agent_run_id,
                user_id=user["id"],
                snapshot_fingerprint=raw_snapshot_fingerprint,
            )
        except AgentRunTransitionError as exc:
            raise HTTPException(409, str(exc)) from exc
        stored_plan = confirmed_agent_run.get("plan")
        stored_context = confirmed_agent_run.get("execution_context")
        agent_plan_context = {
            **(stored_context if isinstance(stored_context, dict) else {}),
            "run_id": raw_agent_run_id,
            "summary": (stored_plan or {}).get("summary", "") if isinstance(stored_plan, dict) else "",
            "answers": confirmed_agent_run.get("answers") or {},
            "snapshot_fingerprint": raw_snapshot_fingerprint,
        }
    is_image2_shortcut = source_clean.endswith("image2_shortcut") or isinstance(
        agent_plan_context.get("image2_shortcut"), dict
    )
    output_resolution = normalize_output_resolution(output_resolution)
    requested_aspect_ratio = aspect_ratio.strip() if isinstance(aspect_ratio, str) else ""
    image_quality = normalize_image_quality(image_quality)
    n = max(1, min(3, int(n or 1)))

    if len(images) > 8:
        raise HTTPException(400, "最多上传 8 张参考图")

    if skill_id_clean:
        skill = await creative_style_repo.get_style_preset(skill_id_clean)
        if not skill:
            skill = await creative_style_repo.get_personal_style_recipe(
                user_id=str(user["id"]),
                style_id=skill_id_clean,
            )
        if not skill or skill.get("enabled") is False:
            raise HTTPException(404, "灵感配方不存在或已停用")
        current_revision = int(skill.get("revision") or 1)
        if submitted_skill_revision and submitted_skill_revision != current_revision:
            raise HTTPException(409, "灵感配方已更新，请重新选择后再提交")
        try:
            resolved_skill = resolve_creative_skill_submission(
                skill,
                expected_module="TEXT_TO_IMAGE",
                user_prompt=user_prompt,
                image_count=len(images),
            )
        except CreativeSkillResolutionError as exc:
            status_code = 404 if exc.code in {"skill_disabled"} else 400
            raise HTTPException(status_code, str(exc)) from exc
        prompt = resolved_skill.instruction
        skill_audit_meta = {
            **resolved_skill.audit_meta(),
            "resolved_params": resolved_skill.params,
        }
        skill_display_name = str(skill.get("name") or skill_id_clean)
        locked_defaults = {
            key: value
            for key, value in resolved_skill.params.items()
            if key not in set(resolved_skill.constraints.get("user_overrides", []))
        }
        if "model_id" in locked_defaults:
            model_id = str(locked_defaults["model_id"])
        if "llm_model_id" in locked_defaults:
            llm_model_id = str(locked_defaults["llm_model_id"])
        if "vision_model_id" in locked_defaults:
            vision_model_id = str(locked_defaults["vision_model_id"])
        if "size" in locked_defaults:
            size = str(locked_defaults["size"])
        if "output_resolution" in locked_defaults:
            output_resolution = str(locked_defaults["output_resolution"])
        if "image_quality" in locked_defaults:
            image_quality = str(locked_defaults["image_quality"])
        if "count" in locked_defaults:
            n = int(locked_defaults["count"] or 1)
        if "make_public" in locked_defaults:
            make_public = bool(locked_defaults["make_public"])
    elif not prompt:
        raise HTTPException(400, "请输入提示词，或选择一个可免提示词运行的灵感配方")

    if not settings.PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED:
        make_public = False

    model = await model_repo.get_model(model_id)
    if not model or model.get("enabled") is False:
        raise HTTPException(404, f"图像模型 {model_id!r} 不存在或已禁用")
    if model.get("category") != "generate":
        raise HTTPException(400, "图像生成请选择 generate 类型模型")
    if is_image2_shortcut and not _is_image2_model(model_id, model):
        raise HTTPException(400, "image2 快捷编辑只能使用已启用的 image2 模型")

    # Default text-to-image must submit exactly one upstream image-generation
    # request. Workflow image editing uses one lightweight planning pass so
    # reference images do not become a rigid "keep original unchanged" wrapper.
    auto_plan_workflow_edit = (
        not is_image2_shortcut
        and source_clean.endswith("workflow_edit")
        and len(images) > 0
    )
    resolved_llm_model_id = "" if is_image2_shortcut else (
        llm_model_id.strip() or (await get_default_model_id("llm") if auto_plan_workflow_edit else "")
    )
    # Keep the established transport contract: visual QA is a multimodal LLM
    # call. Billing must account for that existing call without silently
    # switching users to a separate vision SKU.
    resolved_vision_model_id = ""
    llm_model = await model_repo.get_model(resolved_llm_model_id) if resolved_llm_model_id else None

    if resolved_llm_model_id and (
        not llm_model or llm_model.get("enabled") is False or llm_model.get("category") != "llm"
    ):
        raise HTTPException(400, "规划模型请选择已启用的 llm 类型模型")
    resolved_review_model_id = "" if is_image2_shortcut else (
        resolved_llm_model_id or (await get_default_model_id("llm") or "")
    )
    review_model = (
        llm_model
        if resolved_review_model_id and resolved_review_model_id == resolved_llm_model_id
        else await model_repo.get_model(resolved_review_model_id)
        if resolved_review_model_id
        else None
    )
    if resolved_review_model_id and (
        not review_model
        or review_model.get("enabled") is False
        or review_model.get("category") != "llm"
    ):
        raise HTTPException(400, "质检模型请选择已启用且支持多模态输入的 llm 类型模型")

    conversation_id = conversation_id.strip()
    if conversation_id and not await conversation_repo.conversation_belongs_to_user(conversation_id, user["id"]):
        raise HTTPException(404, "Conversation not found")

    images_bytes: list[bytes] = []
    image_inputs: list[dict] = []
    image_hashes: list[str] = []
    reference_size: tuple[int, int] | None = None
    max_file_bytes = max(1, settings.MAX_FILE_SIZE_MB) * 1024 * 1024
    max_request_bytes = max(max_file_bytes, settings.MAX_IMAGE_REQUEST_MB * 1024 * 1024)
    total_input_bytes = 0
    for image_index, img in enumerate(images):
        raw = await img.read(max_file_bytes + 1)
        if len(raw) > max_file_bytes:
            raise HTTPException(413, f"单张参考图不能超过 {settings.MAX_FILE_SIZE_MB}MB")
        total_input_bytes += len(raw)
        if total_input_bytes > max_request_bytes:
            raise HTTPException(413, f"参考图总大小不能超过 {settings.MAX_IMAGE_REQUEST_MB}MB")
        image_size: tuple[int, int] | None = None
        try:
            with Image.open(io.BytesIO(raw)) as reference_image:
                image_size = reference_image.size
        except Exception:
            image_size = None
        if image_size and image_size[0] * image_size[1] > settings.MAX_IMAGE_PIXELS:
            raise HTTPException(413, "参考图像素尺寸过大")
        if reference_size is None:
            reference_size = image_size
        image_hashes.append(hashlib.sha256(raw).hexdigest())
        images_bytes.append(raw)
        image_inputs.append({
            "role": "source" if image_index == 0 else "reference",
            "data": raw,
            "filename": getattr(img, "filename", "") or f"reference-{image_index}.bin",
            "content_type": getattr(img, "content_type", "") or "application/octet-stream",
        })

    resolved_output = resolve_image_output_options(
        prompt=prompt,
        requested_size=size,
        output_resolution=output_resolution,
        requested_aspect_ratio=requested_aspect_ratio,
        reference_size=reference_size,
    )
    size = resolved_output.size
    output_resolution = resolved_output.output_resolution

    submit_keys = _submit_idempotency_keys(
        user_id=user["id"],
        client_request_id=client_request_id,
        model_id=model_id,
        prompt=prompt,
        size=size,
        output_resolution=output_resolution,
        image_quality=image_quality,
        n=n,
        llm_model_id=resolved_llm_model_id,
        vision_model_id=resolved_vision_model_id,
        conversation_id=conversation_id,
        source=source_clean,
        image_hashes=image_hashes,
        operation_id=operation_id_clean,
        make_public=make_public,
    )
    duplicate = await _claim_submit_keys(submit_keys)
    if duplicate:
        return duplicate

    review_call_count = n if resolved_review_model_id else 0
    cost = round(
        _model_cost(model) * n
        + _model_cost(llm_model)
        + _model_cost(review_model) * review_call_count,
        2,
    )
    task_id = ""
    reservation_task_id = ""
    effective_agent_run_id = raw_agent_run_id
    queued_payload: dict | None = None
    queue_submission_succeeded = False
    try:
        candidate_task_id = str(uuid.uuid4())
        if cost > 0:
            ok = await reserve_for_task(user["id"], candidate_task_id, cost)
            if not ok:
                available = await get_available_balance(user["id"])
                raise HTTPException(
                    402,
                    f"积分不足，本次智能生图至少需要 {cost:g} 积分，可用余额 {available:.2f}。",
                )
            reservation_task_id = candidate_task_id

        task_id = await task_repo.create(
            "compose",
            user_id=user["id"],
            model_id=model_id,
            cost=cost,
            model_name=model.get("name", model_id),
            # A Go image2 callback arms terminal settlement immediately before
            # it completes the task. Do not arm it here: an asset-storage
            # fallback can route the same submission to Python, where the
            # image agent owns the one-and-only model-call debit.
            charge_on_complete=False,
            task_id=candidate_task_id,
        )
        # Image2 retouch can be submitted directly from the mobile canvas and
        # has no pre-existing conversation.  Create the durable image
        # conversation after idempotency is claimed so retries cannot create
        # duplicate history containers.
        if not conversation_id and source_clean in {
            "image2_shortcut",
            "desktop_image2_shortcut",
            "mobile_retouch_image2_shortcut",
        }:
            conversation = await conversation_repo.create_conversation(
                user_id=user["id"],
                conv_type="image",
                title=(prompt.strip()[:80] or "图片精修"),
                creation_key=(f"image:{client_request_id.strip()[:128]}" if client_request_id.strip() else None),
            )
            conversation_id = str(conversation.get("id") or "")
            if not conversation_id:
                raise HTTPException(503, "无法创建图片历史会话")
        if confirmed_agent_run:
            await transition_run(
                raw_agent_run_id,
                user_id=user["id"],
                status="queued",
                stage="task_queued",
                message="已创建生成任务，正在排队执行。",
                task_id=task_id,
            )
        else:
            # Fast submissions share the same durable top-level lifecycle as
            # deep plans.  They remain fast because this only creates state;
            # it does not add an LLM planning call or a confirmation dialog.
            module = "image_edit" if auto_plan_workflow_edit or is_image2_shortcut else "image_generate"
            action = "edit" if module == "image_edit" else "generate"
            reference_roles = (
                ["source", *["reference"] * max(0, len(images_bytes) - 1)]
                if auto_plan_workflow_edit or is_image2_shortcut
                else ["reference"] * len(images_bytes)
            )
            try:
                module_run = await create_module_run(
                    user_id=user["id"],
                    module=module,
                    action=action,
                    instruction=prompt,
                    conversation_id=conversation_id,
                    context={
                        "agent_mode": "fast",
                        "task_id": task_id,
                        "model_id": model_id,
                        "source": source_clean,
                        "output_count": n,
                        "output_size": size,
                        "output_resolution": output_resolution,
                        "image_quality": image_quality,
                        "reference_count": len(images_bytes),
                        "additional_reference_count": max(0, len(images_bytes) - (1 if auto_plan_workflow_edit else 0)),
                        "reference_roles": reference_roles,
                        "creative_skill": skill_audit_meta or None,
                    },
                )
                effective_agent_run_id = str(module_run.get("run_id") or "")
                if effective_agent_run_id:
                    await update_run(
                        effective_agent_run_id,
                        user_id=user["id"],
                        task_id=task_id,
                    )
            except Exception as exc:
                logger.warning("failed to create fast top-level agent run task_id=%s error=%s", task_id, exc)
        if make_public:
            await task_repo._update(task_id, {
                "_make_public": True,
                "_public_prompt": prompt,
                "_public_module": "TEXT_TO_IMAGE",
                "_public_source": source_clean or "web",
                "_public_reward_per_image": 1.0,
            })
        if skill_audit_meta:
            await task_repo._update(task_id, {"_creative_skill": skill_audit_meta})

        if conversation_id:
            try:
                await conversation_repo.add_message(
                    conversation_id=conversation_id,
                    role="user",
                    content=user_prompt or (f"使用技能：{skill_display_name}" if skill_display_name else prompt),
                    meta={
                        "type": "image_request",
                        "task_id": task_id,
                        "job_id": task_id,
                        "model_id": model_id,
                        "llm_model_id": resolved_llm_model_id,
                        "vision_model_id": resolved_vision_model_id,
                        "size": size,
                        "output_resolution": output_resolution,
                        "aspect_ratio": resolved_output.aspect_ratio,
                        "image_quality": image_quality,
                        "has_reference": len(images_bytes) > 0,
                        "source": source_clean or "web",
                        "agent_run_id": effective_agent_run_id,
                        "make_public": make_public,
                        "creative_skill": skill_audit_meta or None,
                        "user_prompt": user_prompt,
                        "skill_name": skill_display_name,
                    },
                )
            except Exception as exc:
                logger.warning("failed to persist generate request message task_id=%s: %s", task_id, exc)

        image_assets = await queue_assets.persist_queue_inputs(
            user_id=user["id"],
            task_id=task_id,
            inputs=image_inputs,
        )
        queued_payload = {
                "model_id": model_id,
                "prompt": prompt,
                "params": {
                    "size": size,
                    "output_resolution": output_resolution,
                    "aspect_ratio": resolved_output.aspect_ratio,
                    "image_quality": image_quality,
                    "force_size": True,
                    "n": n,
                    "reserved_cost": cost,
                    "make_public": make_public,
                    "user_id": user["id"],
                    "conversation_id": conversation_id,
                    "source": source_clean,
                    "agent_mode": "deep" if confirmed_agent_run else "fast",
                    "agent_plan": agent_plan_context,
                    "agent_run_id": effective_agent_run_id,
                    "creative_skill": skill_audit_meta or None,
                    "review_model_id": resolved_review_model_id,
                    "review_model_category": "llm" if resolved_review_model_id else "",
                    "enable_visual_review": False,
                    "allow_image_retry": True,
                    "max_image_attempts": 2,
                },
                # New tasks only carry object references. The Base64 fallback
                # is for local installs without S3/R2 and for migration safety.
                "image_assets": image_assets or [],
                "images_bytes_b64": [] if image_assets is not None else [
                    base64.b64encode(raw).decode("ascii") for raw in images_bytes
                ],
                "llm_model_id": resolved_llm_model_id,
                "vision_model_id": resolved_vision_model_id,
        }
        await enqueue(
            task_type="generate",
            task_id=task_id,
            payload=queued_payload,
            priority="normal",
            user_id=user["id"],
        )
        queue_submission_succeeded = True

        result = {
            "taskId": task_id,
            "cost": cost,
            "call_count": (
                n
                + (1 if resolved_llm_model_id else 0)
                + review_call_count
            ),
            "llm_model_id": resolved_llm_model_id,
            "vision_model_id": resolved_vision_model_id,
            "review_model_id": resolved_review_model_id,
            "agent_run_id": effective_agent_run_id,
            "make_public": make_public,
            "creative_skill": skill_audit_meta or None,
            "duplicate": False,
        }
        await _remember_submit_keys(submit_keys, result)
        return result
    except UserConcurrencyExceeded as exc:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error="当前生成任务过多，请等待已有任务完成或清理后再提交",
            )
            if effective_agent_run_id:
                try:
                    await transition_run(
                        effective_agent_run_id,
                        user_id=user["id"],
                        status="failed",
                        stage="submission_failed",
                        message="任务未能进入执行队列。",
                        detail="当前生成任务过多，请稍后重试。",
                    )
                except Exception:
                    pass
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        if not queue_submission_succeeded:
            await _forget_submit_keys(submit_keys)
        raise HTTPException(429, "当前生成任务过多，请等待已有任务完成或清理后再提交") from exc
    except HTTPException as exc:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error=str(exc.detail) or "任务提交失败，已释放预占积分",
            )
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        if not queue_submission_succeeded:
            await _forget_submit_keys(submit_keys)
        raise
    except Exception:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error="任务提交失败，已释放预占积分",
            )
            if effective_agent_run_id:
                try:
                    await transition_run(
                        effective_agent_run_id,
                        user_id=user["id"],
                        status="failed",
                        stage="submission_failed",
                        message="任务提交失败，未进入执行队列。",
                    )
                except Exception:
                    pass
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        if not queue_submission_succeeded:
            await _forget_submit_keys(submit_keys)
        raise


@router.get("/status/{task_id}", response_model=TaskStatusResponse)
async def status(task_id: str, user: dict = Depends(get_current_user)):
    task = await _get_task_for_user(task_id, user["id"])
    if not task:
        raise HTTPException(404, "任务不存在")
    _require_task_owner(task, user["id"])

    task = await _finalize_if_stale(task_id, task)
    status_result = _status_result(task.get("result"))
    if task.get("status") == "completed" and status_result:
        status_result = await asset_storage.prepare_image_asset_payload(status_result, user["id"])
    return TaskStatusResponse(
        taskId=task_id,
        status=task["status"],
        progress=task.get("progress", 0),
        error=task.get("error"),
        message=task.get("message"),
        agent_steps=task.get("agent_steps") or [],
        result=status_result,
    )


@router.get("/result/{task_id}")
async def result(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    _require_task_owner(task, user["id"])
    if task["status"] != "completed":
        raise HTTPException(400, "任务未完成")
    return await asset_storage.prepare_image_asset_payload(task["result"], user["id"])


@router.post("/cancel/{task_id}")
async def cancel(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        return {"ok": True}
    _require_task_owner(task, user["id"])
    await task_repo.cancel(task_id)
    return {"ok": True}


@router.delete("/{task_id}")
async def delete(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        return {"ok": True}
    _require_task_owner(task, user["id"])
    cleanup_records = {"task_id": task_id, "result": task.get("result") or {}}
    cleanup_intent_id = await asset_lifecycle.create_record_cleanup_intent(
        user_id=user["id"],
        records=cleanup_records,
        reason="generation-task-delete",
    )
    await task_repo.delete(task_id)
    cleanup = await asset_lifecycle.process_record_cleanup_intent(cleanup_intent_id)
    return {"ok": True, "cleanup": cleanup}
