"""
OCR 服务 — Provider 抽象层

定义 OcrProvider Protocol，支持双路径策略：
- 主路径：PaddleOCR 本地推理（2s 内返回，含字号估算）
- 兜底路径：GPT-4o Vision（当 PaddleOCR confidence < 0.5 时启用，推断字体族）

字体推断失败时回退 'system-ui' 默认。

Requirements: R3.1, R3.4
"""

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class BBox:
    """包围盒坐标"""

    x: int
    y: int
    w: int
    h: int


@dataclass
class FontInfo:
    """字体信息"""

    family: str = "system-ui"
    size: int = 16
    weight: int = 400
    align: str = "left"  # 'left' | 'center' | 'right'


@dataclass
class OcrResult:
    """OCR 识别结果"""

    text: str
    confidence: float
    font_info: FontInfo = field(default_factory=FontInfo)
    color_hex: str = "#000000"


@runtime_checkable
class OcrProvider(Protocol):
    """
    OCR 服务 Provider 协议。

    所有 OCR 实现必须遵循此协议，提供统一的 recognize 方法。
    """

    async def recognize(self, image_bytes: bytes) -> OcrResult:
        """
        对图像进行文字识别。

        参数:
            image_bytes: 裁剪后的图像区域 PNG bytes（已包含 padding）

        返回:
            OcrResult 包含识别文字、置信度、字体信息和颜色
        """
        ...


__all__ = [
    "BBox",
    "FontInfo",
    "OcrResult",
    "OcrProvider",
    "PaddleOcrProvider",
    "Gpt4oOcrProvider",
    "OcrRouter",
]

from services.ocr.paddle_provider import PaddleOcrProvider
from services.ocr.gpt4o_provider import Gpt4oOcrProvider
from services.ocr.router import OcrRouter
