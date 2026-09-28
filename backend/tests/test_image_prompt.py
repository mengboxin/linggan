import io
import importlib.util
from importlib.machinery import ModuleSpec
import sys
import types
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, UploadFile


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
    pydantic_networks.version = lambda name: "2.0.0" if name == "email-validator" else original_version(name)

    class EmailNotValidError(ValueError):
        pass

    def validate_email(value, *args, **kwargs):
        normalized = str(value)
        return types.SimpleNamespace(normalized=normalized, email=normalized)

    email_validator.EmailNotValidError = EmailNotValidError
    email_validator.validate_email = validate_email
    sys.modules["email_validator"] = email_validator


@pytest.mark.asyncio
async def test_image_prompt_analysis_uses_vision_model_and_charges_after_success(monkeypatch):
    from routers import image_prompt

    resolved_model = AsyncMock(return_value="vision-model")
    analyze = AsyncMock(return_value='''{
      "title": "窗边编辑摄影",
      "visual_summary": "自然侧光与留白。",
      "prompt": "窗边静物，暖白纸面，克制自然光",
      "negative_prompt": "商标，水印",
      "style_tags": ["静物", "编辑感"],
      "subject": "茶杯与花枝",
      "composition": "左侧主体，右侧留白",
      "lighting": "柔和侧光",
      "palette": ["暖白", "灰青"],
      "materials": "陶器与纸张",
      "camera": "中近景",
      "aspect_ratio": "4:5",
      "confidence": 93,
      "notes": ["文字留后期排版"]
    }''')
    async def execute_billed(**kwargs):
        return await kwargs["invoke"]()

    billed = AsyncMock(side_effect=execute_billed)
    persist = AsyncMock(return_value=("conversation-1", "message-1", {
        "asset_id": "asset-1",
        "image_url": "/api/assets/asset-1/original",
    }))
    monkeypatch.setattr(image_prompt.provider_policy, "choose_vision_model_id", resolved_model)
    monkeypatch.setattr(image_prompt, "call_vision", analyze)
    monkeypatch.setattr(image_prompt, "execute_billed_model_call", billed)
    monkeypatch.setattr(image_prompt, "_persist_analysis_history", persist)
    monkeypatch.setattr(image_prompt.asset_storage, "prepare_image_asset_payload", AsyncMock(side_effect=lambda value, _user_id: value))

    response = await image_prompt.analyze_image_prompt(
        image=UploadFile(filename="reference.png", file=io.BytesIO(b"png-bytes"), headers={"content-type": "image/png"}),
        model_id="selected-model",
        mode="recreate",
        client_request_id="request-1",
        user={"id": "user-1"},
    )

    assert response.analysis.title == "窗边编辑摄影"
    assert response.analysis.aspect_ratio == "4:5"
    assert response.analysis.style_tags == ["静物", "编辑感"]
    assert response.conversation_id == "conversation-1"
    assert response.message_id == "message-1"
    assert response.history_saved is True
    resolved_model.assert_awaited_once_with("selected-model")
    assert analyze.await_args.kwargs["model_id"] == "vision-model"
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args.kwargs["model_id"] == "vision-model"
    assert billed.await_args.kwargs["expected_category"] == "vision"
    assert billed.await_args.kwargs["related_task_id"] is None
    assert billed.await_args.kwargs["idempotency_key"].startswith("model:image-prompt:")
    persist.assert_awaited_once()
    assert persist.await_args.kwargs["client_request_id"] == "request-1"


@pytest.mark.asyncio
async def test_image_prompt_billing_key_binds_image_model_and_analysis_request(monkeypatch):
    from routers import image_prompt

    monkeypatch.setattr(
        image_prompt.provider_policy,
        "choose_vision_model_id",
        AsyncMock(side_effect=lambda model_id: model_id),
    )
    monkeypatch.setattr(image_prompt, "call_vision", AsyncMock(return_value="{}"))

    async def execute_billed(**kwargs):
        return await kwargs["invoke"]()

    billed = AsyncMock(side_effect=execute_billed)
    monkeypatch.setattr(image_prompt, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        image_prompt,
        "_persist_analysis_history",
        AsyncMock(return_value=("", "", {})),
    )
    monkeypatch.setattr(
        image_prompt.asset_storage,
        "prepare_image_asset_payload",
        AsyncMock(side_effect=lambda value, _user_id: value),
    )

    async def run(image_bytes: bytes, model_id: str = "vision-model"):
        return await image_prompt.analyze_image_prompt(
            image=UploadFile(
                filename="reference.png",
                file=io.BytesIO(image_bytes),
                headers={"content-type": "image/png"},
            ),
            model_id=model_id,
            mode="recreate",
            client_request_id="same-request",
            user={"id": "user-1"},
        )

    await run(b"private-image-one")
    await run(b"private-image-one")
    await run(b"private-image-two")
    await run(b"private-image-one", model_id="vision-model-2")

    keys = [call.kwargs["idempotency_key"] for call in billed.await_args_list]
    assert keys[0] == keys[1]
    assert len({keys[0], keys[2], keys[3]}) == 3
    assert all(key.startswith("model:image-prompt:") for key in keys)
    assert all(len(key) < 120 and "private-image" not in key for key in keys)


@pytest.mark.asyncio
async def test_image_prompt_rejects_non_image_upload():
    from routers import image_prompt

    with pytest.raises(HTTPException) as exc_info:
        await image_prompt.analyze_image_prompt(
            image=UploadFile(filename="notes.txt", file=io.BytesIO(b"no"), headers={"content-type": "text/plain"}),
            user={"id": "user-1"},
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_image_prompt_history_restores_source_analysis_and_latest_result(monkeypatch):
    from routers import image_prompt

    monkeypatch.setattr(image_prompt.conversation_repo, "list_conversations", AsyncMock(return_value=[{
        "id": "conversation-1",
        "title": "窗边编辑摄影",
        "created_at": "2026-08-10T10:00:00+00:00",
        "updated_at": "2026-08-10T10:04:00+00:00",
    }]))
    monkeypatch.setattr(image_prompt.conversation_repo, "list_messages_for_conversations", AsyncMock(return_value={
        "conversation-1": [
            {
                "created_at": "2026-08-10T10:00:00+00:00",
                "meta": {
                    "type": "image_prompt_analysis",
                    "mode": "recreate",
                    "vision_model_id": "vision-model",
                    "analysis": {"title": "窗边编辑摄影", "prompt": "窗边静物"},
                    "asset_id": "source-asset",
                    "image_url": "/api/assets/source-asset/original",
                    "thumbnail_url": "/api/assets/source-asset/thumb",
                },
            },
            {
                "created_at": "2026-08-10T10:01:00+00:00",
                "meta": {
                    "type": "image_request",
                    "task_id": "task-1",
                    "source": "image_prompt_recreate",
                    "user_prompt": "用户编辑后的玻璃花房复现提示词",
                },
            },
            {
                "created_at": "2026-08-10T10:04:00+00:00",
                "meta": {
                    "type": "image_result",
                    "status": "completed",
                    "task_id": "task-1",
                    "asset_id": "result-asset",
                    "image_url": "/api/assets/result-asset/original",
                },
            },
            {
                "created_at": "2026-08-10T10:05:00+00:00",
                "meta": {
                    "type": "image_prompt_recipe",
                    "recipe_id": "personal-recipe-1",
                    "recipe_name": "窗边编辑摄影",
                },
            },
        ],
    }))
    monkeypatch.setattr(image_prompt.asset_storage, "prepare_image_asset_payload", AsyncMock(side_effect=lambda value, _user_id: value))

    response = await image_prompt.list_image_prompt_history(limit=30, user={"id": "user-1"})

    assert response["items"][0]["analysis"]["prompt"] == "用户编辑后的玻璃花房复现提示词"
    assert response["items"][0]["source_asset_id"] == "source-asset"
    assert response["items"][0]["result_asset_id"] == "result-asset"
    assert response["items"][0]["result_status"] == "completed"
    assert response["items"][0]["recipe_id"] == "personal-recipe-1"
    assert response["items"][0]["recipe_saved"] is True


@pytest.mark.asyncio
async def test_recipe_confirmation_reads_original_analysis_from_owned_history(monkeypatch):
    from routers import image_prompt

    messages = [{
        "meta": {
            "type": "image_prompt_analysis",
            "asset_id": "fdeddffd-7c88-4352-9684-bc8041fee261",
            "preview_url": "/api/assets/fdeddffd-7c88-4352-9684-bc8041fee261/preview?expires=soon&signature=temporary",
            "analysis": {
                "title": "冷光古典人像",
                "visual_summary": "低饱和冷色肖像。",
                "style_tags": ["古典", "冷光"],
                "composition": "半身侧身肖像",
                "lighting": "窗边冷光",
                "palette": ["深蓝", "银灰"],
                "materials": "丝绸与金属",
                "camera": "85mm 人像镜头",
                "negative_prompt": "文字，水印",
            },
        },
    }]
    get_messages = AsyncMock(return_value=messages)
    create_recipe = AsyncMock(return_value=({
        "id": "personal-1", "name": "我的冷光配方", "is_personal": True,
    }, True))
    add_message = AsyncMock(return_value={"id": "message-recipe"})
    monkeypatch.setattr(image_prompt.conversation_repo, "conversation_belongs_to_user_of_type", AsyncMock(return_value=True))
    monkeypatch.setattr(image_prompt.conversation_repo, "get_conversation_messages", get_messages)
    monkeypatch.setattr(image_prompt.creative_style_repo, "create_personal_style_recipe_idempotent", create_recipe)
    monkeypatch.setattr(image_prompt.conversation_repo, "add_message", add_message)
    monkeypatch.setattr(image_prompt, "_verify_analysis_provenance", lambda **_kwargs: True)

    response = await image_prompt.confirm_image_prompt_recipe(
        conversation_id="conversation-1",
        body=image_prompt.ImagePromptRecipeCreateBody(name="我的冷光配方"),
        user={"id": "user-1"},
    )

    assert response == {
        "item": {"id": "personal-1", "name": "我的冷光配方", "is_personal": True},
        "created": True,
        "duplicate": False,
    }
    get_messages.assert_awaited_once_with("conversation-1", "user-1", light=False)
    submitted = create_recipe.await_args.kwargs["analysis"]
    assert submitted["name"] == "我的冷光配方"
    assert submitted["composition"] == "半身侧身肖像"
    assert submitted["preview_url"] == "/api/assets/fdeddffd-7c88-4352-9684-bc8041fee261/preview"
    assert submitted["source_name"] == "灵感反推"
    assert "prompt" not in submitted
    assert add_message.await_args.kwargs["meta"]["history_key"] == "image-prompt-recipe:conversation-1"


@pytest.mark.asyncio
async def test_recipe_confirmation_rejects_non_image_prompt_conversation(monkeypatch):
    from routers import image_prompt

    monkeypatch.setattr(image_prompt.conversation_repo, "conversation_belongs_to_user_of_type", AsyncMock(return_value=True))
    monkeypatch.setattr(image_prompt.conversation_repo, "get_conversation_messages", AsyncMock(return_value=[]))

    with pytest.raises(HTTPException) as caught:
        await image_prompt.confirm_image_prompt_recipe(
            conversation_id="conversation-1",
            body=image_prompt.ImagePromptRecipeCreateBody(name="配方"),
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 404


@pytest.mark.asyncio
async def test_recipe_confirmation_rejects_analysis_without_server_provenance(monkeypatch):
    from routers import image_prompt

    monkeypatch.setattr(
        image_prompt.conversation_repo,
        "conversation_belongs_to_user_of_type",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        image_prompt.conversation_repo,
        "get_conversation_messages",
        AsyncMock(return_value=[{
            "meta": {
                "type": "image_prompt_analysis",
                "client_request_id": "forged",
                "analysis": {"title": "伪造配方", "visual_summary": "伪造"},
            },
        }]),
    )

    with pytest.raises(HTTPException) as caught:
        await image_prompt.confirm_image_prompt_recipe(
            conversation_id="conversation-1",
            body=image_prompt.ImagePromptRecipeCreateBody(name="伪造配方"),
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 409


def test_image_prompt_analysis_provenance_is_bound_to_user_conversation_and_analysis():
    from routers import image_prompt

    analysis = {"title": "玻璃花房", "prompt": "暖光花房"}
    signature = image_prompt._create_analysis_provenance(
        user_id="user-1",
        conversation_id="conversation-1",
        client_request_id="request-1",
        analysis=analysis,
        secret="unit-test-secret",
    )

    assert image_prompt._verify_analysis_provenance(
        user_id="user-1",
        conversation_id="conversation-1",
        client_request_id="request-1",
        analysis=analysis,
        signature=signature,
        secret="unit-test-secret",
    ) is True
    assert image_prompt._verify_analysis_provenance(
        user_id="user-2",
        conversation_id="conversation-1",
        client_request_id="request-1",
        analysis=analysis,
        signature=signature,
        secret="unit-test-secret",
    ) is False


@pytest.mark.asyncio
async def test_generic_conversation_api_rejects_reserved_image_prompt_metadata():
    from routers import conversation_router

    with pytest.raises(HTTPException) as caught:
        await conversation_router.add_conversation_message(
            conversation_id="conversation-1",
            req=conversation_router.AddMessageRequest(
                role="assistant",
                content="伪造分析",
                meta={"type": "image_prompt_analysis", "analysis": {"title": "fake"}},
            ),
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 400
    assert "保留" in str(caught.value.detail)

    with pytest.raises(HTTPException) as history_key_error:
        await conversation_router.add_conversation_message(
            conversation_id="conversation-1",
            req=conversation_router.AddMessageRequest(
                role="assistant",
                content="尝试覆盖服务端消息",
                meta={"type": "note", "history_key": "image-prompt-analysis:request-1"},
            ),
            user={"id": "user-1"},
        )
    assert history_key_error.value.status_code == 400
