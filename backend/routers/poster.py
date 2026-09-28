"""Poster generation agent routes.

This workflow is intentionally agent-shaped rather than a prompt passthrough:
it reads uploaded materials, optionally analyzes a reference image, plans a
poster series, generates each A3 poster with image2, and preserves every
generated version.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime
import json
import logging
import uuid
from typing import Any, Literal, Optional, TypedDict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from core.concurrency import gather_limited
from core.config import settings
from core.credit_reserve import (
    get_available_balance,
    get_task_reservation,
    release_task_reservation,
    reserve_for_task,
)
from core.generation_execution import (
    claim_submit_key,
    forget_submit_key,
    module_submit_idempotency_key,
    remember_submit_key,
)
from core.job_state_cache import BoundedJobStateCache
from core import history_artifacts
from core.queue import enqueue
import repositories.conversation_repo as conversation_repo
import repositories.image_asset_repo as image_asset_repo
from repositories import creative_style_repo, public_gallery_repo
from routers.auth import get_current_user
from services.ai_client import call_chat, call_image, call_vision
from services import provider_policy
from services.billing_operation import model_billing_operation_key
from services.agents.workflow_agent import set_agent_step
from services.attachment_parser import build_attachment_context, merge_attachment_state
from services.model_billing import check_model_call, execute_billed_model_call
from services import asset_storage
from services.image_asset_contract import (
    ImageAssetReference,
    ImageAssetReferenceError,
    canonicalize_image_asset_references,
    load_original_reference_bytes,
)
from services.agents.creative_runtime import create_module_run, sync_specialist_run
from services.agents.creative_contract import build_delivery_contract
from services.agents.specialist_graph import run_specialist_graph
from services.job_events import publish_job_update, compact_image_versions
from services.image_output import image_output_size, normalize_image_quality, normalize_output_resolution
from services.creative_skill_resolver import CreativeSkillResolutionError, resolve_creative_skill_submission
from langgraph.graph import END, START, StateGraph

router = APIRouter(prefix="/api/poster", tags=["poster"])
logger = logging.getLogger(__name__)

MAX_PER_USER_POSTER_JOBS = 2
MAX_POSTERS = 5
POSTER_SIZE_MAP = {
    "a3_portrait": "1024x1536",
    "a3_landscape": "1536x1024",
    "square": "1024x1024",
}
POSTER_ASPECT_RATIO_MAP = {
    "a3_portrait": "2:3",
    "a3_landscape": "3:2",
    "square": "1:1",
}
POSTER_DIVERSITY_ROLES = [
    {
        "content_focus": "核心能力与结构总览",
        "layout_archetype": "large hero product or topic cutaway in the center, feature cards around it",
        "visual_plan": "Use a strong central hero visual, technical callouts, and compact feature modules.",
    },
    {
        "content_focus": "使用场景、路径或流程",
        "layout_archetype": "scenario map or step-by-step pathway, not a centered cutaway",
        "visual_plan": "Use a route map, scene panels, or process lanes to show how the subject works in real context.",
    },
    {
        "content_focus": "价值对比、结果收益与用户决策",
        "layout_archetype": "comparison dashboard, before-after blocks, outcome metrics, or benefit matrix",
        "visual_plan": "Use comparison panels, outcome badges, and summary blocks instead of repeating the product hero.",
    },
    {
        "content_focus": "操作方法、部署步骤或维护说明",
        "layout_archetype": "instructional workflow with numbered steps and tool/material details",
        "visual_plan": "Use instructional panels, close-up details, and clear step sequencing.",
    },
    {
        "content_focus": "系列总结、规格索引与记忆点",
        "layout_archetype": "summary index, modular grid, checklist, or key specification board",
        "visual_plan": "Use a clean index-like layout with grouped facts and a memorable concluding visual.",
    },
]

_user_sems: dict[str, asyncio.Semaphore] = {}
_mem_store = BoundedJobStateCache(
    max_entries=settings.JOB_STATE_FALLBACK_CACHE_MAX_ENTRIES,
    ttl_seconds=settings.JOB_STATE_FALLBACK_CACHE_TTL_SECONDS,
    max_bytes=settings.JOB_STATE_FALLBACK_CACHE_MAX_BYTES,
)


def _poster_generation_reservation_amount(
    *,
    poster_count: int,
    llm_call_cost: float,
    image_call_cost: float,
    vision_call_cost: float,
    has_reviewer: bool,
    has_reference: bool,
) -> float:
    count = max(1, min(MAX_POSTERS, int(poster_count or 1)))
    attempts_per_poster = 2 if has_reviewer else 1
    image_calls = count * attempts_per_poster
    vision_calls = (count * 2 + (1 if has_reference else 0)) if has_reviewer else 0
    return round(
        max(0.0, llm_call_cost)
        + max(0.0, image_call_cost) * image_calls
        + max(0.0, vision_call_cost) * vision_calls,
        2,
    )


async def _release_poster_generation_reservation(job_id: str) -> None:
    try:
        await release_task_reservation(job_id)
    except Exception as exc:
        # The reservation has a TTL backstop. Preserve the delivered job while
        # making a transient release failure visible to operators.
        logger.warning("[Poster] failed to release credit reservation job_id=%s error=%s", job_id, exc)


async def _execute_poster_model_call(
    *,
    state: dict,
    model_id: str,
    category: str,
    description: str,
    operation: str,
    material: Any,
    invoke,
    attempt: int = 1,
):
    job_id = str(state.get("job_id") or "")
    user_id = str(state["user_id"])
    reservation = await get_task_reservation(job_id) if job_id else None
    if reservation is not None and reservation.user_id != user_id:
        raise HTTPException(409, "Poster billing reservation owner mismatch")
    return await execute_billed_model_call(
        user_id=user_id,
        model_id=model_id,
        expected_category=category,
        description=description,
        # Poster jobs are not rows in the shared task table; keep their UUID in
        # the ledger idempotency key instead of violating the task FK.
        related_task_id=None,
        reservation_task_id=job_id if reservation is not None else None,
        idempotency_key=model_billing_operation_key(
            namespace="poster",
            user_id=str(state["user_id"]),
            operation_scope=(
                f"{job_id}:{operation}:attempt:{max(1, int(attempt))}"
                if job_id else ""
            ),
            material={
                "model_id": model_id,
                "category": category,
                "request": material,
            },
        ),
        invoke=invoke,
    )


class PosterStartRequest(BaseModel):
    description: str
    poster_count: int = Field(default=1, ge=1, le=MAX_POSTERS)
    size: str = "a3_portrait"
    output_resolution: Literal["1k", "2k", "4k", "standard"] = "1k"
    image_quality: Literal["auto", "low", "medium", "high"] = "auto"
    style_hint: str = ""
    reference_assets: list[ImageAssetReference] = Field(default_factory=list)
    # Compatibility for already deployed clients. This is archived once before
    # the job is queued and never used as the durable input identity.
    ref_image_b64: Optional[str] = None
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""
    llm_model_id: Optional[str] = None
    image_model_id: Optional[str] = None
    vision_model_id: Optional[str] = None
    conversation_id: Optional[str] = None
    client_request_id: str = ""
    make_public: bool = False
    skill_id: str = ""
    skill_revision: int = 0


class PosterRefineRequest(BaseModel):
    poster_index: int = Field(default=0, ge=0)
    prompt: str
    image_model_id: Optional[str] = None
    attachments: list[dict] = Field(default_factory=list)
    attachment_context: str = ""


class PosterQualityReviewDecisionRequest(BaseModel):
    poster_index: int = Field(default=0, ge=0)
    decision: Literal["keep"]


class PosterSelectVersionRequest(BaseModel):
    poster_index: int = Field(default=0, ge=0)
    version_index: int = Field(default=0, ge=0)


class PosterOptimizeRequest(BaseModel):
    description: str
    poster_count: int = Field(default=1, ge=1, le=MAX_POSTERS)
    style_hint: str = ""
    attachment_context: str = ""
    attachments: list[dict] = Field(default_factory=list)
    llm_model_id: Optional[str] = None
    client_request_id: str = ""


async def _auth(
    token: Optional[str] = Query(default=None),
    user: Optional[dict] = Depends(get_current_user),
) -> dict:
    if user:
        return user
    if token:
        from core.security import decode_token
        import repositories.user_repo as user_repo

        payload = decode_token(token)
        if payload and payload.get("type") == "access":
            u = await user_repo.get_by_id(payload["sub"])
            if u:
                from routers.auth import _require_current_legal_acceptance
                await _require_current_legal_acceptance(u, payload)
                return u
    raise HTTPException(401, "未登录")


def _get_user_sem(user_id: str) -> asyncio.Semaphore:
    if user_id not in _user_sems:
        _user_sems[user_id] = asyncio.Semaphore(MAX_PER_USER_POSTER_JOBS)
    return _user_sems[user_id]


def _merge_versions(existing_versions: list, incoming_versions: list) -> list:
    merged: list[dict] = []
    seen: set[str] = set()
    for version in [*(existing_versions or []), *(incoming_versions or [])]:
        if not isinstance(version, dict):
            continue
        version_id = str(version.get("id") or "")
        key = version_id or json.dumps(
            {
                "assetId": version.get("assetId") or version.get("asset_id"),
                "createdAt": version.get("createdAt"),
                "imageUrl": version.get("imageUrl") or version.get("previewUrl") or version.get("renderedUrl"),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        if key in seen:
            continue
        seen.add(key)
        merged.append(version)
    return merged


def _merge_state_for_save(existing: dict, incoming: dict) -> dict:
    if not isinstance(existing, dict) or existing.get("job_id") != incoming.get("job_id"):
        return incoming
    merged = {**existing, **incoming}
    existing_posters = existing.get("posters") if isinstance(existing.get("posters"), list) else []
    incoming_posters = incoming.get("posters") if isinstance(incoming.get("posters"), list) else []
    poster_count = max(len(existing_posters), len(incoming_posters))
    posters: list[dict] = []
    for idx in range(poster_count):
        old = existing_posters[idx] if idx < len(existing_posters) and isinstance(existing_posters[idx], dict) else {}
        new = incoming_posters[idx] if idx < len(incoming_posters) and isinstance(incoming_posters[idx], dict) else {}
        poster = {**old, **new}
        old_versions = old.get("versions") if isinstance(old.get("versions"), list) else []
        new_versions = new.get("versions") if isinstance(new.get("versions"), list) else []
        versions = _merge_versions(old_versions, new_versions)
        poster["versions"] = versions
        if len(old_versions) > len(new_versions):
            poster["selected_version_index"] = old.get("selected_version_index", len(versions) - 1)
        elif len(new_versions) > 0:
            poster["selected_version_index"] = new.get("selected_version_index", len(versions) - 1)
        if new.get("refine_status") in {None, "", "idle"} and old.get("refine_status") not in {None, "", "idle"}:
            for key in ("refine_status", "refine_progress", "refine_message", "refine_error"):
                if key in old:
                    poster[key] = old[key]
        posters.append(poster)
    merged["posters"] = posters
    merged["selected_versions"] = [
        int(poster.get("selected_version_index", -1))
        for poster in posters
    ]
    return merged


async def _save_state(job_id: str, state: dict):
    state_to_save = state
    try:
        from core.redis import get_redis

        r = get_redis()
        raw = await r.get(f"poster_job:{job_id}")
        if raw:
            try:
                state_to_save = _merge_state_for_save(json.loads(raw), state)
                state.clear()
                state.update(state_to_save)
            except Exception as exc:
                logger.warning("[Poster] state merge failed: job_id=%s error=%s", job_id, exc)
                state_to_save = state
        await r.set(f"poster_job:{job_id}", json.dumps(state_to_save, ensure_ascii=False), ex=3600 * 24 * 7)
    except Exception as exc:
        _mem_store[job_id] = state_to_save
        logger.warning("[Poster] Redis write failed: %s", exc)
    else:
        _mem_store.discard(job_id)
    await publish_job_update(
        state_to_save,
        job_type="poster",
        job_id=job_id,
    )
    try:
        await sync_specialist_run(state_to_save, module="poster")
    except Exception as exc:
        logger.warning("[Poster] top-level agent run sync failed: %s", exc)


async def _load_state(job_id: str) -> Optional[dict]:
    try:
        from core.redis import get_redis

        r = get_redis()
        raw = await r.get(f"poster_job:{job_id}")
        if raw:
            state = json.loads(raw)
            _mem_store.discard(job_id)
            return state
    except Exception as exc:
        logger.warning("[Poster] Redis read failed: %s", exc)
    return _mem_store.get(job_id)


def _strip_data_url(value: str) -> str:
    return value.split(",", 1)[1] if value.startswith("data:") else value


def _parse_json_object(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end <= start:
        raise ValueError("AI response is not JSON")
    return json.loads(raw[start:end])


def _poster_size(size: str) -> str:
    return POSTER_SIZE_MAP.get(size, POSTER_SIZE_MAP["a3_portrait"])


def _poster_output_size(size: str, output_resolution: str = "1k") -> str:
    aspect_ratio = POSTER_ASPECT_RATIO_MAP.get(size, POSTER_ASPECT_RATIO_MAP["a3_portrait"])
    return image_output_size(aspect_ratio, output_resolution)


def _poster_count(state: dict) -> int:
    try:
        return max(1, min(MAX_POSTERS, int(state.get("poster_count") or 1)))
    except (TypeError, ValueError):
        return 1


def _poster_word(count: int) -> str:
    return f"{count} 张海报" if count > 1 else "海报"


def _poster_diversity_role(index: int) -> dict:
    role = POSTER_DIVERSITY_ROLES[index % len(POSTER_DIVERSITY_ROLES)]
    return {
        "content_focus": role["content_focus"],
        "layout_archetype": role["layout_archetype"],
        "visual_plan": role["visual_plan"],
    }


async def _refresh_running_lock(job_id: str):
    try:
        from core.redis import get_redis

        await get_redis().set(f"poster_job:{job_id}:running", "1", ex=120)
    except Exception as exc:
        logger.warning("[Poster] running lock refresh failed: job_id=%s error=%s", job_id, exc)


async def _clear_running_lock(job_id: str):
    try:
        from core.redis import get_redis

        await get_redis().delete(f"poster_job:{job_id}:running")
    except Exception as exc:
        logger.warning("[Poster] running lock clear failed: job_id=%s error=%s", job_id, exc)


async def _run_with_running_lock(job_id: str, runner):
    async def heartbeat():
        while True:
            await _refresh_running_lock(job_id)
            await asyncio.sleep(30)

    await _refresh_running_lock(job_id)
    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        return await runner()
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        await _clear_running_lock(job_id)


def _poster_placeholder(index: int, prompt: str = "") -> dict:
    number = f"{index + 1:02d}"
    return {
        "id": str(uuid.uuid4()),
        "poster_index": index,
        "number": number,
        "title": f"Poster {number}",
        "content_focus": "",
        "visual_plan": "",
        "prompt": prompt,
        "versions": [],
        "selected_version_index": -1,
        "generation_status": "pending",
        "generation_progress": 0,
        "generation_message": "等待生成",
        "generation_error": "",
        "refine_status": "idle",
        "refine_progress": 0,
        "refine_message": "",
        "refine_error": "",
    }


def _ensure_poster_slot(state: dict, poster_index: int) -> dict:
    posters = state.setdefault("posters", [])
    while len(posters) <= poster_index:
        posters.append(_poster_placeholder(len(posters)))
    poster = posters[poster_index]
    poster.setdefault("generation_status", "completed" if poster.get("versions") else "pending")
    poster.setdefault("generation_progress", 100 if poster.get("versions") else 0)
    poster.setdefault("generation_message", "")
    poster.setdefault("generation_error", "")
    poster.setdefault("refine_status", "idle")
    poster.setdefault("refine_progress", 0)
    poster.setdefault("refine_message", "")
    poster.setdefault("refine_error", "")
    return poster


def _set_poster_generation_status(
    state: dict,
    poster_index: int,
    status: str,
    *,
    progress: int = 0,
    message: str = "",
    error: str = "",
) -> dict:
    poster = _ensure_poster_slot(state, poster_index)
    poster["generation_status"] = status
    poster["generation_progress"] = max(0, min(100, int(progress or 0)))
    poster["generation_message"] = message
    poster["generation_error"] = error
    return poster


def _set_poster_refine_status(
    state: dict,
    poster_index: int,
    status: str,
    *,
    progress: int = 0,
    message: str = "",
    error: str = "",
) -> dict:
    poster = _ensure_poster_slot(state, poster_index)
    poster["refine_status"] = status
    poster["refine_progress"] = max(0, min(100, int(progress or 0)))
    poster["refine_message"] = message
    poster["refine_error"] = error
    return poster


def _poster_has_image(poster: dict) -> bool:
    return any(
        isinstance(version, dict)
        and any(version.get(key) for key in ("renderedB64", "renderedUrl", "previewUrl", "imageUrl", "thumbnailUrl"))
        for version in poster.get("versions", [])
    )


async def _store_poster_asset(state: dict, poster_index: int, image_b64: str, prompt: str, model_id: str = "") -> dict:
    asset = await asset_storage.store_generated_image_best_effort(
        image_base64=image_b64,
        user_id=state["user_id"],
        conversation_id=state.get("conversation_id") or None,
        task_id=state["job_id"],
        prompt=prompt,
        model_id=model_id or state.get("image_model_id", ""),
        category="poster",
        item_id=f"poster_{poster_index + 1:02d}_v{len((state.get('posters') or [{}])[poster_index].get('versions', [])) + 1}" if len(state.get("posters", [])) > poster_index else f"poster_{poster_index + 1:02d}",
    )
    return asset.to_meta() if asset else {}


def _append_poster_version(
    state: dict,
    poster_index: int,
    image_b64: str,
    prompt: str,
    title: str = "",
    asset_meta: dict | None = None,
    user_prompt: str = "",
) -> dict:
    posters = state.setdefault("posters", [])
    while len(posters) <= poster_index:
        posters.append(_poster_placeholder(len(posters)))
    poster = posters[poster_index]
    display_prompt = (user_prompt or state.get("description") or "").strip()
    version = {
        "id": str(uuid.uuid4()),
        "posterIndex": poster_index,
        "number": poster.get("number") or f"{poster_index + 1:02d}",
        "renderedB64": image_b64,
        "renderedUrl": (asset_meta or {}).get("preview_url") or (asset_meta or {}).get("image_url") or "",
        "imageUrl": (asset_meta or {}).get("image_url") or "",
        "previewUrl": (asset_meta or {}).get("preview_url") or "",
        "thumbnailUrl": (asset_meta or {}).get("thumbnail_url") or "",
        "assetId": (asset_meta or {}).get("asset_id") or "",
        "assetOriginalKey": (asset_meta or {}).get("asset_original_key") or "",
        "assetPreviewKey": (asset_meta or {}).get("asset_preview_key") or "",
        "assetThumbKey": (asset_meta or {}).get("asset_thumb_key") or "",
        "prompt": display_prompt,
        "userPrompt": display_prompt,
        "title": title or poster.get("title") or f"Poster {poster_index + 1:02d}",
        "createdAt": datetime.utcnow().isoformat() + "Z",
    }
    poster.setdefault("versions", []).append(version)
    poster["selected_version_index"] = len(poster["versions"]) - 1
    poster["title"] = version["title"]
    state["selected_versions"] = [int(p.get("selected_version_index", -1)) for p in posters]
    return version


def _compact_poster_versions(versions: list[dict]) -> list[dict]:
    """Keep inline pixels only until a durable asset is available."""
    compact: list[dict] = []
    for version in versions or []:
        if not isinstance(version, dict):
            continue
        has_durable_asset = bool(
            version.get("assetId")
            or version.get("asset_id")
            or version.get("imageUrl")
            or version.get("image_url")
            or version.get("previewUrl")
            or version.get("preview_url")
        )
        compact.append(compact_image_versions([version])[0] if has_durable_asset else dict(version))
    return compact


def _compact_posters_for_status(posters: list[dict]) -> list[dict]:
    compact: list[dict] = []
    for poster in posters or []:
        if not isinstance(poster, dict):
            continue
        next_poster = dict(poster)
        next_poster["versions"] = _compact_poster_versions(next_poster.get("versions", []))
        compact.append(next_poster)
    return compact


def _compact_versions_for_history(versions: list[dict]) -> list[dict]:
    compact = _compact_poster_versions(versions)
    for version in compact:
        prompt = version.get("prompt")
        if isinstance(prompt, str) and len(prompt) > 2000:
            version["prompt"] = prompt[:2000] + "..."
    return compact


async def _poster_step(
    state: dict,
    *,
    name: str,
    status: str,
    message: str,
    progress: int,
    attempt: int = 1,
    result: dict | None = None,
    error: str = "",
):
    await set_agent_step(
        state,
        lambda s: _save_state(s["job_id"], s),
        name=name,
        status=status,
        message=message,
        progress=progress,
        attempt=attempt,
        result=result,
        error=error,
    )


POSTER_PLAN_SYSTEM = """You are a senior poster art director and research communication agent.
Return JSON only:
{
  "intent_summary": "short Chinese summary",
  "source_findings": ["facts, entities, metrics, product features, claims extracted from uploaded materials"],
  "reference_style": {
    "layout": "reference layout analysis",
    "palette": "color and mood",
    "typography": "type style and information density",
    "composition": "poster structure"
  },
  "series_strategy": "how the posters differ while staying as a coherent set",
  "posters": [
    {
      "title": "poster title",
      "content_focus": "what this poster communicates",
      "layout_archetype": "distinct layout archetype for this poster",
      "difference_from_previous": "how this poster avoids repeating previous posters",
      "visual_plan": "layout and visual asset plan",
      "generation_prompt": "complete image2 prompt for this poster"
    }
  ],
  "quality_checks": ["checks before returning"]
}
Deeply read the uploaded materials. Extract real content before designing. Every poster in the series must have a different content angle and a visibly different layout archetype. Do not reuse the same hero image, centered exploded-view composition, title structure, or panel arrangement across posters. If a reference image exists, respect its layout density and composition language, but adapt style according to the user's requested style. For A3 posters, plan full-page polished information posters with no accidental blank areas. Do not invent unsupported data; if exact values are missing, describe qualitative insights instead."""


REFERENCE_STYLE_SYSTEM = """You are a visual style analyst.
Return concise JSON only:
{
  "layout": "grid, hierarchy, margins, poster density",
  "palette": "dominant colors and contrast",
  "typography": "title/body/number treatment",
  "composition": "major visual regions and how assets are arranged",
  "dimensions_hint": "portrait/landscape/square and likely aspect"
}"""


POSTER_REVIEW_SYSTEM = """You are a strict poster quality reviewer.
Return JSON only with pass (boolean), score (0-1), issues (short list), and repair_prompt (one concise visual correction instruction).
Judge visible relevance to the requested content focus, layout structure, readability, A3 composition, and whether this poster is distinct from the rest of the series. Do not expose private reasoning."""


async def _analyze_reference(state: dict) -> dict:
    # The start endpoint freezes the reviewer choice into state.  An empty
    # value deliberately means visual analysis is disabled; resolving it again
    # here would silently select a default paid model that was never reserved.
    model_id = str(state.get("vision_model_id") or "").strip()
    references = state.get("reference_assets") or []
    if not references or not model_id:
        return {}
    try:
        ref_images = await load_original_reference_bytes(references, user_id=state["user_id"])
        if not ref_images:
            return {}
        result = await _execute_poster_model_call(
            state=state,
            model_id=model_id,
            category="vision",
            description="海报参考图风格分析",
            operation="reference-analysis",
            material={
                "system": REFERENCE_STYLE_SYSTEM,
                "prompt": "Analyze this reference poster style for a poster-generation agent. Return JSON only.",
                "image": ref_images[0],
                "max_tokens": 900,
            },
            invoke=lambda: call_vision(
                model_id=model_id,
                system=REFERENCE_STYLE_SYSTEM,
                prompt="Analyze this reference poster style for a poster-generation agent. Return JSON only.",
                image_bytes=ref_images[0],
                max_tokens=900,
            ),
        )
        return _parse_json_object(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[Poster] reference analysis failed: %s", exc)
        return {}


async def _plan_posters(state: dict) -> dict:
    count = max(1, min(MAX_POSTERS, int(state.get("poster_count") or 1)))
    model_id = await provider_policy.choose_llm_model_id(state.get("llm_model_id"))
    fallback_posters = [
        {
            "title": "系列海报",
            "content_focus": f"{_poster_diversity_role(idx)['content_focus']}：{state.get('description', '')}",
            "layout_archetype": _poster_diversity_role(idx)["layout_archetype"],
            "difference_from_previous": "Use a different main composition and information structure from earlier posters.",
            "visual_plan": _poster_diversity_role(idx)["visual_plan"],
            "generation_prompt": (
                f"{state.get('description', '')}\n"
                f"Creative direction {idx + 1}: {_poster_diversity_role(idx)['content_focus']}.\n"
                f"Layout archetype: {_poster_diversity_role(idx)['layout_archetype']}."
            ).strip(),
        }
        for idx in range(count)
    ]
    if not model_id:
        return {
            "intent_summary": state.get("description", "")[:160],
            "source_findings": [],
            "reference_style": state.get("reference_style_analysis", {}),
            "series_strategy": "Create a coherent poster series with distinct content focus.",
            "posters": fallback_posters,
            "quality_checks": ["A3 aspect", "no awkward blank areas", "faithful to uploaded sources"],
        }

    user_msg = (
        f"User request:\n{state.get('description', '')}\n\n"
        f"Poster count: {count}\n"
        f"Size: {state.get('size')} ({_poster_output_size(state.get('size', 'a3_portrait'), state.get('output_resolution', '1k'))})\n"
        f"Output resolution: {state.get('output_resolution', '1k')}\n"
        f"Rendering quality: {state.get('image_quality', 'auto')}\n"
        f"Style hint: {state.get('style_hint') or 'Infer from request and sources'}\n"
    )
    if state.get("reference_style_analysis"):
        user_msg += f"\nReference image style analysis:\n{json.dumps(state['reference_style_analysis'], ensure_ascii=False)}\n"
    if state.get("attachment_context"):
        user_msg += f"\nUploaded source materials:\n{state['attachment_context'][:50000]}"

    try:
        raw = await _execute_poster_model_call(
            state=state,
            model_id=model_id,
            category="llm",
            description="海报智能体内容理解与系列规划",
            operation="series-plan",
            material={
                "system": POSTER_PLAN_SYSTEM,
                "user": user_msg,
                "max_tokens": 2400,
                "temperature": 0.25,
            },
            invoke=lambda: call_chat(
                model_id=model_id,
                system=POSTER_PLAN_SYSTEM,
                user=user_msg,
                max_tokens=2400,
                temperature=0.25,
            ),
        )
        plan = _parse_json_object(raw)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[Poster] planning failed, using fallback: %s", exc)
        plan = {
            "intent_summary": state.get("description", "")[:160],
            "source_findings": [],
            "reference_style": state.get("reference_style_analysis", {}),
            "series_strategy": "Create a coherent poster series with distinct content focus.",
            "posters": fallback_posters,
            "quality_checks": ["A3 aspect", "no awkward blank areas", "faithful to uploaded sources"],
        }

    posters = list(plan.get("posters") or [])[:count]
    while len(posters) < count:
        posters.append(fallback_posters[len(posters)])
    for idx, poster in enumerate(posters):
        role = _poster_diversity_role(idx)
        poster.pop("number", None)
        poster.setdefault("title", "系列海报")
        if not poster.get("content_focus"):
            poster["content_focus"] = f"{role['content_focus']}：{state.get('description', '')}"
        poster["layout_archetype"] = poster.get("layout_archetype") or role["layout_archetype"]
        poster["difference_from_previous"] = poster.get("difference_from_previous") or (
            "Use a different main composition and information structure from earlier posters."
        )
        if not poster.get("visual_plan"):
            poster["visual_plan"] = role["visual_plan"]
        if not poster.get("generation_prompt"):
            poster["generation_prompt"] = (
                f"{state.get('description', '')}\n"
                f"Creative direction {idx + 1}: {poster['content_focus']}.\n"
                f"Layout archetype: {poster['layout_archetype']}."
            ).strip()
    plan["posters"] = posters
    plan.setdefault("source_findings", [])
    plan.setdefault("reference_style", state.get("reference_style_analysis", {}))
    plan.setdefault("quality_checks", [])
    return plan

def _build_generation_prompt(state: dict, plan: dict, poster_plan: dict, repair: str = "") -> str:
    ref_style = json.dumps(plan.get("reference_style") or state.get("reference_style_analysis") or {}, ensure_ascii=False)
    findings = "\n".join(f"- {item}" for item in (plan.get("source_findings") or [])[:12])
    series_map = "\n".join(
        (
            f"- Poster {idx + 1}: {item.get('title')} | "
            f"focus: {item.get('content_focus')} | "
            f"layout: {item.get('layout_archetype') or _poster_diversity_role(idx)['layout_archetype']}"
        )
        for idx, item in enumerate(plan.get("posters") or [])
    )
    prompt = f"""
Create one polished A3 poster image.

Poster title: {poster_plan.get("title")}
Content focus: {poster_plan.get("content_focus")}
Required layout archetype: {poster_plan.get("layout_archetype")}
Difference from previous posters: {poster_plan.get("difference_from_previous")}
User request: {state.get("description", "")}
Style hint: {state.get("style_hint") or "use the best style inferred from source materials"}
Series strategy: {plan.get("series_strategy", "")}
Reference style analysis: {ref_style}

Full series map:
{series_map}

Visual plan:
{poster_plan.get("visual_plan", "")}

Poster-specific generation brief:
{poster_plan.get("generation_prompt", "")}

Source findings to use faithfully:
{findings}

Hard requirements:
- A3 poster composition, portrait unless user requested otherwise.
- If the reference image is provided, follow its information density, hierarchy, and poster-like composition.
- Use the requested style adaptation, for example green low-carbon / energy-saving style when requested.
- Do not add serial numbers such as 01/02/03 unless the user explicitly asks for numbered posters.
- This poster must be different in content from the other posters in the series.
- This poster must use the required layout archetype. Do not reuse another poster's main layout, hero image arrangement, centered exploded-view composition, title stack, or panel grid.
- If another poster already uses a large central product/subject hero, this poster must choose a different main composition such as a map, process lane, dashboard, comparison board, instruction sequence, or modular index.
- Fill the poster intentionally; avoid large accidental blank areas.
- Use uploaded materials as factual constraints. Do not invent exact numbers not present in the materials.
- Keep text short, legible, and poster-like.
""".strip()
    if state.get("attachment_context"):
        prompt += "\n\nRelevant uploaded material excerpts:\n" + state["attachment_context"][:18000]
    if repair:
        prompt += "\n\nRepair previous generation issue:\n" + repair
    return prompt


class PosterVariantReactState(TypedDict, total=False):
    state: dict
    plan: dict
    poster_plan: dict
    poster_index: int
    poster_count: int
    model_id: str
    review_model_id: str
    ref_images: list[bytes]
    state_lock: object
    final_prompt: str
    candidate_image: bytes
    review: dict
    quality_review: dict
    repair_prompt: str
    repair_attempt: int
    outcome: Literal["review", "repair", "accepted", "awaiting_user"]


async def _update_poster_variant_step(
    react_state: PosterVariantReactState,
    *,
    status: str,
    progress: int,
    message: str,
    error: str = "",
    attempt: int = 1,
    result: dict | None = None,
) -> None:
    state = react_state["state"]
    poster_index = int(react_state["poster_index"])
    poster_count = int(react_state["poster_count"])
    step_name = f"image2_poster_{poster_index + 1:02d}"

    async def save() -> None:
        _set_poster_generation_status(
            state,
            poster_index,
            "running" if status != "failed" else "failed",
            progress=progress,
            message=message,
            error=error,
        )
        await _poster_step(
            state,
            name=step_name,
            status=status,
            message=message,
            progress=progress,
            attempt=attempt,
            result=result,
            error=error,
        )
        await _save_state(state["job_id"], state)

    lock = react_state.get("state_lock")
    if lock:
        async with lock:
            await save()
    else:
        await save()


async def _poster_variant_generate_node(react_state: PosterVariantReactState) -> dict:
    state = react_state["state"]
    poster_index = int(react_state["poster_index"])
    poster_count = int(react_state["poster_count"])
    attempt = max(1, int(react_state.get("repair_attempt") or 1))
    repair_prompt = str(react_state.get("repair_prompt") or "").strip()
    prompt = _build_generation_prompt(
        state,
        react_state["plan"],
        react_state["poster_plan"],
        repair_prompt,
    )
    output_size = _poster_output_size(
        state.get("size", "a3_portrait"),
        state.get("output_resolution", "1k"),
    )
    image_quality = state.get("image_quality", "auto")
    progress = 36 + int((poster_index / max(poster_count, 1)) * 12)
    await _update_poster_variant_step(
        react_state,
        status="running",
        progress=progress,
        message=(
            f"正在按检查建议修正第 {poster_index + 1}/{poster_count} 张海报：{repair_prompt}"
            if attempt > 1 and repair_prompt
            else f"正在生成第 {poster_index + 1}/{poster_count} 张海报..."
        ),
        attempt=attempt,
        result={"repair_reason": repair_prompt, "poster_index": poster_index} if repair_prompt else {"poster_index": poster_index},
    )
    try:
        image_bytes = await _execute_poster_model_call(
            state=state,
            model_id=react_state["model_id"],
            category="generate",
            description=f"海报 image2 生成 · 第 {poster_index + 1} 张",
            operation=f"poster-{poster_index + 1}:generate",
            attempt=attempt,
            material={
                "prompt": prompt,
                "reference_images": react_state["ref_images"],
                "size": output_size,
                "quality": image_quality,
                "force_size": True,
            },
            invoke=lambda: call_image(
                model_id=react_state["model_id"],
                prompt=prompt,
                ref_images=react_state["ref_images"],
                size=output_size,
                quality=image_quality,
                force_size=True,
            ),
        )
        return {"candidate_image": image_bytes, "final_prompt": prompt, "outcome": "review"}
    except Exception as exc:
        error = str(exc) or repr(exc)
        await _update_poster_variant_step(
            react_state,
            status="failed",
            progress=progress,
            message=f"第 {poster_index + 1} 张海报未返回结果。",
            error=error,
            attempt=attempt,
            result={"repair_reason": repair_prompt, "poster_index": poster_index} if repair_prompt else {"poster_index": poster_index},
        )
        raise


async def _poster_variant_review_node(react_state: PosterVariantReactState) -> dict:
    model_id = str(react_state.get("review_model_id") or "")
    if not model_id:
        return {"outcome": "accepted"}
    state = react_state["state"]
    poster_index = int(react_state["poster_index"])
    poster_plan = react_state["poster_plan"]
    attempt = max(1, int(react_state.get("repair_attempt") or 1))
    review_prompt = (
        f"User request: {state.get('description', '')}\n"
        f"Content focus: {poster_plan.get('content_focus', '')}\n"
        f"Required layout: {poster_plan.get('layout_archetype', '')}\n"
        f"Visual plan: {poster_plan.get('visual_plan', '')}"
    )
    try:
        raw = await _execute_poster_model_call(
            state=state,
            model_id=model_id,
            category="vision",
            description=f"海报视觉检查 · 第 {poster_index + 1} 张",
            operation=f"poster-{poster_index + 1}:review",
            attempt=attempt,
            material={
                "system": POSTER_REVIEW_SYSTEM,
                "prompt": review_prompt,
                "image": react_state["candidate_image"],
                "max_tokens": 500,
            },
            invoke=lambda: call_vision(
                model_id=model_id,
                system=POSTER_REVIEW_SYSTEM,
                prompt=review_prompt,
                image_bytes=react_state["candidate_image"],
                max_tokens=500,
            ),
        )
        verdict = _parse_json_object(raw)
        score = float(verdict.get("score") or 0)
        passed = verdict.get("pass") is True or (verdict.get("pass") is None and score >= 0.72)
        if passed:
            return {"outcome": "accepted"}
        repair = str(verdict.get("repair_prompt") or "优化画面层级、主体聚焦和版式可读性").strip()
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("[Poster] visual review unavailable, accepting candidate: %s", exc)
        return {"outcome": "accepted"}

    review = {
        "score": score,
        "issues": [str(item)[:240] for item in (verdict.get("issues") or []) if str(item).strip()][:4],
        "repair_prompt": repair,
    }
    if attempt < 2:
        await _update_poster_variant_step(
            react_state,
            status="running",
            progress=48 + int((poster_index / max(int(react_state["poster_count"]), 1)) * 12),
            message=f"第 {poster_index + 1} 张海报检查发现问题，正在自动修正：{repair}",
            attempt=attempt + 1,
            result={"repair_reason": repair, "poster_index": poster_index, "issues": review["issues"]},
        )
        return {
            "review": review,
            "repair_prompt": repair,
            "repair_attempt": attempt + 1,
            "outcome": "repair",
        }
    return {"review": review, "outcome": "awaiting_user"}


async def _poster_variant_prepare_revision_request_node(react_state: PosterVariantReactState) -> dict:
    review = react_state.get("review") or {}
    issues = [str(item)[:240] for item in (review.get("issues") or []) if str(item).strip()][:4]
    repair_prompt = str(review.get("repair_prompt") or "优化主体聚焦、版式层级和文字可读性。").strip()
    quality_review = {
        "kind": "quality_review",
        "poster_index": int(react_state["poster_index"]),
        "message": (
            f"第 {int(react_state['poster_index']) + 1} 张海报已经生成。"
            f"检查建议：{'；'.join(issues) or '可进一步优化画面表达'}。"
        ),
        "current_result_available": True,
        "score": review.get("score"),
        "issues": issues,
        "repair_prompt": repair_prompt,
        "actions": ["keep_current", "create_revision"],
    }
    return {"quality_review": quality_review}


def _after_poster_variant_generate(react_state: PosterVariantReactState) -> str:
    return "review"


def _after_poster_variant_review(react_state: PosterVariantReactState) -> str:
    outcome = str(react_state.get("outcome") or "awaiting_user")
    return outcome if outcome in {"accepted", "repair"} else "awaiting_user"


def _build_poster_variant_react_graph():
    graph = StateGraph(PosterVariantReactState)
    graph.add_node("generate_candidate", _poster_variant_generate_node)
    graph.add_node("repair_candidate", _poster_variant_generate_node)
    graph.add_node("review_candidate", _poster_variant_review_node)
    graph.add_node("prepare_revision_request", _poster_variant_prepare_revision_request_node)
    graph.add_node("accepted", lambda _: {})
    graph.add_node("awaiting_user", lambda _: {})
    graph.add_edge(START, "generate_candidate")
    graph.add_conditional_edges(
        "generate_candidate",
        _after_poster_variant_generate,
        {"review": "review_candidate"},
    )
    graph.add_conditional_edges(
        "review_candidate",
        _after_poster_variant_review,
        {"accepted": "accepted", "repair": "repair_candidate", "awaiting_user": "prepare_revision_request"},
    )
    graph.add_edge("repair_candidate", "review_candidate")
    graph.add_edge("prepare_revision_request", "awaiting_user")
    graph.add_edge("accepted", END)
    graph.add_edge("awaiting_user", END)
    return graph.compile()


_POSTER_VARIANT_REACT_GRAPH = _build_poster_variant_react_graph()


async def _run_poster_variant_react(**kwargs) -> PosterVariantReactState:
    return await _POSTER_VARIANT_REACT_GRAPH.ainvoke(kwargs)


async def _record_message(state: dict, role: str, content: str, meta: dict | None = None):
    conv_id = state.get("conversation_id")
    if not conv_id:
        return None
    try:
        return await conversation_repo.add_message(conv_id, role, content, meta or {})
    except Exception as exc:
        logger.warning("[Poster] conversation message write failed: %s", exc)
        return None


def _poster_request_meta(state: dict) -> dict:
    return {
        "type": "poster_request",
        "job_id": state.get("job_id"),
        "poster_count": state.get("poster_count"),
        "size": state.get("size"),
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "style_hint": state.get("style_hint"),
        "make_public": bool(state.get("make_public")),
        "creative_skill": state.get("creative_skill"),
        "user_description": state.get("user_description", ""),
        "attachments": [
            {"filename": item.get("filename"), "kind": item.get("kind"), "size": item.get("size")}
            for item in state.get("attachments", [])
        ],
    }


def _poster_public_gallery_result(state: dict) -> dict:
    images: list[dict] = []
    for poster in state.get("posters", []) or []:
        if not isinstance(poster, dict):
            continue
        versions = [version for version in poster.get("versions", []) if isinstance(version, dict)]
        if not versions:
            continue
        selected_idx = poster.get("selected_version_index")
        if not isinstance(selected_idx, int) or selected_idx < 0 or selected_idx >= len(versions):
            selected_idx = len(versions) - 1
        version = versions[selected_idx]
        images.append({
            "assetId": version.get("assetId") or version.get("asset_id") or "",
            "imageUrl": version.get("imageUrl") or version.get("image_url") or version.get("renderedUrl") or "",
            "previewUrl": version.get("previewUrl") or version.get("preview_url") or "",
            "thumbnailUrl": version.get("thumbnailUrl") or version.get("thumbnail_url") or "",
            "prompt": version.get("userPrompt") or version.get("prompt") or state.get("description", ""),
            "final_prompt": version.get("prompt") or state.get("description", ""),
            "title": version.get("title") or poster.get("title") or "",
        })
    return {
        "images": images,
        "final_prompt": state.get("description", ""),
        "model_id": state.get("image_model_id", ""),
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "output_size": state.get("output_size") or _poster_output_size(
            state.get("size", "a3_portrait"),
            state.get("output_resolution", "1k"),
        ),
        "size": state.get("size", "a3_portrait"),
    }


async def _submit_public_gallery_if_needed(state: dict):
    if not state.get("make_public") or state.get("public_gallery_submitted"):
        return
    if not settings.PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED:
        state["make_public"] = False
        state["public_gallery_submitted"] = True
        state["public_gallery_skipped"] = True
        state["public_gallery_skipped_count"] = 0
        await _save_state(state["job_id"], state)
        return
    result = _poster_public_gallery_result(state)
    if not result.get("images"):
        return
    try:
        submit_result = await public_gallery_repo.publish_generation_result(
            user_id=state["user_id"],
            task_id=None,
            source_task_id=state.get("job_id") or "",
            prompt=str(state.get("description") or ""),
            module="POSTER_GEN",
            source="poster",
            result=result,
            reward_per_image=public_gallery_repo.PUBLIC_REWARD_CREDITS_PER_IMAGE,
        )
        state["public_gallery_submitted"] = True
        state["public_gallery_submitted_count"] = int(submit_result.get("submitted_count") or 0)
        state["public_gallery_skipped_count"] = int(submit_result.get("skipped_count") or 0)
        state["public_gallery_rewarded_credits"] = 0.0
        await _save_state(state["job_id"], state)
    except Exception as exc:
        logger.warning("[Poster] public gallery submit failed: job_id=%s error=%s", state.get("job_id"), exc)


async def _ensure_request_message(state: dict):
    conv_id = state.get("conversation_id")
    user_id = state.get("user_id")
    job_id = state.get("job_id")
    if not conv_id or not user_id or not job_id or state.get("request_message_id"):
        return
    try:
        messages = await conversation_repo.get_conversation_messages(conv_id, user_id, light=True)
        for message in messages:
            meta = message.get("meta") or {}
            if meta.get("job_id") == job_id and meta.get("type") in {"poster_request", "poster_artifact"}:
                state["request_message_id"] = message.get("id") or ""
                return
    except Exception as exc:
        logger.warning("[Poster] request message check failed: %s", exc)

    message = await _record_message(
        state,
        "user",
        state.get("description", ""),
        _poster_request_meta(state),
    )
    if message:
        state["request_message_id"] = message.get("id") or ""


async def _ensure_conversation(state: dict):
    if state.get("conversation_id"):
        try:
            if await conversation_repo.conversation_belongs_to_user(state["conversation_id"], state["user_id"]):
                await _ensure_request_message(state)
                return
            logger.warning("[Poster] conversation %s is unavailable, creating a replacement", state.get("conversation_id"))
            state["conversation_id"] = ""
        except Exception as exc:
            logger.warning("[Poster] conversation ownership check failed: %s", exc)
            state["conversation_id"] = ""
    try:
        conv = await conversation_repo.create_conversation(
            user_id=state["user_id"],
            conv_type="poster",
            title=(state.get("description") or "海报生成")[:80],
            creation_key=(f"poster:{state.get('client_request_id')}" if state.get("client_request_id") else None),
        )
        state["conversation_id"] = conv["id"]
        await _ensure_request_message(state)
        await _save_state(state["job_id"], state)
    except Exception as exc:
        logger.warning("[Poster] conversation create failed: %s", exc)


async def _attach_poster_assets_to_message(state: dict, message_id: str):
    if not message_id:
        return
    asset_ids: set[str] = set()
    for poster in state.get("posters", []):
        for version in poster.get("versions", []):
            asset_id = version.get("assetId") or version.get("asset_id")
            if asset_id:
                asset_ids.add(str(asset_id))
    for asset_id in asset_ids:
        try:
            await image_asset_repo.attach_message(asset_id, message_id)
        except Exception as exc:
            logger.warning(
                "[Poster] asset message attach failed: asset_id=%s message_id=%s error=%s",
                asset_id,
                message_id,
                exc,
            )


async def _save_artifact_message(state: dict):
    await _ensure_conversation(state)
    posters_meta = []
    for poster in state.get("posters", []):
        versions = poster.get("versions", [])
        selected = poster.get("selected_version_index", -1)
        posters_meta.append({
            "id": poster.get("id"),
            "poster_index": poster.get("poster_index"),
            "number": poster.get("number"),
            "title": poster.get("title"),
            "content_focus": poster.get("content_focus"),
            "layout_archetype": poster.get("layout_archetype"),
            "difference_from_previous": poster.get("difference_from_previous"),
            "visual_plan": poster.get("visual_plan"),
            "selected_version_index": selected,
            "versions": _compact_versions_for_history(versions),
            "generation_status": poster.get("generation_status"),
            "generation_progress": poster.get("generation_progress", 0),
            "generation_message": poster.get("generation_message", ""),
            "generation_error": poster.get("generation_error", ""),
            "quality_review": poster.get("quality_review", {}),
            "refine_status": poster.get("refine_status", "idle"),
            "refine_progress": poster.get("refine_progress", 0),
            "refine_message": poster.get("refine_message", ""),
            "refine_error": poster.get("refine_error", ""),
        })
    signature = json.dumps(
        {
            "posters": [
                {
                    "id": poster.get("id"),
                    "version_ids": [version.get("id") for version in poster.get("versions", [])],
                }
                for poster in posters_meta
            ],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    if state.get("artifact_message_signature") == signature:
        return
    saved = await _record_message(
        state,
        "assistant",
        f"已生成 {len(posters_meta)} 张海报，可继续单张编辑或下载。",
        {
            "type": "poster_artifact",
            "job_id": state.get("job_id"),
            "agent_plan": state.get("agent_plan"),
            "agent_steps": state.get("agent_steps", []),
            "posters": posters_meta,
            "selected_versions": state.get("selected_versions", []),
            "size": state.get("size"),
            "output_resolution": state.get("output_resolution", "1k"),
            "image_quality": state.get("image_quality", "auto"),
            "make_public": bool(state.get("make_public")),
        },
    )
    if not saved:
        state["artifact_persist_error"] = "poster_artifact message write failed"
        return
    state["artifact_message_signature"] = signature
    state["artifact_message_id"] = saved.get("id") or ""
    state.pop("artifact_persist_error", None)
    await _attach_poster_assets_to_message(state, state["artifact_message_id"])
    await _save_state(state["job_id"], state)


@router.post("/start")
async def start_generation(body: PosterStartRequest, user: dict = Depends(_auth)):
    submit_key = module_submit_idempotency_key(
        module="poster",
        user_id=user["id"],
        client_request_id=body.client_request_id,
    )
    if not submit_key:
        return await _start_generation(body, user)

    duplicate = await claim_submit_key(submit_key)
    if duplicate:
        return duplicate
    try:
        result = await _start_generation(body, user)
    except Exception:
        await forget_submit_key(submit_key)
        raise
    await remember_submit_key(submit_key, result)
    return result


async def _start_generation(body: PosterStartRequest, user: dict):
    user_id = user["id"]
    user_description = body.description.strip()
    description = user_description
    poster_count = max(1, min(MAX_POSTERS, body.poster_count))
    size = body.size if body.size in POSTER_SIZE_MAP else "a3_portrait"
    output_resolution = normalize_output_resolution(body.output_resolution)
    image_quality = normalize_image_quality(body.image_quality)
    llm_model_request = body.llm_model_id or ""
    image_model_request = body.image_model_id or ""
    vision_model_request = body.vision_model_id or ""
    make_public = bool(body.make_public)
    skill_audit_meta: dict[str, object] = {}
    skill_display_name = ""

    skill_id = body.skill_id.strip()[:160]
    if skill_id:
        skill = await creative_style_repo.get_style_preset(skill_id)
        if not skill or skill.get("enabled") is False:
            raise HTTPException(404, "灵感配方不存在或已停用")
        current_revision = int(skill.get("revision") or 1)
        if body.skill_revision and body.skill_revision != current_revision:
            raise HTTPException(409, "灵感配方已更新，请重新选择后再提交")
        submitted_image_count = len(body.reference_assets) or (1 if body.ref_image_b64 else 0)
        try:
            resolved_skill = resolve_creative_skill_submission(
                skill,
                expected_module="POSTER_GEN",
                user_prompt=user_description,
                image_count=submitted_image_count,
            )
        except CreativeSkillResolutionError as exc:
            status_code = 404 if exc.code == "skill_disabled" else 400
            raise HTTPException(status_code, str(exc)) from exc
        description = resolved_skill.instruction
        skill_display_name = str(skill.get("name") or skill_id)
        skill_audit_meta = {
            **resolved_skill.audit_meta(),
            "resolved_params": resolved_skill.params,
        }
        allowed_overrides = set(resolved_skill.constraints.get("user_overrides", []))
        locked_defaults = {
            key: value
            for key, value in resolved_skill.params.items()
            if key not in allowed_overrides
        }
        if "model_id" in locked_defaults:
            image_model_request = str(locked_defaults["model_id"])
        if "llm_model_id" in locked_defaults:
            llm_model_request = str(locked_defaults["llm_model_id"])
        if "size" in locked_defaults:
            size = str(locked_defaults["size"])
        if "output_resolution" in locked_defaults:
            output_resolution = normalize_output_resolution(str(locked_defaults["output_resolution"]))
        if "image_quality" in locked_defaults:
            image_quality = normalize_image_quality(str(locked_defaults["image_quality"]))
        if "poster_count" in locked_defaults or "count" in locked_defaults:
            poster_count = max(1, min(MAX_POSTERS, int(locked_defaults.get("poster_count", locked_defaults.get("count", 1)) or 1)))
        if "make_public" in locked_defaults:
            make_public = bool(locked_defaults["make_public"])
    elif not description:
        raise HTTPException(400, "请输入海报需求，或选择一个可直接运行的灵感配方")

    if not settings.PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED:
        make_public = False

    llm_model_id = await provider_policy.choose_llm_model_id(llm_model_request)
    image_model_id = await provider_policy.choose_image_model_id(image_model_request)
    # Visual QA is opt-in for poster jobs. Do not silently add a paid reviewer
    # when older clients omit the field; explicit selections are still honored.
    vision_model_id = (
        await provider_policy.choose_vision_model_id(vision_model_request)
        if vision_model_request else ""
    )
    llm_call_cost = 0.0
    if llm_model_id:
        llm_call_cost = await check_model_call(
            user_id=user_id,
            model_id=llm_model_id,
            expected_category="llm",
            description="海报智能体规划",
        )
    if not image_model_id:
        raise HTTPException(400, "未配置图像生成模型，请在管理端配置 image2/generate 模型")
    image_call_cost = await check_model_call(
        user_id=user_id,
        model_id=image_model_id,
        expected_category="generate",
        description="海报 image2 生成",
    )
    vision_call_cost = 0.0
    if vision_model_id:
        vision_call_cost = await check_model_call(
            user_id=user_id,
            model_id=vision_model_id,
            expected_category="vision",
            description="海报视觉检查",
        )
    job_id = str(uuid.uuid4())
    try:
        reference_assets = await canonicalize_image_asset_references(
            references=body.reference_assets,
            legacy_image_base64=body.ref_image_b64 or "",
            user_id=user_id,
            category="poster-reference",
            task_id=job_id,
        )
    except ImageAssetReferenceError as exc:
        raise HTTPException(422, str(exc)) from exc
    reserved_cost = _poster_generation_reservation_amount(
        poster_count=poster_count,
        llm_call_cost=llm_call_cost,
        image_call_cost=image_call_cost,
        vision_call_cost=vision_call_cost,
        has_reviewer=bool(vision_model_id),
        has_reference=bool(reference_assets),
    )
    attachment_context = (body.attachment_context or "").strip() or build_attachment_context(body.attachments or [])
    resolved_poster_size = size if size in POSTER_SIZE_MAP else "a3_portrait"
    state = {
        "job_id": job_id,
        "user_id": user_id,
        "conversation_id": body.conversation_id or "",
        "client_request_id": body.client_request_id.strip()[:128],
        "status": "generating",
        "progress": 0,
        "message": "正在初始化海报智能体...",
        "error": "",
        "description": description,
        "user_description": user_description,
        "poster_count": poster_count,
        "size": resolved_poster_size,
        "output_resolution": output_resolution,
        "output_size": _poster_output_size(resolved_poster_size, output_resolution),
        "image_quality": image_quality,
        "style_hint": body.style_hint or "",
        "reference_assets": [item.model_dump() for item in reference_assets],
        "attachments": body.attachments or [],
        "attachment_context": attachment_context,
        "llm_model_id": llm_model_id,
        "image_model_id": image_model_id,
        "vision_model_id": vision_model_id,
        "make_public": make_public,
        "creative_skill": skill_audit_meta or None,
        "skill_name": skill_display_name,
        "reference_style_analysis": {},
        "agent_plan": {},
        "agent_steps": [],
        "posters": [_poster_placeholder(i) for i in range(poster_count)],
        "selected_versions": [],
        "reserved_cost": reserved_cost,
    }
    contract = build_delivery_contract(
        module="poster",
        action="create",
        instruction=description,
        context={
            "poster_count": poster_count,
            "size": resolved_poster_size,
            "attachment_count": len(body.attachments or []),
            "reference_count": len(reference_assets),
            "creative_skill": skill_audit_meta or None,
        },
    )
    state["delivery_contract"] = contract.model_dump()
    if reserved_cost > 0 and not await reserve_for_task(user_id, job_id, reserved_cost):
        available = await get_available_balance(user_id)
        raise HTTPException(
            402,
            f"积分不足或计费保护服务暂不可用。本任务最多需要占用 {reserved_cost:g} 积分，当前可用 {available:.2f}。",
        )

    try:
        await _ensure_conversation(state)
        try:
            run = await create_module_run(
                user_id=user_id,
                module="poster",
                action="create",
                instruction=description,
                context={
                    "poster_count": poster_count,
                    "size": resolved_poster_size,
                    "attachment_count": len(body.attachments or []),
                    "reference_count": len(reference_assets),
                    "creative_skill": skill_audit_meta or None,
                },
                conversation_id=state.get("conversation_id") or "",
                contract=contract,
            )
            state["agent_run_id"] = run["run_id"]
        except Exception as exc:
            logger.warning("[Poster] failed to create top-level agent run job_id=%s error=%s", job_id, exc)
        await _save_state(job_id, state)
        await enqueue(
            task_type="poster",
            task_id=job_id,
            payload={"job_id": job_id, "user_id": user_id},
            priority="normal",
            user_id=user_id,
        )
    except HTTPException:
        await _release_poster_generation_reservation(job_id)
        raise
    except Exception as exc:
        logger.exception("[Poster] enqueue failed: job_id=%s", job_id)
        state["status"] = "failed"
        state["error"] = "海报任务提交到队列失败，请稍后重试。"
        state["message"] = state["error"]
        try:
            await _save_state(job_id, state)
        except Exception:
            logger.warning("[Poster] failed to persist submission error job_id=%s", job_id, exc_info=True)
        await _release_poster_generation_reservation(job_id)
        raise HTTPException(503, state["error"]) from exc
    logger.info("[Poster] queued generation job: job_id=%s user=%s", job_id, user_id)
    return {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id"),
        "status": "generating",
        "creative_skill": skill_audit_meta or None,
    }


async def run_poster_job_from_queue(job_id: str):
    try:
        await run_specialist_graph(
            module="poster",
            job_id=job_id,
            load_state=lambda: _load_state(job_id),
            execute=lambda: _run_with_running_lock(job_id, lambda: _run_generation(job_id)),
        )
    finally:
        await _release_poster_generation_reservation(job_id)


async def _run_generation(job_id: str):
    state = await _load_state(job_id)
    if not state:
        return

    sem = _get_user_sem(state["user_id"])
    async with sem:
        try:
            await _ensure_conversation(state)
            expected_count = _poster_count(state)
            expected_label = _poster_word(expected_count)

            await _poster_step(
                state,
                name="source_intake",
                status="running",
                message="正在读取附件和参考图，提取主题、素材线索和风格约束...",
                progress=8,
            )
            if state.get("reference_assets"):
                state["reference_style_analysis"] = await _analyze_reference(state)
            await _poster_step(
                state,
                name="source_intake",
                status="completed",
                message=f"资料输入已整理完成，开始规划{expected_label}。",
                progress=18,
                result={
                    "attachments": [item.get("filename") for item in state.get("attachments", [])],
                    "has_reference": bool(state.get("reference_assets")),
                    "reference_style": state.get("reference_style_analysis", {}),
                },
            )

            await _poster_step(
                state,
                name="series_planning",
                status="running",
                message=(
                    f"正在理解内容并规划 {expected_count} 张海报的画面结构..."
                    if expected_count > 1
                    else "正在理解内容并规划海报画面结构..."
                ),
                progress=24,
            )
            plan = await _plan_posters(state)
            state["agent_plan"] = plan
            for idx, poster_plan in enumerate(plan.get("posters", [])):
                if idx < len(state["posters"]):
                    state["posters"][idx].update({
                        "number": "",
                        "title": poster_plan.get("title", "系列海报"),
                        "content_focus": poster_plan.get("content_focus", ""),
                        "layout_archetype": poster_plan.get("layout_archetype", ""),
                        "difference_from_previous": poster_plan.get("difference_from_previous", ""),
                        "visual_plan": poster_plan.get("visual_plan", ""),
                        "prompt": poster_plan.get("generation_prompt", ""),
                    })
            await _poster_step(
                state,
                name="series_planning",
                status="completed",
                message=(
                    "海报规划完成，开始并行调用 image2 生成。"
                    if expected_count > 1
                    else "海报规划完成，开始调用 image2 生成。"
                ),
                progress=34,
                result={
                    "intent_summary": plan.get("intent_summary"),
                    "source_findings": plan.get("source_findings", [])[:8],
                    "series_strategy": plan.get("series_strategy"),
                    "posters": [
                        {
                            "title": item.get("title"),
                            "content_focus": item.get("content_focus"),
                            "layout_archetype": item.get("layout_archetype"),
                        }
                        for item in plan.get("posters", [])
                    ],
                },
            )

            model_id = await provider_policy.choose_image_model_id(state.get("image_model_id"))
            if not model_id:
                raise RuntimeError("未配置图像生成模型，请在管理端配置 image2/generate 模型")
            state["image_model_id"] = model_id
            ref_images = await load_original_reference_bytes(
                state.get("reference_assets") or [],
                user_id=state["user_id"],
            )

            poster_plans = plan.get("posters", [])
            count = len(poster_plans)
            state_lock = asyncio.Lock()
            completed_count = 0
            failure_count = 0

            async def generate_one_poster(idx: int, poster_plan: dict):
                nonlocal completed_count, failure_count
                step_name = f"image2_poster_{idx + 1:02d}"
                try:
                    react_state = await _run_poster_variant_react(
                        state=state,
                        plan=plan,
                        poster_plan=poster_plan,
                        poster_index=idx,
                        poster_count=count,
                        model_id=model_id,
                        review_model_id=state.get("vision_model_id") or "",
                        ref_images=ref_images,
                        state_lock=state_lock,
                    )
                    image_bytes = react_state.get("candidate_image")
                    if not image_bytes:
                        raise RuntimeError("海报生成未返回图片结果")
                    prompt = str(react_state.get("final_prompt") or _build_generation_prompt(state, plan, poster_plan, ""))
                    image_b64 = base64.b64encode(image_bytes).decode()
                    asset_meta = await _store_poster_asset(state, idx, image_b64, prompt, model_id)
                    async with state_lock:
                        _append_poster_version(
                            state,
                            idx,
                            image_b64,
                            prompt,
                            poster_plan.get("title", ""),
                            asset_meta,
                            user_prompt=state.get("description", ""),
                        )
                        quality_review = react_state.get("quality_review")
                        poster = _ensure_poster_slot(state, idx)
                        poster["quality_review"] = quality_review or {}
                        if quality_review:
                            state.setdefault("quality_reviews", []).append(quality_review)
                        _set_poster_generation_status(
                            state,
                            idx,
                            "completed",
                            progress=100,
                            message=(
                                f"第 {idx + 1} 张海报已生成，等待你决定是否创建修订版。"
                                if quality_review else f"第 {idx +1} 张海报已生成。"
                            ),
                        )
                        completed_count += 1
                        state["status"] = "generating"
                        state["progress"] = min(98, 36 + int((completed_count / max(count, 1)) * 60))
                        state["message"] = f"已完成 {completed_count}/{count} 张海报，剩余海报仍在并行生成。"
                        await _poster_step(
                            state,
                            name=step_name,
                            status="completed",
                            message=(
                                f"第 {idx + 1} 张海报已生成，已提供可选修订建议。"
                                if quality_review else f"第 {idx + 1} 张海报已生成。"
                            ),
                            progress=state["progress"],
                            attempt=1,
                            result={"quality_review": quality_review} if quality_review else None,
                        )
                        await _save_state(job_id, state)
                        await _save_artifact_message(state)
                    return None
                except Exception as exc:
                    error = str(exc) or repr(exc)
                    async with state_lock:
                        failure_count += 1
                        _set_poster_generation_status(
                            state,
                            idx,
                            "failed",
                            progress=100,
                            message=f"第 {idx + 1} 张海报生成失败。",
                            error=error,
                        )
                        await _poster_step(
                            state,
                            name=step_name,
                            status="failed",
                            message=f"第 {idx + 1} 张海报生成失败。",
                            progress=min(98, 36 + int(((completed_count + failure_count) / max(count, 1)) * 60)),
                            attempt=1,
                            error=error,
                        )
                        await _save_state(job_id, state)
                    return exc

            async def generate_one_poster_item(item: tuple[int, dict]):
                idx, poster_plan = item
                return await generate_one_poster(idx, poster_plan)

            results = await gather_limited(
                list(enumerate(poster_plans)),
                settings.TASK_FANOUT_CONCURRENCY,
                generate_one_poster_item,
                return_exceptions=True,
            )
            failures = [result for result in results if isinstance(result, BaseException)]
            if failures and not any(_poster_has_image(poster) for poster in state.get("posters", [])):
                raise failures[0]

            state["status"] = "preview"
            state["progress"] = 100
            quality_reviews = [item for item in state.get("quality_reviews", []) if isinstance(item, dict)]
            state["quality_review"] = {
                "kind": "quality_review",
                "message": "当前海报已经生成。部分结果有可选修订建议，请查看对应海报后再决定是否创建新版本。",
                "current_result_available": True,
                "items": quality_reviews,
                "actions": ["keep_current", "create_revision"],
            } if quality_reviews else {}
            state["message"] = (
                f"海报已完成 {completed_count}/{count} 张，{failure_count} 张失败，可先编辑或下载已完成海报。"
                if failure_count
                else (
                    "海报已全部生成完成，可以单张编辑、选择版本或下载。"
                    if expected_count > 1
                    else "海报已生成完成，可以继续编辑、选择版本或下载。"
                )
            )
            await _save_state(job_id, state)
            await _save_artifact_message(state)
            await _submit_public_gallery_if_needed(state)
            return
        except Exception as exc:
            logger.exception("[Poster] job %s failed", job_id)
            state["status"] = "failed"
            state["progress"] = 100
            state["error"] = str(exc) or repr(exc)
            state["message"] = state["error"]
            await _save_state(job_id, state)
            await _record_message(state, "assistant", f"海报生成失败：{state['error']}", {"type": "poster_error", "job_id": job_id})


@router.get("/status/{job_id}")
async def get_status(job_id: str, user: dict = Depends(_auth)):
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    payload = {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id", ""),
        "status": state.get("status"),
        "progress": state.get("progress", 0),
        "message": state.get("message", ""),
        "error": state.get("error", ""),
        "poster_count": state.get("poster_count", 0),
        "size": state.get("size", "a3_portrait"),
        "output_resolution": state.get("output_resolution", "1k"),
        "image_quality": state.get("image_quality", "auto"),
        "agent_run_id": state.get("agent_run_id", ""),
        "delivery_contract": state.get("delivery_contract", {}),
        "intervention": state.get("intervention", {}),
        "quality_review": state.get("quality_review", {}),
        "agent_plan": state.get("agent_plan", {}),
        "agent_steps": state.get("agent_steps", []),
        "posters": _compact_posters_for_status(state.get("posters", [])),
        "selected_versions": state.get("selected_versions", []),
    }
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


@router.get("/history")
async def list_poster_history(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(_auth),
):
    rows = await conversation_repo.list_poster_history_summaries(user["id"], limit=limit, offset=offset)
    prepared_rows = await asset_storage.prepare_image_asset_payload(rows, user["id"])
    return [history_artifacts.poster_history_item(row) for row in prepared_rows]


@router.post("/refine/{job_id}")
async def refine_poster(job_id: str, body: PosterRefineRequest, user: dict = Depends(_auth)):
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    if body.poster_index >= len(state.get("posters", [])):
        raise HTTPException(400, "海报序号不存在")
    if not body.prompt.strip():
        raise HTTPException(400, "修改提示词不能为空")

    poster = _ensure_poster_slot(state, body.poster_index)
    if not poster.get("versions"):
        raise HTTPException(400, "该海报还没有生成可编辑的图片")
    merge_attachment_state(state, body.attachments, body.attachment_context)
    # A refinement is a new, user-approved image call. Preserve the current
    # version but clear the review prompt that led to this decision.
    poster["quality_review"] = {}
    state["quality_reviews"] = [
        item for item in state.get("quality_reviews", [])
        if int(item.get("poster_index", -1)) != body.poster_index
    ]
    if not state["quality_reviews"]:
        state["quality_review"] = {}
    if state.get("status") not in {"generating", "failed"}:
        state["status"] = "preview"
    state["message"] = f"已提交第 {body.poster_index + 1} 张海报的编辑任务..."
    state["error"] = ""
    _set_poster_refine_status(
        state,
        body.poster_index,
        "queued",
        progress=1,
        message=f"第 {body.poster_index + 1} 张海报编辑等待中...",
    )
    await _save_state(job_id, state)
    await _record_message(
        state,
        "user",
        f"修改第 {body.poster_index + 1} 张海报：{body.prompt.strip()}",
        {"type": "poster_refine_request", "job_id": job_id, "poster_index": body.poster_index},
    )
    queue_task_id = f"{job_id}:refine:{uuid.uuid4().hex[:8]}"
    try:
        await enqueue(
            task_type="poster-refine",
            task_id=queue_task_id,
            payload={
                "job_id": job_id,
                "poster_index": body.poster_index,
                "feedback": body.prompt.strip(),
                "image_model_id": body.image_model_id,
                "user_id": user["id"],
            },
            priority="normal",
            user_id=user["id"],
        )
    except Exception as exc:
        logger.exception("[Poster] refine enqueue failed: job_id=%s", job_id)
        state["status"] = "preview"
        state["error"] = "海报编辑任务提交到队列失败，请稍后重试。"
        state["message"] = state["error"]
        await _save_state(job_id, state)
        raise HTTPException(503, state["error"]) from exc
    logger.info(
        "[Poster] queued refine job: job_id=%s poster_index=%s queue_task_id=%s",
        job_id,
        body.poster_index,
        queue_task_id,
    )
    return {"job_id": job_id, "status": "refining"}


@router.post("/quality-review/{job_id}")
async def keep_poster_quality_review(
    job_id: str,
    body: PosterQualityReviewDecisionRequest,
    user: dict = Depends(_auth),
):
    """Persist the user's decision to keep the delivered poster as-is."""
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    if body.poster_index >= len(state.get("posters", [])):
        raise HTTPException(400, "海报序号不存在")
    poster = _ensure_poster_slot(state, body.poster_index)
    poster["quality_review"] = {}
    state["quality_reviews"] = [
        item for item in state.get("quality_reviews", [])
        if int(item.get("poster_index", -1)) != body.poster_index
    ]
    if not state["quality_reviews"]:
        state["quality_review"] = {}
    await _save_state(job_id, state)
    await _record_message(
        state,
        "assistant",
        f"已保留第 {body.poster_index + 1} 张海报当前版本。",
        {"type": "poster_quality_review_kept", "job_id": job_id, "poster_index": body.poster_index},
    )
    return {"ok": True, "job_id": job_id, "status": state.get("status")}


async def run_poster_refine_from_queue(
    job_id: str,
    poster_index: int,
    feedback: str,
    image_model_id: Optional[str],
):
    await run_specialist_graph(
        module="poster",
        job_id=job_id,
        load_state=lambda: _load_state(job_id),
        execute=lambda: _run_with_running_lock(
            job_id,
            lambda: _run_refine(job_id, poster_index, feedback, image_model_id),
        ),
        force_execute=True,
    )


async def _run_refine(job_id: str, poster_index: int, feedback: str, image_model_id: Optional[str]):
    state = await _load_state(job_id)
    if not state:
        return
    sem = _get_user_sem(state["user_id"])
    async with sem:
        try:
            poster = _ensure_poster_slot(state, poster_index)
            versions = poster.get("versions", [])
            selected_idx = int(poster.get("selected_version_index", len(versions) - 1))
            if not versions or selected_idx < 0:
                raise RuntimeError("当前海报没有可编辑的图片版本")
            selected_idx = min(max(selected_idx, 0), len(versions) - 1)
            source_b64 = versions[selected_idx].get("renderedB64", "")
            model_id = await provider_policy.choose_image_model_id(image_model_id or state.get("image_model_id"))
            if not model_id:
                raise RuntimeError("未配置图像生成模型")
            state["image_model_id"] = model_id

            prompt = (
                "Edit this A3 poster with image2. Apply the user's revision precisely, keep the layout full and polished, "
                "and keep text short/readable. Do not add serial numbers such as 01/02/03 unless the user explicitly asks for them.\n\n"
                f"Poster title: {poster.get('title')}\n"
                f"Original focus: {poster.get('content_focus')}\n"
                f"User revision: {feedback}\n"
            )
            if state.get("attachment_context"):
                prompt += "\nSource material constraints:\n" + state["attachment_context"][:12000]

            _set_poster_refine_status(
                state,
                poster_index,
                "running",
                progress=20,
                message=f"正在用 image2 编辑第 {poster_index + 1} 张海报...",
            )
            if state.get("status") not in {"generating", "failed"}:
                state["status"] = "preview"
            await _save_state(job_id, state)
            await _poster_step(
                state,
                name=f"refine_poster_{poster_index + 1:02d}",
                status="running",
                message=f"正在用 image2 编辑第 {poster_index + 1} 张海报并生成新版本...",
                progress=55,
            )
            source_image = base64.b64decode(_strip_data_url(source_b64))
            output_size = _poster_output_size(
                state.get("size", "a3_portrait"),
                state.get("output_resolution", "1k"),
            )
            image_quality = state.get("image_quality", "auto")
            image_bytes = await _execute_poster_model_call(
                state=state,
                model_id=model_id,
                category="generate",
                description=f"海报 image2 编辑 · 第 {poster_index + 1} 张",
                operation=f"poster-{poster_index + 1}:refine-version-{len(versions) + 1}",
                material={
                    "prompt": prompt,
                    "reference_images": [source_image],
                    "size": output_size,
                    "quality": image_quality,
                    "force_size": True,
                },
                invoke=lambda: call_image(
                    model_id=model_id,
                    prompt=prompt,
                    ref_images=[source_image],
                    size=output_size,
                    quality=image_quality,
                    force_size=True,
                ),
            )
            image_b64 = base64.b64encode(image_bytes).decode()
            asset_meta = await _store_poster_asset(state, poster_index, image_b64, prompt, model_id)
            latest = await _load_state(job_id) or state
            state = latest
            poster = _ensure_poster_slot(state, poster_index)
            _append_poster_version(
                state,
                poster_index,
                image_b64,
                prompt,
                poster.get("title", ""),
                asset_meta,
                user_prompt=feedback,
            )
            _set_poster_refine_status(
                state,
                poster_index,
                "completed",
                progress=100,
                message=f"第 {poster_index + 1} 张海报已生成新版本。",
            )
            if state.get("status") != "generating":
                state["status"] = "preview"
                state["progress"] = 100
            state["message"] = f"第 {poster_index + 1} 张海报已生成新版本。"
            await _poster_step(
                state,
                name=f"refine_poster_{poster_index + 1:02d}",
                status="completed",
                message=state["message"],
                progress=100,
            )
            await _save_state(job_id, state)
            await _save_artifact_message(state)
        except Exception as exc:
            latest = await _load_state(job_id) or state
            state = latest
            _set_poster_refine_status(
                state,
                poster_index,
                "failed",
                progress=100,
                message=f"第 {poster_index + 1} 张海报编辑失败。",
                error=str(exc) or repr(exc),
            )
            if state.get("status") != "generating":
                state["status"] = "preview" if any(_poster_has_image(p) for p in state.get("posters", [])) else "failed"
            state["error"] = f"海报编辑失败：{exc}"
            state["message"] = state["error"]
            await _save_state(job_id, state)


@router.post("/select-version/{job_id}")
async def select_version(job_id: str, body: PosterSelectVersionRequest, user: dict = Depends(_auth)):
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    posters = state.get("posters", [])
    if body.poster_index >= len(posters):
        raise HTTPException(400, "海报序号不存在")
    versions = posters[body.poster_index].get("versions", [])
    if body.version_index >= len(versions):
        raise HTTPException(400, "版本不存在")
    posters[body.poster_index]["selected_version_index"] = body.version_index
    state["selected_versions"] = [int(p.get("selected_version_index", -1)) for p in posters]
    await _save_state(job_id, state)
    return {"ok": True, "selected_versions": state["selected_versions"]}


@router.post("/confirm/{job_id}")
async def confirm_generation(job_id: str, user: dict = Depends(_auth)):
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    state["status"] = "done"
    state["message"] = state.get("message") or "海报已生成，可以继续编辑或下载。"
    state["progress"] = 100
    await _save_state(job_id, state)
    return {
        "ok": True,
        "conversation_id": state.get("conversation_id", ""),
        "posters": _compact_posters_for_status(state.get("posters", [])),
        "selected_versions": state.get("selected_versions", []),
    }


@router.get("/result/{job_id}")
async def get_result(
    job_id: str,
    poster_index: int = Query(0, ge=0),
    version_index: int | None = Query(default=None, ge=0),
    user: dict = Depends(_auth),
):
    state = await _load_state(job_id)
    if not state:
        raise HTTPException(404, "任务不存在或已过期")
    if state.get("user_id") != user["id"]:
        raise HTTPException(403, "无权访问")
    posters = state.get("posters", [])
    if poster_index >= len(posters):
        raise HTTPException(400, "海报序号不存在")
    poster = posters[poster_index]
    versions = poster.get("versions", [])
    if not versions:
        raise HTTPException(400, "该海报还没有生成结果")
    selected_idx = poster.get("selected_version_index", len(versions) - 1) if version_index is None else version_index
    selected_idx = min(max(int(selected_idx), 0), len(versions) - 1)
    version = versions[selected_idx]
    image_b64 = version.get("renderedB64", "")
    image_url = version.get("imageUrl") or version.get("renderedUrl") or ""
    asset_id = version.get("assetId") or version.get("asset_id") or ""
    if asset_id and not image_url:
        image_url = f"asset:{asset_id}"
    if not image_b64 and not image_url:
        raise HTTPException(400, "图片数据为空")
    if image_b64:
        data = base64.b64decode(_strip_data_url(image_b64))
    elif image_url.startswith("asset:"):
        data, _ = await asset_storage.fetch_image_asset_variant(image_url.split(":", 1)[1], user["id"], "original")
    else:
        data = await asset_storage.fetch_asset_bytes(image_url)
    filename = f"poster_{job_id[:8]}_{poster_index + 1:02d}_v{selected_idx + 1}.png"
    return Response(
        content=data,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/optimize")
async def optimize_prompt(body: PosterOptimizeRequest, user: dict = Depends(_auth)):
    model_id = await provider_policy.choose_llm_model_id(body.llm_model_id)
    attachment_context = (body.attachment_context or "").strip() or build_attachment_context(body.attachments or [])
    if not model_id:
        role_lines = "\n".join(
            f"方向 {idx + 1}：{role['content_focus']}，版式：{role['layout_archetype']}"
            for idx, role in enumerate(POSTER_DIVERSITY_ROLES[: body.poster_count])
        )
        return {
            "optimized": (
                f"{body.description.strip()}\n\n"
                f"生成 {body.poster_count} 张 A3 系列海报，要求先提取附件内容，再为每张设计不同主题，整体风格统一但构图明显不同。\n"
                f"系列分工：\n{role_lines}"
            ).strip()
        }
    system_prompt = (
        "你是生产级海报生成的提示词策划师。只返回优化后的中文提示词，不要解释。"
        "优化结果必须适合 A3 系列海报生成：明确目标受众、核心信息、风格、参考图使用方式、附件内容提取方式、"
        "每张海报的独立主题和不同版式。必须避免多张海报重复同一主体构图或同一信息结构。"
    )
    user_prompt = (
        f"Original prompt:\n{body.description}\n\n"
        f"Poster count: {body.poster_count}\n"
        f"Style hint: {body.style_hint}\n"
        "Recommended diversity roles:\n"
        + "\n".join(
            f"Creative direction {idx + 1}: {role['content_focus']} | {role['layout_archetype']}"
            for idx, role in enumerate(POSTER_DIVERSITY_ROLES[: body.poster_count])
        )
        + "\n\n"
        f"Uploaded context:\n{attachment_context[:12000]}"
    )
    request_id = body.client_request_id.strip()[:160] or str(uuid.uuid4())
    raw = await execute_billed_model_call(
        user_id=user["id"],
        model_id=model_id,
        expected_category="llm",
        description="海报提示词优化",
        related_task_id=None,
        idempotency_key=model_billing_operation_key(
            namespace="poster",
            user_id=user["id"],
            operation_scope=f"optimize:{request_id}",
            material={
                "model_id": model_id,
                "system": system_prompt,
                "user": user_prompt,
                "max_tokens": 1200,
                "temperature": 0.35,
            },
        ),
        invoke=lambda: call_chat(
            model_id=model_id,
            system=system_prompt,
            user=user_prompt,
            max_tokens=1200,
            temperature=0.35,
        ),
    )
    return {"optimized": raw.strip() or body.description}
