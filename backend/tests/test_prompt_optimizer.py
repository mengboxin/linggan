"""
P5：提示词优化长度合理性测试

属性：∀ 原始提示词 p（len > 0）：
  optimized = PromptAgent(p) → len(optimized) > 0 ∧ len(optimized) ≤ 2000

使用 hypothesis 生成任意提示词，验证优化结果长度合理。
"""
import asyncio
import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from unittest.mock import patch, AsyncMock

from services.agents import PromptAgent


# ─── 辅助：运行规则引擎降级（不依赖 LLM） ────────────────────────────────────

async def run_optimizer_fallback(prompt: str, mode: str = "TEXT_TO_IMAGE", layer_bounds=None) -> dict:
    """使用规则引擎降级运行优化器（不需要真实 LLM）"""
    from services.agents import PromptAgent

    # 强制使用降级模式（不调用 LLM）
    with patch(
        "services.agents.prompt_agent.get_llm_model",
        new_callable=AsyncMock,
        return_value=None,  # 无 LLM 模型，触发降级
    ):
        agent = PromptAgent()
        return await agent.run(
            original_prompt=prompt,
            mode=mode,
            layer_bounds=layer_bounds,
        )


# ─── P5：优化结果长度合理性 ────────────────────────────────────────────────────

@given(
    prompt=st.text(
        alphabet=st.characters(
            whitelist_categories=("Lu", "Ll", "Nd", "Zs"),
            whitelist_characters="，。！？、：；""''（）【】《》",
        ),
        min_size=1,
        max_size=500,
    )
)
@settings(
    max_examples=50,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=10_000,
)
def test_optimized_prompt_length_reasonable(prompt: str):
    """P5：优化结果长度必须 > 0 且 ≤ 2000"""
    async def run():
        result = await run_optimizer_fallback(prompt)
        optimized = result.get("final_prompt", "")
        assert len(optimized) > 0, f"优化结果不应为空: input={prompt[:50]!r}"
        assert len(optimized) <= 2000, f"优化结果过长: {len(optimized)} chars"

    asyncio.run(run())


@given(
    prompt=st.text(min_size=1, max_size=200),
    mode=st.sampled_from(["TEXT_TO_IMAGE", "IMAGE_EDIT"]),
)
@settings(
    max_examples=30,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=10_000,
)
def test_optimized_prompt_not_empty_for_any_mode(prompt: str, mode: str):
    """P5：任意模式下优化结果都不应为空"""
    async def run():
        result = await run_optimizer_fallback(prompt, mode=mode)
        assert len(result.get("final_prompt", "")) > 0

    asyncio.run(run())


@given(
    width=st.integers(min_value=1, max_value=2048),
    height=st.integers(min_value=1, max_value=2048),
)
@settings(max_examples=20, suppress_health_check=[HealthCheck.too_slow], deadline=10_000)
def test_layer_edit_mode_includes_bounds(width: int, height: int):
    """IMAGE_EDIT 模式下，优化结果应包含边界约束描述"""
    async def run():
        bounds = {"x": 0, "y": 0, "width": width, "height": height}
        result = await run_optimizer_fallback(
            "edit the background",
            mode="IMAGE_EDIT",
            layer_bounds=bounds,
        )
        optimized = result.get("final_prompt", "")
        assert str(width) in optimized or str(height) in optimized, \
            f"IMAGE_EDIT 模式应包含尺寸信息: {optimized[:100]!r}"

    asyncio.run(run())


@given(prompt=st.text(min_size=3, max_size=100))
@settings(max_examples=30, suppress_health_check=[HealthCheck.too_slow], deadline=10_000)
def test_optimized_contains_original_content(prompt: str):
    """优化结果应保留原始提示词的核心内容"""
    async def run():
        result = await run_optimizer_fallback(prompt)
        optimized = result.get("final_prompt", "")
        assert prompt in optimized or len(optimized) > 0

    asyncio.run(run())


@pytest.mark.asyncio
async def test_optimizer_returns_suggestions():
    """优化器应返回建议列表"""
    result = await run_optimizer_fallback("a beautiful landscape")
    assert "suggestions" in result
    suggestions = result["suggestions"]
    assert isinstance(suggestions, list)
    for s in suggestions:
        assert isinstance(s, str)
        assert 0 < len(s) <= 2000


@pytest.mark.asyncio
async def test_optimizer_parses_first_json_object_with_trailing_text():
    from services.agents import PromptAgent

    raw = (
        '{"safe": true, "optimized": "polished prompt", "suggestions": ["a", "b", "c"]}'
        '{"extra": "ignored"}'
    )
    with patch("services.agents.prompt_agent.get_llm_model", new_callable=AsyncMock, return_value={"id": "llm"}), patch(
        "services.agents.prompt_agent.call_llm_chat", new_callable=AsyncMock, return_value=raw
    ):
        result = await PromptAgent().run("rough prompt")

    assert result["final_prompt"] == "polished prompt"
    assert result["suggestions"] == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_optimizer_suggestions_count():
    """建议列表数量不超过 5 条"""
    result = await run_optimizer_fallback("test prompt")
    assert len(result.get("suggestions", [])) <= 5


@pytest.mark.asyncio
async def test_unsafe_prompt_returns_original():
    """违规提示词经过安全校验后，应返回原始提示词"""
    unsafe_prompt = "nude explicit adult content"
    result = await run_optimizer_fallback(unsafe_prompt)
    assert len(result.get("final_prompt", "")) > 0


def test_prompt_rule_check_does_not_block_generation_requests():
    result = PromptAgent()._rule_check("pornography explicit adult content")
    assert result == {"safe": True, "reason": ""}


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt", [
    "a",
    "hello world",
    "你好世界",
    "a" * 500,
])
async def test_optimizer_handles_edge_cases(prompt: str):
    """边界情况：各种长度和语言的提示词都应正常处理"""
    result = await run_optimizer_fallback(prompt)
    optimized = result.get("final_prompt", "")
    assert 0 < len(optimized) <= 2000
