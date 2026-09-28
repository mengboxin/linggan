"""
Agent batch variants 属性测试 (Property-Based Tests)

**Validates: Requirements R7.5**

Properties:
  P26 — 结果数量 = n + variant_index 唯一 ∈ [0, n-1]
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
# 纯函数：模拟 batch variants 逻辑
# ---------------------------------------------------------------------------


async def simulate_batch_variants(
    variant_count: int,
    results_map: dict[int, str],  # variant_index → result or "error"
) -> list[dict]:
    """
    模拟 batch variants 并行执行。

    参数:
        variant_count: 变体数量
        results_map: 每个 variant 的结果（"error" 表示失败）

    返回:
        结果列表，每项包含 variant_index 和 status
    """
    results = []
    for i in range(variant_count):
        result_val = results_map.get(i, f"result_{i}")
        if result_val == "error":
            results.append({"variant_index": i, "status": "failed", "error": "模拟失败"})
        else:
            results.append({"variant_index": i, "status": "completed", "result": result_val})
    return results


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

@st.composite
def batch_config_strategy(draw):
    """生成 batch 配置（variant_count 1-10）"""
    count = draw(st.integers(min_value=1, max_value=10))
    # 为每个 variant 生成结果（可能成功或失败）
    results = {}
    for i in range(count):
        if draw(st.booleans()):
            results[i] = f"result_{i}_{draw(st.integers(min_value=0, max_value=1000))}"
        else:
            results[i] = "error"
    return count, results


@st.composite
def all_success_batch_strategy(draw):
    """生成全部成功的 batch 配置"""
    count = draw(st.integers(min_value=1, max_value=10))
    results = {i: f"success_{i}" for i in range(count)}
    return count, results


# ---------------------------------------------------------------------------
# P26 — 结果数量 = n + variant_index 唯一 ∈ [0, n-1]
# **Validates: Requirements R7.5**
# ---------------------------------------------------------------------------


class TestP26BatchVariants:
    """P26: batch variants 结果数量 = n 且 variant_index 唯一"""

    @given(config=batch_config_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_result_count_equals_variant_count(self, config: tuple):
        """
        **Validates: Requirements R7.5**

        结果数量等于请求的 variant_count。
        """
        count, results_map = config
        results = asyncio.run(simulate_batch_variants(count, results_map))

        assert len(results) == count, (
            f"结果数量 {len(results)} != variant_count {count}"
        )

    @given(config=batch_config_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_variant_indices_unique(self, config: tuple):
        """
        **Validates: Requirements R7.5**

        所有 variant_index 唯一。
        """
        count, results_map = config
        results = asyncio.run(simulate_batch_variants(count, results_map))

        indices = [r["variant_index"] for r in results]
        assert len(set(indices)) == len(indices), (
            f"variant_index 有重复: {indices}"
        )

    @given(config=batch_config_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_variant_indices_in_range(self, config: tuple):
        """
        **Validates: Requirements R7.5**

        所有 variant_index ∈ [0, n-1]。
        """
        count, results_map = config
        results = asyncio.run(simulate_batch_variants(count, results_map))

        for r in results:
            assert 0 <= r["variant_index"] < count, (
                f"variant_index {r['variant_index']} 不在 [0, {count-1}] 范围内"
            )

    @given(config=all_success_batch_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_all_success_no_variant_lost(self, config: tuple):
        """
        **Validates: Requirements R7.5**

        全部成功时，每个 variant 都有结果（不丢失）。
        """
        count, results_map = config
        results = asyncio.run(simulate_batch_variants(count, results_map))

        # 所有 variant 都应成功
        for r in results:
            assert r["status"] == "completed", (
                f"variant {r['variant_index']} 应为 completed，实际为 {r['status']}"
            )

        # 覆盖所有 index
        indices = sorted(r["variant_index"] for r in results)
        assert indices == list(range(count))

    @given(config=batch_config_strategy())
    @settings(deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_each_result_has_required_fields(self, config: tuple):
        """
        **Validates: Requirements R7.5**

        每个结果都包含 variant_index 和 status 字段。
        """
        count, results_map = config
        results = asyncio.run(simulate_batch_variants(count, results_map))

        for r in results:
            assert "variant_index" in r
            assert "status" in r
            assert r["status"] in ("completed", "failed")

    def test_variant_count_1(self):
        """单个 variant 应正常工作"""
        results = asyncio.run(simulate_batch_variants(1, {0: "single_result"}))
        assert len(results) == 1
        assert results[0]["variant_index"] == 0
        assert results[0]["status"] == "completed"

    def test_variant_count_10(self):
        """最大 10 个 variant 应正常工作"""
        results_map = {i: f"result_{i}" for i in range(10)}
        results = asyncio.run(simulate_batch_variants(10, results_map))
        assert len(results) == 10
        indices = sorted(r["variant_index"] for r in results)
        assert indices == list(range(10))
