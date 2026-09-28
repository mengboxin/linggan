import json
import sys
from types import ModuleType
from unittest.mock import AsyncMock

import pytest

from core.task_errors import to_user_error_message


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            'Responses image_generation failed (503): {"error":{"message":"Service temporarily unavailable"}}',
            "AI 服务暂时繁忙或网关不可用，请稍后重试。",
        ),
        (
            "Responses image_generation failed: upstream returned an HTML error page (502).",
            "AI 服务暂时繁忙或网关不可用，请稍后重试。",
        ),
        (
            'Responses image_generation failed (403): {"error":{"message":"insufficient balance","type":"billing_error"}}',
            "算力 API 余额不足，请先充值后重试，或切换为平台积分算力。",
        ),
        (
            "Image model 'foxapi:generate:gpt-image-2' is missing or disabled",
            "当前模型不可用，请切换模型，或联系管理员检查模型配置。",
        ),
        (
            "Your request was blocked by the safety system: content_policy_violation",
            "提示词被图像安全系统拦截。请弱化敏感、危险、真实人物或 IP 复刻等描述后重试。",
        ),
        (
            "Responses image_generation request timed out.",
            "生成耗时超过预期，可能是上游排队或网络波动。请稍后查看历史记录，必要时再重试。",
        ),
        (
            "fetch failed: ECONNRESET",
            "网络连接暂时中断，可能是本地网络或上游连接波动，请稍后重试。",
        ),
        (
            "401 Unauthorized: invalid api key",
            "算力 API 令牌无效或权限不足，请检查后台算力配置后重试。",
        ),
        (
            "request entity too large",
            "上传的图片或附件太大，请压缩后再提交。",
        ),
    ],
)
def test_to_user_error_message_maps_generation_failures(raw, expected):
    assert to_user_error_message(raw) == expected


class FakeRedis:
    def __init__(self, payload: dict):
        self.payload = payload
        self.published: list[tuple[str, str]] = []

    async def get(self, _key: str):
        return json.dumps(self.payload, ensure_ascii=False)

    async def set(self, _key: str, raw: str, **_kwargs):
        self.payload = json.loads(raw)

    async def publish(self, channel: str, raw: str):
        self.published.append((channel, raw))


@pytest.mark.asyncio
async def test_task_repo_set_failed_stores_friendly_error_and_keeps_raw(monkeypatch):
    redis_module = ModuleType("core.redis")
    redis_module.get_redis = lambda: None
    monkeypatch.setitem(sys.modules, "core.redis", redis_module)

    import repositories.task_repo as task_repo

    redis = FakeRedis({
        "_user_id": "user-1",
        "_released": True,
        "_failed_event_sent": False,
        "status": "processing",
        "progress": 80,
    })
    monkeypatch.setattr(task_repo, "get_redis", lambda: redis)
    monkeypatch.setattr(task_repo, "_release_user_slot_for_task", AsyncMock())
    monkeypatch.setattr(task_repo, "_pg_update_status", AsyncMock())

    raw_error = 'Responses image_generation failed (503): {"error":{"message":"Service temporarily unavailable"}}'

    await task_repo.set_failed("task-1", raw_error)

    assert redis.payload["error"] == "AI 服务暂时繁忙或网关不可用，请稍后重试。"
    assert redis.payload["_raw_error"] == raw_error
    _, event_raw = redis.published[-1]
    assert json.loads(event_raw)["error"] == "AI 服务暂时繁忙或网关不可用，请稍后重试。"
