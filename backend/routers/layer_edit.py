"""
图层编辑路由

包含：
- /submit: 原有图层编辑（模型驱动）
- /touch-replace: 触摸编辑 - 替换（R2.2）
- /touch-recolor: 触摸编辑 - 重新着色（R2.3）
- /touch-remove: 触摸编辑 - 移除（R2.4）
- /icon-alternatives: 图标替代方案生成（R4.2, R4.4, R4.5）

触摸编辑端点入队为 Redis Streams 任务，任务状态由 task_repo 统一发布到 SSE。

Requirements: R2.2, R2.3, R2.4, R2.6, R2.7, R4.2, R4.4, R4.5
"""

import base64
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from models.schemas import TaskStatusResponse
import repositories.task_repo as task_repo
import repositories.model_repo as model_repo
import repositories.credit_repo as credit_repo
from core.credit_reserve import (
    get_available_balance,
    release_task_reservation,
    reserve_for_task,
)
from routers.auth import get_current_user
from core.queue import UserConcurrencyExceeded, enqueue
from core.rate_limit import rate_limit, RateLimitExceeded
from services import foxapi_credentials
from services import queue_assets
from services.image_upload_validation import read_image_upload, read_image_uploads
from services.platform_provider_billing import require_platform_provider_sku

logger = logging.getLogger(__name__)


async def _queue_binary_inputs(
    *,
    user_id: str,
    task_id: str,
    image: UploadFile,
    image_bytes: bytes,
    mask: UploadFile | None = None,
    mask_bytes: bytes = b"",
) -> tuple[dict | None, dict | None, str, str]:
    """Archive request binaries before enqueueing an edit task."""
    items = [{
        "role": "image",
        "data": image_bytes,
        "filename": image.filename or "image.bin",
        "content_type": image.content_type or "application/octet-stream",
    }]
    if mask is not None:
        items.append({
            "role": "mask",
            "data": mask_bytes,
            "filename": mask.filename or "mask.bin",
            "content_type": mask.content_type or "application/octet-stream",
        })
    try:
        references = await queue_assets.persist_queue_inputs(
            user_id=user_id,
            task_id=task_id,
            inputs=items,
        )
    except Exception as exc:
        await _rollback_unqueued_submission(
            task_id=task_id,
            user_id=user_id,
            payload=None,
            error=exc,
        )
        raise
    if references is None:
        return None, None, base64.b64encode(image_bytes).decode("ascii"), base64.b64encode(mask_bytes).decode("ascii")
    by_role = {str(reference.get("role") or ""): reference for reference in references}
    return by_role.get("image"), by_role.get("mask"), "", ""


async def _rollback_unqueued_submission(
    *,
    task_id: str,
    user_id: str,
    payload: dict | None,
    error: Exception,
) -> None:
    """Release task state and request binaries when submission never reached Redis."""
    try:
        await task_repo.set_failed(
            task_id,
            str(error) or "task submission failed before queueing",
        )
    except Exception as rollback_error:
        logger.exception(
            "failed to mark unqueued edit task as failed task_id=%s error=%s",
            task_id,
            rollback_error,
        )
    if payload:
        await queue_assets.release_consumed_queue_inputs(
            user_id=user_id,
            payload=payload,
        )


def _raise_submission_error(error: Exception) -> None:
    if isinstance(error, UserConcurrencyExceeded):
        raise HTTPException(
            429,
            detail="当前编辑任务过多，请等待已有任务完成后再试",
        ) from error
    raise error


def _require_platform_inpainting(user: dict) -> None:
    if user.get("billing_mode") == foxapi_credentials.BILLING_MODE:
        raise HTTPException(
            409,
            "FoxAPI密钥账号暂不支持专用蒙版修复模型；普通图像编辑仍可选择 FoxAPI 生图模型",
        )

router = APIRouter(prefix="/api/layer-edit", tags=["图层编辑"])


async def _create_provider_billed_task(
    *,
    task_type: str,
    user_id: str,
    model_id: str,
    model_name: str,
    call_count: int = 1,
) -> str:
    """Create a task whose individual provider calls settle in the worker."""
    sku = await require_platform_provider_sku(
        user_id=user_id,
        model_id=model_id,
        expected_category="generate",
        description=model_name,
    )
    if sku is None:
        # Dedicated inpainting routes currently reject external-key mode, but
        # keep this defensive branch from accidentally creating a free task.
        raise HTTPException(409, f"{model_name} is not available in API-key mode")

    unit_cost = float(sku.get("price_credits", 0) or 0)
    cost = round(unit_cost * max(1, int(call_count or 1)), 4)
    candidate_task_id = str(uuid.uuid4())
    if not await reserve_for_task(user_id, candidate_task_id, cost):
        available = await get_available_balance(user_id)
        raise HTTPException(
            402,
            f"Insufficient credits: {model_name} requires up to {cost:g}; "
            f"{available:.2f} credits are currently available.",
        )
    try:
        return await task_repo.create(
            task_type,
            user_id=user_id,
            model_id=model_id,
            cost=cost,
            model_name=str(sku.get("name") or model_name),
            charge_on_complete=False,
            task_id=candidate_task_id,
        )
    except Exception:
        await release_task_reservation(candidate_task_id)
        raise


def _require_task_owner(task: dict, user_id: str) -> None:
    if str(task.get("_user_id") or "") != str(user_id):
        raise HTTPException(404, "task not found")


@router.post("/submit")
async def submit(
    image: UploadFile = File(...),
    model_id: str = Form(...),
    prompt: str = Form(""),
    negative_prompt: str = Form(""),
    strength: float = Form(0.75),
    style: str = Form(""),
    user: dict = Depends(get_current_user),
):
    # 速率限制
    try:
        await rate_limit(user["id"], "layer-edit")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes = await read_image_upload(image)

    # 积分预留（原子性，防并发）
    model = await model_repo.get_model(model_id)
    if not model:
        raise HTTPException(404, f"模型 {model_id!r} 不存在或不可用于当前账号")
    cost = float(model.get("price_credits", 0)) if model else 0.0
    candidate_task_id = str(uuid.uuid4())
    has_reservation = False
    if cost > 0:
        ok = await reserve_for_task(user["id"], candidate_task_id, cost)
        if not ok:
            available = await get_available_balance(user["id"])
            raise HTTPException(
                402,
                f"积分不足，需要 {cost} 积分，可用余额 {available:.2f}（可能有进行中的任务占用）",
            )
        has_reservation = True
    try:
        task_id = await task_repo.create(
            "layer-edit", user_id=user["id"], model_id=model_id,
            cost=cost, model_name=model.get("name", model_id) if model else model_id,
            task_id=candidate_task_id,
        )
    except Exception:
        if has_reservation:
            await release_task_reservation(candidate_task_id)
        raise
    params = dict(
        model_id=model_id, prompt=prompt,
        negative_prompt=negative_prompt, strength=strength, style=style,
    )

    # 入队（任务成功后在 task_repo.set_completed 中扣费）
    image_asset, _, legacy_image, _ = await _queue_binary_inputs(
        user_id=user["id"], task_id=task_id, image=image, image_bytes=image_bytes,
    )
    payload = {
        "image_asset": image_asset,
        "image_bytes": legacy_image,
        "params": params,
    }
    try:
        await enqueue(
            task_type="layer-edit",
            task_id=task_id,
            payload=payload,
            priority="normal",
            user_id=user["id"],
        )
    except Exception as exc:
        await _rollback_unqueued_submission(
            task_id=task_id,
            user_id=user["id"],
            payload=payload,
            error=exc,
        )
        _raise_submission_error(exc)

    return {"taskId": task_id}


@router.get("/status/{task_id}", response_model=TaskStatusResponse)
async def status(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    _require_task_owner(task, user["id"])
    return TaskStatusResponse(
        taskId=task_id, status=task["status"],
        progress=task["progress"], error=task["error"],
        result=task.get("result") if task.get("status") == "completed" else None,
    )


@router.get("/result/{task_id}")
async def result(task_id: str, user: dict = Depends(get_current_user)):
    task = await task_repo.get(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    _require_task_owner(task, user["id"])
    if task["status"] != "completed":
        raise HTTPException(400, "任务未完成")
    return task["result"]


# ─── 触摸编辑端点（R2.2, R2.3, R2.4）────────────────────────────────────────


async def _enqueue_touch_edit(
    task_type: str,
    task_id: str,
    payload: dict,
    user_id: str,
) -> dict:
    try:
        await enqueue(
            task_type=task_type,
            task_id=task_id,
            payload=payload,
            priority="normal",
            user_id=user_id,
        )
    except Exception as exc:
        await _rollback_unqueued_submission(
            task_id=task_id,
            user_id=user_id,
            payload=payload,
            error=exc,
        )
        _raise_submission_error(exc)
    return {"taskId": task_id, "status": "queued"}

@router.post("/touch-replace")
async def touch_replace(
    image: UploadFile = File(..., description="原始图像 PNG"),
    mask: UploadFile = File(..., description="蒙版 PNG（白色区域为编辑区域）"),
    prompt: str = Form(..., min_length=1, max_length=500, description="替换内容描述"),
    element_id: str = Form(..., description="被编辑元素 ID"),
    user: dict = Depends(get_current_user),
):
    """
    触摸编辑 - 替换（R2.2）

    用 prompt 描述的内容替换选中区域。请求入队后立即返回 taskId，
    Worker 通过 task_repo 将进度和终态发布到 SSE。
    """
    _require_platform_inpainting(user)

    # 速率限制
    try:
        await rate_limit(user["id"], "layer-edit")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes, mask_bytes = await read_image_uploads((("原始图片", image), ("蒙版", mask)))

    # 创建任务记录
    task_id = await _create_provider_billed_task(
        task_type="touch-replace",
        user_id=user["id"],
        model_id="inpainting-flux-fill",
        model_name="Touch Replace",
    )

    image_asset, mask_asset, legacy_image, legacy_mask = await _queue_binary_inputs(
        user_id=user["id"], task_id=task_id, image=image, image_bytes=image_bytes,
        mask=mask, mask_bytes=mask_bytes,
    )
    payload = {
        "model_id": "inpainting-flux-fill",
        "billing_model_id": "inpainting-flux-fill",
        "image_asset": image_asset,
        "mask_asset": mask_asset,
        "image_bytes": legacy_image,
        "mask_bytes": legacy_mask,
        "prompt": prompt,
        "element_id": element_id,
        "mode": "replace",
    }

    return await _enqueue_touch_edit(
        task_type="touch-replace",
        task_id=task_id,
        payload=payload,
        user_id=user["id"],
    )


@router.post("/touch-recolor")
async def touch_recolor(
    image: UploadFile = File(..., description="原始图像 PNG"),
    mask: UploadFile = File(..., description="蒙版 PNG（白色区域为编辑区域）"),
    target_color: str = Form(..., description="目标颜色 hex 值，如 #ff0000"),
    element_id: str = Form(..., description="被编辑元素 ID"),
    user: dict = Depends(get_current_user),
):
    """
    触摸编辑 - 重新着色（R2.3）

    改变选中区域颜色，保留纹理和光照。请求入队后立即返回 taskId，
    Worker 通过 task_repo 将进度和终态发布到 SSE。
    """
    _require_platform_inpainting(user)

    # 速率限制
    try:
        await rate_limit(user["id"], "layer-edit")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes, mask_bytes = await read_image_uploads((("原始图片", image), ("蒙版", mask)))

    # 创建任务记录
    task_id = await _create_provider_billed_task(
        task_type="touch-recolor",
        user_id=user["id"],
        model_id="inpainting-flux-fill",
        model_name="Touch Recolor",
    )

    image_asset, mask_asset, legacy_image, legacy_mask = await _queue_binary_inputs(
        user_id=user["id"], task_id=task_id, image=image, image_bytes=image_bytes,
        mask=mask, mask_bytes=mask_bytes,
    )
    payload = {
        "model_id": "inpainting-flux-fill",
        "billing_model_id": "inpainting-flux-fill",
        "image_asset": image_asset,
        "mask_asset": mask_asset,
        "image_bytes": legacy_image,
        "mask_bytes": legacy_mask,
        "target_color": target_color,
        "element_id": element_id,
        "mode": "recolor",
    }

    return await _enqueue_touch_edit(
        task_type="touch-recolor",
        task_id=task_id,
        payload=payload,
        user_id=user["id"],
    )


@router.post("/touch-remove")
async def touch_remove(
    image: UploadFile = File(..., description="原始图像 PNG"),
    mask: UploadFile = File(..., description="蒙版 PNG（白色区域为编辑区域）"),
    element_id: str = Form(..., description="被编辑元素 ID"),
    user: dict = Depends(get_current_user),
):
    """
    触摸编辑 - 移除（R2.4）

    移除选中区域，用背景内容填充。请求入队后立即返回 taskId，
    Worker 通过 task_repo 将进度和终态发布到 SSE。
    """
    _require_platform_inpainting(user)

    # 速率限制
    try:
        await rate_limit(user["id"], "layer-edit")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes, mask_bytes = await read_image_uploads((("原始图片", image), ("蒙版", mask)))

    # 创建任务记录
    task_id = await _create_provider_billed_task(
        task_type="touch-remove",
        user_id=user["id"],
        model_id="inpainting-lama",
        model_name="Touch Remove",
    )

    image_asset, mask_asset, legacy_image, legacy_mask = await _queue_binary_inputs(
        user_id=user["id"], task_id=task_id, image=image, image_bytes=image_bytes,
        mask=mask, mask_bytes=mask_bytes,
    )
    payload = {
        "image_asset": image_asset,
        "mask_asset": mask_asset,
        "image_bytes": legacy_image,
        "mask_bytes": legacy_mask,
        "billing_model_id": "inpainting-lama",
        "element_id": element_id,
        "mode": "remove",
    }

    return await _enqueue_touch_edit(
        task_type="touch-remove",
        task_id=task_id,
        payload=payload,
        user_id=user["id"],
    )


# ─── Icon Alternatives 端点（R4.2, R4.4, R4.5）────────────────────────────────


@router.post("/icon-alternatives")
async def icon_alternatives(
    image: UploadFile = File(..., description="原始图像 PNG"),
    mask: UploadFile = File(..., description="蒙版 PNG（白色区域为图标区域）"),
    element_id: str = Form(..., description="被编辑元素 ID"),
    prompt: Optional[str] = Form("", description="可选的风格描述提示"),
    user: dict = Depends(get_current_user),
):
    """
    图标替代方案生成（R4.2, R4.4, R4.5）

    并行调用 Inpainting 4 次，每次使用不同的 prompt 变体和随机 seed，
    生成至少 4 个风格略有不同的图标候选方案。

    - 分析 mask 周围 32px 环带颜色直方图，将主色加入 prompt（R4.4 风格保留）
    - 15s 超时限制（R4.5）
    - 返回 ≥4 个 base64 编码的候选图像
    """
    _require_platform_inpainting(user)

    # 速率限制
    try:
        await rate_limit(user["id"], "layer-edit")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes, mask_bytes = await read_image_uploads((("原始图片", image), ("蒙版", mask)))

    # R4.4：分析 mask 周围 32px 环带颜色直方图
    task_id = await _create_provider_billed_task(
        task_type="icon-alternatives",
        user_id=user["id"],
        model_id="inpainting-icon-alternatives",
        model_name="Icon Alternatives",
        call_count=4,
    )
    image_asset, mask_asset, legacy_image, legacy_mask = await _queue_binary_inputs(
        user_id=user["id"], task_id=task_id, image=image, image_bytes=image_bytes,
        mask=mask, mask_bytes=mask_bytes,
    )
    payload = {
        "image_asset": image_asset,
        "mask_asset": mask_asset,
        "image_bytes": legacy_image,
        "mask_bytes": legacy_mask,
        "billing_model_id": "inpainting-icon-alternatives",
        "element_id": element_id,
        "prompt": prompt or "",
    }
    await _enqueue_touch_edit(
        task_type="icon-alternatives",
        task_id=task_id,
        payload=payload,
        user_id=user["id"],
    )

    return {"taskId": task_id, "status": "queued", "element_id": element_id}
