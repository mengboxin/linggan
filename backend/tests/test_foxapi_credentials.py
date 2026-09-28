import base64
import json
from unittest.mock import AsyncMock, MagicMock

import pytest


def _catalog():
    return [
        {
            "id": "gpt-5.6",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.6 (Sol)",
        },
        {
            "id": "gpt-5.6-sol",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.6 Sol",
        },
        {
            "id": "gpt-5.6-terra",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.6 Terra",
        },
        {
            "id": "gpt-5.6-luna",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.6 Luna",
        },
        {
            "id": "gpt-5.5",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.5",
        },
        {
            "id": "gpt-5.4",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.4",
        },
        {
            "id": "gpt-5.4-mini",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.4 Mini",
        },
        {
            "id": "gpt-5.3-codex-spark",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.3 Codex Spark",
        },
        {
            "id": "codex-auto-review",
            "object": "model",
            "owned_by": "openai",
            "display_name": "Codex Auto Review",
        },
        {
            "id": "gpt-5.2",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT-5.2",
        },
        {
            "id": "gpt-image-1",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT Image 1",
        },
        {
            "id": "gpt-image-1.5",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT Image 1.5",
        },
        {
            "id": "gpt-image-2",
            "object": "model",
            "owned_by": "openai",
            "display_name": "GPT Image 2",
        },
    ]


def test_runtime_catalog_splits_text_vision_and_image_models():
    from services.foxapi_credentials import build_runtime_models

    public_models = build_runtime_models(
        _catalog(),
        api_base="https://foxapi.cn/v1",
        key_fingerprint="a" * 64,
    )

    llm_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "llm"]
    vision_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "vision"]
    image_ids = [model["meta"]["model_name"] for model in public_models if model["category"] == "generate"]

    assert llm_ids == ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini"]
    assert vision_ids == llm_ids
    assert image_ids == ["gpt-image-2"]
    assert {model["meta"]["model_name"] for model in public_models}.isdisjoint({
        "gpt-5.6",
        "gpt-5.3-codex-spark",
        "codex-auto-review",
        "gpt-5.2",
        "gpt-image-1",
        "gpt-image-1.5",
    })
    assert {model["meta"]["model_name"] for model in public_models if model["is_featured"]} == {
        "gpt-5.5",
        "gpt-image-2",
    }
    assert all(model["billing_mode"] == "external_api_key" for model in public_models)
    assert all(model["price_credits"] == 0 for model in public_models)
    assert all("api_key" not in model for model in public_models)


def test_runtime_catalog_recognizes_configured_non_gpt_image_models():
    from services.foxapi_credentials import build_runtime_models

    public_models = build_runtime_models(
        [
            {
                "id": "grok-imagine-image-2.0",
                "object": "model",
                "owned_by": "xai",
                "display_name": "Grok Imagine Image",
            },
            {
                "id": "gpt-5.5",
                "object": "model",
                "owned_by": "openai",
                "display_name": "GPT-5.5",
            },
        ],
        api_base="https://foxapi.cn/v1",
        key_fingerprint="a" * 64,
    )

    assert [model["meta"]["model_name"] for model in public_models if model["category"] == "generate"] == [
        "grok-imagine-image-2.0",
    ]


def test_runtime_catalog_internal_model_contains_only_requested_secret():
    from services.foxapi_credentials import build_runtime_model

    model = build_runtime_model(
        _catalog(),
        runtime_model_id="foxapi:generate:gpt-image-2",
        api_base="https://foxapi.cn/v1",
        key_fingerprint="b" * 64,
        api_key="fox-secret",
        user_id="user-1",
    )

    assert model is not None
    assert model["category"] == "generate"
    assert model["api_key"] == "fox-secret"
    assert model["meta"]["model_name"] == "gpt-image-2"
    assert model["meta"]["api_mode"] == "responses"
    assert model["meta"]["responses_model"] == "gpt-image-2"
    assert model["meta"]["use_openai_responses_image_generation"] is True
    assert model["credential_user_id"] == "user-1"


def test_runtime_catalog_rejects_filtered_model_ids():
    from services.foxapi_credentials import build_runtime_model

    model = build_runtime_model(
        _catalog(),
        runtime_model_id="foxapi:llm:gpt-5.6",
        api_base="https://foxapi.cn/v1",
        key_fingerprint="b" * 64,
        api_key="fox-secret",
        user_id="user-1",
    )

    assert model is None


@pytest.mark.asyncio
async def test_public_catalog_does_not_request_decrypted_secret(monkeypatch):
    from services import foxapi_credentials

    get_credential = AsyncMock(return_value={
        "api_base": "https://foxapi.cn/v1",
        "key_fingerprint": "a" * 64,
        "model_catalog": _catalog(),
        "status": "active",
    })
    monkeypatch.setattr(foxapi_credentials, "get_runtime_credential", get_credential)

    models = await foxapi_credentials.list_runtime_models_for_user("user-1", "llm")

    get_credential.assert_awaited_once_with("user-1", include_secret=False)
    assert models
    assert all("api_key" not in model for model in models)


def test_api_key_encryption_is_stable_and_never_plaintext(monkeypatch):
    from services import foxapi_credentials

    monkeypatch.setattr(foxapi_credentials.settings, "SECRET_KEY", "test-secret-key")
    monkeypatch.setattr(foxapi_credentials.settings, "FOXAPI_CREDENTIAL_ENCRYPTION_KEY", "")

    encrypted = foxapi_credentials.encrypt_api_key("fox-secret")

    assert encrypted != "fox-secret"
    assert "fox-secret" not in encrypted
    assert foxapi_credentials.decrypt_api_key(encrypted) == "fox-secret"
    assert foxapi_credentials.api_key_fingerprint("fox-secret") == foxapi_credentials.api_key_fingerprint("fox-secret")


def test_credential_errors_are_redacted_before_admin_storage():
    from services import foxapi_credentials

    message = foxapi_credentials.redact_credential_error(
        '401 Authorization: Bearer fox-secret api_key="fox-secret"',
        "fox-secret",
    )

    assert "fox-secret" not in message
    assert message.count("[REDACTED]") >= 2


@pytest.mark.asyncio
async def test_validate_api_key_returns_sanitized_catalog(monkeypatch):
    from services import foxapi_credentials

    response = MagicMock()
    response.status_code = 200
    response.is_success = True
    response.json.return_value = {"object": "list", "data": _catalog()}
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.get = AsyncMock(return_value=response)
    monkeypatch.setattr(foxapi_credentials.httpx, "AsyncClient", MagicMock(return_value=client))

    catalog = await foxapi_credentials.validate_api_key("fox-secret")

    assert [item["id"] for item in catalog] == [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-image-2",
    ]
    assert client.get.await_args.args[0] == "https://foxapi.cn/v1/models"
    assert client.get.await_args.kwargs["headers"] == {"Authorization": "Bearer fox-secret"}
    assert all("api_key" not in item for item in catalog)


@pytest.mark.asyncio
async def test_validate_api_key_rejects_unauthorized_key(monkeypatch):
    from services import foxapi_credentials

    response = MagicMock()
    response.status_code = 401
    response.is_success = False
    response.text = '{"error":"invalid_api_key"}'
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.get = AsyncMock(return_value=response)
    monkeypatch.setattr(foxapi_credentials.httpx, "AsyncClient", MagicMock(return_value=client))

    with pytest.raises(foxapi_credentials.InvalidFoxApiKey):
        await foxapi_credentials.validate_api_key("bad-key")


def test_runtime_catalog_keeps_selected_gpt_image_variant_and_astra():
    from services.foxapi_credentials import build_runtime_models

    models = build_runtime_models(
        [
            {"id": "gpt-6-astra", "display_name": "GPT-6 Astra"},
            {"id": "gpt-image-2.5-flare", "display_name": "GPT Image 2.5 Flare"},
            {"id": "gpt-image-2.5-sunburst", "display_name": "GPT Image 2.5 Sunburst"},
        ],
        api_base="https://foxapi.cn/v1",
        key_fingerprint="a" * 64,
    )

    assert [model["meta"]["model_name"] for model in models if model["category"] == "llm"] == ["gpt-6-astra"]
    assert [model["meta"]["model_name"] for model in models if model["category"] == "vision"] == ["gpt-6-astra"]
    image_models = [model for model in models if model["category"] == "generate"]
    assert [model["meta"]["model_name"] for model in image_models] == [
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst",
    ]
    assert [model["meta"]["responses_model"] for model in image_models] == [
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst",
    ]


@pytest.mark.asyncio
async def test_refresh_api_key_catalog_keeps_billing_mode_and_existing_endpoint(monkeypatch):
    from services import foxapi_credentials

    credential = {
        "api_base": "https://custom.foxapi.example/v1",
        "api_key": "fox-secret",
        "key_fingerprint": "c" * 64,
        "model_catalog": [],
        "status": "active",
    }
    catalog = [{"id": "gpt-image-2.5-flare", "display_name": "GPT Image 2.5 Flare"}]
    get_credential = AsyncMock(return_value=credential)
    validate = AsyncMock(return_value=catalog)
    conn = AsyncMock()
    conn.execute.return_value = "UPDATE 1"
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=conn)
    context.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(foxapi_credentials, "get_runtime_credential", get_credential)
    monkeypatch.setattr(foxapi_credentials, "validate_api_key", validate)
    monkeypatch.setattr(foxapi_credentials, "acquire", MagicMock(return_value=context))

    refreshed = await foxapi_credentials.refresh_api_key_catalog("user-1")

    assert refreshed == 1
    get_credential.assert_awaited_once_with("user-1", include_secret=True)
    validate.assert_awaited_once_with("fox-secret", api_base="https://custom.foxapi.example/v1")
    sql, user_id, provider, stored_catalog, fingerprint = conn.execute.await_args.args
    assert "UPDATE user_api_credentials" in sql
    assert user_id == "user-1"
    assert provider == "foxapi"
    assert json.loads(stored_catalog) == catalog
    assert fingerprint == "c" * 64


def test_generated_fernet_key_has_expected_length(monkeypatch):
    from services import foxapi_credentials

    monkeypatch.setattr(foxapi_credentials.settings, "SECRET_KEY", "another-secret")
    monkeypatch.setattr(foxapi_credentials.settings, "FOXAPI_CREDENTIAL_ENCRYPTION_KEY", "")
    raw = base64.urlsafe_b64decode(foxapi_credentials._fernet_key())
    assert len(raw) == 32


@pytest.mark.asyncio
async def test_record_usage_keeps_key_active_for_billing_403(monkeypatch):
    from services import foxapi_credentials

    conn = AsyncMock()
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=conn)
    context.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(foxapi_credentials, "acquire", MagicMock(return_value=context))

    await foxapi_credentials.record_usage(
        "11111111-1111-1111-1111-111111111111",
        "gpt-image-2",
        success=False,
        error='Responses image_generation failed (403): {"error":{"message":"insufficient balance","type":"billing_error"}}',
        api_key="fox-secret",
    )

    execute_args = conn.execute.await_args.args
    assert execute_args[5] is False
    assert "fox-secret" not in execute_args[4]


@pytest.mark.asyncio
async def test_store_prepared_credential_rejects_key_owned_by_another_account():
    from services import foxapi_credentials

    conn = AsyncMock()
    conn.fetchval.return_value = "other-user"
    prepared = {
        "api_base": "https://foxapi.cn/v1",
        "encrypted_api_key": "encrypted",
        "key_fingerprint": "a" * 64,
        "model_catalog": _catalog(),
    }

    with pytest.raises(foxapi_credentials.FoxApiCredentialConflict):
        await foxapi_credentials.store_prepared_credential(
            conn,
            "current-user",
            prepared,
            activate=True,
        )

    executed_sql = [str(call.args[0]) for call in conn.execute.await_args_list]
    assert any("pg_advisory_xact_lock" in sql for sql in executed_sql)
    assert not any("INSERT INTO user_api_credentials" in sql for sql in executed_sql)


@pytest.mark.asyncio
async def test_store_prepared_credential_upserts_key_without_changing_account_identity():
    from services import foxapi_credentials

    conn = AsyncMock()
    conn.fetchrow.return_value = None
    prepared = {
        "api_base": "https://foxapi.cn/v1",
        "encrypted_api_key": "encrypted",
        "key_fingerprint": "b" * 64,
        "model_catalog": _catalog(),
    }

    await foxapi_credentials.store_prepared_credential(
        conn,
        "current-user",
        prepared,
        activate=True,
    )

    executed_sql = [str(call.args[0]) for call in conn.execute.await_args_list]
    assert any("INSERT INTO user_api_credentials" in sql for sql in executed_sql)
    assert any("UPDATE users SET billing_mode" in sql for sql in executed_sql)
    assert not any("INSERT INTO users" in sql for sql in executed_sql)
