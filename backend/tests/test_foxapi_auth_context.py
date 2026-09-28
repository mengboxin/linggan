import json
import importlib.util
import sys
import types
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException


if importlib.util.find_spec("redis") is None:
    redis_package = types.ModuleType("redis")
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = object
    redis_asyncio.from_url = MagicMock()
    redis_package.asyncio = redis_asyncio
    sys.modules["redis"] = redis_package
    sys.modules["redis.asyncio"] = redis_asyncio

if importlib.util.find_spec("aiosmtplib") is None:
    aiosmtplib = types.ModuleType("aiosmtplib")
    aiosmtplib.SMTP = object
    sys.modules["aiosmtplib"] = aiosmtplib

if importlib.util.find_spec("email_validator") is None:
    email_validator = types.ModuleType("email_validator")
    import pydantic.networks as pydantic_networks

    _original_version = pydantic_networks.version
    pydantic_networks.version = lambda name: "2.0.0" if name == "email-validator" else _original_version(name)

    class EmailNotValidError(ValueError):
        pass

    def validate_email(value, *args, **kwargs):
        normalized = str(value)
        return types.SimpleNamespace(normalized=normalized, email=normalized)

    email_validator.EmailNotValidError = EmailNotValidError
    email_validator.validate_email = validate_email
    sys.modules["email_validator"] = email_validator

if importlib.util.find_spec("captcha") is None:
    class _ImageCaptcha:
        def __init__(self, *args, **kwargs):
            pass

        def generate(self, _text):
            return b""

    captcha_package = types.ModuleType("captcha")
    captcha_image = types.ModuleType("captcha.image")
    captcha_image.ImageCaptcha = _ImageCaptcha
    captcha_package.image = captcha_image
    sys.modules["captcha"] = captcha_package
    sys.modules["captcha.image"] = captcha_image


def _external_user():
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "user@example.com",
        "display_name": "普通账号用户",
        "role": "user",
        "status": "active",
        "credits": 30,
        "auth_provider": "password",
        "billing_mode": "external_api_key",
        "pet_id": "bubu",
        "pet_custom_name": "Bubu",
        "key_fingerprint": "a" * 64,
        "api_key_status": "active",
        "foxapi_model_count": 13,
    }


@pytest.mark.asyncio
async def test_connecting_api_key_keeps_password_account_identity_and_hides_secret(monkeypatch):
    from routers import auth

    connect = AsyncMock()
    monkeypatch.setattr(auth.foxapi_credentials, "connect_api_key", connect)
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=_external_user()))

    payload = await auth.connect_compute_api_key(
        auth.ConnectApiKeyRequest(api_key="fox-secret-key", activate=True),
        _external_user(),
    )

    connect.assert_awaited_once_with(_external_user()["id"], "fox-secret-key", activate=True)
    assert payload["user"]["authProvider"] == "password"
    assert payload["user"]["email"] == "user@example.com"
    assert payload["user"]["billingMode"] == "external_api_key"
    assert payload["user"]["hasApiKey"] is True
    assert "fox-secret-key" not in json.dumps(payload)
    assert "encrypted" not in json.dumps(payload).lower()


@pytest.mark.asyncio
async def test_refreshing_api_key_catalog_keeps_existing_compute_mode(monkeypatch):
    from routers import auth

    refresh = AsyncMock(return_value=3)
    refreshed_user = {**_external_user(), "foxapi_model_count": 16}
    monkeypatch.setattr(auth.foxapi_credentials, "refresh_api_key_catalog", refresh)
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=refreshed_user))

    payload = await auth.refresh_compute_api_key_catalog(_external_user())

    refresh.assert_awaited_once_with(_external_user()["id"])
    assert payload["user"]["billingMode"] == "external_api_key"
    assert payload["computeSource"]["model_count"] == 16


def test_connect_api_key_request_repr_masks_secret():
    from routers import auth

    body = auth.ConnectApiKeyRequest(
        api_key="fox-secret-key",
    )

    assert "fox-secret-key" not in repr(body)
    assert "**********" in repr(body)


@pytest.mark.asyncio
async def test_switching_compute_source_does_not_change_login_provider(monkeypatch):
    from routers import auth

    platform_user = {**_external_user(), "billing_mode": "platform_credits"}
    set_mode = AsyncMock()
    monkeypatch.setattr(auth.foxapi_credentials, "set_billing_mode", set_mode)
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=platform_user))

    payload = await auth.update_compute_source(
        auth.ComputeSourceRequest(mode="platform_credits"),
        _external_user(),
    )

    set_mode.assert_awaited_once_with(_external_user()["id"], "platform_credits")
    assert payload["user"]["authProvider"] == "password"
    assert payload["user"]["billingMode"] == "platform_credits"
    assert payload["user"]["hasApiKey"] is True


@pytest.mark.asyncio
async def test_disconnecting_api_key_returns_account_to_platform_credits(monkeypatch):
    from routers import auth

    disconnected_user = {
        **_external_user(),
        "billing_mode": "platform_credits",
        "key_fingerprint": None,
        "api_key_status": None,
        "foxapi_model_count": 0,
    }
    disconnect = AsyncMock()
    monkeypatch.setattr(auth.foxapi_credentials, "disconnect_api_key", disconnect)
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=disconnected_user))

    payload = await auth.disconnect_compute_api_key(_external_user())

    disconnect.assert_awaited_once_with(_external_user()["id"])
    assert payload["user"]["authProvider"] == "password"
    assert payload["user"]["billingMode"] == "platform_credits"
    assert payload["user"]["hasApiKey"] is False


@pytest.mark.asyncio
async def test_pet_preference_updates_account_payload(monkeypatch):
    from routers import auth

    updated_user = {
        **_external_user(),
        "pet_id": "xueying-wawa",
        "pet_custom_name": "Snow",
    }
    update = AsyncMock(return_value=updated_user)
    monkeypatch.setattr(auth.user_repo, "update_pet_preference", update)

    payload = await auth.update_pet_preference(
        auth.PetPreferenceRequest(pet_id="xueying-wawa", pet_custom_name=" Snow "),
        _external_user(),
    )

    update.assert_awaited_once_with(_external_user()["id"], "xueying-wawa", "Snow")
    assert payload["user"]["petId"] == "xueying-wawa"
    assert payload["user"]["petCustomName"] == "Snow"


@pytest.mark.asyncio
async def test_pet_preference_rejects_invalid_pet_id():
    from routers import auth

    with pytest.raises(HTTPException) as exc_info:
        await auth.update_pet_preference(
            auth.PetPreferenceRequest(pet_id="../bad", pet_custom_name="Bad"),
            _external_user(),
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_model_repository_uses_external_catalog_from_request_context(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    fox_models = [{"id": "foxapi:llm:gpt-5.6", "category": "llm"}]
    grok_models = [{"id": "grok:llm:grok-4.3", "category": "llm"}]
    fox_list = AsyncMock(return_value=fox_models)
    grok_list = AsyncMock(return_value=grok_models)
    monkeypatch.setattr(model_repo.foxapi_credentials, "list_runtime_models_for_user", fox_list)
    monkeypatch.setattr(model_repo.grok_credentials, "list_runtime_models_for_user", grok_list)
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value={"status": "active"}))
    monkeypatch.setattr(model_repo.grok_credentials, "get_runtime_credential", AsyncMock(return_value={"status": "active"}))
    monkeypatch.setattr(model_repo, "is_grok_enabled", AsyncMock(return_value=True))
    acquire = MagicMock()
    conn = AsyncMock()
    conn.fetch.return_value = [{"id": "platform-llm", "category": "llm"}]
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "external_api_key"):
        result = await model_repo.list_models(enabled_only=True, category="llm")

    assert result == fox_models + grok_models
    fox_list.assert_awaited_once_with("user-1", "llm")
    grok_list.assert_awaited_once_with("user-1", "llm")
    acquire.assert_called_once()


@pytest.mark.asyncio
async def test_model_list_reads_grok_availability_once_and_hides_every_video_model(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    availability = AsyncMock(return_value=False)
    fox_list = AsyncMock(return_value=[
        {"id": "foxapi:llm:gpt-5.6", "category": "llm"},
        {"id": "foxapi:video:wan", "category": "video"},
    ])
    monkeypatch.setattr(model_repo, "is_grok_enabled", availability)
    monkeypatch.setattr(model_repo.foxapi_credentials, "list_runtime_models_for_user", fox_list)
    monkeypatch.setattr(model_repo.grok_credentials, "list_runtime_models_for_user", AsyncMock(return_value=[]))
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value=None))
    monkeypatch.setattr(model_repo.grok_credentials, "get_runtime_credential", AsyncMock(return_value=None))
    acquire = MagicMock()
    conn = AsyncMock()
    conn.fetch.return_value = [
        {"id": "platform-llm", "category": "llm"},
        {"id": "platform-video", "category": "video", "provider": "other"},
        {"id": "grok-imagine-video-1.5", "category": "video", "provider": "Grok"},
    ]
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "external_api_key"):
        result = await model_repo.list_models(enabled_only=True)

    assert [model["id"] for model in result] == ["foxapi:llm:gpt-5.6", "platform-llm"]
    assert availability.await_count == 1


@pytest.mark.asyncio
async def test_runtime_video_details_are_hidden_when_grok_is_disabled(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    runtime_video = {"id": "foxapi:video:wan", "category": "video", "provider": "FoxAPI"}
    runtime_get = AsyncMock(return_value=runtime_video)
    monkeypatch.setattr(model_repo, "is_grok_enabled", AsyncMock(return_value=False))
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_model_for_user", runtime_get)

    with bind_user_context("user-1", "external_api_key"):
        assert await model_repo.get_model(runtime_video["id"]) is None
        assert await model_repo.get_model_internal(runtime_video["id"]) is None

    assert runtime_get.await_args_list == [
        (("user-1", runtime_video["id"]), {"internal": False}),
        (("user-1", runtime_video["id"]), {"internal": True}),
    ]


@pytest.mark.asyncio
async def test_key_mode_hides_credits_models_except_unconfigured_channel(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    fox_models = [{"id": "foxapi:llm:gpt-5.6", "category": "llm"}]
    grok_models = [{"id": "grok:llm:grok-4.3", "category": "llm"}]
    monkeypatch.setattr(model_repo.foxapi_credentials, "list_runtime_models_for_user", AsyncMock(return_value=fox_models))
    monkeypatch.setattr(model_repo.grok_credentials, "list_runtime_models_for_user", AsyncMock(return_value=[]))
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value={"status": "active"}))
    monkeypatch.setattr(model_repo.grok_credentials, "get_runtime_credential", AsyncMock(return_value=None))
    monkeypatch.setattr(model_repo, "is_grok_enabled", AsyncMock(return_value=True))
    acquire = MagicMock()
    conn = AsyncMock()
    conn.fetch.return_value = [
        {"id": "gpt-image-2", "category": "generate", "provider": "openai"},
        {"id": "grok-imagine-video-1.5", "category": "video", "provider": "Grok"},
    ]
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "external_api_key"):
        result = await model_repo.list_models(enabled_only=True)

    assert [model["id"] for model in result] == [
        "foxapi:llm:gpt-5.6",
        "grok-imagine-video-1.5",
    ]


@pytest.mark.asyncio
async def test_key_mode_hides_all_credits_models_when_both_channels_are_configured(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    fox_models = [{"id": "foxapi:llm:gpt-5.6", "category": "llm"}]
    grok_models = [{"id": "grok:video:grok-imagine-video-1.5", "category": "video"}]
    monkeypatch.setattr(model_repo.foxapi_credentials, "list_runtime_models_for_user", AsyncMock(return_value=fox_models))
    monkeypatch.setattr(model_repo.grok_credentials, "list_runtime_models_for_user", AsyncMock(return_value=grok_models))
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value={"status": "active"}))
    monkeypatch.setattr(model_repo.grok_credentials, "get_runtime_credential", AsyncMock(return_value={"status": "active"}))
    monkeypatch.setattr(model_repo, "is_grok_enabled", AsyncMock(return_value=True))
    acquire = MagicMock()
    conn = AsyncMock()
    conn.fetch.return_value = [
        {"id": "gpt-image-2", "category": "generate", "provider": "openai"},
        {"id": "grok-imagine-video-1.5", "category": "video", "provider": "Grok"},
    ]
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "external_api_key"):
        result = await model_repo.list_models(enabled_only=True)

    assert [model["id"] for model in result] == [
        "foxapi:llm:gpt-5.6",
        "grok:video:grok-imagine-video-1.5",
    ]


def test_compute_source_status_is_independent_for_both_credentials():
    from services import foxapi_credentials, grok_credentials

    user = {
        "billing_mode": "grok_api_key",
        "key_fingerprint": "f" * 64,
        "api_key_status": "active",
        "grok_key_fingerprint": "g" * 64,
        "grok_api_key_status": "active",
    }

    fox_source = foxapi_credentials.compute_source_from_user(user)
    grok_source = grok_credentials.compute_source_from_user(user)

    assert fox_source["active"] is True
    assert fox_source["billing_mode"] == "external_api_key"
    assert grok_source["active"] is True
    assert grok_source["billing_mode"] == "grok_api_key"


@pytest.mark.asyncio
async def test_model_runtime_routing_ignores_the_other_global_channel(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    fox_model = {"id": "foxapi:llm:gpt-5.6", "provider": "FoxAPI"}
    grok_model = {"id": "grok:llm:grok-4.3", "provider": "Grok"}
    fox_get = AsyncMock(return_value=fox_model)
    grok_get = AsyncMock(return_value=grok_model)
    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_model_for_user", fox_get)
    monkeypatch.setattr(model_repo.grok_credentials, "get_runtime_model_for_user", grok_get)
    monkeypatch.setattr(model_repo, "is_grok_enabled", AsyncMock(return_value=True))
    acquire = MagicMock()
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "grok_api_key"):
        assert await model_repo.get_model_internal("foxapi:llm:gpt-5.6") == fox_model
        assert await model_repo.get_model_internal("grok:llm:grok-4.3") == grok_model

    fox_get.assert_awaited_once_with("user-1", "foxapi:llm:gpt-5.6", internal=True)
    grok_get.assert_awaited_once_with("user-1", "grok:llm:grok-4.3", internal=True)
    acquire.assert_not_called()


@pytest.mark.asyncio
async def test_model_billing_treats_platform_fallback_as_credits_when_grok_is_preferred(monkeypatch):
    from core.user_context import bind_user_context
    from services import foxapi_credentials, grok_availability

    conn = AsyncMock()
    conn.fetchval.side_effect = ["active", "active"]
    acquire = MagicMock()
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(foxapi_credentials, "acquire", acquire)
    monkeypatch.setattr(grok_availability, "is_grok_enabled", AsyncMock(return_value=True))

    with bind_user_context("user-1", "grok_api_key"):
        assert await foxapi_credentials.uses_external_billing(
            "user-1", model_id="foxapi:llm:gpt-5.6"
        ) is True
        assert await foxapi_credentials.uses_external_billing(
            "user-1", model_id="grok:llm:grok-4.3"
        ) is True
        assert await foxapi_credentials.uses_external_billing(
            "user-1", model_id="platform-llm"
        ) is False


@pytest.mark.asyncio
async def test_platform_fallback_billing_keeps_model_id_through_settlement(monkeypatch):
    from core import credit_reserve
    from services import model_billing

    observed_models: list[str | None] = []

    async def uses_external(_user_id: str, *, model_id: str | None = None) -> bool:
        observed_models.append(model_id)
        return False

    claim = credit_reserve.ModelCallCreditClaim(
        user_id="user-1",
        reservation_task_id="model-call-task",
        operation_id="operation-1",
        amount=2,
        claim_key="claim-1",
    )
    consume = AsyncMock(return_value={"balance_after": 8, "transaction_id": "tx-1"})
    monkeypatch.setattr(model_billing.foxapi_credentials, "uses_external_billing", uses_external)
    monkeypatch.setattr(model_billing.model_repo, "get_model", AsyncMock(return_value={
        "id": "platform-llm",
        "category": "llm",
        "enabled": True,
        "price_type": "credits",
        "price_credits": 2,
    }))
    monkeypatch.setattr(model_billing.credit_reserve, "get_available_balance", AsyncMock(return_value=10))
    monkeypatch.setattr(model_billing.credit_reserve, "get_model_call_claim", AsyncMock(return_value=None))
    monkeypatch.setattr(model_billing.credit_repo, "get_consumption_by_idempotency_key", AsyncMock(return_value=None))
    monkeypatch.setattr(model_billing.credit_reserve, "claim_model_call_credits", AsyncMock(return_value=claim))
    monkeypatch.setattr(model_billing.credit_reserve, "mark_model_call_claim_ready", AsyncMock())
    monkeypatch.setattr(model_billing.credit_reserve, "settle_model_call_claim", AsyncMock())
    monkeypatch.setattr(model_billing.credit_repo, "consume_credits", consume)

    result = await model_billing.execute_billed_model_call(
        user_id="user-1",
        model_id="platform-llm",
        expected_category="llm",
        description="platform fallback",
        idempotency_key="operation-1",
        invoke=AsyncMock(return_value="ok"),
    )

    assert result == "ok"
    assert observed_models and all(model_id == "platform-llm" for model_id in observed_models)
    assert consume.await_args.kwargs["model_id"] == "platform-llm"


def test_public_user_payload_falls_back_when_external_key_is_stale():
    from routers import auth

    stale_user = {
        **_external_user(),
        "api_key_status": "invalid",
    }

    payload = auth._public_user_payload(stale_user)

    assert payload["billingMode"] == "platform_credits"


@pytest.mark.asyncio
async def test_model_repository_falls_back_to_platform_when_external_key_is_missing(monkeypatch):
    from core.user_context import bind_user_context
    from repositories import model_repo

    monkeypatch.setattr(model_repo.foxapi_credentials, "get_runtime_credential", AsyncMock(return_value=None))
    acquire = MagicMock()
    conn = AsyncMock()
    conn.fetchrow.return_value = {
        "id": "platform-image-model",
        "category": "generate",
        "enabled": True,
        "meta": {},
    }
    acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", acquire)

    with bind_user_context("user-1", "external_api_key"):
        result = await model_repo.get_model_internal("platform-image-model")

    assert result == {
        "id": "platform-image-model",
        "category": "generate",
        "enabled": True,
        "meta": {},
    }
    acquire.assert_called_once()


@pytest.mark.asyncio
async def test_worker_binds_queued_user_context_and_resets_it(monkeypatch):
    from core import worker
    from core.user_context import get_current_user_id

    observed: list[str | None] = []

    async def handler(_task_id: str, _payload: dict):
        observed.append(get_current_user_id())

    task_type = "test-foxapi-context"
    worker._handlers[task_type] = handler
    monkeypatch.setattr(worker, "ack_message", AsyncMock())
    monkeypatch.setattr(worker, "release_user_slot", AsyncMock())
    monkeypatch.setattr(worker.task_repo, "get", AsyncMock(return_value=None))
    monkeypatch.setattr(worker.foxapi_credentials, "get_billing_mode", AsyncMock(return_value="external_api_key"))

    try:
        await worker.Worker("test-worker")._process_message(
            "queue:test",
            "message-1",
            {
                "task_id": "task-1",
                "task_type": task_type,
                "user_id": "user-1",
                "payload": "{}",
                "retries": "0",
            },
        )
    finally:
        worker._handlers.pop(task_type, None)

    assert observed == ["user-1"]
    assert get_current_user_id() is None


@pytest.mark.asyncio
async def test_agent_base_keeps_external_runtime_model_id(monkeypatch):
    from services.agents import base

    call_chat = AsyncMock(return_value="ok")
    monkeypatch.setattr(base, "call_chat", call_chat)
    model = {
        "id": "foxapi:llm:gpt-5.6",
        "endpoint": "https://foxapi.cn/v1",
        "meta": {"model_name": "gpt-5.6"},
    }

    result = await base.call_llm_chat(
        system="system",
        user="user",
        model=model,
        max_tokens=500,
        temperature=0.2,
    )

    assert result == "ok"
    call_chat.assert_awaited_once_with(
        model_id="foxapi:llm:gpt-5.6",
        user="user",
        system="system",
        max_tokens=500,
        temperature=0.2,
    )


@pytest.mark.asyncio
async def test_nlp_parser_uses_context_routed_external_model(monkeypatch):
    from routers import nlp
    from core.user_context import bind_user_context

    choose_model = AsyncMock(return_value="foxapi:llm:gpt-5.6")
    parse_with_model = AsyncMock(return_value=json.dumps({
        "model_id": "image-edit",
        "params": {},
        "description": "ok",
        "confidence": 0.9,
    }))
    monkeypatch.setattr(nlp.provider_policy, "choose_llm_model_id", choose_model)
    monkeypatch.setattr(nlp, "_llm_parse_raw", parse_with_model)
    async def execute_billed(**kwargs):
        return await kwargs["invoke"]()
    monkeypatch.setattr(nlp, "execute_billed_model_call", execute_billed)
    body = nlp.NLPParseRequest(
        instruction="把背景换成夜景",
        layers=[nlp.LayerInfo(id="layer-1", name="背景", index=0)],
    )

    with bind_user_context(_external_user()["id"], "external_api_key"):
        result = await nlp.parse_instruction(body, _user=_external_user())

    assert result.ok is True
    choose_model.assert_awaited_once_with()
    parse_with_model.assert_awaited_once_with(
        body.instruction,
        body.layers,
        "foxapi:llm:gpt-5.6",
    )


@pytest.mark.asyncio
async def test_pet_ignores_platform_model_config_for_external_context(monkeypatch):
    from routers import pet

    monkeypatch.setattr(pet, "get_pet_config", AsyncMock(return_value={
        "enabled": True,
        "model_id": "platform-llm",
        "model_category": "llm",
        "system_prompt": "You are {pet_name}.",
        "max_tokens": 200,
        "temperature": 0.8,
    }))
    get_model = AsyncMock(return_value=None)
    list_models = AsyncMock(return_value=[{
        "id": "foxapi:llm:gpt-5.6",
        "category": "llm",
        "enabled": True,
    }])
    call_text = AsyncMock(return_value="你好")
    monkeypatch.setattr(pet.model_repo, "get_model", get_model)
    monkeypatch.setattr(pet.model_repo, "list_models", list_models)
    monkeypatch.setattr(pet, "call_text_messages", call_text)

    response = await pet._run_pet_chat(pet.ChatRequest(message="你好", pet_name="布布"))

    assert response.reply == "你好"
    assert response.model_id == "foxapi:llm:gpt-5.6"
    call_text.assert_awaited_once()
    assert call_text.await_args.kwargs["model_id"] == "foxapi:llm:gpt-5.6"
    assert call_text.await_args.kwargs["prefer_chat_completions"] is True


def test_external_user_cannot_fall_back_to_platform_only_image_tools():
    from routers import layer_edit, segmentation

    with pytest.raises(HTTPException) as segmentation_error:
        segmentation._require_segmentation_access(_external_user())
    with pytest.raises(HTTPException) as inpainting_error:
        layer_edit._require_platform_inpainting(_external_user())

    assert segmentation_error.value.status_code == 409
    assert inpainting_error.value.status_code == 409
