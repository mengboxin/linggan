"""
PPT 画布编辑路由

端点：
- PUT /slide/{job_id}/{index}/element/{element_id}: 更新幻灯片元素
- POST /slide/{job_id}/{index}/background: 修改幻灯片背景

调用 Inpainting/TextRender 服务进行元素修改。
失败时不删除原 element 数据（R5.7 状态保留）。

Requirements: R5.3, R5.4, R5.5, R5.7
"""

import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.rate_limit import rate_limit, RateLimitExceeded
from repositories.ppt_canvas_repo import (
    ConcurrentUpdateError,
    get_slide,
    save_slide,
    update_element,
)
from routers.auth import get_current_user
from services.billing_operation import model_billing_operation_key
from services.inpainting.router import InpaintingRouter
from services.platform_provider_billing import execute_platform_provider_call
from services.text_render import TextRenderProvider
from services.text_render.anytext_provider import AnyTextProvider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ppt-canvas", tags=["PPT 画布编辑"])

# ─── 速率限制配置 ─────────────────────────────────────────────────────────────
PPT_CANVAS_RATE_ACTION = "ppt-canvas"
PPT_CANVAS_RATE_LIMIT = 20   # 每分钟 20 次
PPT_CANVAS_RATE_WINDOW = 60  # 60 秒窗口


# ─── 请求/响应模型 ────────────────────────────────────────────────────────────


class ElementPatchRequest(BaseModel):
    """元素更新请求体"""
    patch: dict[str, Any] = Field(
        ..., description="要合并到目标元素的字段（浅合并）"
    )
    expected_version: Optional[int] = Field(
        None, description="乐观锁版本号，为 None 时跳过版本检查"
    )
    # 可选：是否需要调用 AI 服务进行渲染
    use_inpainting: bool = Field(
        False, description="是否调用 Inpainting 服务处理图像元素修改"
    )
    use_text_render: bool = Field(
        False, description="是否调用 TextRender 服务处理文字元素修改"
    )
    # Inpainting 参数（仅 use_inpainting=True 时使用）
    inpainting_prompt: Optional[str] = Field(
        None, description="Inpainting 提示词"
    )
    inpainting_mode: Optional[Literal["replace", "recolor", "remove"]] = Field(
        None, description="Inpainting 模式"
    )
    inpainting_image_base64: Optional[str] = Field(
        None, description="原始图像 base64（PNG）"
    )
    inpainting_mask_base64: Optional[str] = Field(
        None, description="蒙版 base64（PNG）"
    )
    target_color: Optional[str] = Field(
        None, description="目标颜色 hex（仅 recolor 模式）"
    )
    # TextRender 参数（仅 use_text_render=True 时使用）
    text_render_image_base64: Optional[str] = Field(
        None, description="底图 base64（PNG）"
    )
    text_render_mask_base64: Optional[str] = Field(
        None, description="文字区域蒙版 base64（PNG）"
    )
    text_content: Optional[str] = Field(
        None, description="要渲染的文字内容"
    )
    font_family: Optional[str] = Field(None, description="字体族")
    font_size: Optional[int] = Field(None, description="字号")
    font_weight: Optional[int] = Field(None, description="字重")
    text_color: Optional[str] = Field(None, description="文字颜色 hex")


class ElementPatchResponse(BaseModel):
    """元素更新响应"""
    ok: bool
    version: int
    element_id: str
    ai_result_base64: Optional[str] = None
    warning: Optional[str] = None


class BackgroundRequest(BaseModel):
    """背景修改请求体"""
    kind: Literal["solid", "gradient", "image"] = Field(
        ..., description="背景类型"
    )
    value: str = Field(
        ..., description="背景值：solid 为颜色 hex，gradient 为 CSS 渐变字符串，image 为图片 URL 或 base64"
    )
    # 可选：AI 生成背景时的参数
    use_ai_generation: bool = Field(
        False, description="是否使用 AI 生成背景图"
    )
    ai_prompt: Optional[str] = Field(
        None, description="AI 背景生成提示词"
    )
    ai_image_base64: Optional[str] = Field(
        None, description="当前幻灯片图像 base64（用于 AI 生成参考）"
    )
    ai_mask_base64: Optional[str] = Field(
        None, description="背景区域蒙版 base64"
    )
    expected_version: Optional[int] = Field(
        None, description="乐观锁版本号"
    )


class BackgroundResponse(BaseModel):
    """背景修改响应"""
    ok: bool
    version: int
    background: dict[str, Any]
    ai_result_base64: Optional[str] = None
    warning: Optional[str] = None


# ─── 辅助函数 ─────────────────────────────────────────────────────────────────


def _get_inpainting_router() -> InpaintingRouter:
    """获取 InpaintingRouter 实例"""
    return InpaintingRouter()


def _get_text_render_provider() -> TextRenderProvider:
    """获取 TextRender Provider 实例"""
    return AnyTextProvider()


def _canvas_billing_key(
    *,
    user_id: str,
    job_id: str,
    index: int,
    target: str,
    operation: str,
    version: int,
    model_id: str,
    material: Any,
) -> str | None:
    return model_billing_operation_key(
        namespace="ppt-canvas",
        user_id=user_id,
        operation_scope=f"{job_id}:{index}:{target}:{operation}:version:{version}",
        material={
            "model_id": model_id,
            "request": material,
        },
    )


# ─── 路由端点 ─────────────────────────────────────────────────────────────────


@router.put(
    "/slide/{job_id}/{index}/element/{element_id}",
    response_model=ElementPatchResponse,
    summary="更新幻灯片元素",
    description="更新指定幻灯片中的单个元素。支持调用 Inpainting/TextRender 服务。"
    "失败时保留原始元素数据（R5.7）。",
)
async def update_slide_element(
    job_id: str,
    index: int,
    element_id: str,
    body: ElementPatchRequest,
    user: dict = Depends(get_current_user),
):
    """
    更新幻灯片元素（R5.3, R5.4, R5.7）

    - 支持纯数据 patch（直接合并字段）
    - 支持调用 Inpainting 服务修改图像/图标元素
    - 支持调用 TextRender 服务修改文字元素
    - 失败时不删除原 element 数据（R5.7 状态保留）
    """
    # 速率限制
    try:
        await rate_limit(
            user["id"], PPT_CANVAS_RATE_ACTION,
            limit=PPT_CANVAS_RATE_LIMIT, window=PPT_CANVAS_RATE_WINDOW,
        )
    except RateLimitExceeded as e:
        raise HTTPException(
            status_code=429,
            detail=str(e),
            headers={"Retry-After": str(e.retry_after)},
        )

    # 验证幻灯片存在
    slide = await get_slide(job_id, index)
    if not slide:
        raise HTTPException(404, f"幻灯片不存在: job_id={job_id}, index={index}")

    # 验证元素存在
    elements = slide.get("elements", [])
    target_element = None
    for elem in elements:
        if elem.get("id") == element_id:
            target_element = elem
            break
    if target_element is None:
        raise HTTPException(404, f"元素不存在: element_id={element_id}")

    # 构建最终 patch
    final_patch = dict(body.patch)
    ai_result_base64: Optional[str] = None
    warning: Optional[str] = None

    # 调用 Inpainting 服务（如果需要）
    if body.use_inpainting:
        if not body.inpainting_mode:
            raise HTTPException(422, "use_inpainting=True 时必须提供 inpainting_mode")
        if not body.inpainting_image_base64 or not body.inpainting_mask_base64:
            raise HTTPException(422, "use_inpainting=True 时必须提供 image 和 mask 的 base64 数据")

        try:
            import base64 as b64
            image_bytes = b64.b64decode(body.inpainting_image_base64)
            mask_bytes = b64.b64decode(body.inpainting_mask_base64)

            inpainting_router = _get_inpainting_router()
            billing_model_id = (
                "inpainting-lama"
                if body.inpainting_mode == "remove"
                else "inpainting-flux-fill"
            )
            result_bytes = await execute_platform_provider_call(
                user_id=user["id"],
                model_id=billing_model_id,
                expected_category="generate",
                description="PPT canvas inpainting",
                related_task_id=None,
                idempotency_key=_canvas_billing_key(
                    user_id=user["id"],
                    job_id=job_id,
                    index=index,
                    target=element_id,
                    operation=f"inpaint-{body.inpainting_mode}",
                    version=int(slide.get("version") or 0),
                    model_id=billing_model_id,
                    material={
                        "image": image_bytes,
                        "mask": mask_bytes,
                        "prompt": body.inpainting_prompt or "",
                        "mode": body.inpainting_mode,
                        "target_color": body.target_color,
                    },
                ),
                invoke=lambda: inpainting_router.inpaint(
                    image_bytes=image_bytes,
                    mask_bytes=mask_bytes,
                    prompt=body.inpainting_prompt or "",
                    mode=body.inpainting_mode,
                    target_color=body.target_color,
                ),
            )
            ai_result_base64 = b64.b64encode(result_bytes).decode()
            # 将 AI 结果写入 patch 的 src 字段
            final_patch["src"] = f"data:image/png;base64,{ai_result_base64}"
            logger.info(
                f"[ppt_canvas] Inpainting 成功: job_id={job_id}, index={index}, "
                f"element_id={element_id}, mode={body.inpainting_mode}"
            )
        except HTTPException:
            raise
        except Exception as e:
            # R5.7: 失败时不修改原始元素数据
            logger.error(
                f"[ppt_canvas] Inpainting 失败，保留原始数据: "
                f"job_id={job_id}, index={index}, element_id={element_id}, error={e}"
            )
            raise HTTPException(
                502,
                f"Inpainting 服务调用失败: {str(e)}。原始元素数据已保留。",
            )

    # 调用 TextRender 服务（如果需要）
    if body.use_text_render:
        if not body.text_content:
            raise HTTPException(422, "use_text_render=True 时必须提供 text_content")
        if not body.text_render_image_base64 or not body.text_render_mask_base64:
            raise HTTPException(422, "use_text_render=True 时必须提供 image 和 mask 的 base64 数据")

        try:
            import base64 as b64
            from services.ocr import FontInfo

            image_bytes = b64.b64decode(body.text_render_image_base64)
            mask_bytes = b64.b64decode(body.text_render_mask_base64)

            font_info = FontInfo(
                family=body.font_family or "system-ui",
                size=body.font_size or 16,
                weight=body.font_weight or 400,
                align="left",
            )

            text_provider = _get_text_render_provider()
            result_bytes = await execute_platform_provider_call(
                user_id=user["id"],
                model_id="text-render-anytext",
                expected_category="generate",
                description="PPT canvas text render",
                related_task_id=None,
                idempotency_key=_canvas_billing_key(
                    user_id=user["id"],
                    job_id=job_id,
                    index=index,
                    target=element_id,
                    operation="text-render",
                    version=int(slide.get("version") or 0),
                    model_id="text-render-anytext",
                    material={
                        "image": image_bytes,
                        "mask": mask_bytes,
                        "text": body.text_content,
                        "font_family": font_info.family,
                        "font_size": font_info.size,
                        "font_weight": font_info.weight,
                        "font_align": font_info.align,
                        "color": body.text_color or "#000000",
                    },
                ),
                invoke=lambda: text_provider.render(
                    base_image=image_bytes,
                    mask=mask_bytes,
                    text=body.text_content,
                    font_info=font_info,
                    color_hex=body.text_color or "#000000",
                ),
            )
            ai_result_base64 = b64.b64encode(result_bytes).decode()
            # 将 AI 结果写入 patch 的 src 字段
            final_patch["src"] = f"data:image/png;base64,{ai_result_base64}"
            # 同时更新文字内容字段
            final_patch["text"] = body.text_content
            if body.font_family:
                final_patch["fontFamily"] = body.font_family
            if body.font_size:
                final_patch["fontSize"] = body.font_size
            if body.text_color:
                final_patch["color"] = body.text_color

            logger.info(
                f"[ppt_canvas] TextRender 成功: job_id={job_id}, index={index}, "
                f"element_id={element_id}"
            )
        except HTTPException:
            raise
        except Exception as e:
            # R5.7: 失败时不修改原始元素数据
            logger.error(
                f"[ppt_canvas] TextRender 失败，保留原始数据: "
                f"job_id={job_id}, index={index}, element_id={element_id}, error={e}"
            )
            raise HTTPException(
                502,
                f"TextRender 服务调用失败: {str(e)}。原始元素数据已保留。",
            )

    # 执行元素更新（repo 层也有 R5.7 保护）
    try:
        new_version = await update_element(
            job_id=job_id,
            index=index,
            element_id=element_id,
            patch=final_patch,
            expected_version=body.expected_version,
        )
    except ConcurrentUpdateError as e:
        raise HTTPException(409, f"并发更新冲突: {str(e)}")
    except ValueError as e:
        raise HTTPException(404, str(e))

    return ElementPatchResponse(
        ok=True,
        version=new_version,
        element_id=element_id,
        ai_result_base64=ai_result_base64,
        warning=warning,
    )


@router.post(
    "/slide/{job_id}/{index}/background",
    response_model=BackgroundResponse,
    summary="修改幻灯片背景",
    description="修改指定幻灯片的背景。支持纯色、渐变、图片背景，"
    "以及 AI 生成背景。失败时保留原始背景（R5.7）。",
)
async def update_slide_background(
    job_id: str,
    index: int,
    body: BackgroundRequest,
    user: dict = Depends(get_current_user),
):
    """
    修改幻灯片背景（R5.5, R5.7）

    - 支持 solid（纯色）、gradient（渐变）、image（图片）三种背景类型
    - 支持 AI 生成背景图（通过 Inpainting 服务）
    - 失败时保留原始背景数据（R5.7 状态保留）
    """
    # 速率限制
    try:
        await rate_limit(
            user["id"], PPT_CANVAS_RATE_ACTION,
            limit=PPT_CANVAS_RATE_LIMIT, window=PPT_CANVAS_RATE_WINDOW,
        )
    except RateLimitExceeded as e:
        raise HTTPException(
            status_code=429,
            detail=str(e),
            headers={"Retry-After": str(e.retry_after)},
        )

    # 验证幻灯片存在
    slide = await get_slide(job_id, index)
    if not slide:
        raise HTTPException(404, f"幻灯片不存在: job_id={job_id}, index={index}")

    # 保存原始背景（R5.7: 失败时恢复）
    original_background = slide.get("background")
    ai_result_base64: Optional[str] = None
    warning: Optional[str] = None

    # 构建新背景数据
    new_background: dict[str, Any] = {
        "kind": body.kind,
        "value": body.value,
    }

    # 如果需要 AI 生成背景
    if body.use_ai_generation:
        if not body.ai_prompt:
            raise HTTPException(422, "use_ai_generation=True 时必须提供 ai_prompt")
        if not body.ai_image_base64 or not body.ai_mask_base64:
            raise HTTPException(
                422, "use_ai_generation=True 时必须提供 ai_image_base64 和 ai_mask_base64"
            )

        try:
            import base64 as b64
            image_bytes = b64.b64decode(body.ai_image_base64)
            mask_bytes = b64.b64decode(body.ai_mask_base64)

            inpainting_router = _get_inpainting_router()
            result_bytes = await execute_platform_provider_call(
                user_id=user["id"],
                model_id="inpainting-flux-fill",
                expected_category="generate",
                description="PPT canvas background generation",
                related_task_id=None,
                idempotency_key=_canvas_billing_key(
                    user_id=user["id"],
                    job_id=job_id,
                    index=index,
                    target="background",
                    operation="inpaint-replace",
                    version=int(slide.get("version") or 0),
                    model_id="inpainting-flux-fill",
                    material={
                        "image": image_bytes,
                        "mask": mask_bytes,
                        "prompt": body.ai_prompt,
                        "mode": "replace",
                    },
                ),
                invoke=lambda: inpainting_router.inpaint(
                    image_bytes=image_bytes,
                    mask_bytes=mask_bytes,
                    prompt=body.ai_prompt,
                    mode="replace",
                ),
            )
            ai_result_base64 = b64.b64encode(result_bytes).decode()
            # 将 AI 生成的背景图作为 image 类型背景
            new_background = {
                "kind": "image",
                "value": f"data:image/png;base64,{ai_result_base64}",
            }
            logger.info(
                f"[ppt_canvas] AI 背景生成成功: job_id={job_id}, index={index}"
            )
        except HTTPException:
            raise
        except Exception as e:
            # R5.7: 失败时保留原始背景
            logger.error(
                f"[ppt_canvas] AI 背景生成失败，保留原始背景: "
                f"job_id={job_id}, index={index}, error={e}"
            )
            raise HTTPException(
                502,
                f"AI 背景生成失败: {str(e)}。原始背景已保留。",
            )

    # 更新幻灯片背景
    try:
        # 获取当前版本号用于乐观锁
        current_version = slide.get("version", 0)
        if body.expected_version is not None and current_version != body.expected_version:
            raise ConcurrentUpdateError(
                job_id=job_id,
                index=index,
                expected_version=body.expected_version,
                actual_version=current_version,
            )

        # 使用 save_slide 更新整个幻灯片（保留 elements，更新 background）
        new_version = await save_slide(
            job_id=job_id,
            index=index,
            elements=slide.get("elements", []),
            background=new_background,
        )
        logger.info(
            f"[ppt_canvas] 背景更新成功: job_id={job_id}, index={index}, "
            f"kind={body.kind}, version={new_version}"
        )
    except ConcurrentUpdateError as e:
        raise HTTPException(409, f"并发更新冲突: {str(e)}")
    except Exception as e:
        # R5.7: 失败时保留原始背景
        logger.error(
            f"[ppt_canvas] 背景保存失败，原始背景已保留: "
            f"job_id={job_id}, index={index}, error={e}"
        )
        raise HTTPException(
            500,
            f"背景保存失败: {str(e)}。原始背景已保留。",
        )

    return BackgroundResponse(
        ok=True,
        version=new_version,
        background=new_background,
        ai_result_base64=ai_result_base64,
        warning=warning,
    )
