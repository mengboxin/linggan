"""
Inpainting Router 单元测试

测试路由器的 mode 路由逻辑、超时降级、以及 LaMa/SDXL Provider 的工具函数。
"""

import asyncio
from io import BytesIO
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image, ImageDraw

from services.inpainting.lama_provider import LaMaProvider, _feather_mask
from services.inpainting.sdxl_inpaint_provider import (
    SdxlInpaintProvider,
    _blur_mask_edges as sdxl_blur_mask_edges,
)
from services.inpainting.router import InpaintingRouter
from services.inpainting import InpaintingProvider


def _run(coro):
    """辅助函数：运行异步协程"""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _create_mask(width: int, height: int, rect: tuple[int, int, int, int]) -> bytes:
    """创建一个矩形蒙版（rect 区域为白色 255，其余为黑色 0）"""
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle(rect, fill=255)
    buf = BytesIO()
    mask.save(buf, format="PNG")
    return buf.getvalue()


def _create_color_image(
    width: int, height: int, color: tuple[int, int, int]
) -> bytes:
    """创建纯色 RGB 图像"""
    img = Image.new("RGB", (width, height), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _create_result_image() -> bytes:
    """创建一个模拟的结果图像"""
    img = Image.new("RGBA", (100, 100), (0, 255, 0, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# LaMaProvider Protocol 合规测试
# ---------------------------------------------------------------------------


class TestLaMaProviderProtocol:
    """验证 LaMaProvider 实现了 InpaintingProvider Protocol"""

    def test_implements_protocol(self):
        """LaMaProvider 应实现 InpaintingProvider Protocol"""
        provider = LaMaProvider()
        assert isinstance(provider, InpaintingProvider)


# ---------------------------------------------------------------------------
# SdxlInpaintProvider Protocol 合规测试
# ---------------------------------------------------------------------------


class TestSdxlInpaintProviderProtocol:
    """验证 SdxlInpaintProvider 实现了 InpaintingProvider Protocol"""

    def test_implements_protocol(self):
        """SdxlInpaintProvider 应实现 InpaintingProvider Protocol"""
        provider = SdxlInpaintProvider()
        assert isinstance(provider, InpaintingProvider)

    def test_build_prompt_replace(self):
        """replace 模式应直接使用用户 prompt"""
        provider = SdxlInpaintProvider()
        result = provider._build_prompt("a blue sky", "replace", None)
        assert result == "a blue sky"

    def test_build_prompt_recolor(self):
        """recolor 模式应构造颜色变更 prompt"""
        provider = SdxlInpaintProvider()
        result = provider._build_prompt("", "recolor", "#00ff00")
        assert "change color to #00ff00" in result
        assert "preserve texture and lighting" in result

    def test_build_prompt_remove(self):
        """remove 模式应使用固定 prompt"""
        provider = SdxlInpaintProvider()
        result = provider._build_prompt("", "remove", None)
        assert "remove object" in result
        assert "fill with background" in result


# ---------------------------------------------------------------------------
# _feather_mask 测试（LaMa 专用 4px 羽化）
# ---------------------------------------------------------------------------


class TestFeatherMask:
    """测试 LaMa 的 _feather_mask 函数"""

    def test_basic_feather(self):
        """基本羽化：输出应为有效 PNG 且尺寸不变"""
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))
        result = _feather_mask(mask_bytes, feather_px=4)

        img = Image.open(BytesIO(result))
        assert img.size == (100, 100)
        assert img.mode == "L"

    def test_zero_feather(self):
        """feather_px=0 时应返回原始蒙版"""
        mask_bytes = _create_mask(50, 50, (10, 10, 40, 40))
        result = _feather_mask(mask_bytes, feather_px=0)

        original = Image.open(BytesIO(mask_bytes)).convert("L")
        feathered = Image.open(BytesIO(result)).convert("L")
        assert list(original.tobytes()) == list(feathered.tobytes())

    def test_feather_creates_gradient(self):
        """羽化后边缘应产生渐变"""
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))
        result = _feather_mask(mask_bytes, feather_px=4)

        img = Image.open(BytesIO(result)).convert("L")
        pixels = list(img.tobytes())
        unique_values = set(pixels)
        assert len(unique_values) > 2, "羽化后应产生渐变中间值"

    def test_feather_preserves_center(self):
        """大蒙版中心区域在羽化后应仍接近 255"""
        mask_bytes = _create_mask(200, 200, (50, 50, 150, 150))
        result = _feather_mask(mask_bytes, feather_px=4)

        img = Image.open(BytesIO(result)).convert("L")
        center_value = img.getpixel((100, 100))
        assert center_value >= 250, f"中心值应接近 255，实际为 {center_value}"

    def test_feather_empty_mask(self):
        """全黑蒙版羽化后仍为全黑"""
        mask = Image.new("L", (50, 50), 0)
        buf = BytesIO()
        mask.save(buf, format="PNG")
        mask_bytes = buf.getvalue()

        result = _feather_mask(mask_bytes, feather_px=4)
        img = Image.open(BytesIO(result)).convert("L")
        assert max(img.tobytes()) == 0


# ---------------------------------------------------------------------------
# SDXL _blur_mask_edges 测试
# ---------------------------------------------------------------------------


class TestSdxlBlurMaskEdges:
    """测试 SDXL 的 _blur_mask_edges 函数"""

    def test_basic_blur(self):
        """基本模糊：输出应为有效 PNG 且尺寸不变"""
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))
        result = sdxl_blur_mask_edges(mask_bytes, blur_px=8)

        img = Image.open(BytesIO(result))
        assert img.size == (100, 100)
        assert img.mode == "L"

    def test_zero_blur(self):
        """blur_px=0 时应返回原始蒙版"""
        mask_bytes = _create_mask(50, 50, (10, 10, 40, 40))
        result = sdxl_blur_mask_edges(mask_bytes, blur_px=0)

        original = Image.open(BytesIO(mask_bytes)).convert("L")
        blurred = Image.open(BytesIO(result)).convert("L")
        assert list(original.tobytes()) == list(blurred.tobytes())


# ---------------------------------------------------------------------------
# InpaintingRouter 路由逻辑测试
# ---------------------------------------------------------------------------


class TestInpaintingRouter:
    """测试 InpaintingRouter 路由逻辑"""

    def _make_router(
        self,
        flux_result=None,
        lama_result=None,
        sdxl_result=None,
        flux_error=None,
        lama_error=None,
        flux_delay=0,
        lama_delay=0,
        timeout=5,
    ):
        """创建带 mock provider 的路由器"""
        flux = AsyncMock()
        lama = AsyncMock()
        sdxl = AsyncMock()

        async def flux_side_effect(*args, **kwargs):
            if flux_delay:
                await asyncio.sleep(flux_delay)
            if flux_error:
                raise flux_error
            return flux_result or _create_result_image()

        async def lama_side_effect(*args, **kwargs):
            if lama_delay:
                await asyncio.sleep(lama_delay)
            if lama_error:
                raise lama_error
            return lama_result or _create_result_image()

        flux.inpaint = AsyncMock(side_effect=flux_side_effect)
        lama.inpaint = AsyncMock(side_effect=lama_side_effect)
        sdxl.inpaint = AsyncMock(
            return_value=sdxl_result or _create_result_image()
        )

        router = InpaintingRouter(
            flux_fill_provider=flux,
            lama_provider=lama,
            sdxl_provider=sdxl,
            timeout=timeout,
        )
        return router, flux, lama, sdxl

    def test_remove_routes_to_lama(self):
        """remove 模式应路由到 LaMa"""
        router, flux, lama, sdxl = self._make_router()
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "", "remove"))

        lama.inpaint.assert_called_once()
        flux.inpaint.assert_not_called()
        sdxl.inpaint.assert_not_called()

    def test_replace_routes_to_flux_fill(self):
        """replace 模式应路由到 Flux Fill"""
        router, flux, lama, sdxl = self._make_router()
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "a cat", "replace"))

        flux.inpaint.assert_called_once()
        lama.inpaint.assert_not_called()
        sdxl.inpaint.assert_not_called()

    def test_recolor_routes_to_flux_fill(self):
        """recolor 模式应路由到 Flux Fill"""
        router, flux, lama, sdxl = self._make_router()
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "", "recolor", target_color="#00ff00"))

        flux.inpaint.assert_called_once()
        lama.inpaint.assert_not_called()
        sdxl.inpaint.assert_not_called()

    def test_flux_timeout_falls_back_to_sdxl(self):
        """Flux Fill 超时时应降级到 SDXL"""
        router, flux, lama, sdxl = self._make_router(
            flux_delay=10, timeout=1
        )
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "a dog", "replace"))

        flux.inpaint.assert_called_once()
        sdxl.inpaint.assert_called_once()

    def test_flux_error_falls_back_to_sdxl(self):
        """Flux Fill 失败时应降级到 SDXL"""
        router, flux, lama, sdxl = self._make_router(
            flux_error=RuntimeError("API 调用失败")
        )
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "a dog", "replace"))

        flux.inpaint.assert_called_once()
        sdxl.inpaint.assert_called_once()

    def test_lama_timeout_falls_back_to_sdxl(self):
        """LaMa 超时时应降级到 SDXL"""
        router, flux, lama, sdxl = self._make_router(
            lama_delay=10, timeout=1
        )
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "", "remove"))

        lama.inpaint.assert_called_once()
        sdxl.inpaint.assert_called_once()
        flux.inpaint.assert_not_called()

    def test_lama_error_falls_back_to_sdxl(self):
        """LaMa 失败时应降级到 SDXL"""
        router, flux, lama, sdxl = self._make_router(
            lama_error=RuntimeError("LaMa 服务不可用")
        )
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "", "remove"))

        lama.inpaint.assert_called_once()
        sdxl.inpaint.assert_called_once()
        flux.inpaint.assert_not_called()

    def test_all_providers_fail_raises_error(self):
        """所有 Provider 均失败时应抛出 RuntimeError"""
        router, flux, lama, sdxl = self._make_router(
            lama_error=RuntimeError("LaMa 失败")
        )
        sdxl.inpaint = AsyncMock(
            side_effect=RuntimeError("SDXL 也失败")
        )
        router.sdxl = sdxl

        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        with pytest.raises(RuntimeError, match="所有 Inpainting Provider 均失败"):
            _run(router.inpaint(image, mask, "", "remove"))

    def test_router_passes_all_params(self):
        """路由器应将所有参数正确传递给 Provider"""
        router, flux, lama, sdxl = self._make_router()
        image = _create_color_image(100, 100, (255, 0, 0))
        mask = _create_mask(100, 100, (30, 30, 70, 70))

        _run(router.inpaint(image, mask, "make it blue", "recolor", target_color="#0000ff"))

        flux.inpaint.assert_called_once_with(
            image, mask, "make it blue", "recolor", "#0000ff"
        )

    def test_router_default_timeout_from_settings(self):
        """未指定 timeout 时应使用 settings.INPAINTING_TIMEOUT"""
        with patch("services.inpainting.router.settings") as mock_settings:
            mock_settings.INPAINTING_TIMEOUT = 42
            router = InpaintingRouter(
                flux_fill_provider=AsyncMock(),
                lama_provider=AsyncMock(),
                sdxl_provider=AsyncMock(),
            )
            assert router.timeout == 42
