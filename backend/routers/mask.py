"""蒙版处理路由"""
import asyncio
import base64
from io import BytesIO

import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile
from PIL import Image, ImageFilter

from core.config import settings
from services.image_upload_validation import read_image_uploads

router = APIRouter(prefix="/api/mask", tags=["蒙版"])
_refine_sem = asyncio.Semaphore(max(1, int(settings.MASK_REFINE_CONCURRENCY)))


class MaskRefinementTooLarge(ValueError):
    pass


def _refine_mask_bytes(img_bytes: bytes, mask_bytes: bytes) -> str:
    """Run the NumPy-heavy path outside the async request loop."""
    with Image.open(BytesIO(img_bytes)) as image_source, Image.open(BytesIO(mask_bytes)) as mask_source:
        img_pil = image_source.convert("RGBA")
        mask_pil = mask_source.convert("L")

    if mask_pil.size != img_pil.size:
        mask_pil = mask_pil.resize(img_pil.size, Image.Resampling.LANCZOS)
    width, height = img_pil.size
    if width * height > max(1, int(settings.MASK_REFINE_MAX_PIXELS)):
        raise MaskRefinementTooLarge("mask refinement pixel budget exceeded")

    refined = _refine_mask_edges(img_pil, mask_pil)
    buf = BytesIO()
    refined.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@router.post("/refine")
async def refine_mask(
    image: UploadFile = File(...),
    mask:  UploadFile = File(...),
):
    """
    AI 边缘优化：基于原图颜色信息精细化蒙版边缘
    算法：
    1. 检测蒙版边缘区域（过渡带）
    2. 在边缘区域用 GrabCut / 颜色聚类重新判断前景/背景
    3. 返回精细化后的蒙版
    """
    img_bytes, mask_bytes = await read_image_uploads([
        ("原图", image),
        ("蒙版", mask),
    ])
    try:
        async with _refine_sem:
            mask_b64 = await asyncio.to_thread(_refine_mask_bytes, img_bytes, mask_bytes)
    except MaskRefinementTooLarge:
        raise HTTPException(
            413,
            f"蒙版精修图片不能超过 {settings.MASK_REFINE_MAX_PIXELS} 像素",
        ) from None

    return {"maskBase64": mask_b64}


def _refine_mask_edges(img: Image.Image, mask: Image.Image) -> Image.Image:
    """
    边缘精细化核心算法
    使用 numpy + PIL 实现，无需额外 AI 模型
    """
    img_arr  = np.array(img.convert("RGB"), dtype=np.float32)
    mask_arr = np.array(mask, dtype=np.float32) / 255.0

    # 1. 找到边缘过渡区域（蒙版值在 0.1~0.9 之间，或边缘附近）
    mask_blur = np.array(mask.filter(ImageFilter.GaussianBlur(radius=3)), dtype=np.float32) / 255.0
    edge_zone = (np.abs(mask_arr - mask_blur) > 0.05) | (
        (mask_arr > 0.1) & (mask_arr < 0.9)
    )

    # 2. 在边缘区域，根据颜色相似度重新判断前景/背景
    # 采样前景色和背景色的代表颜色
    fg_mask = mask_arr > 0.8
    bg_mask = mask_arr < 0.2

    if fg_mask.sum() > 0 and bg_mask.sum() > 0:
        fg_colors = img_arr[fg_mask].mean(axis=0)  # 前景平均色
        bg_colors = img_arr[bg_mask].mean(axis=0)  # 背景平均色

        # 对边缘区域每个像素，计算与前景/背景的颜色距离
        edge_pixels = img_arr[edge_zone]
        if len(edge_pixels) > 0:
            dist_fg = np.linalg.norm(edge_pixels - fg_colors, axis=1)
            dist_bg = np.linalg.norm(edge_pixels - bg_colors, axis=1)

            # 根据距离比例计算新的蒙版值（软边缘）
            total = dist_fg + dist_bg + 1e-6
            new_mask_vals = 1.0 - (dist_fg / total)

            refined_arr = mask_arr.copy()
            refined_arr[edge_zone] = new_mask_vals
        else:
            refined_arr = mask_arr.copy()
    else:
        refined_arr = mask_arr.copy()

    # 3. 轻微高斯模糊平滑边缘，避免锯齿
    refined_pil = Image.fromarray((refined_arr * 255).astype(np.uint8), mode="L")
    refined_pil = refined_pil.filter(ImageFilter.GaussianBlur(radius=0.8))

    return refined_pil
