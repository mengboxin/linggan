import json
from unittest.mock import patch

import pytest

from core import generation_execution


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.set_calls: list[tuple[str, str, int | None, bool]] = []

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value: str, ex=None, nx=False):
        self.set_calls.append((key, value, ex, nx))
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    async def delete(self, key: str):
        self.store.pop(key, None)


def _identity(*, client_request_id: str, operation_id: str = ""):
    return generation_execution.GenerateSubmitIdentity(
        user_id="user-1",
        client_request_id=client_request_id,
        model_id="image-2",
        prompt="同一个提示词",
        size="2048x2048",
        n=1,
        llm_model_id="",
        vision_model_id="",
        conversation_id="",
        source="web",
        image_hashes=[],
        operation_id=operation_id,
    )


def test_operation_id_keeps_explicit_canvas_submissions_independent():
    first = generation_execution.generate_submit_idempotency_keys(
        _identity(client_request_id="request-1", operation_id="operation-1"),
    )
    second = generation_execution.generate_submit_idempotency_keys(
        _identity(client_request_id="request-2", operation_id="operation-2"),
    )

    assert first[1] != second[1]
    assert generation_execution.generate_submit_idempotency_keys(
        _identity(client_request_id="request-1", operation_id="operation-1"),
    ) == first


def test_module_submit_keys_are_scoped_to_module_and_user():
    first = generation_execution.module_submit_idempotency_key(
        module="poster",
        user_id="user-1",
        client_request_id="request-1",
    )

    assert first.startswith("submit:poster:client:")
    assert first == generation_execution.module_submit_idempotency_key(
        module="poster",
        user_id="user-1",
        client_request_id="request-1",
    )
    assert first != generation_execution.module_submit_idempotency_key(
        module="sci_fig",
        user_id="user-1",
        client_request_id="request-1",
    )
    assert first != generation_execution.module_submit_idempotency_key(
        module="poster",
        user_id="user-2",
        client_request_id="request-1",
    )


@pytest.mark.asyncio
async def test_claim_submit_keys_releases_pending_keys_when_later_key_is_duplicate():
    redis = FakeRedis()
    redis.store["submit:key:existing"] = json.dumps({"taskId": "task-existing"})

    with patch("core.generation_execution.get_redis", return_value=redis):
        result = await generation_execution.claim_submit_keys(["submit:key:new", "submit:key:existing"])

    assert result == {"taskId": "task-existing", "duplicate": True}
    assert "submit:key:new" not in redis.store
    assert json.loads(redis.store["submit:key:existing"]) == {"taskId": "task-existing"}


@pytest.mark.asyncio
async def test_remember_submit_keys_stores_record_with_submit_ttl():
    redis = FakeRedis()
    record = {"taskId": "task-1", "duplicate": False}

    with patch("core.generation_execution.get_redis", return_value=redis):
        await generation_execution.remember_submit_keys(["submit:key:1", "submit:key:2"], record)

    assert json.loads(redis.store["submit:key:1"]) == record
    assert json.loads(redis.store["submit:key:2"]) == record
    assert all(call[2] == generation_execution.SUBMIT_IDEMPOTENCY_TTL_SECONDS for call in redis.set_calls)


@pytest.mark.asyncio
async def test_claim_generate_execution_once_allows_only_first_worker():
    redis = FakeRedis()

    with patch("core.generation_execution.get_redis", return_value=redis):
        first = await generation_execution.claim_generate_execution_once("task-1")
        second = await generation_execution.claim_generate_execution_once("task-1")

    assert first is True
    assert second is False
    assert redis.store["task:task-1:generate_started"] == "1"
    assert redis.set_calls[0][2] == generation_execution.EXECUTION_CLAIM_TTL_SECONDS
    assert redis.set_calls[0][3] is True
