"""
TextRender 服务 — Provider 抽象层

定义 TextRenderProvider Protocol，支持双路径策略：
- 主路径：AnyText（中英文风格保留，保持原始字体风格渲染）
- 辅路径：TextDiffuser-2（英文长段落渲染）

同时提供 fit_text_to_bbox 纯函数，用于自动缩字以适配包围盒。

Requirements: R3.2, R3.5, R3.6
"""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from services.ocr import BBox, FontInfo


@runtime_checkable
class TextRenderProvider(Protocol):
    """
    文字渲染服务 Provider 协议。

    所有文字渲染实现必须遵循此协议，提供统一的 render 方法。
    """

    async def render(
        self,
        base_image: bytes,
        mask: bytes,
        text: str,
        font_info: FontInfo,
        color_hex: str,
    ) -> bytes:
        """
        在图像中渲染文字。

        参数:
            base_image: 原始图像 PNG bytes
            mask: 文字区域蒙版 PNG bytes（白色区域为渲染区域）
            text: 要渲染的文字内容
            font_info: 字体信息（字族、字号、字重、对齐方式）
            color_hex: 文字颜色 hex 值（如 '#ff0000'）

        返回:
            渲染后的图像 PNG bytes
        """
        ...


def _measure_text_size(
    text: str, font_size: int, font_family: str
) -> tuple[int, int]:
    """
    测量文字在给定字号下的像素宽高。

    使用 PIL ImageFont 进行测量。若指定字体不可用，
    回退到默认字体进行估算。

    参数:
        text: 文字内容
        font_size: 字号（像素）
        font_family: 字体族名称

    返回:
        (width, height) 文字占用的像素宽高
    """
    from PIL import ImageFont

    try:
        # 尝试加载指定字体
        font = ImageFont.truetype(font_family, font_size)
    except (OSError, IOError):
        try:
            # 尝试常见系统字体路径
            font = ImageFont.load_default()
            # 使用默认字体时，基于字号进行估算
            # 默认字体不支持 size 参数，使用经验公式
            avg_char_width = font_size * 0.6
            # 中文字符宽度约等于字号
            width = 0
            for ch in text:
                if ord(ch) > 127:
                    # 中文/全角字符
                    width += font_size
                else:
                    # 英文/半角字符
                    width += avg_char_width
            height = int(font_size * 1.2)
            return (int(width), height)
        except Exception:
            # 最终回退：使用经验公式
            avg_char_width = font_size * 0.6
            width = int(len(text) * avg_char_width)
            height = int(font_size * 1.2)
            return (width, height)

    # 使用 PIL 的 getbbox 或 getlength 测量
    try:
        bbox = font.getbbox(text)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        return (width, height)
    except Exception:
        # 回退到经验公式
        avg_char_width = font_size * 0.6
        width = int(len(text) * avg_char_width)
        height = int(font_size * 1.2)
        return (width, height)


def fit_text_to_bbox(
    text: str, bbox: BBox, font_info: FontInfo
) -> tuple[FontInfo, bool]:
    """
    自动缩字以适配包围盒（R3.6）。

    迭代将字号乘以 0.95 系数缩小，直到文字宽高均不超过 bbox，
    或字号降至最低 8px。若发生了缩字则 warning=True。

    参数:
        text: 要渲染的文字内容
        bbox: 目标包围盒
        font_info: 原始字体信息

    返回:
        (调整后的 FontInfo, warning: bool)
        - warning=True 表示字号被缩小（文字超出了原始 bbox）
        - warning=False 表示字号未变（文字本身就能放下）

    算法:
        1. 从 font_info.size 开始
        2. 测量文字宽高
        3. 若宽高均 <= bbox 的宽高，返回当前字号
        4. 否则将字号乘以 0.95，取整（至少减 1px）
        5. 若字号 < 8，强制设为 8 并返回 warning=True
    """
    if not text:
        return font_info, False

    min_size = 8
    original_size = font_info.size
    current_size = original_size

    while current_size >= min_size:
        w, h = _measure_text_size(text, current_size, font_info.family)
        if w <= bbox.w and h <= bbox.h:
            # 文字能放下
            was_shrunk = current_size != original_size
            adjusted = FontInfo(
                family=font_info.family,
                size=current_size,
                weight=font_info.weight,
                align=font_info.align,
            )
            return adjusted, was_shrunk

        # 缩小字号：乘以 0.95，取整，确保至少减 1px
        new_size = int(current_size * 0.95)
        if new_size >= current_size:
            new_size = current_size - 1
        current_size = new_size

    # 字号已降至最低 8px，仍然放不下
    adjusted = FontInfo(
        family=font_info.family,
        size=min_size,
        weight=font_info.weight,
        align=font_info.align,
    )
    return adjusted, True


__all__ = [
    "TextRenderProvider",
    "AnyTextProvider",
    "TextDiffuserProvider",
    "fit_text_to_bbox",
]

from services.text_render.anytext_provider import AnyTextProvider
from services.text_render.textdiffuser_provider import TextDiffuserProvider
