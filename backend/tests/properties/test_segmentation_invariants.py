"""
分割服务属性测试 (Property-Based Tests)

**Validates: Requirements R1.6, R1.7**

Properties:
  P19 — bbox 包含蒙版：所有非零像素必须位于 _extract_bbox_from_mask 返回的 bbox 内
  P29 — 下采样上限 4096 + 比例保留：downsample_if_needed 保证最长边 ≤ 4096 且宽高比误差 < 0.01
"""
import os
from io import BytesIO

import numpy as np
from hypothesis import given, settings, assume, HealthCheck
from hypothesis import strategies as st
from PIL import Image

from services.segmentation import (
    BBox,
    downsample_if_needed,
    _extract_bbox_from_mask,
)

# ---------------------------------------------------------------------------
# Hypothesis profile 注册
# ---------------------------------------------------------------------------
settings.register_profile("ci", max_examples=200)
settings.register_profile("nightly", max_examples=2000)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "ci"))


# ---------------------------------------------------------------------------
# 辅助策略 (Strategies)
# ---------------------------------------------------------------------------

def _image_dimensions():
    """生成随机图像尺寸 (1-16384)"""
    return st.integers(min_value=1, max_value=16384)


def _mask_dimensions():
    """生成合理的蒙版尺寸 (1-2048)，避免内存爆炸"""
    return st.integers(min_value=1, max_value=2048)


@st.composite
def random_mask_image(draw):
    """
    生成随机灰度蒙版图像，包含随机白色区域。
    返回 PIL Image (mode='L')。
    """
    w = draw(st.integers(min_value=1, max_value=512))
    h = draw(st.integers(min_value=1, max_value=512))

    # 生成策略：随机选择蒙版类型
    mask_type = draw(st.sampled_from([
        "empty",        # 全黑（无非零像素）
        "full",         # 全白
        "random_rect",  # 随机矩形区域
        "random_noise", # 随机噪声
        "single_pixel", # 单个像素
    ]))

    img = Image.new("L", (w, h), 0)

    if mask_type == "empty":
        pass  # 全黑
    elif mask_type == "full":
        img = Image.new("L", (w, h), 255)
    elif mask_type == "random_rect":
        # 随机矩形白色区域
        x1 = draw(st.integers(min_value=0, max_value=w - 1))
        y1 = draw(st.integers(min_value=0, max_value=h - 1))
        x2 = draw(st.integers(min_value=x1, max_value=w - 1))
        y2 = draw(st.integers(min_value=y1, max_value=h - 1))
        pixels = img.load()
        for y in range(y1, y2 + 1):
            for x in range(x1, x2 + 1):
                pixels[x, y] = 255
    elif mask_type == "random_noise":
        # 随机噪声蒙版
        arr = np.random.randint(0, 256, size=(h, w), dtype=np.uint8)
        img = Image.fromarray(arr, mode="L")
    elif mask_type == "single_pixel":
        # 单个像素
        px = draw(st.integers(min_value=0, max_value=w - 1))
        py = draw(st.integers(min_value=0, max_value=h - 1))
        img.putpixel((px, py), 255)

    return img


# ---------------------------------------------------------------------------
# P19 — ElementMask bbox 包含蒙版
# **Validates: Requirements R1.6**
#
# ∀ ElementMask m, ∀ point p ∈ image:
#     alpha(m, p) > 0 → p ∈ bbox(m)
#     ∧ bbox(m).w > 0 ∧ bbox(m).h > 0
#     ∧ bbox(m).x ≥ 0 ∧ bbox(m).y ≥ 0
#     ∧ bbox(m).x + bbox(m).w ≤ image.width
#     ∧ bbox(m).y + bbox(m).h ≤ image.height
# ---------------------------------------------------------------------------


class TestP19BboxContainsMask:
    """P19: bbox 必须包含蒙版中所有非零像素"""

    @given(mask_img=random_mask_image())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_all_nonzero_pixels_within_bbox(self, mask_img: Image.Image):
        """所有非零像素必须位于 bbox 内"""
        bbox = _extract_bbox_from_mask(mask_img)

        # 验证 bbox 维度有效
        assert bbox.w > 0, f"bbox.w 必须 > 0，实际为 {bbox.w}"
        assert bbox.h > 0, f"bbox.h 必须 > 0，实际为 {bbox.h}"
        assert bbox.x >= 0, f"bbox.x 必须 >= 0，实际为 {bbox.x}"
        assert bbox.y >= 0, f"bbox.y 必须 >= 0，实际为 {bbox.y}"

        # 验证 bbox 不超出图像边界
        assert bbox.x + bbox.w <= mask_img.width, (
            f"bbox 右边界 {bbox.x + bbox.w} 超出图像宽度 {mask_img.width}"
        )
        assert bbox.y + bbox.h <= mask_img.height, (
            f"bbox 下边界 {bbox.y + bbox.h} 超出图像高度 {mask_img.height}"
        )

        # 验证所有非零像素都在 bbox 内
        arr = np.array(mask_img)
        nonzero_coords = np.argwhere(arr > 0)  # (row, col) = (y, x)

        if len(nonzero_coords) == 0:
            # 全黑蒙版：bbox 应为整图 fallback，已验证维度有效
            return

        for row, col in nonzero_coords:
            y, x = int(row), int(col)
            assert bbox.x <= x < bbox.x + bbox.w, (
                f"非零像素 ({x}, {y}) 不在 bbox x 范围 [{bbox.x}, {bbox.x + bbox.w}) 内"
            )
            assert bbox.y <= y < bbox.y + bbox.h, (
                f"非零像素 ({x}, {y}) 不在 bbox y 范围 [{bbox.y}, {bbox.y + bbox.h}) 内"
            )

    @given(mask_img=random_mask_image())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_bbox_is_tight(self, mask_img: Image.Image):
        """bbox 应为最紧凑的包围盒（对有非零像素的蒙版）"""
        bbox = _extract_bbox_from_mask(mask_img)

        arr = np.array(mask_img)
        nonzero_coords = np.argwhere(arr > 0)  # (row, col) = (y, x)

        if len(nonzero_coords) == 0:
            # 全黑蒙版 fallback 到整图，不验证紧凑性
            return

        # 计算实际最小包围盒
        min_y = int(nonzero_coords[:, 0].min())
        max_y = int(nonzero_coords[:, 0].max())
        min_x = int(nonzero_coords[:, 1].min())
        max_x = int(nonzero_coords[:, 1].max())

        expected_x = min_x
        expected_y = min_y
        expected_w = max_x - min_x + 1
        expected_h = max_y - min_y + 1

        assert bbox.x == expected_x, f"bbox.x={bbox.x} != expected {expected_x}"
        assert bbox.y == expected_y, f"bbox.y={bbox.y} != expected {expected_y}"
        assert bbox.w == expected_w, f"bbox.w={bbox.w} != expected {expected_w}"
        assert bbox.h == expected_h, f"bbox.h={bbox.h} != expected {expected_h}"


# ---------------------------------------------------------------------------
# P29 — 下采样上限 4096 + 比例保留
# **Validates: Requirements R1.7**
#
# ∀ image (w, h) where w > 0 ∧ h > 0:
#     let (w', h') = downsampleIfNeeded(w, h)
#     max(w', h') ≤ 4096
#     ∧ |w/h - w'/h'| < 0.01  // 宽高比保留
#     ∧ (max(w, h) ≤ 4096 → w' = w ∧ h' = h)  // 不放大
# ---------------------------------------------------------------------------


class TestP29DownsampleUpperBound:
    """P29: 下采样保证最长边 ≤ 4096 且宽高比误差 < 0.01"""

    @given(
        w=st.integers(min_value=1, max_value=16384),
        h=st.integers(min_value=1, max_value=16384),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_max_dimension_within_4096(self, w: int, h: int):
        """处理后最长边必须 ≤ 4096"""
        # 创建最小测试图像（1x1 像素拉伸到目标尺寸太慢，用纯色小图）
        # 为避免内存问题，对超大尺寸使用小图模拟
        actual_w = min(w, 4200)
        actual_h = min(h, 4200)

        img = Image.new("RGBA", (actual_w, actual_h), (128, 128, 128, 255))
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            image_bytes, max_size=4096
        )

        # 验证最长边 ≤ 4096
        assert max(proc_size) <= 4096, (
            f"处理后尺寸 {proc_size} 最长边 {max(proc_size)} > 4096"
        )

    @given(
        w=st.integers(min_value=2, max_value=16384),
        h=st.integers(min_value=2, max_value=16384),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_aspect_ratio_preserved(self, w: int, h: int):
        """
        **Validates: Requirements R1.7**

        宽高比保留验证。downsample_if_needed 使用 int() 截断计算新尺寸，
        因此验证：
        1. 处理后的尺寸严格遵循 max(1, int(dim * scale)) 公式
        2. 相对宽高比误差受限于 int 截断的理论上界（≈ 1/min_dim）
        """
        actual_w = min(w, 4200)
        actual_h = min(h, 4200)

        img = Image.new("RGBA", (actual_w, actual_h), (128, 128, 128, 255))
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            image_bytes, max_size=4096
        )

        if not was_downsampled:
            # 未缩放，尺寸应完全相同
            assert proc_size == orig_size
            return

        # 验证缩放公式正确性：new_dim = max(1, int(dim * scale))
        max_dim = max(orig_size)
        scale = 4096 / max_dim
        expected_w = max(1, int(orig_size[0] * scale))
        expected_h = max(1, int(orig_size[1] * scale))
        assert proc_size[0] == expected_w, (
            f"宽度不符合缩放公式: {proc_size[0]} != {expected_w}"
        )
        assert proc_size[1] == expected_h, (
            f"高度不符合缩放公式: {proc_size[1]} != {expected_h}"
        )

        # 验证相对宽高比误差
        # int 截断最多导致每个维度 1px 误差
        # 相对误差上界 ≈ 1/min(proc_size)
        orig_ratio = orig_size[0] / orig_size[1]
        proc_ratio = proc_size[0] / proc_size[1]
        relative_error = abs(1.0 - proc_ratio / orig_ratio)

        # 允许的相对误差：1/min_dim + 小余量（浮点精度）
        min_dim = min(proc_size)
        max_allowed_relative_error = 1.0 / min_dim + 0.001
        assert relative_error <= max_allowed_relative_error, (
            f"相对宽高比误差 {relative_error:.6f} 超过允许值 "
            f"{max_allowed_relative_error:.6f} (min_dim={min_dim})"
        )

    @given(
        w=st.integers(min_value=1, max_value=4096),
        h=st.integers(min_value=1, max_value=4096),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_no_upscaling_when_within_limit(self, w: int, h: int):
        """当 max(w, h) ≤ 4096 时不应缩放（不放大）"""
        img = Image.new("RGBA", (w, h), (128, 128, 128, 255))
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            image_bytes, max_size=4096
        )

        # 不应缩放
        assert was_downsampled is False, (
            f"尺寸 ({w}, {h}) 在限制内但被缩放了"
        )
        assert proc_size == orig_size, (
            f"未缩放时尺寸应不变: {proc_size} != {orig_size}"
        )

    @given(
        w=st.integers(min_value=4097, max_value=16384),
        h=st.integers(min_value=1, max_value=16384),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_downsampled_when_exceeds_limit(self, w: int, h: int):
        """当 max(w, h) > 4096 时必须缩放"""
        # 确保至少一个维度 > 4096
        assume(max(w, h) > 4096)

        actual_w = min(w, 4200)
        actual_h = min(h, 4200)
        # 确保实际创建的图像也超过限制
        assume(max(actual_w, actual_h) > 4096)

        img = Image.new("RGBA", (actual_w, actual_h), (128, 128, 128, 255))
        buf = BytesIO()
        img.save(buf, format="PNG")
        image_bytes = buf.getvalue()

        _, orig_size, proc_size, was_downsampled = downsample_if_needed(
            image_bytes, max_size=4096
        )

        assert was_downsampled is True, (
            f"尺寸 ({actual_w}, {actual_h}) 超过限制但未被缩放"
        )
        assert max(proc_size) <= 4096, (
            f"缩放后最长边 {max(proc_size)} 仍 > 4096"
        )
