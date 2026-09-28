from unittest.mock import AsyncMock

import pytest

import services.ai_client as ai_client
from core.user_context import bind_user_context


@pytest.mark.asyncio
async def test_unified_call_logs_platform_credits_without_payload_data(monkeypatch):
    record_call = AsyncMock()
    monkeypatch.setattr(ai_client.model_call_log_repo, "record_model_call", record_call)

    async def successful_call():
        return "ok"

    with bind_user_context("00000000-0000-0000-0000-000000000111", "platform_credits"):
        assert await ai_client._tracked_model_call({
            "id": "gpt-text",
            "name": "GPT Text",
            "category": "llm",
            "provider": "foxapi",
        }, successful_call()) == "ok"

    record_call.assert_awaited_once()
    kwargs = record_call.await_args.kwargs
    assert kwargs["user_id"] == "00000000-0000-0000-0000-000000000111"
    assert kwargs["billing_mode"] == "platform_credits"
    assert kwargs["model_id"] == "gpt-text"
    assert kwargs["model_category"] == "llm"
    assert kwargs["success"] is True
    assert "prompt" not in kwargs
    assert "api_key" not in kwargs


@pytest.mark.asyncio
async def test_unified_call_logs_api_key_failures_with_redacted_error(monkeypatch):
    record_call = AsyncMock()
    record_usage = AsyncMock()
    monkeypatch.setattr(ai_client.model_call_log_repo, "record_model_call", record_call)
    monkeypatch.setattr(ai_client.foxapi_credentials, "record_usage", record_usage)

    secret = "sk-test-private-value"

    async def failed_call():
        raise RuntimeError(f"upstream rejected Bearer {secret}")

    with pytest.raises(RuntimeError, match="upstream rejected"):
        await ai_client._tracked_model_call({
            "id": "foxapi:vision:gpt-5.5",
            "name": "GPT 5.5",
            "category": "vision",
            "provider": "foxapi",
            "api_key": secret,
            "credential_user_id": "00000000-0000-0000-0000-000000000222",
        }, failed_call())

    kwargs = record_call.await_args.kwargs
    assert kwargs["billing_mode"] == "external_api_key"
    assert kwargs["success"] is False
    assert secret not in kwargs["error_message"]
    assert "[REDACTED]" in kwargs["error_message"]
    record_usage.assert_awaited_once()
