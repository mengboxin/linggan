"""
OCR Service Provider 单元测试

测试 OCR 双路径策略：
- PaddleOcrProvider 的字号估算和颜色提取
- Gpt4oOcrProvider 的 JSON 解析和字体推断
- OcrRouter 的双路径路由逻辑
- 字体推断失败回退 'system-ui'

Requirements: R3.1, R3.4
"""

import pytest
from io import BytesIO
from unittest.mock import AsyncMock, patch

from PIL import Image, ImageDraw, ImageFont

from services.ocr import BBox, FontInfo, OcrProvider, OcrResult
from services.ocr.gpt4o_provider import Gpt4oOcrProvider
from services.ocr.paddle_provider import (
    PaddleOcrProvider,
    estimate_font_size,
    extract_dominant_color,
)
from services.ocr.router import OcrRouter, crop_with_padding


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _create_text_image(
    width: int = 200,
    height: int = 50,
    text: str = "Hello",
    bg_color: tuple = (255, 255, 255),
    text_color: tuple = (0, 0, 0),
) -> bytes:
    """创建包含文字的测试图像"""
    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)
    # 使用默认字体
    draw.text((10, 10), text, fill=text_color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _create_color_image(
    width: int, height: int, color: tuple[int, int, int]
) -> bytes:
    """创建纯色 RGB 图像"""
    img = Image.new("RGB", (width, height), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# estimate_font_size 测试
# ---------------------------------------------------------------------------


class TestEstimateFontSize:
    """测试字号估算函数"""

    def test_normal_bbox(self):
        """正常检测框应返回合理字号"""
        # 模拟一个高度为 24px 的检测框
        bbox_points = [[10, 10], [100, 10], [100, 34], [10, 34]]
        size = estimate_font_size(bbox_points)
        assert size == 24

    def test_small_bbox(self):
        """小检测框应返回最小字号 8"""
        bbox_points = [[10, 10], [30, 10], [30, 15], [10, 15]]
        size = estimate_font_size(bbox_points)
        assert size == 8  # 高度 5px，但最小为 8

    def test_large_bbox(self):
        """大检测框应返回大字号"""
        bbox_points = [[0, 0], [200, 0], [200, 72], [0, 72]]
        size = estimate_font_size(bbox_points)
        assert size == 72

    def test_empty_bbox(self):
        """空 bbox 应返回默认值 16"""
        assert estimate_font_size([]) == 16
        assert estimate_font_size(None) == 16

    def test_insufficient_points(self):
        """不足 4 个点应返回默认值 16"""
        assert estimate_font_size([[0, 0], [10, 0]]) == 16


# ---------------------------------------------------------------------------
# extract_dominant_color 测试
# ---------------------------------------------------------------------------


class TestExtractDominantColor:
    """测试主色调提取函数"""

    def test_black_text_on_white(self):
        """白底黑字应提取到接近黑色"""
        img = Image.new("RGB", (100, 50), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        # 画一大块黑色区域模拟文字
        draw.rectangle((10, 10, 90, 40), fill=(0, 0, 0))
        color = extract_dominant_color(img)
        assert color.startswith("#0")  # 接近黑色

    def test_red_text(self):
        """红色文字应提取到接近红色"""
        img = Image.new("RGB", (100, 50), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw.rectangle((10, 10, 90, 40), fill=(200, 0, 0))
        color = extract_dominant_color(img)
        # 量化后应接近红色
        assert color.startswith("#")
        r = int(color[1:3], 16)
        assert r > 100  # 红色分量应较高

    def test_all_white_image(self):
        """全白图像（无深色像素）应返回有效 hex"""
        img = Image.new("RGB", (50, 50), (255, 255, 255))
        color = extract_dominant_color(img)
        assert color.startswith("#")
        assert len(color) == 7

    def test_returns_valid_hex(self):
        """返回值应为有效 hex 格式"""
        img = Image.new("RGB", (50, 50), (128, 64, 32))
        color = extract_dominant_color(img)
        assert color.startswith("#")
        assert len(color) == 7
        # 验证是有效 hex
        int(color[1:], 16)


# ---------------------------------------------------------------------------
# crop_with_padding 测试
# ---------------------------------------------------------------------------


class TestCropWithPadding:
    """测试图像裁剪函数"""

    def test_basic_crop(self):
        """基本裁剪应返回正确尺寸"""
        image_bytes = _create_color_image(200, 200, (128, 128, 128))
        bbox = BBox(x=50, y=50, w=100, h=50)
        result = crop_with_padding(image_bytes, bbox, padding=8)

        img = Image.open(BytesIO(result))
        # 宽度: 100 + 2*8 = 116, 高度: 50 + 2*8 = 66
        assert img.size == (116, 66)

    def test_crop_at_edge(self):
        """边缘裁剪不应超出图像边界"""
        image_bytes = _create_color_image(100, 100, (128, 128, 128))
        bbox = BBox(x=0, y=0, w=50, h=50)
        result = crop_with_padding(image_bytes, bbox, padding=8)

        img = Image.open(BytesIO(result))
        # x1=max(0, 0-8)=0, y1=max(0, 0-8)=0
        # x2=min(100, 0+50+8)=58, y2=min(100, 0+50+8)=58
        assert img.size == (58, 58)

    def test_crop_at_bottom_right(self):
        """右下角裁剪不应超出图像边界"""
        image_bytes = _create_color_image(100, 100, (128, 128, 128))
        bbox = BBox(x=60, y=60, w=40, h=40)
        result = crop_with_padding(image_bytes, bbox, padding=8)

        img = Image.open(BytesIO(result))
        # x1=max(0, 60-8)=52, y1=max(0, 60-8)=52
        # x2=min(100, 60+40+8)=100, y2=min(100, 60+40+8)=100
        assert img.size == (48, 48)

    def test_zero_padding(self):
        """padding=0 时应精确裁剪"""
        image_bytes = _create_color_image(200, 200, (128, 128, 128))
        bbox = BBox(x=50, y=50, w=80, h=40)
        result = crop_with_padding(image_bytes, bbox, padding=0)

        img = Image.open(BytesIO(result))
        assert img.size == (80, 40)


# ---------------------------------------------------------------------------
# Gpt4oOcrProvider JSON 解析测试
# ---------------------------------------------------------------------------


class TestGpt4oOcrProviderParsing:
    """测试 GPT-4o Provider 的 JSON 解析逻辑"""

    def setup_method(self):
        self.provider = Gpt4oOcrProvider(api_key="test-key")

    def test_parse_valid_json(self):
        """有效 JSON 应正确解析"""
        response = '{"text": "你好世界", "font_family": "黑体", "font_weight": 700, "text_align": "center"}'
        result = self.provider._parse_response(response)

        assert result.text == "你好世界"
        assert result.font_info.family == "黑体"
        assert result.font_info.weight == 700
        assert result.font_info.align == "center"
        assert result.confidence == 0.85

    def test_parse_json_in_code_block(self):
        """```json 代码块中的 JSON 应正确解析"""
        response = '```json\n{"text": "Hello", "font_family": "Arial", "font_weight": 400, "text_align": "left"}\n```'
        result = self.provider._parse_response(response)

        assert result.text == "Hello"
        assert result.font_info.family == "Arial"

    def test_parse_json_with_surrounding_text(self):
        """JSON 前后有其他文字时应正确提取"""
        response = '以下是识别结果：\n{"text": "测试", "font_family": "宋体", "font_weight": 400, "text_align": "left"}\n以上。'
        result = self.provider._parse_response(response)

        assert result.text == "测试"
        assert result.font_info.family == "宋体"

    def test_parse_invalid_json_fallback(self):
        """无效 JSON 应回退到纯文本模式"""
        response = "这是一段无法解析的文字"
        result = self.provider._parse_response(response)

        assert result.text == "这是一段无法解析的文字"
        assert result.font_info.family == "system-ui"  # 回退默认
        assert result.confidence == 0.6

    def test_parse_missing_font_family_fallback(self):
        """font_family 为空时应回退 'system-ui'"""
        response = '{"text": "Hello", "font_family": "", "font_weight": 400, "text_align": "left"}'
        result = self.provider._parse_response(response)

        assert result.text == "Hello"
        assert result.font_info.family == "system-ui"

    def test_parse_null_font_family_fallback(self):
        """font_family 为 null 时应回退 'system-ui'"""
        response = '{"text": "Hello", "font_family": null, "font_weight": 400, "text_align": "left"}'
        result = self.provider._parse_response(response)

        assert result.font_info.family == "system-ui"

    def test_parse_invalid_font_weight(self):
        """无效 font_weight 应回退 400"""
        response = '{"text": "Hello", "font_family": "Arial", "font_weight": -1, "text_align": "left"}'
        result = self.provider._parse_response(response)

        assert result.font_info.weight == 400

    def test_parse_invalid_text_align(self):
        """无效 text_align 应回退 'left'"""
        response = '{"text": "Hello", "font_family": "Arial", "font_weight": 400, "text_align": "justify"}'
        result = self.provider._parse_response(response)

        assert result.font_info.align == "left"

    def test_extract_json_pure(self):
        """纯 JSON 字符串应直接提取"""
        result = self.provider._extract_json('{"key": "value"}')
        assert result == '{"key": "value"}'

    def test_extract_json_code_block(self):
        """代码块中的 JSON 应正确提取"""
        result = self.provider._extract_json('```json\n{"key": "value"}\n```')
        assert result == '{"key": "value"}'

    def test_extract_json_none(self):
        """无 JSON 内容应返回 None"""
        result = self.provider._extract_json("no json here")
        assert result is None

    def test_empty_result_has_system_ui(self):
        """空结果应使用 'system-ui' 字体"""
        result = self.provider._empty_result()
        assert result.font_info.family == "system-ui"
        assert result.text == ""
        assert result.confidence == 0.0


# ---------------------------------------------------------------------------
# OcrProvider Protocol 合规测试
# ---------------------------------------------------------------------------


class TestOcrProviderProtocol:
    """验证 Provider 实现了 OcrProvider Protocol"""

    def test_paddle_implements_protocol(self):
        """PaddleOcrProvider 应实现 OcrProvider Protocol"""
        provider = PaddleOcrProvider()
        assert isinstance(provider, OcrProvider)

    def test_gpt4o_implements_protocol(self):
        """Gpt4oOcrProvider 应实现 OcrProvider Protocol"""
        provider = Gpt4oOcrProvider(api_key="test")
        assert isinstance(provider, OcrProvider)


# ---------------------------------------------------------------------------
# OcrRouter 双路径策略测试
# ---------------------------------------------------------------------------


class TestOcrRouter:
    """测试 OCR 路由器的双路径策略"""

    @pytest.mark.asyncio
    async def test_high_confidence_uses_paddle(self):
        """PaddleOCR 置信度 >= 0.5 时应直接使用本地结果"""
        # Mock PaddleOCR 返回高置信度结果
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="你好世界",
                confidence=0.9,
                font_info=FontInfo(family="system-ui", size=24),
                color_hex="#000000",
            )
        )
        mock_gpt4o = AsyncMock()
        mock_gpt4o.recognize = AsyncMock()

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
            confidence_threshold=0.5,
        )

        image_bytes = _create_text_image(text="你好世界")
        result = await router.recognize(image_bytes)

        assert result.text == "你好世界"
        assert result.confidence == 0.9
        # GPT-4o 不应被调用
        mock_gpt4o.recognize.assert_not_called()

    @pytest.mark.asyncio
    async def test_low_confidence_falls_back_to_gpt4o(self):
        """PaddleOCR 置信度 < 0.5 时应切换到 GPT-4o"""
        # Mock PaddleOCR 返回低置信度结果
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="你好",
                confidence=0.3,
                font_info=FontInfo(family="system-ui", size=20),
                color_hex="#000000",
            )
        )
        # Mock GPT-4o 返回高质量结果
        mock_gpt4o = AsyncMock()
        mock_gpt4o.recognize = AsyncMock(
            return_value=OcrResult(
                text="你好世界",
                confidence=0.85,
                font_info=FontInfo(family="黑体", size=16, weight=700),
                color_hex="#000000",
            )
        )

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
            confidence_threshold=0.5,
        )

        image_bytes = _create_text_image(text="你好世界")
        result = await router.recognize(image_bytes)

        # 应使用 GPT-4o 的文字和字体族
        assert result.text == "你好世界"
        assert result.font_info.family == "黑体"
        # 字号应来自 PaddleOCR（因为 PaddleOCR 有文字结果）
        assert result.font_info.size == 20
        # GPT-4o 应被调用
        mock_gpt4o.recognize.assert_called_once()

    @pytest.mark.asyncio
    async def test_gpt4o_failure_returns_paddle_result(self):
        """GPT-4o 也失败时应返回 PaddleOCR 的结果"""
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="模糊文字",
                confidence=0.3,
                font_info=FontInfo(family="system-ui", size=18),
                color_hex="#333333",
            )
        )
        # GPT-4o 返回空结果
        mock_gpt4o = AsyncMock()
        mock_gpt4o.recognize = AsyncMock(
            return_value=OcrResult(
                text="",
                confidence=0.0,
                font_info=FontInfo(family="system-ui"),
                color_hex="#000000",
            )
        )

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
            confidence_threshold=0.5,
        )

        image_bytes = _create_text_image()
        result = await router.recognize(image_bytes)

        # 应返回 PaddleOCR 的结果
        assert result.text == "模糊文字"
        assert result.confidence == 0.3

    @pytest.mark.asyncio
    async def test_bbox_triggers_crop(self):
        """提供 bbox 时应裁剪图像"""
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="裁剪区域",
                confidence=0.8,
                font_info=FontInfo(size=16),
                color_hex="#000000",
            )
        )
        mock_gpt4o = AsyncMock()

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
        )

        image_bytes = _create_color_image(400, 400, (255, 255, 255))
        bbox = BBox(x=100, y=100, w=200, h=50)
        result = await router.recognize(image_bytes, bbox=bbox)

        assert result.text == "裁剪区域"
        # 验证传给 PaddleOCR 的是裁剪后的图像（尺寸应小于原图）
        call_args = mock_paddle.recognize.call_args[0][0]
        cropped_img = Image.open(BytesIO(call_args))
        assert cropped_img.size[0] < 400
        assert cropped_img.size[1] < 400

    @pytest.mark.asyncio
    async def test_font_fallback_system_ui(self):
        """字体推断失败时应回退 'system-ui'"""
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="test",
                confidence=0.2,
                font_info=FontInfo(family="system-ui", size=14),
                color_hex="#000000",
            )
        )
        # GPT-4o 返回空 font_family
        mock_gpt4o = AsyncMock()
        mock_gpt4o.recognize = AsyncMock(
            return_value=OcrResult(
                text="test text",
                confidence=0.85,
                font_info=FontInfo(family="", size=16),
                color_hex="#000000",
            )
        )

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
            confidence_threshold=0.5,
        )

        image_bytes = _create_text_image(text="test")
        result = await router.recognize(image_bytes)

        # 空 font_family 应回退为 'system-ui'
        assert result.font_info.family == "system-ui"

    @pytest.mark.asyncio
    async def test_exact_threshold_uses_paddle(self):
        """置信度恰好等于阈值时应使用 PaddleOCR"""
        mock_paddle = AsyncMock()
        mock_paddle.recognize = AsyncMock(
            return_value=OcrResult(
                text="边界值",
                confidence=0.5,  # 恰好等于阈值
                font_info=FontInfo(size=16),
                color_hex="#000000",
            )
        )
        mock_gpt4o = AsyncMock()
        mock_gpt4o.recognize = AsyncMock()

        router = OcrRouter(
            paddle_provider=mock_paddle,
            gpt4o_provider=mock_gpt4o,
            confidence_threshold=0.5,
        )

        image_bytes = _create_text_image()
        result = await router.recognize(image_bytes)

        assert result.text == "边界值"
        mock_gpt4o.recognize.assert_not_called()
