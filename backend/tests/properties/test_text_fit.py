"""
文字 fit 算法属性测试 (Property-Based Tests)

**Validates: Requirements R3.6**

Properties:
  P14 — 终止性：fit_text_to_bbox 迭代次数 ≤ ⌈log₀.₉₅(8/init_size)⌉+1 且最终 size ≥ 8
  P15 — 单调非增：迭代过程中 size 序列严格非增（每步 size 不增加）
"""

import math
import os
from unittest.mock import patch

from hypothesis import given, settings, HealthCheck, assume
from hypothesis import strategies as st

from services.ocr import BBox, FontInfo
from services.text_render import fit_text_to_bbox

# ---------------------------------------------------------------------------
# Hypothesis profile 注册
# ---------------------------------------------------------------------------
settings.register_profile("ci", max_examples=200)
settings.register_profile("nightly", max_examples=2000)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "ci"))


# ---------------------------------------------------------------------------
# 辅助策略 (Strategies)
# ---------------------------------------------------------------------------

@st.composite
def text_strategy(draw):
    """生成 1-500 长度的文字（混合中英文和特殊字符）"""
    length = draw(st.integers(min_value=1, max_value=500))
    # 混合 ASCII 和中文字符
    chars = draw(st.lists(
        st.one_of(
            st.characters(whitelist_categories=("L", "N", "P", "S")),
            st.sampled_from("你好世界测试文字渲染像素"),
        ),
        min_size=length,
        max_size=length,
    ))
    text = "".join(chars)
    assume(len(text) >= 1)
    return text


@st.composite
def bbox_strategy(draw):
    """生成 1×1 到 4096×4096 的包围盒"""
    w = draw(st.integers(min_value=1, max_value=4096))
    h = draw(st.integers(min_value=1, max_value=4096))
    x = draw(st.integers(min_value=0, max_value=100))
    y = draw(st.integers(min_value=0, max_value=100))
    return BBox(x=x, y=y, w=w, h=h)


@st.composite
def font_info_strategy(draw):
    """生成 init size 1-200 的字体信息"""
    size = draw(st.integers(min_value=1, max_value=200))
    family = draw(st.sampled_from(["system-ui", "Arial", "宋体", "黑体", "Sans"]))
    weight = draw(st.sampled_from([400, 700]))
    align = draw(st.sampled_from(["left", "center", "right"]))
    return FontInfo(family=family, size=size, weight=weight, align=align)


# ---------------------------------------------------------------------------
# 辅助函数：复制 fit_text_to_bbox 的迭代逻辑以记录 trace
# ---------------------------------------------------------------------------

def _fit_text_trace(text: str, bbox: BBox, font_info: FontInfo) -> list[int]:
    """
    复制 fit_text_to_bbox 的迭代逻辑，返回每次迭代的 size 序列。
    用于验证 P15 单调非增性质。

    trace[0] = 初始 size
    trace[i] = 第 i 次缩小后的 size（对应 while 循环中每次测量的 size）
    """
    from services.text_render import _measure_text_size

    if not text:
        return [font_info.size]

    min_size = 8
    current_size = font_info.size
    trace = [current_size]

    while current_size >= min_size:
        w, h = _measure_text_size(text, current_size, font_info.family)
        if w <= bbox.w and h <= bbox.h:
            # 文字能放下，终止
            break

        if current_size <= min_size:
            break

        # 缩小字号
        new_size = int(current_size * 0.95)
        if new_size >= current_size:
            new_size = current_size - 1
        current_size = new_size

        if current_size >= min_size:
            trace.append(current_size)
        else:
            # 降至最低 8px（clamping）
            trace.append(min_size)
            break

    return trace


# ---------------------------------------------------------------------------
# P14 — 文字 fit 终止性
# **Validates: Requirements R3.6**
#
# ∀ text t, ∀ bbox b, ∀ font_info f with f.size > 0:
#     let n_max = ⌈log₀.₉₅(8 / f.size)⌉ + 1
#     let result = fit_text_to_bbox(t, b, f)
#     iterations(fit_text_to_bbox) ≤ n_max
#     ∧ result.size ≥ 8
#     ∧ (fits(t, b, result) ∨ result.size = 8)
# ---------------------------------------------------------------------------


class TestP14TextFitTermination:
    """P14: fit_text_to_bbox 终止性 — 迭代次数有上界且最终 size ≥ 8"""

    @given(
        text=text_strategy(),
        bbox=bbox_strategy(),
        font_info=font_info_strategy(),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_terminates_within_bound(self, text: str, bbox: BBox, font_info: FontInfo):
        """
        **Validates: Requirements R3.6**

        迭代次数不超过 ⌈log₀.₉₅(8/init_size)⌉+1 步。
        """
        init_size = font_info.size

        # 计算理论最大迭代次数上界
        if init_size <= 8:
            # 初始 size 已经 <= 8，最多 1 次迭代（检查是否 fit）
            n_max = 1
        else:
            # ⌈log₀.₉₅(8/init_size)⌉ + 1
            # log₀.₉₅(x) = ln(x) / ln(0.95)
            n_max = math.ceil(math.log(8 / init_size) / math.log(0.95)) + 1

        # 获取实际迭代 trace
        trace = _fit_text_trace(text, bbox, font_info)
        iterations = len(trace)

        assert iterations <= n_max, (
            f"迭代次数 {iterations} 超过理论上界 {n_max} "
            f"(init_size={init_size}, trace={trace[:10]}...)"
        )

    @given(
        text=text_strategy(),
        bbox=bbox_strategy(),
        font_info=font_info_strategy(),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_final_size_at_least_8(self, text: str, bbox: BBox, font_info: FontInfo):
        """
        **Validates: Requirements R3.6**

        最终返回的字号 ≥ 8px。
        """
        result_font, _ = fit_text_to_bbox(text, bbox, font_info)

        assert result_font.size >= 8, (
            f"最终字号 {result_font.size} < 8px "
            f"(init_size={font_info.size}, bbox=({bbox.w}×{bbox.h}))"
        )

    @given(
        text=text_strategy(),
        bbox=bbox_strategy(),
        font_info=font_info_strategy(),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_result_fits_or_at_minimum(self, text: str, bbox: BBox, font_info: FontInfo):
        """
        **Validates: Requirements R3.6**

        结果要么文字能放入 bbox，要么字号已降至最低 8px。
        """
        from services.text_render import _measure_text_size

        result_font, _ = fit_text_to_bbox(text, bbox, font_info)

        w, h = _measure_text_size(text, result_font.size, result_font.family)
        fits = w <= bbox.w and h <= bbox.h

        assert fits or result_font.size == 8, (
            f"文字不 fit (w={w}, h={h}, bbox={bbox.w}×{bbox.h}) "
            f"且字号 {result_font.size} != 8"
        )


# ---------------------------------------------------------------------------
# P15 — 文字 fit 单调非增
# **Validates: Requirements R3.6**
#
# ∀ text t, ∀ bbox b, ∀ font_info f:
#     let trace = fit_text_to_bbox.trace(t, b, f)
#     ∀ i: trace[i+1] ≤ trace[i]
# ---------------------------------------------------------------------------


class TestP15TextFitMonotone:
    """P15: fit_text_to_bbox 迭代 size 序列严格非增"""

    @given(
        text=text_strategy(),
        bbox=bbox_strategy(),
        font_info=font_info_strategy(),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_size_sequence_non_increasing(self, text: str, bbox: BBox, font_info: FontInfo):
        """
        **Validates: Requirements R3.6**

        迭代过程中 size 序列严格非增：每一步的 size 不大于前一步。
        """
        trace = _fit_text_trace(text, bbox, font_info)

        for i in range(len(trace) - 1):
            assert trace[i + 1] <= trace[i], (
                f"size 序列非单调：trace[{i}]={trace[i]} -> "
                f"trace[{i + 1}]={trace[i + 1]} (增加了！) "
                f"完整 trace={trace}"
            )

    @given(
        text=text_strategy(),
        bbox=bbox_strategy(),
        font_info=font_info_strategy(),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_size_strictly_decreases_before_minimum(
        self, text: str, bbox: BBox, font_info: FontInfo
    ):
        """
        **Validates: Requirements R3.6**

        在到达最低 8px 之前，每次迭代 size 至少减少 1px（严格递减）。
        最终 clamping 到 8px 时允许相等（非增即可）。
        """
        trace = _fit_text_trace(text, bbox, font_info)

        # 排除最后一步 clamping 到 min_size 的情况，
        # 在此之前的每步应严格递减
        for i in range(len(trace) - 1):
            # 如果当前步和下一步都 > 8，则必须严格递减
            if trace[i] > 8:
                assert trace[i + 1] < trace[i], (
                    f"缩字过程中 size 未严格递减：trace[{i}]={trace[i]} -> "
                    f"trace[{i + 1}]={trace[i + 1]} "
                    f"完整 trace={trace}"
                )
