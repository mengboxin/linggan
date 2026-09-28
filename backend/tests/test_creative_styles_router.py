import importlib.util
from importlib.machinery import ModuleSpec
import sys
import types
from unittest.mock import AsyncMock

import pytest


if importlib.util.find_spec("redis") is None:
    redis_package = types.ModuleType("redis")
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_package.__spec__ = ModuleSpec("redis", loader=None)
    redis_asyncio.__spec__ = ModuleSpec("redis.asyncio", loader=None)
    redis_asyncio.Redis = object
    redis_asyncio.from_url = AsyncMock()
    redis_package.asyncio = redis_asyncio
    sys.modules["redis"] = redis_package
    sys.modules["redis.asyncio"] = redis_asyncio

if importlib.util.find_spec("aiosmtplib") is None:
    aiosmtplib = types.ModuleType("aiosmtplib")
    aiosmtplib.__spec__ = ModuleSpec("aiosmtplib", loader=None)
    aiosmtplib.SMTP = object
    sys.modules["aiosmtplib"] = aiosmtplib

if importlib.util.find_spec("captcha") is None:
    class _ImageCaptcha:
        def __init__(self, *args, **kwargs):
            pass

    captcha_package = types.ModuleType("captcha")
    captcha_image = types.ModuleType("captcha.image")
    captcha_package.__spec__ = ModuleSpec("captcha", loader=None)
    captcha_image.__spec__ = ModuleSpec("captcha.image", loader=None)
    captcha_image.ImageCaptcha = _ImageCaptcha
    captcha_package.image = captcha_image
    sys.modules["captcha"] = captcha_package
    sys.modules["captcha.image"] = captcha_image

if importlib.util.find_spec("email_validator") is None:
    email_validator = types.ModuleType("email_validator")
    email_validator.__spec__ = ModuleSpec("email_validator", loader=None)
    import pydantic.networks as pydantic_networks

    original_version = pydantic_networks.version
    pydantic_networks.version = lambda name: "2.0.0" if name == "email-validator" else original_version(name)
    email_validator.EmailNotValidError = ValueError
    email_validator.validate_email = lambda value, *_args, **_kwargs: types.SimpleNamespace(
        normalized=str(value), email=str(value)
    )
    sys.modules["email_validator"] = email_validator

from routers import creative_styles


@pytest.mark.asyncio
async def test_public_creative_styles_forwards_gallery_filter(monkeypatch):
    captured = {}

    async def list_style_presets(**kwargs):
        captured.update(kwargs)
        return [{"id": "style-1"}]

    monkeypatch.setattr(creative_styles.creative_style_repo, "list_style_presets", list_style_presets)
    monkeypatch.setattr(
        creative_styles.creative_style_repo,
        "list_personal_style_recipes",
        AsyncMock(return_value=[]),
    )

    response = await creative_styles.list_creative_styles(
        module="TEXT_TO_IMAGE",
        gallery_only=True,
        user={"id": "user-1"},
    )

    assert response == {"items": [{"id": "style-1"}]}
    assert captured == {
        "module": "TEXT_TO_IMAGE",
        "enabled_only": True,
        "gallery_only": True,
    }
