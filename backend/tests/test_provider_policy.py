import pytest
from unittest.mock import AsyncMock

from core.user_context import bind_user_context
from services import provider_policy


@pytest.mark.asyncio
async def test_choose_model_id_prefers_explicit_without_default_lookup(monkeypatch):
    async def fail_default_lookup(category: str):
        raise AssertionError(f"default lookup should not run for {category}")

    monkeypatch.setattr(provider_policy, "get_default_model_id", fail_default_lookup)

    assert await provider_policy.choose_llm_model_id(" llm-explicit ") == "llm-explicit"


@pytest.mark.asyncio
async def test_choose_model_id_uses_category_default(monkeypatch):
    seen: list[str] = []

    async def fake_default_lookup(category: str):
        seen.append(category)
        return f"default-{category}"

    monkeypatch.setattr(provider_policy, "get_default_model_id", fake_default_lookup)

    assert await provider_policy.choose_image_model_id("") == "default-generate"
    assert await provider_policy.choose_vision_model_id(None) == "default-vision"
    assert seen == ["generate", "vision"]


@pytest.mark.asyncio
async def test_choose_model_id_normalizes_unprefixed_ids_for_external_compute(monkeypatch):
    async def fail_default_lookup(category: str):
        raise AssertionError(f"default lookup should not run for {category}")

    monkeypatch.setattr(provider_policy, "get_default_model_id", fail_default_lookup)
    monkeypatch.setattr(
        provider_policy.foxapi_credentials,
        "get_runtime_credential",
        AsyncMock(return_value={"is_active": True}),
    )

    with bind_user_context("user-1", "external_api_key"):
        assert await provider_policy.choose_image_model_id("gpt-image-2") == "foxapi:generate:gpt-image-2"
        assert await provider_policy.choose_llm_model_id("gpt-5.5") == "foxapi:llm:gpt-5.5"
        assert await provider_policy.choose_vision_model_id("foxapi:vision:gpt-5.5") == "foxapi:vision:gpt-5.5"


@pytest.mark.asyncio
async def test_choose_model_id_falls_back_from_stale_runtime_id(monkeypatch):
    monkeypatch.setattr(provider_policy.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value=None))
    monkeypatch.setattr(provider_policy, "get_default_model_id", AsyncMock(return_value="gpt-image-2"))

    with bind_user_context("user-1", "external_api_key"):
        assert await provider_policy.choose_image_model_id("foxapi:generate:gpt-image-2") == "gpt-image-2"


@pytest.mark.asyncio
async def test_choose_model_id_keeps_fox_runtime_selection_when_grok_is_preferred(monkeypatch):
    monkeypatch.setattr(
        provider_policy.foxapi_credentials,
        "get_runtime_credential",
        AsyncMock(return_value={"status": "active"}),
    )

    with bind_user_context("user-1", "grok_api_key"):
        assert await provider_policy.choose_llm_model_id("foxapi:llm:gpt-5.5") == "foxapi:llm:gpt-5.5"


def test_image_generation_attempts_are_always_one_per_user_submission():
    assert provider_policy.image_generation_attempts({}) == 1
    assert provider_policy.image_generation_attempts({"max_image_attempts": 2}) == 1
    assert provider_policy.image_generation_attempts({"allow_image_retry": False}) == 1


def test_image_generation_attempts_ignores_legacy_retry_payloads():
    assert provider_policy.image_generation_attempts({
        "allow_image_retry": "true",
        "max_image_attempts": "5",
    }) == 1
    assert provider_policy.image_generation_attempts({
        "allow_image_retry": "on",
        "max_image_attempts": 2,
    }) == 1


def test_non_retryable_image_errors_cover_configuration_and_safety_failures():
    assert provider_policy.is_non_retryable_image_error("missing Responses endpoint")
    assert provider_policy.is_non_retryable_image_error("Responses image generation requires an SSE response")
    assert not provider_policy.is_non_retryable_image_error("Cloudflare 524 timeout")
    assert provider_policy.is_retryable_image_error("Cloudflare 524 timeout")
    assert provider_policy.is_non_retryable_image_error("content_policy_violation")
    assert provider_policy.is_non_retryable_image_error("提示词被图像安全系统拦截")
    assert not provider_policy.is_non_retryable_image_error("temporary socket reset")


def test_transient_responses_503_requires_an_explicit_user_retry():
    gateway_error = 'Responses image_generation failed (503): {"error":"temporarily unavailable"}'
    safety_error = "content_policy_violation: blocked by safety system"

    assert provider_policy.image_generation_attempts({}) == 1
    assert provider_policy.is_retryable_image_error(gateway_error)
    assert not provider_policy.is_non_retryable_image_error(gateway_error)
    assert provider_policy.is_non_retryable_image_error(safety_error)
    assert not provider_policy.is_retryable_image_error(safety_error)
