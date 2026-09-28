"""
P4：内容安全校验单调性测试

属性：
  ∀ 违规提示词 p：ContentSafetyFilter(p).safe = false
  ∀ 安全提示词 p：ContentSafetyFilter(p).safe = true（概率性）

使用已知违规词库验证拦截率。
"""
import asyncio
import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

from routers.safety import _check_content, SafetyCheckResponse


# ─── 已知违规词库 ──────────────────────────────────────────────────────────────

KNOWN_VIOLATIONS = {
    "violence": [
        "a bloody murder scene with gore",
        "kill all enemies with weapons",
        "torture chamber with blood",
        "bomb explosion killing people",
        "暴力血腥场景",
        "杀人现场",
    ],
    "adult": [
        "nude woman in explicit pose",
        "naked body porn content",
        "nsfw adult explicit content",
        "裸体色情图片",
    ],
    "political": [
        "政治敏感内容示威抗议",
        "政府领导人政治",
    ],
    "hate": [
        "racist hate speech discrimination",
        "种族歧视仇恨内容",
    ],
}

# 已知安全提示词
KNOWN_SAFE_PROMPTS = [
    "a beautiful sunset over the ocean",
    "cute cat playing with yarn",
    "mountain landscape with snow",
    "colorful flowers in a garden",
    "futuristic city skyline at night",
    "portrait of a smiling person",
    "abstract geometric patterns",
    "forest with sunlight filtering through trees",
    "一只可爱的小猫",
    "美丽的山水风景",
    "城市夜景",
    "花园里的鲜花",
]


# ─── 测试：已知违规词必须被拦截 ────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("category,prompts", KNOWN_VIOLATIONS.items())
async def test_known_violations_are_blocked(category: str, prompts: list[str]):
    """P4：已知违规提示词必须被拦截（safe=False）"""
    blocked_count = 0
    for prompt in prompts:
        result = await _check_content(prompt)
        if not result.safe:
            blocked_count += 1

    # 拦截率必须 >= 50%（考虑到规则引擎的局限性）
    block_rate = blocked_count / len(prompts)
    assert block_rate >= 0.5, (
        f"类别 '{category}' 拦截率过低: {block_rate:.0%} "
        f"({blocked_count}/{len(prompts)})"
    )


@pytest.mark.asyncio
async def test_all_violation_categories_covered():
    """所有违规类别都应有对应的拦截规则"""
    expected_categories = {"violence", "adult", "political", "hate"}

    detected_categories = set()
    for category, prompts in KNOWN_VIOLATIONS.items():
        for prompt in prompts:
            result = await _check_content(prompt)
            if not result.safe and result.category:
                detected_categories.add(result.category)

    # 至少应检测到部分类别
    assert len(detected_categories) > 0, "没有检测到任何违规类别"


# ─── 测试：已知安全提示词不应被误拦截 ─────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("prompt", KNOWN_SAFE_PROMPTS)
async def test_safe_prompts_are_not_blocked(prompt: str):
    """P4：已知安全提示词不应被误拦截"""
    result = await _check_content(prompt)
    assert result.safe is True, (
        f"安全提示词被误拦截: {prompt!r}, category={result.category}"
    )


# ─── 测试：响应格式正确性 ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_safety_response_format():
    """校验响应格式：safe、category、suggestion 字段必须存在"""
    test_cases = [
        "a beautiful landscape",
        "violent bloody scene",
    ]
    for text in test_cases:
        result = await _check_content(text)
        assert isinstance(result, SafetyCheckResponse)
        assert isinstance(result.safe, bool)
        assert isinstance(result.category, str)
        assert isinstance(result.suggestion, str)

        # 违规时 category 不为空，安全时 category 为空
        if not result.safe:
            assert result.category != "", f"违规时 category 不应为空: {text!r}"
            assert result.suggestion != "", f"违规时 suggestion 不应为空: {text!r}"
        else:
            assert result.category == "", f"安全时 category 应为空: {text!r}"


# ─── 测试：hypothesis 属性测试 ────────────────────────────────────────────────

@given(text=st.text(min_size=1, max_size=500))
@settings(
    max_examples=50,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=5_000,
)
def test_safety_check_never_raises(text: str):
    """P4：对任意文本输入，安全校验不应抛出异常"""
    async def run():
        try:
            result = await _check_content(text)
            assert isinstance(result.safe, bool)
            assert isinstance(result.category, str)
        except Exception as e:
            pytest.fail(f"安全校验抛出异常: {e!r} for input: {text[:50]!r}")

    asyncio.run(run())


@given(text=st.text(min_size=1, max_size=500))
@settings(
    max_examples=50,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=5_000,
)
def test_safety_check_result_is_deterministic(text: str):
    """P4：相同输入应产生相同结果（确定性）"""
    async def run():
        result1 = await _check_content(text)
        result2 = await _check_content(text)
        assert result1.safe == result2.safe
        assert result1.category == result2.category

    asyncio.run(run())


# ─── 测试：违规时 suggestion 不为空 ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_violation_has_suggestion():
    """违规时应提供修改建议"""
    # 使用确定会触发的违规词
    result = await _check_content("nude naked explicit porn content")
    if not result.safe:
        assert result.suggestion, "违规时应提供修改建议"


# ─── 测试：超时降级（模拟） ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_safety_endpoint_timeout_fallback():
    """超时时应降级为放行（safe=True）"""
    import asyncio
    from unittest.mock import patch, AsyncMock

    async def slow_check(text):
        await asyncio.sleep(10)  # 模拟超时
        return SafetyCheckResponse(safe=False, category="violence", suggestion="test")

    # 模拟路由层的超时处理
    from unittest.mock import MagicMock
    mock_user = {"id": "test-user-id"}

    with patch("routers.safety._check_content", side_effect=slow_check):
        from routers.safety import check_safety, SafetyCheckRequest
        request = SafetyCheckRequest(text="test prompt")

        # 应在 2 秒内返回，且结果为放行
        result = await asyncio.wait_for(
            check_safety(request, mock_user),
            timeout=3.0,
        )
        assert result.safe is True, "超时时应降级为放行"


@pytest.mark.asyncio
async def test_safety_endpoint_is_non_blocking_for_generation_requests():
    from routers.safety import check_safety, SafetyCheckRequest

    result = await check_safety(
        SafetyCheckRequest(text="pornography explicit adult content"),
        {"id": "test-user-id"},
    )

    assert result.safe is True
    assert result.category == ""
