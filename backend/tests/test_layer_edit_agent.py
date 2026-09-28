"""
P3：图层编辑尺寸不变性测试

属性：∀ 图层编辑操作 op，原图层尺寸 (w, h)：
  result = LayerEditAgent(op) → result.width = w ∧ result.height = h

使用 hypothesis 生成任意尺寸图层，验证 Agent 输出尺寸不变。
"""
import asyncio
import base64
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from PIL import Image


# ─── 辅助函数 ──────────────────────────────────────────────────────────────────

def make_test_image(width: int, height: int) -> bytes:
    """创建指定尺寸的测试图像（RGBA）"""
    img = Image.new("RGBA", (width, height), color=(100, 150, 200, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def get_image_size(image_bytes: bytes) -> tuple[int, int]:
    """从字节数据获取图像尺寸"""
    img = Image.open(BytesIO(image_bytes))
    return img.width, img.height


# ─── 模拟模型调用（返回不同尺寸的图像，测试 Agent 的尺寸修正能力） ──────────────

async def mock_call_model_endpoint_wrong_size(img, params, model=None):
    """模拟返回错误尺寸的模型（Agent 应自动修正）"""
    wrong_w = img.width * 2
    wrong_h = img.height * 2
    result = Image.new("RGBA", (wrong_w, wrong_h), color=(200, 100, 50, 255))
    return result


async def mock_call_model_endpoint_correct_size(img, params, model=None):
    """模拟返回正确尺寸的模型"""
    result = Image.new("RGBA", (img.width, img.height), color=(200, 100, 50, 255))
    return result


# ─── 测试：validate_output_size 节点的尺寸修正 ────────────────────────────────

@given(
    width=st.integers(min_value=16, max_value=512),
    height=st.integers(min_value=16, max_value=512),
)
@settings(
    max_examples=30,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=10_000,
)
def test_layer_edit_agent_size_invariance_with_wrong_model(width: int, height: int):
    """P3：即使模型返回错误尺寸，Agent 也应将结果调整为原始尺寸。"""
    async def run():
        image_bytes = make_test_image(width, height)
        bounds = {"x": 0, "y": 0, "width": width, "height": height}

        with patch(
            "services.layer_edit._call_model_endpoint",
            side_effect=mock_call_model_endpoint_wrong_size,
        ), patch(
            "repositories.model_repo.get_model_internal",
            new_callable=AsyncMock,
            return_value={"id": "test-model", "endpoint": "http://test", "api_key": "test"},
        ):
            from services.agents import LayerEditAgent
            agent = LayerEditAgent()
            result = await agent.run(
                image_bytes=image_bytes,
                prompt="test edit",
                bounds=bounds,
                model_id="test-model",
            )

        assert "result" in result
        result_bytes = base64.b64decode(result["result"])
        result_w, result_h = get_image_size(result_bytes)

        assert result_w == width, f"宽度不匹配: 期望 {width}, 实际 {result_w}"
        assert result_h == height, f"高度不匹配: 期望 {height}, 实际 {result_h}"

    asyncio.run(run())


@given(
    width=st.integers(min_value=16, max_value=512),
    height=st.integers(min_value=16, max_value=512),
)
@settings(
    max_examples=30,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=10_000,
)
def test_layer_edit_agent_size_invariance_with_correct_model(width: int, height: int):
    """P3：模型返回正确尺寸时，Agent 输出尺寸也应与输入一致。"""
    async def run():
        image_bytes = make_test_image(width, height)
        bounds = {"x": 0, "y": 0, "width": width, "height": height}

        with patch(
            "services.layer_edit._call_model_endpoint",
            side_effect=mock_call_model_endpoint_correct_size,
        ), patch(
            "repositories.model_repo.get_model_internal",
            new_callable=AsyncMock,
            return_value={"id": "test-model", "endpoint": "http://test", "api_key": "test"},
        ):
            from services.agents import LayerEditAgent
            agent = LayerEditAgent()
            result = await agent.run(
                image_bytes=image_bytes,
                prompt="test edit",
                bounds=bounds,
                model_id="test-model",
            )

        result_bytes = base64.b64decode(result["result"])
        result_w, result_h = get_image_size(result_bytes)

        assert result_w == width
        assert result_h == height

    asyncio.run(run())


@given(
    width=st.integers(min_value=16, max_value=256),
    height=st.integers(min_value=16, max_value=256),
)
@settings(max_examples=20, suppress_health_check=[HealthCheck.too_slow], deadline=10_000)
def test_layer_edit_agent_empty_bounds_uses_image_size(width: int, height: int):
    """bounds 为空（0,0,0,0）时，Agent 应从图像中提取实际尺寸"""
    async def run():
        image_bytes = make_test_image(width, height)
        bounds = {"x": 0, "y": 0, "width": 0, "height": 0}

        with patch(
            "services.layer_edit._call_model_endpoint",
            side_effect=mock_call_model_endpoint_correct_size,
        ), patch(
            "repositories.model_repo.get_model_internal",
            new_callable=AsyncMock,
            return_value={"id": "test-model", "endpoint": "http://test", "api_key": "test"},
        ):
            from services.agents import LayerEditAgent
            agent = LayerEditAgent()
            result = await agent.run(
                image_bytes=image_bytes,
                prompt="test",
                bounds=bounds,
                model_id="test-model",
            )

        assert "result" in result
        result_bytes = base64.b64decode(result["result"])
        result_w, result_h = get_image_size(result_bytes)

        assert result_w == width
        assert result_h == height

    asyncio.run(run())


def test_layer_edit_agent_fallback_on_model_failure():
    """模型调用失败时，Agent 应返回原始图像（不崩溃）"""
    async def run():
        width, height = 64, 64
        image_bytes = make_test_image(width, height)
        bounds = {"x": 0, "y": 0, "width": width, "height": height}

        async def failing_model(img, params, model=None):
            raise RuntimeError("模型调用失败")

        with patch(
            "services.layer_edit._call_model_endpoint",
            side_effect=failing_model,
        ), patch(
            "repositories.model_repo.get_model_internal",
            new_callable=AsyncMock,
            return_value=None,
        ):
            from services.agents import LayerEditAgent
            agent = LayerEditAgent()
            result = await agent.run(
                image_bytes=image_bytes,
                prompt="test",
                bounds=bounds,
                model_id="test-model",
            )

        assert "result" in result
        result_bytes = base64.b64decode(result["result"])
        result_w, result_h = get_image_size(result_bytes)
        assert result_w == width
        assert result_h == height

    asyncio.run(run())
