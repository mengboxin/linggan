"""
Inpainting 服务 — Provider 抽象层

定义 InpaintingProvider Protocol，支持 Replace / Recolor / Remove 三种模式。
具体实现由 FluxFillProvider（主路径）、LaMaProvider（Remove 专用）、
SdxlInpaintProvider（兜底）提供。

Requirements: R2.2, R2.3, R2.4, R4.4
"""

from typing import Literal, Optional, Protocol, runtime_checkable


@runtime_checkable
class InpaintingProvider(Protocol):
    """
    Inpainting 服务 Provider 协议。

    所有 Inpainting 实现必须遵循此协议，提供统一的 inpaint 方法。
    """

    async def inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        执行 Inpainting 操作。

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 蒙版 PNG bytes（白色区域为编辑区域）
            prompt: 文本提示（replace 模式由用户提供，recolor/remove 模式自动构造）
            mode: 编辑模式
                - 'replace': 用 prompt 描述的内容替换选中区域
                - 'recolor': 改变选中区域颜色，保留纹理和光照
                - 'remove': 移除选中区域，用背景填充
            target_color: 目标颜色 hex 值（仅 recolor 模式需要，如 '#ff0000'）

        返回:
            编辑后的图像 PNG bytes
        """
        ...


__all__ = [
    "InpaintingProvider",
    "FluxFillProvider",
    "LaMaProvider",
    "SdxlInpaintProvider",
    "InpaintingRouter",
]

from services.inpainting.flux_fill_provider import FluxFillProvider
from services.inpainting.lama_provider import LaMaProvider
from services.inpainting.sdxl_inpaint_provider import SdxlInpaintProvider
from services.inpainting.router import InpaintingRouter
