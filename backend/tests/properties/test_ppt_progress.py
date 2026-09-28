"""
PPT 进度与单页隔离属性测试 (Property-Based Tests)

**Validates: Requirements R6.1, R6.4**

Properties:
  P20 — 进度序列单调非减 + 终值 ≤ 100
  P27 — 单页失败隔离：仅失败页 status=error，其余 ready
"""

import os
from hypothesis import given, settings, HealthCheck, assume
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Hypothesis profile 注册
# ---------------------------------------------------------------------------
settings.register_profile("ci", max_examples=200)
settings.register_profile("nightly", max_examples=2000)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "ci"))


# ---------------------------------------------------------------------------
# 纯函数：PPT 进度 reducer（后端版本）
# ---------------------------------------------------------------------------

def ppt_progress_reducer(current_progress: float, new_progress: float) -> float:
    """
    PPT 进度 reducer：丢弃乱序事件，clamp 到 [0, 100]。

    规则：
    1. new_progress < current_progress → 丢弃（返回 current）
    2. new_progress > 100 → clamp 到 100
    3. 否则返回 new_progress
    """
    if new_progress < current_progress:
        return current_progress
    return min(100.0, max(0.0, new_progress))


def reduce_progress_sequence(events: list[float]) -> list[float]:
    """对进度事件序列应用 reducer，返回所有中间状态"""
    states = [0.0]
    current = 0.0
    for event in events:
        current = ppt_progress_reducer(current, event)
        states.append(current)
    return states


# ---------------------------------------------------------------------------
# 纯函数：单页失败隔离逻辑
# ---------------------------------------------------------------------------

def apply_slide_failure(
    slide_statuses: list[str], failed_index: int
) -> list[str]:
    """
    将指定 index 的 slide 标记为 error，其余保持不变。

    R6.4: 单页失败不影响其他页。
    """
    result = slide_statuses.copy()
    if 0 <= failed_index < len(result):
        result[failed_index] = "error"
    return result


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

@st.composite
def progress_sequence_strategy(draw):
    """生成进度事件序列（含正常和乱序事件）"""
    length = draw(st.integers(min_value=1, max_value=50))
    events = draw(st.lists(
        st.floats(min_value=-10.0, max_value=120.0, allow_nan=False, allow_infinity=False),
        min_size=length,
        max_size=length,
    ))
    return events


@st.composite
def slide_statuses_strategy(draw):
    """生成 slide 状态列表（1-50 页，初始全为 ready）"""
    count = draw(st.integers(min_value=1, max_value=50))
    return ["ready"] * count


# ---------------------------------------------------------------------------
# P20 — 进度序列单调非减 + 终值 ≤ 100
# **Validates: Requirements R6.1**
# ---------------------------------------------------------------------------


class TestP20ProgressMonotone:
    """P20: 进度序列单调非减 + 终值 ≤ 100"""

    @given(events=progress_sequence_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_progress_monotone_non_decreasing(self, events: list[float]):
        """
        **Validates: Requirements R6.1**

        reducer 输出的进度序列严格单调非减。
        """
        states = reduce_progress_sequence(events)

        for i in range(len(states) - 1):
            assert states[i + 1] >= states[i], (
                f"进度序列非单调: states[{i}]={states[i]} > states[{i+1}]={states[i+1]}"
            )

    @given(events=progress_sequence_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_progress_bounded_by_100(self, events: list[float]):
        """
        **Validates: Requirements R6.1**

        所有状态的 progress ≤ 100。
        """
        states = reduce_progress_sequence(events)

        for state in states:
            assert state <= 100.0, f"进度超过 100: {state}"

    @given(events=progress_sequence_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_progress_non_negative(self, events: list[float]):
        """
        **Validates: Requirements R6.1**

        所有状态的 progress ≥ 0。
        """
        states = reduce_progress_sequence(events)

        for state in states:
            assert state >= 0.0, f"进度为负: {state}"

    @given(
        current=st.floats(min_value=0, max_value=100, allow_nan=False, allow_infinity=False),
        lower=st.floats(min_value=-10, max_value=100, allow_nan=False, allow_infinity=False),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_out_of_order_events_discarded(self, current: float, lower: float):
        """
        **Validates: Requirements R6.1**

        乱序事件（progress < current）被丢弃。
        """
        assume(lower < current)
        result = ppt_progress_reducer(current, lower)
        assert result == current


# ---------------------------------------------------------------------------
# P27 — 单页失败隔离
# **Validates: Requirements R6.4**
# ---------------------------------------------------------------------------


class TestP27SlideFailureIsolation:
    """P27: 单页失败隔离 — 仅失败页 status=error，其余 ready"""

    @given(
        statuses=slide_statuses_strategy(),
        failed_index=st.integers(min_value=0, max_value=49),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_only_failed_slide_has_error_status(
        self, statuses: list[str], failed_index: int
    ):
        """
        **Validates: Requirements R6.4**

        单页失败后，仅该页 status=error，其余页保持 ready。
        """
        assume(failed_index < len(statuses))

        result = apply_slide_failure(statuses, failed_index)

        # 失败页应为 error
        assert result[failed_index] == "error"

        # 其余页应保持 ready
        for i, status in enumerate(result):
            if i != failed_index:
                assert status == "ready", (
                    f"非失败页 {i} 的状态应为 ready，实际为 {status}"
                )

    @given(
        statuses=slide_statuses_strategy(),
        failed_indices=st.lists(
            st.integers(min_value=0, max_value=49),
            min_size=1,
            max_size=5,
            unique=True,
        ),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_multiple_failures_isolated(
        self, statuses: list[str], failed_indices: list[int]
    ):
        """
        **Validates: Requirements R6.4**

        多页失败时，每页独立标记，互不影响。
        """
        # 过滤掉超出范围的 index
        valid_indices = [i for i in failed_indices if i < len(statuses)]
        assume(len(valid_indices) >= 1)

        result = statuses.copy()
        for idx in valid_indices:
            result = apply_slide_failure(result, idx)

        # 验证失败页
        for idx in valid_indices:
            assert result[idx] == "error"

        # 验证非失败页
        for i, status in enumerate(result):
            if i not in valid_indices:
                assert status == "ready"

    @given(statuses=slide_statuses_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_failure_does_not_modify_original(self, statuses: list[str]):
        """
        **Validates: Requirements R6.4**

        apply_slide_failure 不修改原始列表（返回新副本）。
        """
        assume(len(statuses) >= 1)
        original = statuses.copy()

        apply_slide_failure(statuses, 0)

        assert statuses == original
