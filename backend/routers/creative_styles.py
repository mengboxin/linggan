"""面向已登录用户的风格配方目录。"""
from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from repositories import creative_style_repo
from routers.auth import get_current_user
from services import creative_skill_import, provider_policy
from services.model_billing import execute_billed_model_call

router = APIRouter(prefix="/api/creative-styles", tags=["创作风格"])
logger = logging.getLogger(__name__)


class CreativeSkillImportConfirmBody(BaseModel):
    review_token: str = Field(min_length=40, max_length=100_000)
    name: str = Field(default="", max_length=80)


@router.post("/mine", status_code=410)
async def create_personal_creative_style_recipe(
    _user: dict = Depends(get_current_user),
):
    raise HTTPException(410, "该保存入口已停用，请通过提示词反推确认或配方包审核后保存")


def _import_error_status(exc: creative_skill_import.SkillImportError) -> int:
    if isinstance(exc, creative_skill_import.NoImageGenerationSkill):
        return 422
    if "超过" in str(exc) or "不能超过" in str(exc):
        return 413
    return 400


async def _enforce_skill_import_rate_limit(user_id: str) -> None:
    from core.rate_limit import RateLimitExceeded, RateLimitUnavailable, rate_limit

    try:
        await rate_limit(user_id, "skill-import", limit=4, window=60, fail_closed=True)
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)}) from exc
    except RateLimitUnavailable as exc:
        raise HTTPException(503, "配方审核限流服务暂不可用，请稍后重试") from exc


@router.post("/import/inspect")
async def inspect_creative_skill_import(
    archive: UploadFile | None = File(default=None),
    github_url: str = Form(default=""),
    user: dict = Depends(get_current_user),
):
    """Inspect one ZIP or public GitHub repository without persisting its package."""
    actual_archive = archive if hasattr(archive, "read") and hasattr(archive, "filename") else None
    actual_github_url = github_url.strip() if isinstance(github_url, str) else ""
    source_url = ""
    source_name = ""
    archive_bytes = b""
    try:
        if bool(actual_archive) == bool(actual_github_url):
            raise HTTPException(400, "请上传一个 ZIP 配方包，或填写一个 GitHub 仓库地址")
        await _enforce_skill_import_rate_limit(str(user["id"]))
        if actual_archive:
            content_type = str(actual_archive.content_type or "").lower()
            filename = str(actual_archive.filename or "skill.zip")
            if not filename.casefold().endswith(".zip") or content_type not in {
                "application/zip", "application/x-zip-compressed", "application/octet-stream", "",
            }:
                raise creative_skill_import.SkillImportInputError("请上传 ZIP 格式的配方包")
            archive_bytes = await actual_archive.read(creative_skill_import.MAX_ARCHIVE_BYTES + 1)
            source_name = filename
        else:
            github_archive = await creative_skill_import.download_github_archive(actual_github_url)
            archive_bytes = github_archive.archive_bytes
            source_name = github_archive.source_name
            source_url = github_archive.source_url

        package = creative_skill_import.inspect_archive_bytes(
            archive_bytes,
            source_name=source_name,
        )
        # A deterministic gate rejects obvious non-image packages before any
        # paid model call. The model performs the semantic review after it.
        creative_skill_import.require_image_generation_signals(package)
        model_id = await provider_policy.choose_llm_model_id()
        if not model_id:
            raise HTTPException(503, "暂未配置可用的文本模型，无法审核灵感配方")
        operation_id = f"skill-import-{uuid4()}"
        semantic_rejection: creative_skill_import.NoImageGenerationSkill | None = None

        async def invoke_review():
            nonlocal semantic_rejection
            try:
                return await creative_skill_import.extract_image_style_candidate(
                    package,
                    model_id=model_id,
                    source_url=source_url,
                )
            except creative_skill_import.NoImageGenerationSkill as exc:
                # The model call succeeded and returned a semantic rejection.
                # It is still one successful, billable review.
                semantic_rejection = exc
                return None

        try:
            review = await execute_billed_model_call(
                user_id=str(user["id"]),
                model_id=model_id,
                expected_category="llm",
                description="导入生图灵感配方",
                idempotency_key=operation_id,
                invoke=invoke_review,
            )
            if semantic_rejection is not None:
                raise semantic_rejection
        except Exception as exc:
            if isinstance(exc, (HTTPException, creative_skill_import.NoImageGenerationSkill)):
                raise
            raise HTTPException(502, "配方审核失败，请稍后重试") from exc
        assert review is not None
        try:
            review_token = creative_skill_import.create_review_token(
                user_id=str(user["id"]),
                candidate=review.candidate,
            )
        except RuntimeError as exc:
            raise HTTPException(503, "服务器暂时无法签发配方审核凭证") from exc
        return {
            "accepted": True,
            "candidate": review.candidate,
            "review": {
                "category": "image_generation",
                "confidence": review.confidence,
                "checks": list(review.checks),
                "warnings": list(review.warnings),
            },
            "cleanup": {"temporary_upload_deleted": True},
            "review_token": review_token,
        }
    except HTTPException:
        raise
    except creative_skill_import.NoImageGenerationSkill as exc:
        raise HTTPException(422, "未解析到生图相关的风格模板，上传内容已清理") from exc
    except creative_skill_import.SkillImportError as exc:
        raise HTTPException(_import_error_status(exc), str(exc)) from exc
    finally:
        # UploadFile may be backed by a spooled temporary file. Closing it in
        # every outcome deletes that file; the in-memory archive is discarded.
        archive_bytes = b""
        if actual_archive:
            try:
                await actual_archive.close()
            except Exception as exc:
                logger.error("failed to close skill import upload: %s", exc)


@router.post("/import/confirm", status_code=201)
async def confirm_creative_skill_import(
    body: CreativeSkillImportConfirmBody,
    user: dict = Depends(get_current_user),
):
    try:
        candidate = creative_skill_import.verify_review_token(
            body.review_token,
            user_id=str(user["id"]),
        )
    except creative_skill_import.SkillReviewTokenError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.name.strip():
        candidate["name"] = body.name.strip()
    try:
        item, created = await creative_style_repo.create_personal_style_recipe_idempotent(
            user_id=str(user["id"]),
            analysis=candidate,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"item": item, "created": created, "duplicate": not created}


@router.get("")
async def list_creative_styles(
    module: str = Query(default=""),
    gallery_only: bool = Query(default=False),
    user: dict = Depends(get_current_user),
):
    try:
        platform_items = await creative_style_repo.list_style_presets(
            module=module or None,
            enabled_only=True,
            gallery_only=gallery_only,
        )
        personal_items = await creative_style_repo.list_personal_style_recipes(
            user_id=str(user["id"]),
            module=module or None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"items": creative_style_repo.deduplicate_style_catalog([*platform_items, *personal_items])}
