"""Private callbacks for the isolated Go image-edit worker.

The Go worker owns only the provider HTTP call and its large buffers. Python
remains authoritative for task state, asset archival, terminal effects, and
user-facing events.
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
import repositories.task_repo as task_repo
from services import asset_storage, foxapi_credentials
from services.platform_provider_billing import require_platform_provider_sku

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/internal/go-image-heavy", tags=["go-image-heavy"], include_in_schema=False)


def _require_worker_secret(secret: str) -> None:
    expected = settings.GO_CONTROL_PLANE_SHARED_SECRET
    if not expected or not secret or not hmac.compare_digest(secret, expected):
        raise HTTPException(401, "invalid Go worker credentials")


async def _owned_task(task_id: str, user_id: str) -> dict:
    task = await task_repo.get(task_id)
    if not task or str(task.get("_user_id") or "") != user_id:
        raise HTTPException(404, "task not found")
    return task


def _active(task: dict) -> None:
    if task.get("status") == "completed":
        raise HTTPException(409, "task is already completed")
    if task.get("status") in {"failed", "cancelled"}:
        raise HTTPException(409, "task is already terminal")
    if task.get("status") not in {"pending", "processing"}:
        raise HTTPException(409, "task is not executable")


def _expected_model(task: dict, model_id: str) -> None:
    expected = str(task.get("_model_id") or "").strip()
    if expected and expected != str(model_id or "").strip():
        raise HTTPException(409, "model does not match the queued task")


async def _billing_mode(task: dict) -> str:
    value = str(task.get("_billing_mode") or "").strip()
    if value in {
        foxapi_credentials.BILLING_MODE,
        foxapi_credentials.PLATFORM_BILLING_MODE,
    }:
        return value
    raise HTTPException(409, "task billing mode is missing or invalid")


def _completion_asset_id(task_id: str, completion_id: str, image_sha256: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"pixelscribe:go-image-heavy:{task_id}:{completion_id}:{image_sha256}"))


class LeaseBody(BaseModel):
    task_id: str
    user_id: str
    model_id: str
    prompt: str = ""
    mode: str
    target_color: str = ""
    billing_mode: str = ""


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
    await _owned_task(task_id, user_id)
    normalized = key.strip().lstrip("/")
    prefix = asset_storage.user_asset_prefix(user_id).rstrip("/") + "/"
    if not normalized.startswith(prefix):
        raise HTTPException(403, "asset is outside task owner scope")
    try:
        data = await asset_storage.fetch_asset_key_bytes(normalized)
    except Exception as exc:
        logger.warning("Go heavy input fetch failed task_id=%s error=%s", task_id, exc)
        raise HTTPException(404, "input asset unavailable") from exc
    return Response(content=data, media_type=mimetypes.guess_type(normalized)[0] or "application/octet-stream", headers={"Cache-Control": "no-store"})


@router.post("/lease")
async def lease(body: LeaseBody, secret: str = Header(..., alias="X-Control-Plane-Secret")):
    _require_worker_secret(secret)
    if body.mode not in {"replace", "recolor"}:
        raise HTTPException(400, "Go heavy worker only supports replace and recolor")
    task = await _owned_task(body.task_id, body.user_id)
    _active(task)
    _expected_model(task, body.model_id)
    if not await generation_execution.claim_generate_execution_once(body.task_id):
        raise HTTPException(409, "task execution is already claimed")
    billing_mode = await _billing_mode(task)
    try:
        with bind_user_context(body.user_id, billing_mode):
            sku = await require_platform_provider_sku(
                user_id=body.user_id,
                model_id=body.model_id,
                expected_category="generate",
                description="Go heavy image edit",
            )
            if sku is not None and float(task.get("_cost") or 0) <= 0:
                raise HTTPException(503, "image edit task has no platform credit quote")
            api_key = str(settings.FLUX_FILL_API_KEY or settings.REPLICATE_API_TOKEN or "").strip()
            endpoint = str(settings.FLUX_FILL_ENDPOINT or "").strip()
            if not api_key or not endpoint:
                raise HTTPException(503, "image edit runtime is unavailable")
            prompt = str(body.prompt or "").strip()
            if body.mode == "recolor":
                prompt = f"change color to {body.target_color or '#000000'}, preserve texture and lighting"
            if not prompt:
                raise HTTPException(400, "prompt is required")
            await task_repo.set_processing(body.task_id, 20)
        return {
            "ok": True,
            "billing_mode": billing_mode,
            "endpoint": endpoint,
            "api_key": api_key,
            "prompt": prompt,
            "strength": 0.6 if body.mode == "recolor" else 0.95,
        }
    except HTTPException as exc:
        await task_repo.set_failed(body.task_id, str(exc.detail))
        raise
    except Exception as exc:
        logger.exception("Go heavy lease failed task_id=%s", body.task_id)
        await task_repo.set_failed(body.task_id, str(exc))
        raise HTTPException(503, "image edit runtime is unavailable") from exc


@router.post("/complete")
async def complete(
    task_id: str = Form(...), user_id: str = Form(...), model_id: str = Form(...),
    prompt: str = Form(""), mode: str = Form(...), element_id: str = Form(""),
    completion_id: str = Form(..., min_length=1, max_length=160), billing_mode: str = Form(""),
    image: UploadFile = File(...), secret: str = Header(..., alias="X-Control-Plane-Secret"),
):
    _require_worker_secret(secret)
    task = await _owned_task(task_id, user_id)
    _expected_model(task, model_id)
    if task.get("status") == "completed":
        return {"ok": True, "already_finalized": True}
    _active(task)
    claim_key = f"go_image_heavy:finalizing:{task_id}"
    if not await get_redis().set(claim_key, "1", ex=7200, nx=True):
        raise HTTPException(409, "task finalization is already in progress")
    staged = None
    try:
        max_bytes = max(1, int(settings.GO_IMAGE_HEAVY_WORKER_MAX_OUTPUT_BYTES))
        staged = await asset_storage.stage_uploaded_image(image, max_bytes=max_bytes)
        resolved = await _billing_mode(task)
        stored = await asset_storage.store_generated_image_best_effort(
            image_path=staged.path,
            image_sha256=staged.sha256,
            image_size_bytes=staged.size_bytes,
            user_id=user_id,
            conversation_id=None,
            task_id=task_id,
            prompt=prompt,
            model_id=model_id,
            category="image_edit",
            asset_id=_completion_asset_id(task_id, completion_id, staged.sha256),
        )
        if not stored:
            raise HTTPException(503, "generated image archival failed")
        result_b64 = ""
        result = {
            "image": stored.original_url,
            "imageBase64": result_b64,
            "imageUrl": stored.original_url,
            "previewUrl": stored.preview_url,
            "thumbnailUrl": stored.thumb_url,
            "assetId": stored.id,
            "element_id": element_id,
            "mode": mode,
        }
        with bind_user_context(user_id, resolved):
            # The Go worker has already completed exactly one provider call.
            # Arm the task-owned, idempotent terminal debit before completion
            # wins; API-key mode is still bypassed by the credit repository.
            if not await task_repo._update(task_id, {"_charge_on_complete": True}):
                return {"ok": True, "already_finalized": True, "asset_id": stored.id}
            transition = await task_repo.set_completed(task_id, result)
        return {"ok": True, "already_finalized": not transition.won, "asset_id": stored.id}
    except BaseException:
        raise
    finally:
        await get_redis().delete(claim_key)
        await asset_storage.remove_staged_image_file(staged)


@router.post("/failed")
async def failed(body: FailureBody, secret: str = Header(..., alias="X-Control-Plane-Secret")):
    _require_worker_secret(secret)
    task = await _owned_task(body.task_id, body.user_id)
    if task.get("status") in {"completed", "failed", "cancelled"}:
        return {"ok": True, "already_finalized": True}
    billing_mode = await _billing_mode(task)
    with bind_user_context(body.user_id, billing_mode):
        await task_repo.set_failed(body.task_id, (body.error or "Go image edit failed")[:1000])
    return {"ok": True}
