"""
单元测试：GroundingDinoProvider
覆盖实例化、文本提示构造、bbox 解析、矩形蒙版生成
"""
import base64
from io import BytesIO

import pytest
from PIL import Image

from services.segmentation import (
    BBox,
    GroundingDinoProvider,
    SegmentationProvider,
)


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _make_image_bytes(width: int, height: int, color=(255, 0, 0, 255)) -> bytes:
    """创建指定尺寸的纯色 RGBA 测试图像"""
    img = Image.new("RGBA", (width, height), color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 实例化与协议兼容性测试
# ---------------------------------------------------------------------------


class TestGroundingDinoProviderInstantiation:
    """GroundingDinoProvider 实例化测试"""

    def test_can_instantiate(self):
        """应能正常实例化"""
        provider = GroundingDinoProvider()
        assert provider is not None

    def test_implements_protocol(self):
        """应实现 SegmentationProvider 协议"""
        provider = GroundingDinoProvider()
        assert isinstance(provider, SegmentationProvider)

    def test_has_segment_method(self):
        """应具有 segment 方法"""
        provider = GroundingDinoProvider()
        assert hasattr(provider, "segment")
        assert callable(provider.segment)

    def test_has_endpoint_from_settings(self):
        """应从 settings 读取 endpoint"""
        provider = GroundingDinoProvider()
        assert provider.endpoint is not None
        assert isinstance(provider.endpoint, str)


# ---------------------------------------------------------------------------
# 文本提示构造测试
# ---------------------------------------------------------------------------


class TestBuildTextPrompt:
    """_build_text_prompt 静态方法测试"""

    def test_single_category(self):
        """单个类别应正确构造提示"""
        result = GroundingDinoProvider._build_text_prompt(["red button"])
        assert result == "red button ."

    def test_multiple_categories(self):
        """多个类别应用 ' . ' 连接"""
        result = GroundingDinoProvider._build_text_prompt(
            ["red button", "title text", "icon"]
        )
        assert result == "red button . title text . icon ."

    def test_strips_whitespace(self):
        """应去除类别两端空白"""
        result = GroundingDinoProvider._build_text_prompt(
            ["  red button  ", " icon "]
        )
        assert result == "red button . icon ."

    def test_filters_empty_strings(self):
        """应过滤空字符串"""
        result = GroundingDinoProvider._build_text_prompt(
            ["red button", "", "  ", "icon"]
        )
        assert result == "red button . icon ."

    def test_chinese_categories(self):
        """应支持中文类别"""
        result = GroundingDinoProvider._build_text_prompt(
            ["红色按钮", "标题文字"]
        )
        assert result == "红色按钮 . 标题文字 ."


# ---------------------------------------------------------------------------
# bbox 解析测试
# ---------------------------------------------------------------------------


class TestParseDetectionBbox:
    """_parse_detection_bbox 静态方法测试"""

    def test_list_pixel_coords(self):
        """列表格式像素坐标 [x1, y1, x2, y2]"""
        bbox = GroundingDinoProvider._parse_detection_bbox(
            [100, 200, 300, 400], 1000, 1000
        )
        assert bbox is not None
        assert bbox.x == 100
        assert bbox.y == 200
        assert bbox.w == 200  # 300 - 100
        assert bbox.h == 200  # 400 - 200

    def test_list_normalized_coords(self):
        """列表格式归一化坐标 [0-1]"""
        bbox = GroundingDinoProvider._parse_detection_bbox(
            [0.1, 0.2, 0.5, 0.8], 1000, 500
        )
        assert bbox is not None
        assert bbox.x == 100   # 0.1 * 1000
        assert bbox.y == 100   # 0.2 * 500
        assert bbox.w == 400   # (0.5 - 0.1) * 1000
        assert bbox.h == 300   # (0.8 - 0.2) * 500

    def test_dict_format(self):
        """字典格式 {x1, y1, x2, y2}"""
        bbox = GroundingDinoProvider._parse_detection_bbox(
            {"x1": 50, "y1": 60, "x2": 150, "y2": 160}, 500, 500
        )
        assert bbox is not None
        assert bbox.x == 50
        assert bbox.y == 60
        assert bbox.w == 100
        assert bbox.h == 100

    def test_dict_left_top_right_bottom(self):
        """字典格式 {left, top, right, bottom}"""
        bbox = GroundingDinoProvider._parse_detection_bbox(
            {"left": 10, "top": 20, "right": 110, "bottom": 120}, 500, 500
        )
        assert bbox is not None
        assert bbox.x == 10
        assert bbox.y == 20
        assert bbox.w == 100
        assert bbox.h == 100

    def test_invalid_bbox_returns_none(self):
        """无效 bbox 应返回 None"""
        # 空列表
        assert GroundingDinoProvider._parse_detection_bbox([], 100, 100) is None
        # 太短的列表
        assert GroundingDinoProvider._parse_detection_bbox([1, 2], 100, 100) is None
        # None
        assert GroundingDinoProvider._parse_detection_bbox(None, 100, 100) is None

    def test_zero_area_bbox_returns_none(self):
        """面积为零的 bbox 应返回 None"""
        # x1 == x2
        assert GroundingDinoProvider._parse_detection_bbox(
            [100, 100, 100, 200], 500, 500
        ) is None
        # y1 == y2
        assert GroundingDinoProvider._parse_detection_bbox(
            [100, 100, 200, 100], 500, 500
        ) is None

    def test_coords_clamped_to_image_bounds(self):
        """坐标应被限制在图像边界内"""
        bbox = GroundingDinoProvider._parse_detection_bbox(
            [50, 50, 600, 600], 500, 500
        )
        assert bbox is not None
        # x2 被限制为 500，y2 被限制为 500
        assert bbox.x == 50
        assert bbox.y == 50
        assert bbox.w == 450  # 500 - 50
        assert bbox.h == 450  # 500 - 50


# ---------------------------------------------------------------------------
# 矩形蒙版生成测试
# ---------------------------------------------------------------------------


class TestGenerateRectangularMask:
    """_generate_rectangular_mask 静态方法测试"""

    def test_basic_mask_generation(self):
        """应生成有效的 base64 编码 PNG 蒙版"""
        bbox = BBox(x=10, y=20, w=50, h=30)
        mask_b64 = GroundingDinoProvider._generate_rectangular_mask(
            bbox, 100, 100
        )
        # 应为有效 base64
        mask_bytes = base64.b64decode(mask_b64)
        # 应为有效 PNG
        img = Image.open(BytesIO(mask_bytes))
        assert img.size == (100, 100)
        assert img.mode == "L"

    def test_bbox_region_is_white(self):
        """bbox 区域内应为白色 (255)"""
        bbox = BBox(x=10, y=10, w=20, h=20)
        mask_b64 = GroundingDinoProvider._generate_rectangular_mask(
            bbox, 100, 100
        )
        mask_bytes = base64.b64decode(mask_b64)
        img = Image.open(BytesIO(mask_bytes))

        # bbox 中心点应为白色
        center_x = bbox.x + bbox.w // 2
        center_y = bbox.y + bbox.h // 2
        assert img.getpixel((center_x, center_y)) == 255

    def test_outside_bbox_is_black(self):
        """bbox 区域外应为黑色 (0)"""
        bbox = BBox(x=50, y=50, w=20, h=20)
        mask_b64 = GroundingDinoProvider._generate_rectangular_mask(
            bbox, 100, 100
        )
        mask_bytes = base64.b64decode(mask_b64)
        img = Image.open(BytesIO(mask_bytes))

        # bbox 外的点应为黑色
        assert img.getpixel((0, 0)) == 0
        assert img.getpixel((99, 99)) == 0
        assert img.getpixel((49, 49)) == 0

    def test_full_image_bbox(self):
        """bbox 覆盖整个图像时，蒙版应全白"""
        bbox = BBox(x=0, y=0, w=100, h=100)
        mask_b64 = GroundingDinoProvider._generate_rectangular_mask(
            bbox, 100, 100
        )
        mask_bytes = base64.b64decode(mask_b64)
        img = Image.open(BytesIO(mask_bytes))

        # 四角应为白色
        assert img.getpixel((0, 0)) == 255
        assert img.getpixel((99, 99)) == 255
        assert img.getpixel((50, 50)) == 255

    def test_bbox_clamped_to_image(self):
        """bbox 超出图像边界时应被裁剪"""
        # bbox 右下角超出图像
        bbox = BBox(x=80, y=80, w=50, h=50)
        mask_b64 = GroundingDinoProvider._generate_rectangular_mask(
            bbox, 100, 100
        )
        mask_bytes = base64.b64decode(mask_b64)
        img = Image.open(BytesIO(mask_bytes))
        assert img.size == (100, 100)
        # bbox 起始点应为白色
        assert img.getpixel((80, 80)) == 255
        # 图像右下角应为白色（被裁剪到边界）
        assert img.getpixel((99, 99)) == 255


# ---------------------------------------------------------------------------
# segment 方法验证测试（无网络调用）
# ---------------------------------------------------------------------------


class TestSegmentValidation:
    """segment 方法参数验证测试"""

    def test_empty_categories_raises(self):
        """空 categories 应抛出 ValueError"""
        import asyncio

        provider = GroundingDinoProvider()
        img_bytes = _make_image_bytes(100, 100)

        with pytest.raises(ValueError, match="至少一个 category"):
            asyncio.run(provider.segment(img_bytes, categories=[]))

    def test_none_categories_raises(self):
        """None categories 应抛出 ValueError"""
        import asyncio

        provider = GroundingDinoProvider()
        img_bytes = _make_image_bytes(100, 100)

        with pytest.raises(ValueError, match="至少一个 category"):
            asyncio.run(provider.segment(img_bytes, categories=None))
