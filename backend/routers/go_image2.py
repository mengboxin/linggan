"""Internal callbacks used by the Go image2 worker during migration.

The Go worker owns queue consumption and upstream image2 execution. Python
remains the authority for credits, asset variants, history, and user events
until those database-backed modules move to Go.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import mimetypes
from typing import Optional
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from core import generation_execution
from core.config import settings
from core.redis import get_redis
from core.user_context import bind_user_context
import repositories.model_repo as model_repo
import repositories.image_asset_repo as image_asset_repo
import repositories.task_repo as task_repo
from services import asset_storage, foxapi_credentials
from services.ai_client import (
    _image_quality_for_output_resolution,
    _image_responses_model_name,
    _normalize_responses_image_quality,
    _normalize_responses_image_size,
    _parse_meta,
    _responses_endpoint,
    _sub2api_responses_image_tool_size,
    _uses_sub2api_responses_image_compatibility,
    _with_image_output_contract,
)
from services.model_billing import check_model_call


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/internal/go-image2", tags=["go-image2"], include_in_schema=False)


async def _ensure_history_conversation(
    *,
    user_id: str,
    task_id: str,
    conversation_id: str,
    prompt: str,
    source: str,
) -> str:
    """Return a durable image conversation for terminal image2 results.

    Older Go workers did not always carry the conversation ID through the
    callback form. A completed image must still get a listable history row,
    so create the missing image conversation at the terminal boundary.
    """
    normalized = str(conversation_id or "").strip()
    if normalized:
        return normalized
    try:
        from repositories import conversation_repo

        conversation = await conversation_repo.create_conversation(
            user_id=user_id,
            conv_type="image",
            title=(str(prompt or "").strip()[:80] or "图片精修"),
            creation_key=f"go-image2:{task_id}",
        )
        created = str(conversation.get("id") or "").strip()
        if created:
            return created
    except Exception as exc:
        logger.warning(
            "failed to create fallback image2 history conversation task_source=%s error=%s",
            source,
            exc,
        )
    return ""


def _require_worker_secret(secret: str) -> None:
    expected = settings.GO_CONTROL_PLANE_SHARED_SECRET
    if not expected or not secret or not hmac.compare_digest(secret, expected):
        raise HTTPException(401, "invalid Go worker credentials")


async def _require_owned_task(task_id: str, user_id: str) -> dict:
    task = await task_repo.get(task_id)
    if not task or str(task.get("_user_id") or "") != user_id:
        raise HTTPException(404, "task not found")
    return task


async def _claim_finalization(task_id: str) -> bool:
    """Prevent a reclaimed stream message from charging/completing twice."""
    return bool(await get_redis().set(f"go_image2:finalizing:{task_id}", "1", ex=7200, nx=True))


async def _release_finalization_claim(task_id: str) -> None:
    try:
        await get_redis().delete(f"go_image2:finalizing:{task_id}")
    except Exception as exc:
        logger.warning("failed to release Go image2 finalization claim task_id=%s error=%s", task_id, exc)


def _completion_asset_id(task_id: str, completion_id: str, image: bytes | str) -> str:
    """Bind a retried Go completion asset to both callback ID and image bytes."""
    digest = image if isinstance(image, str) else hashlib.sha256(image).hexdigest()
    return str(uuid5(NAMESPACE_URL, f"pixelscribe:go-image2:{task_id}:{completion_id}:{digest}"))


def _completion_result(
    *,
    stored: asset_storage.StoredImageAsset,
    model_id: str,
    prompt: str,
    size: str,
    output_resolution: str,
    image_quality: str,
    completion_id: str,
    recovered: bool = False,
) -> dict:
    result_image = {
        "imageBase64": "",
        "imageUrl": stored.original_url,
        "previewUrl": stored.preview_url,
        "thumbnailUrl": stored.thumb_url,
        "assetId": stored.id,
        "model_id": model_id,
        "final_prompt": prompt,
        "variantIndex": 1,
    }
    return {
        **result_image,
        "images": [result_image],
        "size": size,
        "output_size": size,
        "output_resolution": output_resolution,
        "image_quality": image_quality,
        "agent_steps": [],
        "partial": False,
        "requested_count": 1,
        "completed_count": 1,
        "failed_variants": [],
        "go_image2_completion_id": completion_id,
        "go_image2_recovered": recovered,
    }


def _stored_asset_from_row(row: dict) -> Optional[asset_storage.StoredImageAsset]:
    """Convert a durable generated asset row into a task result candidate."""
    asset_id = str(row.get("id") or "").strip()
    original_url = str(row.get("original_url") or "").strip()
    if not asset_id or not original_url:
        return None
    return asset_storage.StoredImageAsset(
        id=asset_id,
        original_url=original_url,
        preview_url=str(row.get("preview_url") or ""),
        thumb_url=str(row.get("thumb_url") or ""),
        original_key=str(row.get("original_key") or ""),
        preview_key=str(row.get("preview_key") or ""),
        thumb_key=str(row.get("thumb_key") or ""),
        width=int(row.get("width") or 0),
        height=int(row.get("height") or 0),
        mime_type=str(row.get("mime_type") or "image/png"),
        size_bytes=int(row.get("size_bytes") or 0),
        sha256=str(row.get("sha256") or ""),
    )


async def _finalize_completion(
    *,
    task_id: str,
    user_id: str,
    billing_mode: str,
    model_id: str,
    prompt: str,
    conversation_id: str,
    source: str,
    reference_count: int,
    stored: asset_storage.StoredImageAsset,
    size: str,
    output_resolution: str,
    image_quality: str,
    completion_id: str,
    recovered: bool = False,
) -> bool:
    """Make a durable archived image visible as one idempotent task result.

    The terminal repository owns the debit and reservation release.  Arming
    completion billing while the task is still active closes the cancellation
    race that previously let this callback charge before its completion won.
    """
    result = _completion_result(
        stored=stored,
        model_id=model_id,
        prompt=prompt,
        size=size,
        output_resolution=output_resolution,
        image_quality=image_quality,
        completion_id=completion_id,
        recovered=recovered,
    )
    # Generate submissions normally keep this false because the Python image
    # worker bills individual variants.  This Go-only one-image path instead
    # delegates its single charge to the terminal outbox after completion wins.
    if not await task_repo._update(task_id, {"_charge_on_complete": True}):
        return False

    from services.agents.image_generation_agent import _persist_generation_history

    with bind_user_context(user_id, billing_mode):
        transition = await task_repo.set_completed(task_id, result)
        if not transition.won:
            return False
        conversation_id = await _ensure_history_conversation(
            user_id=user_id,
            task_id=task_id,
            conversation_id=conversation_id,
            prompt=prompt,
            source=source,
        )
        await _persist_generation_history(
            task_id=task_id,
            user_id=user_id,
            conversation_id=conversation_id,
            source=source,
            prompt=prompt,
            model_id=model_id,
            llm_model_id=None,
            vision_model_id=None,
            size=size,
            output_resolution=output_resolution,
            image_quality=image_quality,
            ref_count=max(0, int(reference_count)),
            image_asset_meta=stored.to_meta(),
            result_meta={
                "go_image2": True,
                "go_image2_recovered": recovered,
                "requested_count": 1,
                "completed_count": 1,
            },
        )
    return True


async def _recover_archived_completion(
    *,
    task: dict,
    task_id: str,
    user_id: str,
    billing_mode: str,
) -> bool:
    """Finish a callback crash once its output asset has reached Postgres.

    This path is intentionally used only by terminal callbacks. Queue input
    files use a different table, so a matching image asset proves the upstream
    image was already archived and may safely be delivered instead of failed.
    """
    current = await task_repo.get(task_id)
    if not current or str(current.get("status") or "") not in {"pending", "processing"}:
        return False
    expected_model_id = str(current.get("_model_id") or task.get("_model_id") or "").strip()
    try:
        rows = await image_asset_repo.list_assets_by_task_ids([task_id], user_id)
    except Exception as exc:
        logger.warning("Go image2 archived completion lookup failed task_id=%s error=%s", task_id, exc)
        return False
    for row in reversed(rows):
        model_id = str(row.get("model_id") or "").strip()
        if expected_model_id and model_id != expected_model_id:
            continue
        stored = _stored_asset_from_row(row)
        if not stored:
            continue
        prompt = str(row.get("prompt") or "")
        conversation_id = str(row.get("conversation_id") or "")
        size = f"{stored.width}x{stored.height}" if stored.width and stored.height else "1024x1024"
        try:
            if not await _finalize_completion(
                task_id=task_id,
                user_id=user_id,
                billing_mode=billing_mode,
                model_id=model_id or expected_model_id,
                prompt=prompt,
                conversation_id=conversation_id,
                source="go_image2_recovery",
                reference_count=0,
                stored=stored,
                size=size,
                output_resolution="1k",
                image_quality="auto",
                completion_id=f"recovered:{stored.id}",
                recovered=True,
            ):
                return False
            return True
        except Exception as exc:
            logger.warning("Go image2 archived completion recovery failed task_id=%s error=%s", task_id, exc)
            return False
    return False


def _require_active_task(task: dict) -> None:
    status = str(task.get("status") or "")
    if status == "completed":
        raise HTTPException(409, "task is already completed")
    if status in {"failed", "cancelled"}:
        raise HTTPException(409, "task is already terminal")
    if status not in {"pending", "processing"}:
        raise HTTPException(409, "task is not executable")


def _require_expected_model(task: dict, model_id: str) -> None:
    expected_model_id = str(task.get("_model_id") or "").strip()
    if expected_model_id and expected_model_id != str(model_id or "").strip():
        raise HTTPException(409, "model does not match the queued task")


async def _resolve_billing_mode(task: dict) -> str:
    frozen = str(task.get("_billing_mode") or "").strip()
    if frozen in {
        foxapi_credentials.BILLING_MODE,
        foxapi_credentials.PLATFORM_BILLING_MODE,
    }:
        return frozen
    raise HTTPException(409, "task billing mode is missing or invalid")


def _lease_runtime_config(
    *,
    model: dict,
    prompt: str,
    reference_count: int,
    size: str,
    image_quality: str,
    force_size: bool,
) -> dict:
    """Resolve exactly the Responses options that Python would send upstream."""
    from services.agents.image_generation_agent import _reference_image_contract

    meta = _parse_meta(model)
    endpoint = _responses_endpoint(model, meta)
    api_key = str(model.get("api_key") or "").strip()
    responses_model = _image_responses_model_name(model, meta)
    if not endpoint or not api_key or not responses_model:
        raise HTTPException(503, "image2 runtime configuration is unavailable")

    requested_prompt = str(prompt or "").strip()
    if not requested_prompt:
        raise HTTPException(400, "prompt is required")
    ref_count = max(0, min(int(reference_count or 0), 8))
    reference_contract = _reference_image_contract(ref_count, is_workflow_edit=False)
    final_prompt = requested_prompt
    if reference_contract and reference_contract not in final_prompt:
        final_prompt = f"{reference_contract}\nUser request: {final_prompt}"
    if force_size:
        final_prompt = _with_image_output_contract(final_prompt, size)

    action = str(
        meta.get("image_generation_action")
        or meta.get("responses_image_action")
        or ("edit" if ref_count else "generate")
    )
    configured_tool_size = str(meta.get("responses_image_size") or "").strip()
    tool_size = _normalize_responses_image_size(size, meta, prefer_requested_size=force_size)
    use_sub2api_size_compatibility = _uses_sub2api_responses_image_compatibility(model, meta)
    if tool_size and use_sub2api_size_compatibility:
        tool_size = _sub2api_responses_image_tool_size(tool_size)
    include_size = bool(
        tool_size
        and (
            configured_tool_size
            or force_size
            or use_sub2api_size_compatibility
            or tool_size not in {"1024x1024", "1024x1536", "1536x1024"}
        )
    )
    requested_quality = _image_quality_for_output_resolution(image_quality, size)
    tool_quality = _normalize_responses_image_quality(requested_quality, meta)

    return {
        "endpoint": endpoint,
        "api_key": api_key,
        "model": responses_model,
        "action": action,
        "size": tool_size if include_size else "",
        # Go's client uses this flag only to decide whether to emit the size
        # field, so expose Python's effective decision rather than the input.
        "force_size": include_size,
        "quality": tool_quality or "",
        "reasoning_effort": str(meta.get("responses_reasoning_effort") or meta.get("reasoning_effort") or ""),
        "reasoning_summary": str(meta.get("responses_reasoning_summary") or ""),
        "final_prompt": final_prompt,
    }


async def _mark_lease_failure(task_id: str, error: str, *, billing_mode: str) -> None:
    """Finish a claimed task when Python cannot issue an executable lease."""
    try:
        task = await task_repo.get(task_id)
        if task and task.get("status") in {"pending", "processing"}:
            user_id = str(task.get("_user_id") or "")
            with bind_user_context(user_id or None, billing_mode or None):
                await task_repo.set_failed(task_id, error[:1000] or "Go image2 lease failed")
    except Exception as exc:
        logger.warning("Go image2 lease failure finalization failed task_id=%s error=%s", task_id, exc)


class ProgressBody(BaseModel):
    task_id: str
    user_id: str
    model_id: str
    progress: int = 20
    billing_mode: str = ""


class LeaseBody(BaseModel):
    task_id: str
    user_id: str
    model_id: str
    prompt: str
    source: str = ""
    billing_mode: str = ""
    size: str = "1024x1024"
    image_quality: str = "auto"
    force_size: bool = True
    reference_count: int = 0


class FailureBody(BaseModel):
    task_id: str
    user_id: str
    error: str
    billing_mode: str = ""


@router.get("/input")
async def fetch_input(
    key: str = Query(..., min_length=1),
    task_id: str = Query(..., min_length=1),
    user_id: str = Header(..., alias="X-Task-User-ID"),
    secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    _require_worker_secret(secret)
    await _require_owned_task(task_id, user_id)
    normalized_key = key.strip().lstrip("/")
    allowed_prefix = asset_storage.user_asset_prefix(user_id).rstrip("/") + "/"
    if not normalized_key.startswith(allowed_prefix):
        raise HTTPException(403, "asset is outside task owner scope")
    try:
        data = await asset_storage.fetch_asset_key_bytes(normalized_key)
    except Exception as exc:
        logger.warning("Go image2 input fetch failed task_id=%s error=%s", task_id, exc)
        raise HTTPException(404, "input asset unavailable") from exc
    return Response(
        content=data,
        media_type=mimetypes.guess_type(normalized_key)[0] or "application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/lease")
async def lease(
    body: LeaseBody,
    secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    """Claim a direct image2 execution and issue an in-memory runtime lease.

    Model secrets never enter Redis.  The Go worker receives them only after
    acquiring the same one-time execution lock used by the Python worker.
    """
    _require_worker_secret(secret)
    task = await _require_owned_task(body.task_id, body.user_id)
    _require_active_task(task)
    _require_expected_model(task, body.model_id)
    source = str(body.source or "").strip()
    if source and not source.endswith("image2_shortcut"):
        raise HTTPException(400, "Go image2 lease only supports image2 shortcuts")

    if not await generation_execution.claim_generate_execution_once(body.task_id):
        # This matches the Python worker's duplicate-message behavior: the
        # worker must not make another upstream call for an existing claim.
        raise HTTPException(409, "task execution is already claimed")

    billing_mode = await _resolve_billing_mode(task)
    try:
        with bind_user_context(body.user_id, billing_mode):
            model = await model_repo.get_model_internal(body.model_id)
            if not model or model.get("category") != "generate":
                raise HTTPException(409, "image model is missing, disabled, or invalid")

            # This one-call Go shortcut is charged by the task terminal
            # outbox after completion wins.  Only validate its frozen task
            # reservation here; allocating a per-call claim would conflict
            # with terminal settlement and could strand the reservation.
            await check_model_call(
                user_id=body.user_id,
                model_id=body.model_id,
                expected_category="generate",
                description="Go image2 generation",
                reservation_task_id=body.task_id,
            )
            runtime = _lease_runtime_config(
                model=model,
                prompt=body.prompt,
                reference_count=body.reference_count,
                size=str(body.size or "1024x1024"),
                image_quality=str(body.image_quality or "auto"),
                force_size=bool(body.force_size),
            )
            await task_repo.set_processing(body.task_id, 20)
        return {
            "ok": True,
            "billing_mode": billing_mode,
            "endpoint": runtime["endpoint"],
            "api_key": runtime["api_key"],
            "model": runtime["model"],
            "prompt": runtime["final_prompt"],
            "tool": {
                "action": runtime["action"],
                "size": runtime["size"],
                "quality": runtime["quality"],
                "force_size": runtime["force_size"],
                "reasoning": {
                    "effort": runtime["reasoning_effort"],
                    "summary": runtime["reasoning_summary"],
                },
            },
        }
    except HTTPException as exc:
        await _mark_lease_failure(body.task_id, str(exc.detail), billing_mode=billing_mode)
        raise
    except Exception as exc:
        logger.exception("Go image2 lease failed task_id=%s", body.task_id)
        await _mark_lease_failure(body.task_id, str(exc), billing_mode=billing_mode)
        raise HTTPException(503, "image2 runtime lease is unavailable") from exc


@router.post("/prepare")
async def prepare(
    body: ProgressBody,
    secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    _require_worker_secret(secret)
    task = await _require_owned_task(body.task_id, body.user_id)
    if task.get("status") in {"completed", "failed", "cancelled"}:
        # The following lease maps the existing execution claim to a duplicate
        # ACK. Do not let this compatibility endpoint regress task status.
        return {"ok": True, "already_finalized": True}
    _require_active_task(task)
    _require_expected_model(task, body.model_id)
    billing_mode = await _resolve_billing_mode(task)
    with bind_user_context(body.user_id, billing_mode):
        await check_model_call(
            user_id=body.user_id,
            model_id=body.model_id,
            expected_category="generate",
            description="Go image2 generation",
            reservation_task_id=body.task_id,
        )
        await task_repo.set_processing(body.task_id, max(10, min(int(body.progress), 90)))
    return {"ok": True}


@router.post("/complete")
async def complete(
    task_id: str = Form(...),
    user_id: str = Form(...),
    model_id: str = Form(...),
    prompt: str = Form(...),
    size: str = Form("1024x1024"),
    output_resolution: str = Form("1k"),
    image_quality: str = Form("auto"),
    conversation_id: str = Form(""),
    source: str = Form(""),
    reference_count: int = Form(0),
    completion_id: str = Form(..., min_length=1, max_length=160),
    billing_mode: str = Form(""),
    image: UploadFile = File(...),
    secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    _require_worker_secret(secret)
    task = await _require_owned_task(task_id, user_id)
    _require_expected_model(task, model_id)
    if task.get("status") == "completed":
        return {"ok": True, "already_finalized": True}
    _require_active_task(task)
    if not await _claim_finalization(task_id):
        resolved_billing_mode = await _resolve_billing_mode(task)
        if await _recover_archived_completion(
            task=task,
            task_id=task_id,
            user_id=user_id,
            billing_mode=resolved_billing_mode,
        ):
            return {"ok": True, "already_finalized": True, "recovered": True}
        raise HTTPException(409, "task finalization is already in progress")
    staged_image: asset_storage.StagedImageFile | None = None
    try:
        max_output_bytes = max(1, int(settings.GO_IMAGE2_WORKER_MAX_OUTPUT_BYTES))
        try:
            staged_image = await asset_storage.stage_uploaded_image(
                image,
                max_bytes=max_output_bytes,
            )
        except asset_storage.ImageUploadTooLargeError as exc:
            raise HTTPException(413, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        resolved_billing_mode = await _resolve_billing_mode(task)
    except BaseException:
        await _release_finalization_claim(task_id)
        raise
    try:
        source_client = "desktop" if source.startswith("desktop") else "web"
        stored = await asset_storage.store_generated_image_best_effort(
            image_path=staged_image.path,
            image_sha256=staged_image.sha256,
            image_size_bytes=staged_image.size_bytes,
            user_id=user_id,
            conversation_id=conversation_id or None,
            task_id=task_id,
            prompt=prompt,
            model_id=model_id,
            category="images",
            source_client=source_client,
            asset_id=_completion_asset_id(task_id, completion_id, staged_image.sha256),
        )
        if not stored:
            raise HTTPException(503, "generated image archival failed")
        completed = await _finalize_completion(
            task_id=task_id,
            user_id=user_id,
            billing_mode=resolved_billing_mode,
            model_id=model_id,
            prompt=prompt,
            conversation_id=conversation_id,
            source=source,
            reference_count=reference_count,
            stored=stored,
            size=size,
            output_resolution=output_resolution,
            image_quality=image_quality,
            completion_id=completion_id,
        )
        if not completed:
            return {"ok": True, "already_finalized": True}
        return {"ok": True, "asset_id": stored.id}
    except BaseException:
        await _release_finalization_claim(task_id)
        raise
    finally:
        await asset_storage.remove_staged_image_file(staged_image)


@router.post("/failed")
async def failed(
    body: FailureBody,
    secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    _require_worker_secret(secret)
    task = await _require_owned_task(body.task_id, body.user_id)
    if task.get("status") in {"completed", "failed", "cancelled"}:
        return {"ok": True, "already_finalized": True}
    _require_active_task(task)
    billing_mode = await _resolve_billing_mode(task)
    if await _recover_archived_completion(
        task=task,
        task_id=body.task_id,
        user_id=body.user_id,
        billing_mode=billing_mode,
    ):
        return {"ok": True, "already_finalized": True, "recovered": True}
    if not await _claim_finalization(body.task_id):
        refreshed = await task_repo.get(body.task_id)
        if refreshed and refreshed.get("status") in {"completed", "failed", "cancelled"}:
            return {"ok": True, "already_finalized": True}
        raise HTTPException(409, "task finalization is already in progress")
    try:
        with bind_user_context(body.user_id, billing_mode):
            await task_repo.set_failed(body.task_id, body.error[:1000] or "Go image2 worker failed")
        return {"ok": True}
    except BaseException:
        await _release_finalization_claim(body.task_id)
        raise
