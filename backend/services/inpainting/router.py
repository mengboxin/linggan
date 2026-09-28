"""
Inpainting 路由器 — 根据 mode 自动选择 Provider

路由策略:
- remove → LaMa（轻量补全，速度快，背景填充质量高）
- replace / recolor → Flux Fill（复杂语义生成，质量最高）
- 超时兜底 → SDXL Inpainting（Flux Fill 超时或失败时自动降级）

超时阈值由 settings.INPAINTING_TIMEOUT 控制（默认 30s，R2.7）。

Requirements: R2.2, R2.3, R2.4
"""

import asyncio
import logging
from typing import Literal, Optional

from core.config import settings
from services.inpainting.flux_fill_provider import FluxFillProvider
from services.inpainting.lama_provider import LaMaProvider
from services.inpainting.sdxl_inpaint_provider import SdxlInpaintProvider

logger = logging.getLogger(__name__)


class InpaintingRouter:
    """
    Inpainting 路由器。

    根据编辑模式自动选择最合适的 Provider，并在主路径超时时
    自动降级到兜底 Provider。

    路由规则:
        - mode == "remove" → LaMaProvider（4px 羽化，无 prompt）
        - mode == "replace" / "recolor" → FluxFillProvider（8px 模糊，风格保留）
        - FluxFillProvider 超时 → SdxlInpaintProvider（兜底）

    使用方式:
        router = InpaintingRouter()
        result = await router.inpaint(image, mask, prompt, mode="remove")
    """

    def __init__(
        self,
        flux_fill_provider: Optional[FluxFillProvider] = None,
        lama_provider: Optional[LaMaProvider] = None,
        sdxl_provider: Optional[SdxlInpaintProvider] = None,
        timeout: Optional[int] = None,
    ):
        """
        初始化路由器。

        参数:
            flux_fill_provider: Flux Fill Provider 实例（可选，默认自动创建）
            lama_provider: LaMa Provider 实例（可选，默认自动创建）
            sdxl_provider: SDXL Provider 实例（可选，默认自动创建）
            timeout: 主路径超时时间（秒），默认使用 settings.INPAINTING_TIMEOUT
        """
        self.flux_fill = flux_fill_provider or FluxFillProvider()
        self.lama = lama_provider or LaMaProvider()
        self.sdxl = sdxl_provider or SdxlInpaintProvider()
        self.timeout = timeout if timeout is not None else settings.INPAINTING_TIMEOUT

    async def inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        执行 Inpainting，自动路由到合适的 Provider。

        路由逻辑:
        1. mode == "remove" → 使用 LaMa（快速背景补全）
           - LaMa 失败时降级到 SDXL
        2. mode == "replace" / "recolor" → 使用 Flux Fill（高质量语义生成）
           - Flux Fill 超时或失败时降级到 SDXL

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 蒙版 PNG bytes（白色区域为编辑区域）
            prompt: 文本提示
            mode: 编辑模式（replace / recolor / remove）
            target_color: 目标颜色 hex 值（仅 recolor 模式）

        返回:
            编辑后的图像 PNG bytes

        异常:
            RuntimeError: 所有 Provider 均失败时抛出
        """
        if mode == "remove":
            return await self._route_remove(
                image_bytes, mask_bytes, prompt, mode, target_color
            )
        else:
            return await self._route_replace_recolor(
                image_bytes, mask_bytes, prompt, mode, target_color
            )

    async def _route_remove(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        Remove 模式路由：LaMa → SDXL 兜底。

        LaMa 对纯背景填充质量高、速度快，是 Remove 模式的首选。
        如果 LaMa 超时或失败，降级到 SDXL。
        """
        try:
            result = await asyncio.wait_for(
                self.lama.inpaint(
                    image_bytes, mask_bytes, prompt, mode, target_color
                ),
                timeout=self.timeout,
            )
            logger.info("Remove 模式：LaMa 成功完成")
            return result
        except asyncio.TimeoutError:
            logger.warning(
                f"LaMa 超时（>{self.timeout}s），降级到 SDXL"
            )
        except Exception as e:
            logger.warning(f"LaMa 失败: {e}，降级到 SDXL")

        # 兜底：使用 SDXL
        return await self._fallback_sdxl(
            image_bytes, mask_bytes, prompt, mode, target_color
        )

    async def _route_replace_recolor(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        Replace / Recolor 模式路由：Flux Fill → SDXL 兜底。

        Flux Fill 边缘融合质量最高，是 Replace/Recolor 的首选。
        如果 Flux Fill 超时或失败，降级到 SDXL。
        """
        try:
            result = await asyncio.wait_for(
                self.flux_fill.inpaint(
                    image_bytes, mask_bytes, prompt, mode, target_color
                ),
                timeout=self.timeout,
            )
            logger.info(f"{mode.capitalize()} 模式：Flux Fill 成功完成")
            return result
        except asyncio.TimeoutError:
            logger.warning(
                f"Flux Fill 超时（>{self.timeout}s），降级到 SDXL"
            )
        except Exception as e:
            logger.warning(f"Flux Fill 失败: {e}，降级到 SDXL")

        # 兜底：使用 SDXL
        return await self._fallback_sdxl(
            image_bytes, mask_bytes, prompt, mode, target_color
        )

    async def _fallback_sdxl(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        SDXL 兜底调用。

        当主路径（LaMa 或 Flux Fill）超时/失败时调用。
        SDXL 不设额外超时限制（使用 httpx 自身的 90s 超时）。

        异常:
            RuntimeError: SDXL 也失败时抛出，包含原始错误信息
        """
        try:
            result = await self.sdxl.inpaint(
                image_bytes, mask_bytes, prompt, mode, target_color
            )
            logger.info(f"SDXL 兜底成功完成（mode={mode}）")
            return result
        except Exception as e:
            logger.error(f"SDXL 兜底也失败: {e}")
            raise RuntimeError(
                f"所有 Inpainting Provider 均失败（mode={mode}）: {e}"
            ) from e
