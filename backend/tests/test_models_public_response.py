import asyncio
from unittest.mock import AsyncMock, patch

from routers import models


def test_public_model_list_never_serializes_runtime_configuration():
    async def _run():
        configured_model = {
            "id": "image-model",
            "name": "Image model",
            "category": "generate",
            "enabled": True,
            "provider": "provider-name",
            "price_credits": 4,
            "billing_mode": "platform_credits",
            "endpoint": "https://private.example.invalid/v1",
            "api_key": "not-for-browser",
            "meta": {
                "responses_endpoint": "https://private.example.invalid/responses",
                "external_api_key": "not-for-browser",
            },
        }
        with patch.object(models.model_repo, "list_models", new=AsyncMock(return_value=[configured_model])):
            payload = await models.list_models(category="generate", _user=None)

        assert payload == [{
            "id": "image-model",
            "name": "Image model",
            "category": "generate",
            "enabled": True,
            "provider": "provider-name",
            "price_credits": 4,
            "billing_mode": "platform_credits",
        }]

    asyncio.run(_run())


def test_public_model_detail_never_serializes_runtime_configuration():
    async def _run():
        configured_model = {
            "id": "vision-model",
            "name": "Vision model",
            "category": "vision",
            "enabled": True,
            "endpoint": "https://private.example.invalid/v1",
            "meta": {"token": "not-for-browser"},
        }
        with patch.object(models.model_repo, "get_model", new=AsyncMock(return_value=configured_model)):
            payload = await models.get_model("vision-model", _user=None)

        assert payload == {
            "id": "vision-model",
            "name": "Vision model",
            "category": "vision",
            "enabled": True,
        }

    asyncio.run(_run())
