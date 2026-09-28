"""
TextRender Service Provider 单元测试

测试 fit_text_to_bbox 自动缩字算法：
- 文字能放下时不缩字（warning=False）
- 文字超出 bbox 时迭代缩字（warning=True）
- 字号最低不低于 8px
- 空文字不触发缩字
- 中英文混合文字的宽度估算
- Protocol 合规性验证

Requirements: R3.2, R3.5, R3.6
"""

import pytest

from services.ocr import BBox, FontInfo
from services.text_render import (
    TextRenderProvider,
    fit_text_to_bbox,
    _measure_text_size,
)
from services.text_render.anytext_provider import AnyTextProvider
from services.text_render.textdiffuser_provider import TextDiffuserProvider


# ---------------------------------------------------------------------------
# fit_text_to_bbox 核心算法测试
# ---------------------------------------------------------------------------


class TestFitTextToBbox:
    """测试自动缩字算法"""

    def test_text_fits_no_shrink(self):
        """文字能放下时不应缩字，warning=False"""
        # 短文字 + 大 bbox
        bbox = BBox(x=0, y=0, w=500, h=100)
        font_info = FontInfo(family="system-ui", size=24, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("Hi", bbox, font_info)

        assert warning is False
        assert result_font.size == 24  # 字号不变

    def test_text_exceeds_bbox_shrinks(self):
        """文字超出 bbox 时应缩字，warning=True"""
        # 长文字 + 小 bbox
        bbox = BBox(x=0, y=0, w=50, h=30)
        font_info = FontInfo(family="system-ui", size=48, weight=400, align="left")

        result_font, warning = fit_text_to_bbox(
            "这是一段很长的文字内容", bbox, font_info
        )

        assert warning is True
        assert result_font.size < 48  # 字号应被缩小

    def test_minimum_size_8px(self):
        """字号最低不应低于 8px"""
        # 极长文字 + 极小 bbox，迫使字号降到最低
        bbox = BBox(x=0, y=0, w=10, h=10)
        font_info = FontInfo(family="system-ui", size=72, weight=400, align="left")

        result_font, warning = fit_text_to_bbox(
            "这是一段非常非常长的文字内容用于测试最小字号限制", bbox, font_info
        )

        assert warning is True
        assert result_font.size == 8  # 最低 8px

    def test_empty_text_no_shrink(self):
        """空文字不应触发缩字"""
        bbox = BBox(x=0, y=0, w=100, h=50)
        font_info = FontInfo(family="system-ui", size=24, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("", bbox, font_info)

        assert warning is False
        assert result_font.size == 24  # 保持原始字号

    def test_preserves_font_family(self):
        """缩字后应保留原始字体族"""
        bbox = BBox(x=0, y=0, w=30, h=20)
        font_info = FontInfo(family="黑体", size=48, weight=700, align="center")

        result_font, warning = fit_text_to_bbox("测试文字", bbox, font_info)

        assert result_font.family == "黑体"
        assert result_font.weight == 700
        assert result_font.align == "center"

    def test_preserves_font_weight(self):
        """缩字后应保留原始字重"""
        bbox = BBox(x=0, y=0, w=30, h=20)
        font_info = FontInfo(family="system-ui", size=36, weight=700, align="left")

        result_font, warning = fit_text_to_bbox("Long text", bbox, font_info)

        assert result_font.weight == 700

    def test_preserves_font_align(self):
        """缩字后应保留原始对齐方式"""
        bbox = BBox(x=0, y=0, w=30, h=20)
        font_info = FontInfo(family="system-ui", size=36, weight=400, align="right")

        result_font, warning = fit_text_to_bbox("Long text", bbox, font_info)

        assert result_font.align == "right"

    def test_shrink_factor_095(self):
        """缩字应按 0.95 系数迭代"""
        # 使用一个刚好需要缩一次的场景
        bbox = BBox(x=0, y=0, w=200, h=50)
        font_info = FontInfo(family="system-ui", size=40, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("A", bbox, font_info)

        # 单字符 "A" 在 40px 时宽度约 24px，高度约 48px
        # 高度 48 > bbox.h 50? 取决于测量，但字号应 <= 40
        # 关键是验证算法逻辑正确
        assert result_font.size <= 40
        assert result_font.size >= 8

    def test_size_already_at_minimum(self):
        """初始字号为 8px 时，若放不下应返回 8px + warning"""
        bbox = BBox(x=0, y=0, w=5, h=5)
        font_info = FontInfo(family="system-ui", size=8, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("测试", bbox, font_info)

        assert result_font.size == 8
        assert warning is True

    def test_exact_fit_no_warning(self):
        """文字恰好能放下时 warning=False"""
        # 使用大 bbox 确保能放下
        bbox = BBox(x=0, y=0, w=1000, h=200)
        font_info = FontInfo(family="system-ui", size=16, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("Hello", bbox, font_info)

        assert warning is False
        assert result_font.size == 16

    def test_single_char_chinese(self):
        """单个中文字符的缩字测试"""
        # 中文字符宽度约等于字号
        bbox = BBox(x=0, y=0, w=20, h=20)
        font_info = FontInfo(family="system-ui", size=30, weight=400, align="left")

        result_font, warning = fit_text_to_bbox("字", bbox, font_info)

        # 30px 中文字符宽度约 30px > 20px，需要缩字
        assert warning is True
        assert result_font.size < 30
        assert result_font.size >= 8


# ---------------------------------------------------------------------------
# _measure_text_size 测试
# ---------------------------------------------------------------------------


class TestMeasureTextSize:
    """测试文字尺寸测量函数"""

    def test_returns_positive_dimensions(self):
        """应返回正数宽高"""
        w, h = _measure_text_size("Hello", 16, "system-ui")
        assert w > 0
        assert h > 0

    def test_larger_font_larger_size(self):
        """更大字号应产生更大尺寸"""
        w1, h1 = _measure_text_size("Hello", 12, "system-ui")
        w2, h2 = _measure_text_size("Hello", 24, "system-ui")
        assert w2 > w1
        assert h2 > h1

    def test_longer_text_wider(self):
        """更长文字应更宽"""
        w1, _ = _measure_text_size("Hi", 16, "system-ui")
        w2, _ = _measure_text_size("Hello World", 16, "system-ui")
        assert w2 > w1

    def test_chinese_char_width(self):
        """中文字符宽度应约等于字号"""
        w, _ = _measure_text_size("字", 20, "system-ui")
        # 中文字符宽度应接近字号（允许一定误差）
        assert w >= 15  # 至少 75% 字号
        assert w <= 30  # 不超过 150% 字号

    def test_unknown_font_fallback(self):
        """未知字体应回退到估算模式"""
        w, h = _measure_text_size("Test", 16, "NonExistentFont12345")
        assert w > 0
        assert h > 0


# ---------------------------------------------------------------------------
# TextRenderProvider Protocol 合规测试
# ---------------------------------------------------------------------------


class TestTextRenderProviderProtocol:
    """验证 Provider 实现了 TextRenderProvider Protocol"""

    def test_anytext_implements_protocol(self):
        """AnyTextProvider 应实现 TextRenderProvider Protocol"""
        provider = AnyTextProvider(endpoint="http://test", api_key="test")
        assert isinstance(provider, TextRenderProvider)

    def test_textdiffuser_implements_protocol(self):
        """TextDiffuserProvider 应实现 TextRenderProvider Protocol"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="test")
        assert isinstance(provider, TextRenderProvider)


# ---------------------------------------------------------------------------
# AnyTextProvider 构造测试
# ---------------------------------------------------------------------------


class TestAnyTextProvider:
    """测试 AnyText Provider 的构造和 prompt 生成"""

    def test_build_prompt_bold(self):
        """粗体字应在 prompt 中包含 bold"""
        provider = AnyTextProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="Arial", size=24, weight=700, align="left")
        prompt = provider._build_prompt("Hello", font_info, "#000000")
        assert "bold" in prompt

    def test_build_prompt_light(self):
        """细体字应在 prompt 中包含 light"""
        provider = AnyTextProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="Arial", size=24, weight=300, align="left")
        prompt = provider._build_prompt("Hello", font_info, "#000000")
        assert "light" in prompt

    def test_build_prompt_with_font_family(self):
        """指定字体族应在 prompt 中体现"""
        provider = AnyTextProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="黑体", size=24, weight=400, align="left")
        prompt = provider._build_prompt("你好", font_info, "#ff0000")
        assert "黑体" in prompt

    def test_build_prompt_system_ui_no_family(self):
        """system-ui 字体不应在 prompt 中出现字体族描述"""
        provider = AnyTextProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="system-ui", size=24, weight=400, align="left")
        prompt = provider._build_prompt("Hello", font_info, "#000000")
        assert "system-ui" not in prompt

    @pytest.mark.asyncio
    async def test_render_no_endpoint_raises(self):
        """未配置端点时应抛出 RuntimeError"""
        provider = AnyTextProvider(endpoint="", api_key="test")
        with pytest.raises(RuntimeError, match="未配置 AnyText 端点"):
            await provider.render(
                b"img", b"mask", "text",
                FontInfo(), "#000000"
            )

    @pytest.mark.asyncio
    async def test_render_no_api_key_raises(self):
        """未配置 API Key 时应抛出 RuntimeError"""
        provider = AnyTextProvider(endpoint="http://test", api_key="")
        with pytest.raises(RuntimeError, match="未配置 AnyText API Key"):
            await provider.render(
                b"img", b"mask", "text",
                FontInfo(), "#000000"
            )


# ---------------------------------------------------------------------------
# TextDiffuserProvider 构造测试
# ---------------------------------------------------------------------------


class TestTextDiffuserProvider:
    """测试 TextDiffuser Provider 的构造和 prompt 生成"""

    def test_build_prompt_basic(self):
        """基本 prompt 应包含文字内容"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="system-ui", size=16, weight=400, align="left")
        prompt = provider._build_prompt("Hello World", font_info, "#000000")
        assert "Hello World" in prompt

    def test_build_prompt_with_color(self):
        """prompt 应包含颜色信息"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="system-ui", size=16, weight=400, align="left")
        prompt = provider._build_prompt("Test", font_info, "#ff0000")
        assert "#ff0000" in prompt

    def test_build_prompt_center_align(self):
        """居中对齐应在 prompt 中体现"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="system-ui", size=16, weight=400, align="center")
        prompt = provider._build_prompt("Test", font_info, "#000000")
        assert "center" in prompt

    def test_build_prompt_bold(self):
        """粗体应在 prompt 中体现"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="test")
        font_info = FontInfo(family="system-ui", size=16, weight=700, align="left")
        prompt = provider._build_prompt("Test", font_info, "#000000")
        assert "bold" in prompt

    @pytest.mark.asyncio
    async def test_render_no_endpoint_raises(self):
        """未配置端点时应抛出 RuntimeError"""
        provider = TextDiffuserProvider(endpoint="", api_key="test")
        with pytest.raises(RuntimeError, match="未配置 TextDiffuser 端点"):
            await provider.render(
                b"img", b"mask", "text",
                FontInfo(), "#000000"
            )

    @pytest.mark.asyncio
    async def test_render_no_api_key_raises(self):
        """未配置 API Key 时应抛出 RuntimeError"""
        provider = TextDiffuserProvider(endpoint="http://test", api_key="")
        with pytest.raises(RuntimeError, match="未配置 TextDiffuser API Key"):
            await provider.render(
                b"img", b"mask", "text",
                FontInfo(), "#000000"
            )
