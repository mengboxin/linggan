import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from routers import auth
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS


def _auth_acceptances():
    return [
        {
            "documentType": document_type,
            "version": CURRENT_LEGAL_DOCUMENTS[document_type].version,
            "contentHash": CURRENT_LEGAL_DOCUMENTS[document_type].content_hash,
        }
        for document_type in ("terms", "privacy")
    ]


def test_parse_registration_welcome_credits_defaults_to_30():
    assert auth._parse_registration_welcome_credits(None) == 30.0
    assert auth._parse_registration_welcome_credits("not-json") == 30.0
    assert auth._parse_registration_welcome_credits({"amount": -10}) == 0.0


def test_register_passes_configured_welcome_credits_to_create_user():
    async def _run():
        body = auth.RegisterRequest(
            email="new-user@example.com",
            code="123456",
            password="password123",
            confirm_password="password123",
            display_name="New User",
            legal_acceptances=_auth_acceptances(),
        )

        created_user = {
            "id": "user-1",
            "email": "new-user@example.com",
            "display_name": "New User",
            "role": "user",
            "status": "active",
            "credits": 18.5,
        }

        with patch("routers.auth._enforce_auth_rate_limit", new=AsyncMock()), patch(
            "routers.auth.user_repo.email_exists", new=AsyncMock(return_value=False)
        ), patch(
            "routers.auth.verify_otp", new=AsyncMock(return_value=True)
        ), patch(
            "routers.auth._get_registration_welcome_credits", new=AsyncMock(return_value=18.5)
        ), patch(
            "routers.auth.user_repo.create_user", new=AsyncMock(return_value=created_user)
        ) as create_user_mock, patch(
            "routers.auth.hash_password", return_value="hashed-password"
        ), patch(
            "routers.auth.create_access_token", return_value="access-token"
        ), patch(
            "routers.auth.create_refresh_token", return_value="refresh-token"
        ):
            response = await auth.register(body)

        assert response.user["credits"] == 18.5
        create_user_mock.assert_awaited_once()
        assert create_user_mock.await_args.kwargs["welcome_credits"] == 18.5

    asyncio.run(_run())


def test_register_rejects_missing_policy_acceptance():
    async def _run():
        body = auth.RegisterRequest(
            email="new-user@example.com",
            code="123456",
            password="password123",
            confirm_password="password123",
            display_name="New User",
        )

        with patch("routers.auth._enforce_auth_rate_limit", new=AsyncMock()):
            with pytest.raises(auth.HTTPException) as exc_info:
                await auth.register(body)

        assert exc_info.value.status_code == 400
        assert exc_info.value.detail == "请先阅读并同意服务条款和隐私政策"

    asyncio.run(_run())


def test_register_can_optionally_bind_key_without_creating_a_second_identity():
    async def _run():
        body = auth.RegisterRequest(
            email="key-user@example.com",
            code="123456",
            password="password123",
            confirm_password="password123",
            display_name="Key User",
            api_key="fox-secret-key",
            use_external_compute=True,
            legal_acceptances=_auth_acceptances(),
        )
        created_user = {
            "id": "11111111-1111-1111-1111-111111111111",
            "email": "key-user@example.com",
            "display_name": "Key User",
            "role": "user",
            "status": "active",
            "credits": 30,
            "auth_provider": "password",
            "billing_mode": "external_api_key",
            "key_fingerprint": "a" * 64,
            "api_key_status": "active",
            "foxapi_model_count": 3,
        }
        prepared = {
            "api_base": "https://foxapi.cn/v1",
            "encrypted_api_key": "encrypted",
            "key_fingerprint": "a" * 64,
            "model_catalog": [],
        }
        conn = AsyncMock()
        transaction = MagicMock()
        transaction.__aenter__ = AsyncMock(return_value=None)
        transaction.__aexit__ = AsyncMock(return_value=False)
        conn.transaction = MagicMock(return_value=transaction)
        acquire_context = MagicMock()
        acquire_context.__aenter__ = AsyncMock(return_value=conn)
        acquire_context.__aexit__ = AsyncMock(return_value=False)

        with patch("routers.auth._enforce_auth_rate_limit", new=AsyncMock()), patch(
            "routers.auth.user_repo.email_exists", new=AsyncMock(return_value=False)
        ), patch(
            "routers.auth.verify_otp", new=AsyncMock(return_value=True)
        ), patch(
            "routers.auth.foxapi_credentials.prepare_api_key", new=AsyncMock(return_value=prepared)
        ) as prepare_key, patch(
            "routers.auth.foxapi_credentials.store_prepared_credential", new=AsyncMock()
        ) as store_credential, patch(
            "routers.auth.user_repo.create_user", new=AsyncMock(return_value=created_user)
        ) as create_user, patch(
            "routers.auth.user_repo.get_by_id", new=AsyncMock(return_value=created_user)
        ), patch(
            "routers.auth._get_registration_welcome_credits", new=AsyncMock(return_value=30)
        ), patch(
            "routers.auth.acquire", return_value=acquire_context
        ), patch(
            "routers.auth.hash_password", return_value="hashed-password"
        ), patch(
            "routers.auth.create_access_token", return_value="access-token"
        ), patch(
            "routers.auth.create_refresh_token", return_value="refresh-token"
        ):
            response = await auth.register(body)

        prepare_key.assert_awaited_once_with("fox-secret-key")
        assert create_user.await_args.kwargs["conn"] is conn
        store_credential.assert_awaited_once_with(
            conn,
            created_user["id"],
            prepared,
            activate=True,
        )
        assert response.user["email"] == "key-user@example.com"
        assert response.user["authProvider"] == "password"
        assert response.user["billingMode"] == "external_api_key"

    asyncio.run(_run())


def test_password_login_rejects_missing_policy_acceptance():
    async def _run():
        body = auth.LoginPasswordRequest(
            email="user@example.com",
            password="password123",
        )

        with pytest.raises(auth.HTTPException) as exc_info:
            await auth.login_password(body)

        assert exc_info.value.status_code == 400
        assert exc_info.value.detail == "请先阅读并同意服务条款和隐私政策"

    asyncio.run(_run())
