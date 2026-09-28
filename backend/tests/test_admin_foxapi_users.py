import json
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_admin_user_list_exposes_foxapi_monitoring_without_credentials(monkeypatch):
    from routers import admin

    monkeypatch.setattr(admin.user_repo, "list_all", AsyncMock(return_value=[{
        "id": "user-1",
        "email": "user@example.com",
        "display_name": "普通账号用户",
        "role": "user",
        "status": "active",
        "created_at": "2026-07-13T00:00:00+00:00",
        "auth_provider": "password",
        "billing_mode": "external_api_key",
        "key_fingerprint": "abcdef1234567890",
        "api_key_status": "active",
        "foxapi_model_count": 13,
        "request_count": 42,
        "failed_count": 2,
        "last_used_at": "2026-07-13T01:00:00+00:00",
        "last_verified_at": "2026-07-13T00:00:00+00:00",
        "last_model_id": "gpt-image-2",
        "last_error": None,
    }]))
    conn = AsyncMock()
    conn.fetch.side_effect = [
        [{"user_id": "user-1", "cnt": 7}],
        [{"user_id": "user-1", "calls": 42, "failed": 2}],
        [{
            "user_id": "user-1",
            "model_id": "gpt-image-2",
            "model_category": "generate",
            "error_message": None,
            "created_at": "2026-07-13T01:00:00+00:00",
        }],
    ]
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=conn)
    context.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(admin, "acquire", MagicMock(return_value=context))

    result = await admin.list_users(True)
    payload = [item.model_dump() for item in result]
    serialized = json.dumps(payload)

    assert payload[0]["auth_provider"] == "password"
    assert payload[0]["billing_mode"] == "external_api_key"
    assert payload[0]["key_fingerprint"] == "567890"
    assert payload[0]["request_count"] == 42
    assert payload[0]["failed_count"] == 2
    assert payload[0]["last_model_id"] == "gpt-image-2"
    assert payload[0]["last_call_category"] == "generate"
    assert payload[0]["grok_key_fingerprint"] is None
    assert payload[0]["grok_model_count"] == 0
    assert "encrypted_api_key" not in serialized
    assert "api_key" not in payload[0]
