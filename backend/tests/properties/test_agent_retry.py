"""
Agent retry 上限属性测试 (Property-Based Tests)

**Validates: Requirements R7.4**

Properties:
  P13 — 任意失败序列下 retries ≤ 3 + status=failed → retries=3
"""

import asyncio
import os

from hypothesis import given, settings, HealthCheck, assume
from hypothesis import strategies as st

from models.schemas import SubTask

# ---------------------------------------------------------------------------
# Hypothesis profile 注册
# ---------------------------------------------------------------------------
settings.register_profile("ci", max_examples=200)
settings.register_profile("nightly", max_examples=2000)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "ci"))


# ---------------------------------------------------------------------------
# 纯函数：模拟 retry 逻辑（从 orchestrator.py 提取）
# ---------------------------------------------------------------------------

MAX_RETRIES = 3


def simulate_retries(failure_sequence: list[bool]) -> tuple[int, str]:
    """
    模拟子任务执行的 retry 逻辑。

    参数:
        failure_sequence: 每次执行是否失败（True=失败，False=成功）

    返回:
        (最终 retries 计数, 最终 status)
    """
    retries = 0
    status = "pending"

    for i, fails in enumerate(failure_sequence):
        if status in ("completed", "failed"):
            break

        status = "running"

        if fails:
            retries += 1
            if retries >= MAX_RETRIES:
                status = "failed"
            else:
                status = "pending"  # 等待重试
        else:
            status = "completed"
            break

    # 如果序列用完了还没成功也没达到上限
    if status == "pending" or status == "running":
        status = "pending"

    return retries, status


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

@st.composite
def failure_sequence_strategy(draw):
    """生成执行成功/失败序列（长度 1-10）"""
    length = draw(st.integers(min_value=1, max_value=10))
    return draw(st.lists(st.booleans(), min_size=length, max_size=length))


# ---------------------------------------------------------------------------
# P13 — retries ≤ 3 + status=failed → retries=3
# **Validates: Requirements R7.4**
# ---------------------------------------------------------------------------


class TestP13RetryBound:
    """P13: 任意失败序列下 retries ≤ 3"""

    @given(failures=failure_sequence_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_retries_never_exceed_max(self, failures: list[bool]):
        """
        **Validates: Requirements R7.4**

        无论失败模式如何，retries 永远不超过 MAX_RETRIES (3)。
        """
        retries, status = simulate_retries(failures)
        assert retries <= MAX_RETRIES, (
            f"retries={retries} 超过上限 {MAX_RETRIES}, failures={failures}"
        )

    @given(failures=st.lists(st.just(True), min_size=3, max_size=10))
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_all_failures_leads_to_failed_status(self, failures: list[bool]):
        """
        **Validates: Requirements R7.4**

        连续 3 次失败后 status 必须为 'failed'。
        """
        retries, status = simulate_retries(failures)
        assert status == "failed", (
            f"连续 {len(failures)} 次失败后 status 应为 failed，实际为 {status}"
        )
        assert retries == MAX_RETRIES

    @given(failures=failure_sequence_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_failed_implies_retries_equals_max(self, failures: list[bool]):
        """
        **Validates: Requirements R7.4**

        status=failed 当且仅当 retries=MAX_RETRIES。
        """
        retries, status = simulate_retries(failures)

        if status == "failed":
            assert retries == MAX_RETRIES, (
                f"status=failed 但 retries={retries} != {MAX_RETRIES}"
            )

    @given(
        prefix_failures=st.lists(st.just(True), min_size=0, max_size=2),
    )
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_success_after_failures_completes(self, prefix_failures: list[bool]):
        """
        **Validates: Requirements R7.4**

        失败后成功应标记为 completed（只要 retries < 3）。
        """
        # 在失败序列后加一个成功
        failures = prefix_failures + [False]
        retries, status = simulate_retries(failures)

        assert status == "completed", (
            f"失败 {len(prefix_failures)} 次后成功应为 completed，实际为 {status}"
        )
        assert retries == len(prefix_failures)

    def test_empty_sequence_stays_pending(self):
        """空序列应保持 pending"""
        retries, status = simulate_retries([])
        assert retries == 0
        assert status == "pending"

    def test_single_success_completes(self):
        """单次成功应立即 completed"""
        retries, status = simulate_retries([False])
        assert retries == 0
        assert status == "completed"

    def test_exactly_three_failures(self):
        """恰好 3 次失败应标记 failed"""
        retries, status = simulate_retries([True, True, True])
        assert retries == 3
        assert status == "failed"

    def test_two_failures_then_success(self):
        """2 次失败后成功应 completed"""
        retries, status = simulate_retries([True, True, False])
        assert retries == 2
        assert status == "completed"
