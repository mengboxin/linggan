"""
单元测试：segmentation service 纯函数
覆盖 downsample_if_needed、upscale_masks、compute_content_hash、
_extract_bbox_from_mask、_map_label_to_category
"""
import base64
from io import BytesIO

import pytest
from PIL import Image

from services.segmentation import (
    BBox,
    downsample_if_needed,
    upscale_masks,
    compute_content_hash,
    _extract_bbox_from_mask,
    _map_label_to_category,
    VALID_CATEGORIES,
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


def _make_mask_bytes(width: int, height: int, fill: int = 255) -> bytes:
    """创建指定尺寸的灰度蒙版图像"""
    img = Image.new("L", (width, height), fill)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_mask_with_rect(
    width: int, height: int, rect: tuple[int, int, int, int]
) -> bytes:
    """创建带有矩形白色区域的蒙版"""
    img = Image.new("L", (width, height), 0)
    x1, y1, x2, y2 = rect
    for y in range(y1, min(y2, height)):
        for x in range(x1, min(x2, width)):
            img.putpixel((x, y), 255)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# downsample_if_needed 测试
# ---------------------------------------------------------------------------


class TestDownsampleIfNeeded:
    """R1.7 降采样测试"""

    def test_small_image_no_downscale(self):
        """小于 4096 的图像不应被缩放"""
        img_bytes = _make_image_bytes(1024, 768)
        result_bytes, orig_size, proc_size, was_downsampled = (
            downsample_if_needed(img_bytes, max_size=4096)
        )
        assert orig_size == (1024, 768)
        assert proc_size == (1024, 768)
        assert was_downsampled is False

    def test_exact_boundary_no_downscale(self):
        """恰好等于 4096 的图像不应被缩放"""
        img_bytes = _make_image_bytes(4096, 2048)
        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            img_bytes, max_size=4096
        )
        assert orig_size == (4096, 2048)
        assert proc_size == (4096, 2048)
        assert was_downsampled is False

    def test_wide_image_downscale(self):
        """宽图超过 4096 应被等比缩放"""
        img_bytes = _make_image_bytes(8192, 4096)
        result_bytes, orig_size, proc_size, was_downsampled = (
            downsample_if_needed(img_bytes, max_size=4096)
        )
        assert orig_size == (8192, 4096)
        assert was_downsampled is True
        # 最长边应为 4096
        assert max(proc_size) == 4096
        # 等比缩放：8192 → 4096, 4096 → 2048
        assert proc_size == (4096, 2048)

    def test_tall_image_downscale(self):
        """高图超过 4096 应被等比缩放"""
        img_bytes = _make_image_bytes(2000, 6000)
        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            img_bytes, max_size=4096
        )
        assert orig_size == (2000, 6000)
        assert was_downsampled is True
        assert max(proc_size) == 4096
        # 6000 → 4096, 2000 → int(2000 * 4096/6000) = 1365
        assert proc_size[1] == 4096
        assert proc_size[0] == int(2000 * 4096 / 6000)


    def test_square_image_downscale(self):
        """正方形超大图像应被缩放"""
        img_bytes = _make_image_bytes(5000, 5000)
        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            img_bytes, max_size=4096
        )
        assert orig_size == (5000, 5000)
        assert was_downsampled is True
        assert max(proc_size) == 4096
        assert proc_size == (4096, 4096)

    def test_custom_max_size(self):
        """自定义 max_size 参数"""
        img_bytes = _make_image_bytes(2000, 1000)
        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            img_bytes, max_size=1024
        )
        assert was_downsampled is True
        assert max(proc_size) == 1024
        assert proc_size == (1024, 512)

    def test_output_is_valid_png(self):
        """输出应为有效的 PNG 图像"""
        img_bytes = _make_image_bytes(8000, 6000)
        result_bytes, _, proc_size, _ = downsample_if_needed(
            img_bytes, max_size=4096
        )
        # 验证输出是有效 PNG
        img = Image.open(BytesIO(result_bytes))
        assert img.size == proc_size
        assert img.mode == "RGBA"

    def test_aspect_ratio_preserved(self):
        """缩放后宽高比应保持不变（允许 ±1px 舍入误差）"""
        img_bytes = _make_image_bytes(7680, 4320)  # 16:9
        _, orig_size, proc_size, _ = downsample_if_needed(
            img_bytes, max_size=4096
        )
        orig_ratio = orig_size[0] / orig_size[1]
        proc_ratio = proc_size[0] / proc_size[1]
        assert abs(orig_ratio - proc_ratio) < 0.01


# ---------------------------------------------------------------------------
# upscale_masks 测试
# ---------------------------------------------------------------------------


class TestUpscaleMasks:
    """蒙版放大测试"""

    def test_same_size_no_change(self):
        """原始尺寸与降采样尺寸相同时不应修改"""
        mask_bytes = _make_mask_bytes(100, 100)
        masks_data = [{"mask_bytes": mask_bytes, "bbox": {"x": 10, "y": 20, "w": 30, "h": 40}}]
        result = upscale_masks(masks_data, (100, 100), (100, 100))
        assert result[0]["bbox"] == {"x": 10, "y": 20, "w": 30, "h": 40}

    def test_2x_upscale(self):
        """2 倍放大：bbox 坐标和尺寸应翻倍"""
        mask_bytes = _make_mask_bytes(50, 50)
        masks_data = [{"mask_bytes": mask_bytes, "bbox": {"x": 10, "y": 10, "w": 20, "h": 20}}]
        result = upscale_masks(masks_data, (100, 100), (50, 50))
        assert result[0]["bbox"] == {"x": 20, "y": 20, "w": 40, "h": 40}
        # 验证蒙版图像尺寸
        mask_img = Image.open(BytesIO(result[0]["mask_bytes"]))
        assert mask_img.size == (100, 100)

    def test_non_uniform_scale(self):
        """非均匀缩放（宽高比不同）"""
        mask_bytes = _make_mask_bytes(200, 100)
        masks_data = [{"mask_bytes": mask_bytes, "bbox": {"x": 50, "y": 25, "w": 100, "h": 50}}]
        result = upscale_masks(masks_data, (400, 300), (200, 100))
        # scale_x = 400/200 = 2, scale_y = 300/100 = 3
        assert result[0]["bbox"] == {"x": 100, "y": 75, "w": 200, "h": 150}

    def test_multiple_masks(self):
        """多个蒙版应全部被放大"""
        mask1 = _make_mask_bytes(50, 50)
        mask2 = _make_mask_bytes(50, 50)
        masks_data = [
            {"mask_bytes": mask1, "bbox": {"x": 0, "y": 0, "w": 10, "h": 10}},
            {"mask_bytes": mask2, "bbox": {"x": 20, "y": 30, "w": 15, "h": 15}},
        ]
        result = upscale_masks(masks_data, (100, 100), (50, 50))
        assert len(result) == 2
        assert result[0]["bbox"] == {"x": 0, "y": 0, "w": 20, "h": 20}
        assert result[1]["bbox"] == {"x": 40, "y": 60, "w": 30, "h": 30}

    def test_empty_masks_list(self):
        """空列表应返回空列表"""
        result = upscale_masks([], (100, 100), (50, 50))
        assert result == []


# ---------------------------------------------------------------------------
# compute_content_hash 测试
# ---------------------------------------------------------------------------


class TestComputeContentHash:
    """内容哈希计算测试"""

    def test_deterministic(self):
        """相同输入应产生相同哈希"""
        data = b"test image data"
        h1 = compute_content_hash(data)
        h2 = compute_content_hash(data)
        assert h1 == h2

    def test_different_input_different_hash(self):
        """不同输入应产生不同哈希"""
        h1 = compute_content_hash(b"image A")
        h2 = compute_content_hash(b"image B")
        assert h1 != h2

    def test_hash_format(self):
        """哈希应为 64 字符的十六进制字符串（SHA-256）"""
        h = compute_content_hash(b"test")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


# ---------------------------------------------------------------------------
# _extract_bbox_from_mask 测试
# ---------------------------------------------------------------------------


class TestExtractBboxFromMask:
    """从蒙版提取包围盒测试"""

    def test_full_white_mask(self):
        """全白蒙版的 bbox 应覆盖整个图像"""
        img = Image.new("L", (100, 80), 255)
        bbox = _extract_bbox_from_mask(img)
        assert bbox.x == 0
        assert bbox.y == 0
        assert bbox.w == 100
        assert bbox.h == 80

    def test_empty_mask(self):
        """全黑蒙版应返回整个图像尺寸作为 fallback"""
        img = Image.new("L", (100, 80), 0)
        bbox = _extract_bbox_from_mask(img)
        # 全黑时 getbbox() 返回 None，fallback 到整图
        assert bbox.x == 0
        assert bbox.y == 0
        assert bbox.w == 100
        assert bbox.h == 80

    def test_partial_mask(self):
        """部分白色区域应正确提取 bbox"""
        img = Image.new("L", (200, 200), 0)
        # 在 (50, 60) 到 (150, 160) 区域填白
        for y in range(60, 160):
            for x in range(50, 150):
                img.putpixel((x, y), 255)
        bbox = _extract_bbox_from_mask(img)
        assert bbox.x == 50
        assert bbox.y == 60
        assert bbox.w == 100
        assert bbox.h == 100


# ---------------------------------------------------------------------------
# _map_label_to_category 测试
# ---------------------------------------------------------------------------


class TestMapLabelToCategory:
    """标签到类别映射测试"""

    def test_direct_match(self):
        """直接匹配有效类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("person", valid) == "person"
        assert _map_label_to_category("text", valid) == "text"
        assert _map_label_to_category("icon", valid) == "icon"

    def test_fuzzy_match_person(self):
        """模糊匹配 person 类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("man", valid) == "person"
        assert _map_label_to_category("woman", valid) == "person"
        assert _map_label_to_category("human face", valid) == "person"

    def test_fuzzy_match_text(self):
        """模糊匹配 text 类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("word", valid) == "text"
        assert _map_label_to_category("writing on wall", valid) == "text"

    def test_fuzzy_match_icon(self):
        """模糊匹配 icon 类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("logo", valid) == "icon"
        assert _map_label_to_category("symbol", valid) == "icon"
        assert _map_label_to_category("sticker", valid) == "icon"

    def test_fuzzy_match_shape(self):
        """模糊匹配 shape 类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("circle", valid) == "shape"
        assert _map_label_to_category("red rectangle", valid) == "shape"

    def test_fuzzy_match_background(self):
        """模糊匹配 background 类别"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("sky", valid) == "background"
        assert _map_label_to_category("ground", valid) == "background"
        assert _map_label_to_category("scene", valid) == "background"

    def test_unknown_label_defaults_to_object(self):
        """未知标签应默认为 object"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("car", valid) == "object"
        assert _map_label_to_category("table", valid) == "object"

    def test_case_insensitive(self):
        """匹配应不区分大小写"""
        valid = list(VALID_CATEGORIES)
        assert _map_label_to_category("PERSON", valid) == "person"
        assert _map_label_to_category("Text", valid) == "text"

    def test_filtered_categories(self):
        """仅在指定的候选类别中匹配"""
        valid = ["person", "text"]
        assert _map_label_to_category("man", valid) == "person"
        # icon 不在候选中，应返回第一个候选
        result = _map_label_to_category("logo", valid)
        assert result in valid
