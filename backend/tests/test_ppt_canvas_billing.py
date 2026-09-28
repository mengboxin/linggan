import base64
import importlib.util
from importlib.machinery import ModuleSpec
import sys
import types
from unittest.mock import AsyncMock, MagicMock

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

        def generate(self, _text):
            return b""

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
    pydantic_networks.version = (
        lambda name: "2.0.0" if name == "email-validator" else original_version(name)
    )

    class EmailNotValidError(ValueError):
        pass

    def validate_email(value, *args, **kwargs):
        normalized = str(value)
        return types.SimpleNamespace(normalized=normalized, email=normalized)

    email_validator.EmailNotValidError = EmailNotValidError
    email_validator.validate_email = validate_email
    sys.modules["email_validator"] = email_validator

@pytest.mark.asyncio
async def test_same_slide_version_uses_input_sensitive_canvas_billing_keys(monkeypatch):
    from routers import ppt_canvas

    slide = {
        "job_id": "job-001",
        "index": 0,
        "elements": [{"id": "elem-icon-1", "type": "icon"}],
        "background": {"kind": "solid", "value": "#fff"},
        "version": 7,
    }
    user = {"id": "user-ppt-canvas-001"}
    billed = AsyncMock(return_value=b"rendered")
    monkeypatch.setattr(ppt_canvas, "execute_platform_provider_call", billed)
    monkeypatch.setattr(ppt_canvas, "get_slide", AsyncMock(return_value=slide))
    monkeypatch.setattr(ppt_canvas, "update_element", AsyncMock(return_value=8))
    monkeypatch.setattr(ppt_canvas, "rate_limit", AsyncMock())
    monkeypatch.setattr(
        ppt_canvas,
        "_get_inpainting_router",
        lambda: MagicMock(inpaint=AsyncMock(return_value=b"rendered")),
    )

    image_one = base64.b64encode(b"private-image-one").decode()
    image_two = base64.b64encode(b"private-image-two").decode()
    mask_one = base64.b64encode(b"private-mask-one").decode()
    mask_two = base64.b64encode(b"private-mask-two").decode()

    async def run(*, prompt: str, image: str = image_one, mask: str = mask_one):
        await ppt_canvas.update_slide_element(
            job_id="job-001",
            index=0,
            element_id="elem-icon-1",
            body=ppt_canvas.ElementPatchRequest(
                patch={},
                use_inpainting=True,
                inpainting_mode="replace",
                inpainting_prompt=prompt,
                inpainting_image_base64=image,
                inpainting_mask_base64=mask,
            ),
            user=user,
        )

    await run(prompt="replace with a red icon")
    await run(prompt="replace with a red icon")
    await run(prompt="replace with a blue icon")
    await run(prompt="replace with a red icon", image=image_two)
    await run(prompt="replace with a red icon", mask=mask_two)

    keys = [call.kwargs["idempotency_key"] for call in billed.await_args_list]
    assert keys[0] == keys[1]
    assert len({keys[0], keys[2], keys[3], keys[4]}) == 4
    assert all(key.startswith("model:ppt-canvas:") for key in keys)
    assert all(len(key) < 120 for key in keys)
    assert all("private-image" not in key and "replace with" not in key for key in keys)
