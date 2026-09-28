import asyncio
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.grok_availability import (
    GROK_DISABLED_MESSAGE,
    filter_models_for_grok_availability,
    filter_public_models,
    is_grok_model_row,
    reject_if_grok_disabled,
)


def test_is_grok_model_row_detects_grok_channel():
    assert is_grok_model_row({"id": "grok-4.3", "provider": "xai"})
    assert is_grok_model_row({"id": "grok-imagine-image-2.0"})
    assert is_grok_model_row({"id": "grok-imagine-video-1.5"})
    assert is_grok_model_row({"id": "custom", "meta": {"api_mode": "grok_chat"}})
    assert is_grok_model_row({"id": "custom", "billing_mode": "grok_api_key"})
    assert not is_grok_model_row({"id": "gpt-image-1", "provider": "openai"})
    assert not is_grok_model_row({"id": "flux-pro", "provider": "foxapi"})


def test_filter_public_models_hides_grok_when_disabled():
    models = [
        {"id": "gpt-image-1", "provider": "openai"},
        {"id": "foxapi:video:wan", "category": "video", "provider": "foxapi"},
        {"id": "grok-4.3", "provider": "xai"},
        {"id": "grok-imagine-video-1.5", "category": "video"},
    ]

    async def _run():
        with patch("services.grok_availability.is_grok_enabled", new=AsyncMock(return_value=False)):
            return await filter_public_models(models)

    assert [model["id"] for model in asyncio.run(_run())] == ["gpt-image-1"]


def test_filter_models_for_grok_availability_is_a_pure_filter():
    models = [
        {"id": "gpt-image-1", "provider": "openai"},
        {"id": "foxapi:video:wan", "category": "video", "provider": "foxapi"},
        {"id": "grok-4.3", "provider": "xai"},
    ]

    assert [model["id"] for model in filter_models_for_grok_availability(models, False)] == ["gpt-image-1"]
    assert filter_models_for_grok_availability(models, True) == models


def test_filter_public_models_keeps_grok_when_enabled():
    models = [
        {"id": "gpt-image-1", "provider": "openai"},
        {"id": "grok-4.3", "provider": "xai"},
    ]

    async def _run():
        with patch("services.grok_availability.is_grok_enabled", new=AsyncMock(return_value=True)):
            return await filter_public_models(models)

    assert [model["id"] for model in asyncio.run(_run())] == ["gpt-image-1", "grok-4.3"]


def test_reject_if_grok_disabled_raises_for_grok_models():
    async def _run():
        with patch("services.grok_availability.is_grok_enabled", new=AsyncMock(return_value=False)):
            with pytest.raises(HTTPException) as exc:
                await reject_if_grok_disabled({"id": "grok-4.3"})
            return exc.value

    error = asyncio.run(_run())
    assert error.status_code == 503
    assert error.detail == GROK_DISABLED_MESSAGE


def test_reject_if_grok_disabled_allows_other_models():
    async def _run():
        with patch("services.grok_availability.is_grok_enabled", new=AsyncMock(return_value=False)):
            await reject_if_grok_disabled({"id": "gpt-image-1", "provider": "openai"})

    asyncio.run(_run())
