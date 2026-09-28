from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from routers import auth
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS


def _password_body(**overrides):
    values = {
        "email": "person@example.com",
        "password": "wrong-password",
        "legal_acceptances": [
            {
                "documentType": document_type,
                "version": CURRENT_LEGAL_DOCUMENTS[document_type].version,
                "contentHash": CURRENT_LEGAL_DOCUMENTS[document_type].content_hash,
            }
            for document_type in ("terms", "privacy")
        ],
    }
    values.update(overrides)
    return auth.LoginPasswordRequest(**values)


@pytest.mark.asyncio
async def test_first_password_failure_requires_captcha_for_next_attempt(monkeypatch):
    monkeypatch.setattr(auth, "_enforce_auth_rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "_get_fail_count", AsyncMock(return_value=0))
    increment = AsyncMock()
    monkeypatch.setattr(auth, "_incr_fail", increment)
    monkeypatch.setattr(auth.user_repo, "get_by_email", AsyncMock(return_value=None))

    with pytest.raises(HTTPException) as error:
        await auth.login_password(_password_body())

    assert error.value.status_code == 401
    assert error.value.detail["require_captcha"] is True
    increment.assert_awaited_once_with("person@example.com")


@pytest.mark.asyncio
async def test_captcha_is_required_before_password_lookup_after_failure(monkeypatch):
    monkeypatch.setattr(auth, "_enforce_auth_rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "_get_fail_count", AsyncMock(return_value=1))
    lookup = AsyncMock()
    monkeypatch.setattr(auth.user_repo, "get_by_email", lookup)

    with pytest.raises(HTTPException) as error:
        await auth.login_password(_password_body())

    assert error.value.status_code == 400
    lookup.assert_not_awaited()


def test_forwarded_ip_is_only_used_when_request_is_from_local_proxy():
    class Client:
        host = "203.0.113.8"

    class Request:
        client = Client()
        headers = {"x-real-ip": "198.51.100.4"}

    assert auth._request_ip(Request()) == "203.0.113.8"


def test_local_proxy_ip_uses_real_client_header():
    class Client:
        host = "127.0.0.1"

    class Request:
        client = Client()
        headers = {"x-real-ip": "198.51.100.4"}

    assert auth._request_ip(Request()) == "198.51.100.4"
