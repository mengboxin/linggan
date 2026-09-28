"""
OCR 路由器 — 双路径策略实现

路由策略:
- 主路径：PaddleOCR 本地推理（2s 内返回，含字号估算）
- 兜底路径：GPT-4o Vision（当 PaddleOCR confidence < 0.5 时启用）

当 PaddleOCR 置信度低于阈值时，自动切换到 GPT-4o Vision 进行识别，
并利用 GPT-4o 的能力推断字体族。字体推断失败时回退 'system-ui'。

Requirements: R3.1, R3.4
"""

import logging
from io import BytesIO
from typing import Optional

from PIL import Image

from services.ocr import BBox, FontInfo, OcrResult
from services.ocr.gpt4o_provider import Gpt4oOcrProvider
from services.ocr.paddle_provider import (
    PaddleOcrProvider,
    extract_dominant_color,
)

logger = logging.getLogger(__name__)

# PaddleOCR 置信度阈值，低于此值时切换到 GPT-4o（R3.4）
CONFIDENCE_THRESHOLD = 0.5


def crop_with_padding(
    image_bytes: bytes, bbox: BBox, padding: int = 8
) -> bytes:
    """
    根据 BBox 裁剪图像，并添加 padding 像素的边距。

    参数:
        image_bytes: 原始图像 PNG bytes
        bbox: 裁剪区域包围盒
        padding: 边距像素数（默认 8px）

    返回:
        裁剪后的图像 PNG bytes
    """
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    width, height = image.size

    # 计算带 padding 的裁剪区域
    x1 = max(0, bbox.x - padding)
    y1 = max(0, bbox.y - padding)
    x2 = min(width, bbox.x + bbox.w + padding)
    y2 = min(height, bbox.y + bbox.h + padding)

    cropped = image.crop((x1, y1, x2, y2))

    buf = BytesIO()
    cropped.save(buf, format="PNG")
    return buf.getvalue()


class OcrRouter:
    """
    OCR 路由器 — 双路径策略。

    自动选择最合适的 OCR Provider：
    1. 首先尝试 PaddleOCR（本地推理，快速）
    2. 如果 PaddleOCR 置信度 < 0.5，切换到 GPT-4o Vision（R3.4）
    3. GPT-4o 能推断字体族，PaddleOCR 的字号估算会被保留

    使用方式:
        router = OcrRouter()
        result = await router.recognize(image_bytes, bbox)
    """

    def __init__(
        self,
        paddle_provider: Optional[PaddleOcrProvider] = None,
        gpt4o_provider: Optional[Gpt4oOcrProvider] = None,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
    ):
        """
        初始化 OCR 路由器。

        参数:
            paddle_provider: PaddleOCR Provider 实例（可选，默认自动创建）
            gpt4o_provider: GPT-4o Provider 实例（可选，默认自动创建）
            confidence_threshold: 置信度阈值（默认 0.5），低于此值时切换到 GPT-4o
        """
        self.paddle = paddle_provider or PaddleOcrProvider()
        self.gpt4o = gpt4o_provider or Gpt4oOcrProvider()
        self.confidence_threshold = confidence_threshold

    async def recognize(
        self, image_bytes: bytes, bbox: Optional[BBox] = None
    ) -> OcrResult:
        """
        执行 OCR 识别，自动路由到合适的 Provider。

        路由逻辑（R3.4）:
        1. 如果提供了 bbox，先裁剪图像
        2. 使用 PaddleOCR 进行本地推理
        3. 如果 PaddleOCR confidence < 0.5，切换到 GPT-4o Vision
        4. 合并两个 Provider 的优势：
           - PaddleOCR 的字号估算
           - GPT-4o 的字体族推断
        5. 字体推断失败时回退 'system-ui'

        参数:
            image_bytes: 原始图像 PNG bytes
            bbox: 文字区域包围盒（可选，提供时会裁剪图像）

        返回:
            OcrResult 包含最终识别结果
        """
        # 步骤 1：如果提供了 bbox，裁剪图像
        if bbox is not None:
            crop_bytes = crop_with_padding(image_bytes, bbox, padding=8)
        else:
            crop_bytes = image_bytes

        # 步骤 2：PaddleOCR 本地推理
        paddle_result = await self.paddle.recognize(crop_bytes)
        logger.info(
            f"PaddleOCR 结果: text='{paddle_result.text[:50]}...', "
            f"confidence={paddle_result.confidence:.2f}"
        )

        # 步骤 3：检查置信度，决定是否需要 GPT-4o 兜底
        if paddle_result.confidence >= self.confidence_threshold:
            # PaddleOCR 置信度足够，直接返回
            logger.info("PaddleOCR 置信度足够，使用本地结果")
            return paddle_result

        # 步骤 4：PaddleOCR 置信度不足，切换到 GPT-4o
        logger.info(
            f"PaddleOCR 置信度 {paddle_result.confidence:.2f} < {self.confidence_threshold}，"
            f"切换到 GPT-4o Vision"
        )
        gpt4o_result = await self.gpt4o.recognize(crop_bytes)

        # 步骤 5：合并结果
        # - 如果 GPT-4o 也失败了，返回 PaddleOCR 的结果（即使置信度低）
        if not gpt4o_result.text:
            logger.warning("GPT-4o 也未能识别文字，返回 PaddleOCR 结果")
            return paddle_result

        # 合并优势：
        # - 文字内容和字体族来自 GPT-4o（更准确）
        # - 字号来自 PaddleOCR（基于像素测量，更精确）
        # - 颜色从图像直接提取
        merged_font_info = FontInfo(
            family=gpt4o_result.font_info.family or "system-ui",
            size=paddle_result.font_info.size if paddle_result.text else 16,
            weight=gpt4o_result.font_info.weight,
            align=gpt4o_result.font_info.align,
        )

        # 从裁剪图像提取颜色
        try:
            image = Image.open(BytesIO(crop_bytes)).convert("RGB")
            color_hex = extract_dominant_color(image)
        except Exception:
            color_hex = "#000000"

        merged_result = OcrResult(
            text=gpt4o_result.text,
            confidence=gpt4o_result.confidence,
            font_info=merged_font_info,
            color_hex=color_hex,
        )

        logger.info(
            f"GPT-4o 兜底成功: text='{merged_result.text[:50]}...', "
            f"font_family='{merged_font_info.family}'"
        )
        return merged_result
