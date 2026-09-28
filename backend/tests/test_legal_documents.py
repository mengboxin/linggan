from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from routers import auth, legal
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS, CURRENT_LEGAL_VERSION
from services.legal_documents import current_required_legal_fingerprint


def _claim(document_type: str) -> dict:
    document = CURRENT_LEGAL_DOCUMENTS[document_type]
    return {
        "documentType": document_type,
        "version": document.version,
        "contentHash": document.content_hash,
    }


def test_registry_has_four_hashed_immutable_current_documents():
    assert set(CURRENT_LEGAL_DOCUMENTS) == {"terms", "privacy", "ai", "payment"}
    for document in CURRENT_LEGAL_DOCUMENTS.values():
        assert document.version == CURRENT_LEGAL_VERSION == "2026.08.13"
        assert len(document.content_hash) == 64
        assert document.content_markdown.startswith("# ")


def test_old_auth_clients_cannot_map_boolean_acceptance_to_new_content():
    with pytest.raises(HTTPException) as error:
        auth._resolve_policy_acceptances(True, True)
    assert error.value.status_code == 426
    assert error.value.detail["code"] == "LEGAL_CLIENT_UPGRADE_REQUIRED"


def test_versioned_auth_acceptance_requires_terms_and_privacy():
    body = auth.AuthLegalAcceptance(**_claim("terms"))
    with pytest.raises(HTTPException) as error:
        auth._resolve_policy_acceptances(False, False, [body])
    assert error.value.status_code == 400


def test_versioned_auth_acceptance_rejects_content_hash_mismatch():
    claim = _claim("terms")
    claim["contentHash"] = "0" * 64
    with pytest.raises(HTTPException) as error:
        auth._resolve_policy_acceptances(
            False,
            False,
            [
                auth.AuthLegalAcceptance(**claim),
                auth.AuthLegalAcceptance(**_claim("privacy")),
            ],
        )
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "LEGAL_DOCUMENT_OUTDATED"


def test_legal_acceptance_endpoint_claim_resolver_rejects_duplicates():
    claim = legal.LegalAcceptanceClaim(**_claim("terms"))
    with pytest.raises(HTTPException) as error:
        legal.resolve_acceptance_claims([claim, claim])
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_successful_login_records_current_acceptance(monkeypatch):
    user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "person@example.com",
        "password_hash": "hash",
        "display_name": "Person",
        "role": "user",
        "status": "active",
        "credits": 5,
    }
    record = AsyncMock()
    monkeypatch.setattr(auth, "_enforce_auth_rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "_get_fail_count", AsyncMock(return_value=0))
    monkeypatch.setattr(auth, "_clear_fail", AsyncMock())
    monkeypatch.setattr(auth.user_repo, "get_by_email", AsyncMock(return_value=user))
    monkeypatch.setattr(auth.user_repo, "update_last_active", AsyncMock())
    monkeypatch.setattr(auth.legal_repo, "record_acceptances", record)
    monkeypatch.setattr(auth, "verify_password", lambda password, hashed: True)
    monkeypatch.setattr(auth, "create_access_token", lambda *args: "access")
    monkeypatch.setattr(auth, "create_refresh_token", lambda *args: "refresh")

    await auth.login_password(
        auth.LoginPasswordRequest(
            email=user["email"],
            password="password123",
            legal_acceptances=[_claim("terms"), _claim("privacy")],
        )
    )

    record.assert_awaited_once()
    assert record.await_args.args[0] == user["id"]
    assert {document.document_type for document in record.await_args.args[1]} == {
        "terms",
        "privacy",
    }
    assert record.await_args.kwargs["source"] == "login-password"


@pytest.mark.asyncio
async def test_password_login_succeeds_when_acceptance_audit_is_temporarily_unavailable(monkeypatch):
    user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "person@example.com",
        "password_hash": "hash",
        "display_name": "Person",
        "role": "user",
        "status": "active",
        "credits": 5,
    }
    access_claims = []
    monkeypatch.setattr(auth, "_enforce_auth_rate_limit", AsyncMock())
    monkeypatch.setattr(auth, "_get_fail_count", AsyncMock(return_value=0))
    monkeypatch.setattr(auth, "_clear_fail", AsyncMock())
    monkeypatch.setattr(auth.user_repo, "get_by_email", AsyncMock(return_value=user))
    monkeypatch.setattr(auth.user_repo, "update_last_active", AsyncMock())
    monkeypatch.setattr(auth.legal_repo, "record_acceptances", AsyncMock(side_effect=RuntimeError("db busy")))
    monkeypatch.setattr(auth, "verify_password", lambda *_args: True)
    monkeypatch.setattr(auth, "create_access_token", lambda *args: access_claims.append(args) or "access")
    monkeypatch.setattr(auth, "create_refresh_token", lambda *args: "refresh")

    response = await auth.login_password(auth.LoginPasswordRequest(
        email=user["email"],
        password="password123",
        legal_acceptances=[_claim("terms"), _claim("privacy")],
    ))

    assert response.access_token == "access"
    assert access_claims[0][-1] == current_required_legal_fingerprint()


@pytest.mark.asyncio
async def test_refresh_requires_reconsent_for_an_old_session(monkeypatch):
    user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "person@example.com",
        "role": "user",
        "status": "active",
    }
    monkeypatch.setattr(auth, "decode_token", lambda _: {"sub": user["id"], "type": "refresh"})
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=user))
    monkeypatch.setattr(auth.legal_repo, "has_current_required_acceptances", AsyncMock(return_value=False))

    with pytest.raises(HTTPException) as error:
        await auth.refresh(auth.RefreshRequest(refresh_token="old"))
    assert error.value.status_code == 428
    assert error.value.detail["code"] == "LEGAL_RECONSENT_REQUIRED"


@pytest.mark.asyncio
async def test_refresh_skips_database_check_for_current_legal_claim(monkeypatch):
    user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "person@example.com",
        "role": "user",
        "status": "active",
    }
    lookup = AsyncMock(return_value=False)
    monkeypatch.setattr(auth, "decode_token", lambda _: {
        "sub": user["id"],
        "type": "refresh",
        "legal": current_required_legal_fingerprint(),
    })
    monkeypatch.setattr(auth.user_repo, "get_by_id", AsyncMock(return_value=user))
    monkeypatch.setattr(auth.legal_repo, "has_current_required_acceptances", lookup)
    monkeypatch.setattr(auth, "create_access_token", lambda *args: "access")
    monkeypatch.setattr(auth, "create_refresh_token", lambda *args: "refresh")

    response = await auth.refresh(auth.RefreshRequest(refresh_token="current"))
    assert response.access_token == "access"
    lookup.assert_not_awaited()


@pytest.mark.asyncio
async def test_legal_acceptance_endpoint_can_bypass_gate_and_returns_fresh_tokens(monkeypatch):
    user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "email": "person@example.com",
        "display_name": "Person",
        "role": "user",
        "status": "active",
        "credits": 5,
    }
    monkeypatch.setattr(legal, "_client_evidence", lambda _request: ("127.0.0.1", "pytest"))
    monkeypatch.setattr(legal.legal_repo, "record_acceptances", AsyncMock(return_value=["a", "b"]))
    monkeypatch.setattr(legal.legal_repo, "get_acceptance_status", AsyncMock(return_value=[
        {**CURRENT_LEGAL_DOCUMENTS["terms"].public_payload(), "accepted": True},
        {**CURRENT_LEGAL_DOCUMENTS["privacy"].public_payload(), "accepted": True},
    ]))
    monkeypatch.setattr(legal, "_make_token_response", lambda *_args, **_kwargs: auth.TokenResponse(
        access_token="fresh-access",
        refresh_token="fresh-refresh",
        user={"id": user["id"]},
    ))

    response = await legal.accept_legal_documents(
        legal.LegalAcceptanceRequest(items=[
            legal.LegalAcceptanceClaim(**_claim("terms")),
            legal.LegalAcceptanceClaim(**_claim("privacy")),
        ]),
        request=None,
        user=user,
    )

    assert response["allRequiredAccepted"] is True
    assert response["access_token"] == "fresh-access"
    assert response["refresh_token"] == "fresh-refresh"
