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


async def _invoke_billed_call(**kwargs):
    return await kwargs["invoke"]()


@pytest.mark.asyncio
async def test_legacy_unreviewed_personal_recipe_endpoint_is_closed():
    from fastapi import HTTPException
    from routers import creative_styles

    with pytest.raises(HTTPException) as caught:
        await creative_styles.create_personal_creative_style_recipe(_user={"id": "user-1"})

    assert caught.value.status_code == 410


@pytest.mark.asyncio
async def test_style_catalog_includes_only_the_current_users_personal_recipes(monkeypatch):
    from routers import creative_styles

    platform = AsyncMock(return_value=[{"id": "platform-recipe"}])
    personal = AsyncMock(return_value=[{"id": "personal-recipe", "is_personal": True}])
    monkeypatch.setattr(creative_styles.creative_style_repo, "list_style_presets", platform)
    monkeypatch.setattr(creative_styles.creative_style_repo, "list_personal_style_recipes", personal)
    monkeypatch.setattr(
        creative_styles.creative_style_repo,
        "deduplicate_style_catalog",
        lambda items: items,
    )

    response = await creative_styles.list_creative_styles(
        module="TEXT_TO_IMAGE",
        gallery_only=True,
        user={"id": "user-1"},
    )

    assert response["items"] == [{"id": "platform-recipe"}, {"id": "personal-recipe", "is_personal": True}]
    personal.assert_awaited_once_with(user_id="user-1", module="TEXT_TO_IMAGE")


@pytest.mark.asyncio
async def test_skill_import_inspection_closes_upload_and_charges_only_after_model_review(monkeypatch):
    from fastapi import UploadFile
    import io

    from routers import creative_styles
    from services import creative_skill_import

    upload = UploadFile(
        filename="cinema.zip",
        file=io.BytesIO(b"zip-data"),
        headers={"content-type": "application/zip"},
    )
    package = creative_skill_import.InspectedSkillPackage(
        source_name="cinema.zip",
        files=(creative_skill_import.SkillTextFile("SKILL.md", "文生图 构图 光线 镜头", 32),),
    )
    review = creative_skill_import.SkillCandidateReview(
        candidate={
            "name": "电影叙事配方", "visual_summary": "电影视觉", "style_tags": ["电影感"],
            "composition": "前中后景", "lighting": "单一窗光", "palette": ["灰蓝"],
            "materials": "旧木", "camera": "50mm", "negative_prompt": "水印",
            "execution_instructions": "执行电影叙事规则", "source_name": "cinema.zip",
            "source_url": "", "preview_url": "",
        },
        confidence=0.93,
        checks=({"id": "image-generation", "label": "确认为生图相关模板", "passed": True},),
    )
    monkeypatch.setattr(creative_styles, "_enforce_skill_import_rate_limit", AsyncMock())
    monkeypatch.setattr(creative_styles.provider_policy, "choose_llm_model_id", AsyncMock(return_value="llm-1"))
    billed = AsyncMock(side_effect=_invoke_billed_call)
    monkeypatch.setattr(creative_styles, "execute_billed_model_call", billed)
    monkeypatch.setattr(creative_styles.creative_skill_import, "inspect_archive_bytes", lambda *_args, **_kwargs: package)
    monkeypatch.setattr(creative_styles.creative_skill_import, "extract_image_style_candidate", AsyncMock(return_value=review))
    monkeypatch.setattr(creative_styles.creative_skill_import, "create_review_token", lambda **_kwargs: "review-token-1")

    response = await creative_styles.inspect_creative_skill_import(
        archive=upload,
        github_url="",
        user={"id": "user-1"},
    )

    assert response == {
        "accepted": True,
        "candidate": review.candidate,
        "review": {
            "category": "image_generation",
            "confidence": 0.93,
            "checks": list(review.checks),
            "warnings": [],
        },
        "cleanup": {"temporary_upload_deleted": True},
        "review_token": "review-token-1",
    }
    assert upload.file.closed is True
    billing = billed.await_args.kwargs
    assert billing["user_id"] == "user-1"
    assert billing["model_id"] == "llm-1"
    assert billing["expected_category"] == "llm"
    assert billing["description"] == "导入生图灵感配方"
    assert billing["idempotency_key"].startswith("skill-import-")


@pytest.mark.asyncio
async def test_skill_import_non_image_error_has_stable_product_message(monkeypatch):
    from fastapi import HTTPException
    from routers import creative_styles
    from services import creative_skill_import

    monkeypatch.setattr(creative_styles, "_enforce_skill_import_rate_limit", AsyncMock())
    monkeypatch.setattr(
        creative_styles.creative_skill_import,
        "download_github_archive",
        AsyncMock(return_value=creative_skill_import.GithubArchive(b"zip", "owner/repo", "https://github.com/owner/repo")),
    )
    monkeypatch.setattr(
        creative_styles.creative_skill_import,
        "inspect_archive_bytes",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(creative_skill_import.NoImageGenerationSkill()),
    )

    with pytest.raises(HTTPException) as caught:
        await creative_styles.inspect_creative_skill_import(
            archive=None,
            github_url="https://github.com/owner/repo",
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 422
    assert caught.value.detail == "未解析到生图相关的风格模板，上传内容已清理"


@pytest.mark.asyncio
async def test_invalid_dual_import_source_still_closes_uploaded_spool():
    from fastapi import HTTPException, UploadFile
    import io

    from routers import creative_styles

    upload = UploadFile(
        filename="skill.zip",
        file=io.BytesIO(b"zip"),
        headers={"content-type": "application/zip"},
    )
    with pytest.raises(HTTPException) as caught:
        await creative_styles.inspect_creative_skill_import(
            archive=upload,
            github_url="https://github.com/owner/repo",
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 400
    assert upload.file.closed is True


@pytest.mark.asyncio
async def test_model_transport_failure_releases_reserved_credits_without_charging(monkeypatch):
    from fastapi import HTTPException, UploadFile
    import io

    from routers import creative_styles
    from services import creative_skill_import

    upload = UploadFile(
        filename="cinema.zip",
        file=io.BytesIO(b"zip-data"),
        headers={"content-type": "application/zip"},
    )
    package = creative_skill_import.InspectedSkillPackage(
        source_name="cinema.zip",
        files=(creative_skill_import.SkillTextFile("SKILL.md", "文生图 构图 光线 镜头", 32),),
    )
    billed = AsyncMock(side_effect=_invoke_billed_call)
    monkeypatch.setattr(creative_styles, "_enforce_skill_import_rate_limit", AsyncMock())
    monkeypatch.setattr(creative_styles.provider_policy, "choose_llm_model_id", AsyncMock(return_value="llm-1"))
    monkeypatch.setattr(creative_styles, "execute_billed_model_call", billed)
    monkeypatch.setattr(creative_styles.creative_skill_import, "inspect_archive_bytes", lambda *_args, **_kwargs: package)
    monkeypatch.setattr(creative_styles.creative_skill_import, "require_image_generation_signals", lambda _package: None)
    monkeypatch.setattr(
        creative_styles.creative_skill_import,
        "extract_image_style_candidate",
        AsyncMock(side_effect=RuntimeError("upstream disconnected")),
    )

    with pytest.raises(HTTPException) as caught:
        await creative_styles.inspect_creative_skill_import(
            archive=upload,
            github_url="",
            user={"id": "user-1"},
    )

    assert caught.value.status_code == 502
    assert billed.await_args.kwargs["idempotency_key"].startswith("skill-import-")


@pytest.mark.asyncio
async def test_semantic_rejection_charges_review_once_and_releases_reservation(monkeypatch):
    from fastapi import HTTPException, UploadFile
    import io

    from routers import creative_styles
    from services import creative_skill_import

    upload = UploadFile(
        filename="borderline.zip",
        file=io.BytesIO(b"zip-data"),
        headers={"content-type": "application/zip"},
    )
    package = creative_skill_import.InspectedSkillPackage(
        source_name="borderline.zip",
        files=(creative_skill_import.SkillTextFile("SKILL.md", "文生图 构图 光线 镜头", 32),),
    )
    billed = AsyncMock(side_effect=_invoke_billed_call)
    monkeypatch.setattr(creative_styles, "_enforce_skill_import_rate_limit", AsyncMock())
    monkeypatch.setattr(creative_styles.provider_policy, "choose_llm_model_id", AsyncMock(return_value="llm-1"))
    monkeypatch.setattr(creative_styles, "execute_billed_model_call", billed)
    monkeypatch.setattr(creative_styles.creative_skill_import, "inspect_archive_bytes", lambda *_args, **_kwargs: package)
    monkeypatch.setattr(creative_styles.creative_skill_import, "require_image_generation_signals", lambda _package: None)
    monkeypatch.setattr(
        creative_styles.creative_skill_import,
        "extract_image_style_candidate",
        AsyncMock(side_effect=creative_skill_import.NoImageGenerationSkill()),
    )

    with pytest.raises(HTTPException) as caught:
        await creative_styles.inspect_creative_skill_import(
            archive=upload,
            github_url="",
            user={"id": "user-1"},
        )

    assert caught.value.status_code == 422
    assert billed.await_count == 1
    assert billed.await_args.kwargs["idempotency_key"].startswith("skill-import-")


@pytest.mark.asyncio
async def test_skill_import_rate_limit_fails_closed_when_redis_is_unavailable(monkeypatch):
    from core import rate_limit as rate_limit_module

    monkeypatch.setattr(rate_limit_module, "get_redis", lambda: (_ for _ in ()).throw(ConnectionError("redis down")))

    with pytest.raises(rate_limit_module.RateLimitUnavailable):
        await rate_limit_module.rate_limit(
            "user-1",
            "skill-import",
            limit=4,
            window=60,
            fail_closed=True,
        )
@pytest.mark.asyncio
async def test_confirm_import_accepts_only_user_bound_review_token(monkeypatch):
    from routers import creative_styles

    candidate = {
        "name": "电影叙事配方", "visual_summary": "电影视觉", "style_tags": ["电影感"],
        "composition": "前中后景", "lighting": "单一窗光", "palette": ["灰蓝"],
        "materials": "旧木", "camera": "50mm", "negative_prompt": "水印",
        "execution_instructions": "视觉方向：电影视觉", "source_name": "owner/repo",
        "source_url": "https://github.com/owner/repo", "preview_url": "",
    }
    verify = lambda token, **kwargs: candidate
    create = AsyncMock(return_value=({"id": "personal-1", "name": "我的电影配方"}, True))
    monkeypatch.setattr(creative_styles.creative_skill_import, "verify_review_token", verify)
    monkeypatch.setattr(creative_styles.creative_style_repo, "create_personal_style_recipe_idempotent", create)

    response = await creative_styles.confirm_creative_skill_import(
        body=creative_styles.CreativeSkillImportConfirmBody(
            review_token="signed-review-token-that-is-long-enough-for-validation",
            name="我的电影配方",
        ),
        user={"id": "user-1"},
    )

    assert response["created"] is True
    submitted = create.await_args.kwargs["analysis"]
    assert submitted["name"] == "我的电影配方"
    assert submitted["source_url"] == "https://github.com/owner/repo"


@pytest.mark.asyncio
async def test_multipart_zip_reaches_inspector_with_starlette_upload_file(monkeypatch):
    import httpx
    from fastapi import FastAPI

    from routers import creative_styles
    from services import creative_skill_import

    package = creative_skill_import.InspectedSkillPackage(
        source_name="cinema.zip",
        files=(creative_skill_import.SkillTextFile("SKILL.md", "文生图 构图 光线 镜头", 32),),
    )
    review = creative_skill_import.SkillCandidateReview(
        candidate={
            "name": "电影配方", "visual_summary": "电影视觉", "style_tags": ["电影感"],
            "composition": "前中后景", "lighting": "窗光", "palette": ["灰蓝"],
            "materials": "旧木", "camera": "50mm", "negative_prompt": "水印",
            "execution_instructions": "视觉方向：电影视觉", "source_name": "cinema.zip",
            "source_url": "", "preview_url": "",
        },
        confidence=0.9,
        checks=(),
    )
    inspect = MagicMock(return_value=package)
    monkeypatch.setattr(creative_styles, "_enforce_skill_import_rate_limit", AsyncMock())
    monkeypatch.setattr(creative_styles.provider_policy, "choose_llm_model_id", AsyncMock(return_value="llm-1"))
    monkeypatch.setattr(
        creative_styles,
        "execute_billed_model_call",
        AsyncMock(side_effect=_invoke_billed_call),
    )
    monkeypatch.setattr(creative_styles.creative_skill_import, "inspect_archive_bytes", inspect)
    monkeypatch.setattr(creative_styles.creative_skill_import, "require_image_generation_signals", lambda _package: None)
    monkeypatch.setattr(creative_styles.creative_skill_import, "extract_image_style_candidate", AsyncMock(return_value=review))
    monkeypatch.setattr(creative_styles.creative_skill_import, "create_review_token", lambda **_kwargs: "signed-token")

    app = FastAPI()
    app.include_router(creative_styles.router)
    app.dependency_overrides[creative_styles.get_current_user] = lambda: {"id": "user-1"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/creative-styles/import/inspect",
            files={"archive": ("cinema.zip", b"actual-multipart-bytes", "application/zip")},
        )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert inspect.call_args.args[0] == b"actual-multipart-bytes"
