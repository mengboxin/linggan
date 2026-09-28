"""Grok video generation routes."""

from __future__ import annotations

import io
import logging
import time
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image

from core.config import settings
from core.credit_reserve import get_available_balance, release_task_reservation, reserve_for_task
from core.rate_limit import RateLimitExceeded, rate_limit
from core.worker import TASK_TIMEOUT
from models.schemas import TaskStatusResponse
from routers.auth import get_current_user
from core.queue import UserConcurrencyExceeded, enqueue
import repositories.model_repo as model_repo
import repositories.task_repo as task_repo
from services import queue_assets
from services.grok_availability import GROK_DISABLED_MESSAGE, is_grok_enabled
from services.grok_output import (
    grok_video_duration,
    grok_video_requires_reference_image,
)

router = APIRouter(prefix="/api/generate-video", tags=["视频生成"])
logger = logging.getLogger(__name__)
STALE_STATUS_GRACE_SECONDS = 120


def _now_ms() -> int:
    return int(time.time() * 1000)


def _model_cost(row: Optional[dict]) -> float:
    if not row or row.get("price_type") in ("free", "subscription"):
        return 0.0
    return float(row.get("price_credits", 0) or 0)


async def _rollback_unqueued_submission(*, task_id: str, user_id: str, payload: dict | None, error: str) -> None:
    try:
        await task_repo.set_failed(task_id, error)
    except Exception as rollback_error:
        logger.exception("failed to mark unqueued video task as failed task_id=%s error=%s", task_id, rollback_error)
    if payload:
        await queue_assets.release_consumed_queue_inputs(user_id=user_id, payload=payload)


async def _finalize_if_stale(task_id: str, task: dict) -> dict:
    status = task.get("status")
    if status not in {"pending", "processing"}:
        return task
    updated_ms = int(task.get("_updated_ms") or task.get("_start_ms") or 0)
    timeout_seconds = TASK_TIMEOUT.get("generate-video", TASK_TIMEOUT["default"])
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


@router.post("/submit")
async def submit(
    model_id: str = Form(...),
    prompt: str = Form(...),
    duration: int = Form(6),
    source: str = Form(""),
    client_request_id: str = Form(""),
    images: List[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    try:
        await rate_limit(user["id"], "generate")
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)})

    if not await is_grok_enabled():
        raise HTTPException(503, GROK_DISABLED_MESSAGE)
    prompt = prompt.strip() if isinstance(prompt, str) else ""
    if not prompt:
        raise HTTPException(400, "请输入视频提示词")
    duration = grok_video_duration(duration)
    source_clean = source.strip()[:40] if isinstance(source, str) else ""

    model = await model_repo.get_model(model_id)
    if not model or model.get("enabled") is False:
        raise HTTPException(404, f"视频模型 {model_id!r} 不存在或已禁用")
    if model.get("category") != "video":
        raise HTTPException(400, "视频生成请选择 video 类型模型")

    if len(images) > 1:
        raise HTTPException(400, "Grok Imagine Video 一次仅支持 1 张参考图")

    images_bytes: list[bytes] = []
    image_inputs: list[dict] = []
    max_file_bytes = max(1, settings.MAX_FILE_SIZE_MB) * 1024 * 1024
    for image_index, img in enumerate(images):
        raw = await img.read(max_file_bytes + 1)
        if len(raw) > max_file_bytes:
            raise HTTPException(413, f"单张参考图不能超过 {settings.MAX_FILE_SIZE_MB}MB")
        try:
            with Image.open(io.BytesIO(raw)) as reference_image:
                if reference_image.size[0] * reference_image.size[1] > settings.MAX_IMAGE_PIXELS:
                    raise HTTPException(413, "参考图像素尺寸过大")
        except HTTPException:
            raise
        except Exception:
            pass
        images_bytes.append(raw)
        image_inputs.append({
            "role": "reference",
            "data": raw,
            "filename": getattr(img, "filename", "") or f"reference-{image_index}.bin",
            "content_type": getattr(img, "content_type", "") or "application/octet-stream",
        })

    model_meta = model.get("meta") if isinstance(model.get("meta"), dict) else {}
    model_name = str(model_meta.get("model_name") or model.get("id") or "")
    if grok_video_requires_reference_image(model_name) and not images_bytes:
        raise HTTPException(400, "该 Grok 视频模型仅支持图生视频，请先上传一张参考图")

    cost = round(_model_cost(model), 2)
    task_id = ""
    reservation_task_id = ""
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
                    f"积分不足，本次生视频至少需要 {cost:g} 积分，可用余额 {available:.2f}。",
                )
            reservation_task_id = candidate_task_id

        task_id = await task_repo.create(
            "generate-video",
            user_id=user["id"],
            model_id=model_id,
            cost=cost,
            model_name=model.get("name", model_id),
            charge_on_complete=True,
            task_id=candidate_task_id,
        )
        image_assets = await queue_assets.persist_queue_inputs(
            user_id=user["id"],
            task_id=task_id,
            inputs=image_inputs,
        )
        queued_payload = {
            "model_id": model_id,
            "prompt": prompt,
            "params": {
                "duration": duration,
                "reserved_cost": cost,
                "user_id": user["id"],
                "source": source_clean,
                "client_request_id": client_request_id.strip()[:160] if isinstance(client_request_id, str) else "",
            },
            "image_assets": image_assets or [],
            "images_bytes_b64": [] if image_assets is not None else [
                __import__("base64").b64encode(raw).decode("ascii") for raw in images_bytes
            ],
        }
        await enqueue(
            task_type="generate-video",
            task_id=task_id,
            payload=queued_payload,
            priority="normal",
            user_id=user["id"],
        )
        queue_submission_succeeded = True
        return {
            "taskId": task_id,
            "cost": cost,
            "duplicate": False,
        }
    except UserConcurrencyExceeded as exc:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error="当前生成任务过多，请等待已有任务完成或清理后再提交",
            )
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        raise HTTPException(429, "当前生成任务过多，请等待已有任务完成或清理后再提交") from exc
    except HTTPException:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error="任务提交失败，已释放预占积分",
            )
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        raise
    except Exception:
        if task_id and not queue_submission_succeeded:
            await _rollback_unqueued_submission(
                task_id=task_id,
                user_id=user["id"],
                payload=queued_payload,
                error="任务提交失败，已释放预占积分",
            )
        elif reservation_task_id:
            await release_task_reservation(reservation_task_id)
        raise


@router.get("/status/{task_id}", response_model=TaskStatusResponse)
async def status(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task or task.get("_user_id") != user["id"]:
        raise HTTPException(404, "任务不存在")
    task = await _finalize_if_stale(task_id, task)
    return TaskStatusResponse(
        taskId=task_id,
        status=task["status"],
        progress=task.get("progress", 0),
        error=task.get("error"),
        message=task.get("message"),
        agent_steps=task.get("agent_steps") or [],
        result=task.get("result"),
    )


@router.get("/result/{task_id}")
async def result(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task or task.get("_user_id") != user["id"]:
        raise HTTPException(404, "任务不存在")
    if task["status"] != "completed":
        raise HTTPException(400, "任务未完成")
    return task["result"]


@router.post("/cancel/{task_id}")
async def cancel(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        return {"ok": True}
    if task.get("_user_id") != user["id"]:
        raise HTTPException(404, "任务不存在")
    await task_repo.cancel(task_id)
    return {"ok": True}
