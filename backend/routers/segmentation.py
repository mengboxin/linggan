from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
import base64
import json
import uuid

from models.schemas import TaskStatusResponse
import repositories.task_repo as task_repo
import repositories.model_repo as model_repo
import repositories.credit_repo as credit_repo
from core.credit_reserve import (
    get_available_balance,
    release_task_reservation,
    reserve_for_task,
)
from core.redis import get_redis
from routers.auth import get_current_user
from core.queue import UserConcurrencyExceeded, enqueue
from core.rate_limit import rate_limit, RateLimitExceeded
from services import foxapi_credentials
from services import queue_assets
from services.image_upload_validation import read_image_upload
from services.platform_provider_billing import require_platform_provider_sku

router = APIRouter(prefix="/api/segmentation", tags=["分割"])

# Redis 缓存 TTL：7 天（604800 秒）
SEG_CACHE_TTL = 604800
PARTIAL_SEGMENTATION_BILLING_MODEL_ID = "segmentation-sam2-grounding-dino"
REPLICATE_LAYERING_BILLING_MODEL_ID = "segmentation-replicate-layering"
OPENAI_LAYERING_BILLING_MODEL_ID = "segmentation-openai-layer"


async def _rollback_unqueued_submission(
    *,
    task_id: str,
    user_id: str,
    payload: dict | None,
    error: Exception,
) -> None:
    try:
        await task_repo.set_failed(
            task_id,
            str(error) or "task submission failed before queueing",
        )
    except Exception:
        pass
    if payload:
        await queue_assets.release_consumed_queue_inputs(
            user_id=user_id,
            payload=payload,
        )


def _raise_submission_error(error: Exception) -> None:
    if isinstance(error, UserConcurrencyExceeded):
        raise HTTPException(429, "当前分割任务过多，请等待已有任务完成后再试") from error
    raise error


async def _persist_queue_inputs(
    *,
    task_id: str,
    user_id: str,
    inputs: list[dict],
) -> list[dict] | None:
    try:
        return await queue_assets.persist_queue_inputs(
            user_id=user_id,
            task_id=task_id,
            inputs=inputs,
        )
    except Exception as exc:
        await _rollback_unqueued_submission(
            task_id=task_id,
            user_id=user_id,
            payload=None,
            error=exc,
        )
        raise


async def _enqueue_submission(
    *,
    task_type: str,
    task_id: str,
    user_id: str,
    payload: dict,
) -> None:
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


def _require_task_owner(task: dict, user_id: str) -> None:
    if str(task.get("_user_id") or "") != str(user_id):
        raise HTTPException(404, "task not found")


def _require_segmentation_access(user: dict) -> None:
    if user.get("billing_mode") == foxapi_credentials.BILLING_MODE:
        raise HTTPException(409, "FoxAPI密钥账号暂不支持专用分割模型，请先使用生图与编辑模块")


async def _create_partial_segmentation_task(user_id: str) -> str:
    sku = await require_platform_provider_sku(
        user_id=user_id,
        model_id=PARTIAL_SEGMENTATION_BILLING_MODEL_ID,
        expected_category="segmentation",
        description="SAM2 and GroundingDINO partial segmentation",
    )
    if sku is None:
        raise HTTPException(409, "Partial segmentation is not available in API-key mode")

    cost = float(sku.get("price_credits", 0) or 0)
    candidate_task_id = str(uuid.uuid4())
    if not await reserve_for_task(user_id, candidate_task_id, cost):
        available = await get_available_balance(user_id)
        raise HTTPException(
            402,
            f"Insufficient credits: partial segmentation requires {cost:g}; "
            f"{available:.2f} credits are currently available.",
        )
    try:
        return await task_repo.create(
            "segmentation-partial",
            user_id=user_id,
            model_id=PARTIAL_SEGMENTATION_BILLING_MODEL_ID,
            cost=cost,
            model_name=str(sku.get("name") or "SAM2 + GroundingDINO"),
            charge_on_complete=False,
            task_id=candidate_task_id,
        )
    except Exception:
        await release_task_reservation(candidate_task_id)
        raise


@router.get("/by-hash/{content_hash}")
async def get_by_hash(content_hash: str, user: dict = Depends(get_current_user)):
    """
    按内容 hash 命中 Redis 分割缓存（R12.2）。

    Redis key: seg:hash:{content_hash}
    缓存命中返回 SegmentationResult JSON，未命中返回 404。
    """
    redis = get_redis()
    cache_key = f"seg:hash:{content_hash}"
    cached = await redis.get(cache_key)
    if cached is None:
        raise HTTPException(404, "分割缓存未命中")
    try:
        result = json.loads(cached)
    except (json.JSONDecodeError, TypeError):
        # 缓存数据损坏，删除并返回 404
        await redis.delete(cache_key)
        raise HTTPException(404, "分割缓存数据损坏，已清除")
    return result


@router.post("/partial")
async def submit_partial(
    image: UploadFile = File(...),
    region_x: int = Form(...),
    region_y: int = Form(...),
    region_w: int = Form(...),
    region_h: int = Form(...),
    user: dict = Depends(get_current_user),
):
    """
    部分区域重分割（R12.3, R12.4）。

    仅对指定矩形区域进行分割，不重新处理整张图像。
    区域越界时返回 400 错误。
    """
    _require_segmentation_access(user)

    # 读取图像获取尺寸
    image_bytes = await read_image_upload(image)
    try:
        from PIL import Image as PILImage
        from io import BytesIO

        with PILImage.open(BytesIO(image_bytes)) as img:
            img_width, img_height = img.size
    except Exception:
        raise HTTPException(400, "无法解析上传的图像文件")

    # 区域参数校验
    if region_w <= 0 or region_h <= 0:
        raise HTTPException(400, "区域宽高必须为正整数")
    if region_x < 0 or region_y < 0:
        raise HTTPException(400, "区域坐标不能为负数")
    if region_x + region_w > img_width or region_y + region_h > img_height:
        raise HTTPException(
            400,
            f"区域越界：region({region_x},{region_y},{region_w},{region_h}) "
            f"超出图像尺寸({img_width}×{img_height})"
        )

    # 创建任务并入队
    task_id = await _create_partial_segmentation_task(user["id"])

    image_assets = await _persist_queue_inputs(
        user_id=user["id"],
        task_id=task_id,
        inputs=[{
            "role": "image",
            "data": image_bytes,
            "filename": image.filename or "segmentation-input.bin",
            "content_type": image.content_type or "application/octet-stream",
        }],
    )
    await _enqueue_submission(
        task_type="segmentation-partial",
        task_id=task_id,
        payload={
            "image_asset": image_assets[0] if image_assets else None,
            "image_bytes": "" if image_assets is not None else base64.b64encode(image_bytes).decode("ascii"),
            "region": {
                "x": region_x,
                "y": region_y,
                "w": region_w,
                "h": region_h,
            },
            "billing_model_id": PARTIAL_SEGMENTATION_BILLING_MODEL_ID,
        },
        user_id=user["id"],
    )

    return {"taskId": task_id}


@router.post("/submit")
async def submit(
    image: UploadFile = File(...),
    model_id: str = Form(""),
    prompt: str = Form(""),
    negative_prompt: str = Form(""),
    seed: int = Form(0),
    randomize_seed: bool = Form(True),
    go_fast: bool = Form(True),
    description: str = Form("auto"),
    output_format: str = Form("webp"),
    output_quality: int = Form(95),
    disable_safety_checker: bool = Form(False),
    guidance_scale: float = Form(4.0),
    num_inference_steps: int = Form(50),
    num_layers: int = Form(10),
    cfg_normalization: bool = Form(True),
    auto_caption_en: bool = Form(True),
    provider: str = Form("qwen"),
    max_layers: int = Form(4),
    user: dict = Depends(get_current_user),
):
    _require_segmentation_access(user)

    # 速率限制
    try:
        await rate_limit(user["id"], "segmentation")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    image_bytes = await read_image_upload(image)

    model = None
    cost = 0.0
    resolved_provider = str(provider or "qwen").strip().lower()
    billing_model_id = str(model_id or "").strip()
    if billing_model_id:
        model = await require_platform_provider_sku(
            user_id=user["id"],
            model_id=billing_model_id,
            expected_category="segmentation",
            description="Image layering",
        )
        if model is None:
            raise HTTPException(409, "Image layering is not available in API-key mode")
        provider_text = f"{model.get('provider', '')} {model.get('endpoint', '')}".lower()
        meta = model.get("meta") or {}
        if isinstance(meta, str):
            try:
                import json as _json
                meta = _json.loads(meta)
            except Exception:
                meta = {}
        if meta.get("provider"):
            resolved_provider = str(meta["provider"]).lower()
        elif "replicate" in provider_text or meta.get("layering") == "replicate":
            resolved_provider = "replicate"
        elif "openai" in provider_text or meta.get("layering") == "openai":
            resolved_provider = "openai"
        elif resolved_provider == "replicate":
            resolved_provider = "replicate"
        elif resolved_provider == "qwen":
            resolved_provider = "qwen"
    elif resolved_provider in {"replicate", "openai"}:
        billing_model_id = (
            REPLICATE_LAYERING_BILLING_MODEL_ID
            if resolved_provider == "replicate"
            else OPENAI_LAYERING_BILLING_MODEL_ID
        )
        model = await require_platform_provider_sku(
            user_id=user["id"],
            model_id=billing_model_id,
            expected_category="segmentation",
            description=f"{resolved_provider} image layering",
        )
        if model is None:
            raise HTTPException(409, "Image layering is not available in API-key mode")

    model_meta = (model or {}).get("meta") or {}
    if isinstance(model_meta, str):
        try:
            model_meta = json.loads(model_meta)
        except Exception:
            model_meta = {}
    provider_model_id = str(
        model_meta.get("provider_model_id")
        or model_meta.get("image_model_id")
        or ""
    ).strip()
    resolved_max_layers = max(1, min(int(max_layers or 4), 4))
    call_count = resolved_max_layers if resolved_provider == "openai" else 1
    if model:
        cost = round(float(model.get("price_credits", 0) or 0) * call_count, 4)

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
            "segmentation",
            user_id=user["id"],
            model_id=billing_model_id or None,
            cost=cost,
            model_name=model.get("name", billing_model_id) if model else "默认分割模型",
            charge_on_complete=resolved_provider != "openai",
            task_id=candidate_task_id,
        )
    except Exception:
        if has_reservation:
            await release_task_reservation(candidate_task_id)
        raise

    params = dict(
        prompt=prompt, negative_prompt=negative_prompt, seed=seed,
        randomize_seed=randomize_seed, go_fast=go_fast,
        description=description, output_format=output_format,
        output_quality=output_quality, disable_safety_checker=disable_safety_checker,
        guidance_scale=guidance_scale,
        num_inference_steps=num_inference_steps, num_layers=num_layers,
        cfg_normalization=cfg_normalization, auto_caption_en=auto_caption_en,
        provider=resolved_provider,
        max_layers=resolved_max_layers,
        model_id=(provider_model_id if resolved_provider == "openai" else billing_model_id),
        billing_model_id=billing_model_id,
    )

    # 入队（任务成功后在 task_repo.set_completed 中扣费）
    image_assets = await _persist_queue_inputs(
        user_id=user["id"],
        task_id=task_id,
        inputs=[{
            "role": "image",
            "data": image_bytes,
            "filename": image.filename or "segmentation-input.bin",
            "content_type": image.content_type or "application/octet-stream",
        }],
    )
    await _enqueue_submission(
        task_type="segmentation",
        task_id=task_id,
        payload={
            "image_asset": image_assets[0] if image_assets else None,
            "image_bytes": "" if image_assets is not None else base64.b64encode(image_bytes).decode("ascii"),
            "params": params,
        },
        user_id=user["id"],
    )

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
