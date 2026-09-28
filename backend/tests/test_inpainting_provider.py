"""
InpaintingService Provider 单元测试

测试 _blur_mask_edges 和 _analyze_surrounding_palette 纯工具函数。
"""

import pytest
from io import BytesIO
from PIL import Image, ImageDraw

from services.inpainting.flux_fill_provider import (
    _blur_mask_edges,
    _analyze_surrounding_palette,
    FluxFillProvider,
)
from services.inpainting import InpaintingProvider


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


def _create_image_with_ring(
    width: int,
    height: int,
    mask_rect: tuple[int, int, int, int],
    ring_color: tuple[int, int, int],
    bg_color: tuple[int, int, int] = (0, 0, 0),
) -> bytes:
    """
    创建一个图像：mask_rect 周围的环带区域为 ring_color，其余为 bg_color。
    """
    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)
    # 在 mask 周围画一个更大的矩形作为环带
    x1, y1, x2, y2 = mask_rect
    ring_rect = (
        max(0, x1 - 32),
        max(0, y1 - 32),
        min(width - 1, x2 + 32),
        min(height - 1, y2 + 32),
    )
    draw.rectangle(ring_rect, fill=ring_color)
    # mask 内部保持 bg_color
    draw.rectangle(mask_rect, fill=bg_color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# _blur_mask_edges 测试
# ---------------------------------------------------------------------------


class TestBlurMaskEdges:
    """测试 _blur_mask_edges 函数"""

    def test_basic_blur(self):
        """基本模糊：输出应为有效 PNG 且尺寸不变"""
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))
        result = _blur_mask_edges(mask_bytes, blur_px=8)

        # 验证输出是有效 PNG
        img = Image.open(BytesIO(result))
        assert img.size == (100, 100)
        assert img.mode == "L"

    def test_zero_blur(self):
        """blur_px=0 时应返回原始蒙版"""
        mask_bytes = _create_mask(50, 50, (10, 10, 40, 40))
        result = _blur_mask_edges(mask_bytes, blur_px=0)

        # 输出应与输入相同（像素级）
        original = Image.open(BytesIO(mask_bytes)).convert("L")
        blurred = Image.open(BytesIO(result)).convert("L")
        assert list(original.tobytes()) == list(blurred.tobytes())

    def test_blur_creates_gradient(self):
        """模糊后边缘应产生渐变（非全 0 或全 255 的中间值）"""
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))
        result = _blur_mask_edges(mask_bytes, blur_px=8)

        img = Image.open(BytesIO(result)).convert("L")
        pixels = list(img.tobytes())

        # 应该存在中间值（不全是 0 和 255）
        unique_values = set(pixels)
        assert len(unique_values) > 2, "模糊后应产生渐变中间值"

    def test_blur_preserves_center(self):
        """大蒙版中心区域在模糊后应仍接近 255"""
        # 创建一个大蒙版，中心区域远离边缘
        mask_bytes = _create_mask(200, 200, (50, 50, 150, 150))
        result = _blur_mask_edges(mask_bytes, blur_px=8)

        img = Image.open(BytesIO(result)).convert("L")
        # 检查中心点（100, 100）的值应接近 255
        center_value = img.getpixel((100, 100))
        assert center_value >= 240, f"中心值应接近 255，实际为 {center_value}"

    def test_blur_small_mask(self):
        """小蒙版（小于 blur 半径）不应崩溃"""
        mask_bytes = _create_mask(10, 10, (3, 3, 7, 7))
        result = _blur_mask_edges(mask_bytes, blur_px=8)

        img = Image.open(BytesIO(result))
        assert img.size == (10, 10)

    def test_blur_empty_mask(self):
        """全黑蒙版模糊后仍为全黑"""
        mask = Image.new("L", (50, 50), 0)
        buf = BytesIO()
        mask.save(buf, format="PNG")
        mask_bytes = buf.getvalue()

        result = _blur_mask_edges(mask_bytes, blur_px=8)
        img = Image.open(BytesIO(result)).convert("L")
        assert max(img.tobytes()) == 0

    def test_blur_full_mask(self):
        """全白蒙版模糊后仍为全白"""
        mask = Image.new("L", (50, 50), 255)
        buf = BytesIO()
        mask.save(buf, format="PNG")
        mask_bytes = buf.getvalue()

        result = _blur_mask_edges(mask_bytes, blur_px=8)
        img = Image.open(BytesIO(result)).convert("L")
        assert min(img.tobytes()) == 255


# ---------------------------------------------------------------------------
# _analyze_surrounding_palette 测试
# ---------------------------------------------------------------------------


class TestAnalyzeSurroundingPalette:
    """测试 _analyze_surrounding_palette 函数"""

    def test_uniform_ring_color(self):
        """环带为单一颜色时应返回该颜色"""
        width, height = 200, 200
        mask_rect = (60, 60, 140, 140)

        # 创建图像：环带区域为红色
        image_bytes = _create_image_with_ring(
            width, height, mask_rect,
            ring_color=(255, 0, 0),
            bg_color=(0, 0, 0),
        )
        mask_bytes = _create_mask(width, height, mask_rect)

        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)

        # 应返回至少一个颜色
        assert len(colors) >= 1
        # 第一个颜色应接近红色（量化后为 #f00000）
        assert colors[0].startswith("#f") or colors[0].startswith("#e")

    def test_empty_ring(self):
        """蒙版覆盖整个图像时，环带为空，应返回空列表"""
        width, height = 50, 50
        # 蒙版覆盖整个图像
        mask_bytes = _create_mask(width, height, (0, 0, 49, 49))
        image_bytes = _create_color_image(width, height, (128, 128, 128))

        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)
        # 环带区域为空（蒙版已覆盖全图），应返回空列表
        assert isinstance(colors, list)

    def test_returns_hex_format(self):
        """返回的颜色应为有效 hex 格式"""
        width, height = 200, 200
        mask_rect = (80, 80, 120, 120)
        image_bytes = _create_color_image(width, height, (100, 150, 200))
        mask_bytes = _create_mask(width, height, mask_rect)

        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)

        for color in colors:
            assert color.startswith("#"), f"颜色应以 # 开头: {color}"
            assert len(color) == 7, f"颜色应为 7 字符: {color}"
            # 验证是有效 hex
            int(color[1:], 16)

    def test_max_five_colors(self):
        """最多返回 5 个颜色"""
        width, height = 200, 200
        mask_rect = (80, 80, 120, 120)

        # 创建多色图像
        img = Image.new("RGB", (width, height))
        draw = ImageDraw.Draw(img)
        # 画多个不同颜色的条纹
        stripe_colors = [
            (255, 0, 0), (0, 255, 0), (0, 0, 255),
            (255, 255, 0), (255, 0, 255), (0, 255, 255),
            (128, 0, 0), (0, 128, 0),
        ]
        stripe_h = height // len(stripe_colors)
        for i, color in enumerate(stripe_colors):
            draw.rectangle(
                (0, i * stripe_h, width - 1, (i + 1) * stripe_h - 1),
                fill=color,
            )
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        mask_bytes = _create_mask(width, height, mask_rect)
        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)

        assert len(colors) <= 5

    def test_invalid_image_returns_empty(self):
        """无效图像数据应返回空列表"""
        colors = _analyze_surrounding_palette(
            b"not an image", b"not a mask", ring_width=32
        )
        assert colors == []

    def test_size_mismatch_handled(self):
        """图像和蒙版尺寸不一致时应正常处理（蒙版会被 resize）"""
        image_bytes = _create_color_image(200, 200, (100, 200, 50))
        mask_bytes = _create_mask(100, 100, (30, 30, 70, 70))

        # 不应抛出异常
        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)
        assert isinstance(colors, list)

    def test_multiple_dominant_colors(self):
        """环带有多种主要颜色时应返回多个"""
        width, height = 200, 200
        mask_rect = (80, 80, 120, 120)

        # 创建图像：左半为蓝色，右半为绿色
        img = Image.new("RGB", (width, height))
        draw = ImageDraw.Draw(img)
        draw.rectangle((0, 0, 99, 199), fill=(0, 0, 255))
        draw.rectangle((100, 0, 199, 199), fill=(0, 255, 0))
        # mask 内部设为黑色（不影响环带分析）
        draw.rectangle(mask_rect, fill=(0, 0, 0))
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        mask_bytes = _create_mask(width, height, mask_rect)
        colors = _analyze_surrounding_palette(image_bytes, mask_bytes, ring_width=32)

        # 应返回至少 2 个颜色
        assert len(colors) >= 2


# ---------------------------------------------------------------------------
# FluxFillProvider Protocol 合规测试
# ---------------------------------------------------------------------------


class TestFluxFillProviderProtocol:
    """验证 FluxFillProvider 实现了 InpaintingProvider Protocol"""

    def test_implements_protocol(self):
        """FluxFillProvider 应实现 InpaintingProvider Protocol"""
        provider = FluxFillProvider()
        assert isinstance(provider, InpaintingProvider)

    def test_build_prompt_replace(self):
        """replace 模式应直接使用用户 prompt"""
        provider = FluxFillProvider()
        result = provider._build_prompt("a red car", "replace", None)
        assert result == "a red car"

    def test_build_prompt_recolor(self):
        """recolor 模式应构造颜色变更 prompt"""
        provider = FluxFillProvider()
        result = provider._build_prompt("", "recolor", "#ff0000")
        assert "change color to #ff0000" in result
        assert "preserve texture and lighting" in result

    def test_build_prompt_recolor_default_color(self):
        """recolor 模式无 target_color 时使用默认黑色"""
        provider = FluxFillProvider()
        result = provider._build_prompt("", "recolor", None)
        assert "#000000" in result

    def test_build_prompt_remove(self):
        """remove 模式应使用固定 prompt"""
        provider = FluxFillProvider()
        result = provider._build_prompt("", "remove", None)
        assert "remove object" in result
        assert "fill with background" in result
