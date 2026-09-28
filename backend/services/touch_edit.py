"""
触摸编辑服务 — Worker 任务处理器

通过 InpaintingRouter 执行 replace / recolor / remove 操作，
并将结果写入 task_repo。

Requirements: R2.2, R2.3, R2.4, R2.7
"""

import base64
import logging
import random
from typing import Optional

from fastapi import HTTPException

import repositories.task_repo as task_repo
from core.concurrency import gather_limited
from core.config import settings
from services import asset_storage
from services.inpainting.router import InpaintingRouter
from services.platform_provider_billing import execute_platform_provider_call

logger = logging.getLogger(__name__)

# 全局路由器实例（延迟初始化）
_router: Optional[InpaintingRouter] = None


def _get_router() -> InpaintingRouter:
    """获取或创建 InpaintingRouter 单例"""
    global _router
    if _router is None:
        _router = InpaintingRouter()
    return _router


async def _store_edit_result(
    *,
    image_bytes: bytes,
    user_id: str,
    task_id: str,
    item_id: str,
    prompt: str,
    model_id: str,
):
    """Archive a completed edit so Redis does not retain the rendered pixels."""
    if not user_id:
        return None
    return await asset_storage.store_generated_image_best_effort(
        image_bytes=image_bytes,
        user_id=user_id,
        conversation_id=None,
        task_id=task_id,
        item_id=item_id,
        prompt=prompt,
        model_id=model_id,
        category="image_edit",
    )


async def run_icon_alternatives(
    *,
    task_id: str,
    image_bytes: bytes,
    mask_bytes: bytes,
    element_id: str,
    prompt: str = "",
    user_id: str = "",
    billing_model_id: str = "",
) -> None:
    """Generate icon/sticker replacement candidates in the queue worker."""

    await task_repo.set_processing(task_id, progress=5)
    try:
        from services.inpainting.flux_fill_provider import _analyze_surrounding_palette

        palette_colors = _analyze_surrounding_palette(
            image_bytes,
            mask_bytes,
            ring_width=32,
        )
        palette_suffix = ""
        if palette_colors:
            palette_suffix = ", matching surrounding palette: " + ", ".join(palette_colors)

        router = _get_router()
        base_prompt = prompt.strip() if prompt else "icon"
        count = 4
        completed = 0

        async def generate_one(index: int) -> Optional[dict]:
            nonlocal completed
            variant_prompt = (
                f"{base_prompt}, alternative #{index}, slightly different style"
                f"{palette_suffix}, seed:{random.randint(1, 2**31 - 1)}"
            )
            try:
                await task_repo.set_progress(
                    task_id,
                    min(90, 10 + int((completed / count) * 75)),
                )
                model_id = billing_model_id or "inpainting-icon-alternatives"
                result_bytes = await execute_platform_provider_call(
                    user_id=user_id,
                    model_id=model_id,
                    expected_category="generate",
                    description=f"Icon alternative {index}",
                    related_task_id=None,
                    reservation_task_id=task_id,
                    idempotency_key=f"task:{task_id}:provider:{model_id}:candidate:{index}",
                    invoke=lambda: router.inpaint(
                        image_bytes=image_bytes,
                        mask_bytes=mask_bytes,
                        prompt=variant_prompt,
                        mode="replace",
                    ),
                )
                stored_asset = await _store_edit_result(
                    image_bytes=result_bytes,
                    user_id=user_id,
                    task_id=task_id,
                    item_id=f"icon-alternative-{index}",
                    prompt=variant_prompt,
                    model_id="image2-inpaint",
                )
                image_base64 = "" if stored_asset else base64.b64encode(result_bytes).decode()
                completed += 1
                image_url = (
                    stored_asset.original_url
                    if stored_asset
                    else f"data:image/png;base64,{image_base64}"
                )
                return {
                    "id": f"candidate-{index}",
                    "index": index,
                    "image_base64": image_base64,
                    "image_url": image_url,
                    "preview_url": stored_asset.preview_url if stored_asset else "",
                    "thumbnail_url": stored_asset.thumb_url if stored_asset else "",
                    "asset_id": stored_asset.id if stored_asset else "",
                }
            except HTTPException:
                raise
            except Exception as exc:
                logger.warning(
                    "[icon_alternatives] candidate failed: task_id=%s index=%s error=%s",
                    task_id,
                    index,
                    exc,
                )
                return None

        results = await gather_limited(
            range(1, count + 1),
            settings.ICON_ALTERNATIVES_CONCURRENCY,
            generate_one,
        )
        candidates = [item for item in results if isinstance(item, dict)]
        if not candidates:
            raise RuntimeError("all icon alternatives failed")

        alternatives = [
            {
                "id": item["id"],
                "image_url": item["image_url"],
                "image_base64": item["image_base64"],
                "preview_url": item["preview_url"],
                "thumbnail_url": item["thumbnail_url"],
                "asset_id": item["asset_id"],
            }
            for item in candidates
        ]
        await task_repo.set_completed(task_id, {
            "element_id": element_id,
            "candidates": candidates,
            "alternatives": alternatives,
            "total": len(candidates),
        })
        logger.info(
            "[icon_alternatives] task completed: task_id=%s element_id=%s total=%s",
            task_id,
            element_id,
            len(candidates),
        )
    except Exception as exc:
        error_msg = f"icon alternatives failed: {exc}"
        await task_repo.set_failed(task_id, error_msg)
        logger.error("[icon_alternatives] %s task_id=%s", error_msg, task_id)
        raise


async def run_touch_inpaint(
    task_id: str,
    image_bytes: bytes,
    mask_bytes: bytes,
    prompt: str,
    mode: str,
    target_color: Optional[str] = None,
    element_id: Optional[str] = None,
    user_id: str = "",
    billing_model_id: str = "",
) -> None:
    """
    执行触摸编辑 Inpainting 任务。

    由 Worker 调用，通过 InpaintingRouter 路由到合适的 Provider。
    成功后将结果（base64 编码的 PNG）写入 task_repo。
    失败时由 task_repo 标记任务并统一发布 SSE task_failed 事件。

    参数:
        task_id: 任务 ID
        image_bytes: 原始图像 PNG bytes
        mask_bytes: 蒙版 PNG bytes
        prompt: 文本提示（replace 模式）
        mode: 编辑模式（replace / recolor / remove）
        target_color: 目标颜色 hex（recolor 模式）
        element_id: 被编辑元素 ID
    """
    # 标记任务开始处理
    await task_repo.set_processing(task_id, progress=10)

    try:
        router = _get_router()

        # 更新进度：开始 Inpainting
        await task_repo.set_progress(task_id, 30)

        # 执行 Inpainting（InpaintingRouter 内部处理超时和降级）
        model_id = billing_model_id or (
            "inpainting-lama" if mode == "remove" else "inpainting-flux-fill"
        )
        result_bytes = await execute_platform_provider_call(
            user_id=user_id,
            model_id=model_id,
            expected_category="generate",
            description=f"Touch {mode}",
            related_task_id=None,
            reservation_task_id=task_id,
            idempotency_key=f"task:{task_id}:provider:{model_id}:inpaint",
            invoke=lambda: router.inpaint(
                image_bytes=image_bytes,
                mask_bytes=mask_bytes,
                prompt=prompt,
                mode=mode,
                target_color=target_color,
            ),
        )

        # 更新进度：Inpainting 完成
        await task_repo.set_progress(task_id, 90)

        # 编码结果
        stored_asset = await _store_edit_result(
            image_bytes=result_bytes,
            user_id=user_id,
            task_id=task_id,
            item_id=f"touch-{element_id or mode}",
            prompt=prompt or f"{mode} image edit",
            model_id="image2-inpaint",
        )
        result_b64 = "" if stored_asset else base64.b64encode(result_bytes).decode()

        # 标记任务完成
        await task_repo.set_completed(task_id, {
            "image": stored_asset.original_url if stored_asset else result_b64,
            "imageBase64": result_b64,
            "imageUrl": stored_asset.original_url if stored_asset else "",
            "previewUrl": stored_asset.preview_url if stored_asset else "",
            "thumbnailUrl": stored_asset.thumb_url if stored_asset else "",
            "assetId": stored_asset.id if stored_asset else "",
            "element_id": element_id,
            "mode": mode,
        })

        logger.info(
            f"[touch_edit] 任务完成: task_id={task_id} mode={mode} "
            f"element_id={element_id}"
        )

    except Exception as e:
        error_msg = f"触摸编辑失败（mode={mode}）: {str(e)}"
        logger.error(f"[touch_edit] {error_msg}, task_id={task_id}")

        # 标记任务失败
        await task_repo.set_failed(task_id, error_msg)

        raise  # 重新抛出让 Worker 记录
 
