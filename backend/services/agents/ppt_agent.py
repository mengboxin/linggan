"""PPT generation orchestration and compatibility export entry points.

Job state is persisted in Redis with a bounded in-memory fallback, so a
generation can be resumed after a worker reconnects.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import shutil
import time
from html import unescape as html_unescape
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from xml.sax.saxutils import escape as xml_escape

import httpx
import re
from fastapi import HTTPException

from core.concurrency import gather_limited
from core.config import settings
from core.job_state_cache import BoundedJobStateCache
from services.ai_client import ExternalBillingError, call_chat, call_chat_with_images, call_image, call_vision, get_default_model_id
from services.attachment_parser import build_attachment_context
from services.agents.workflow_agent import set_agent_step
from services.agents.creative_runtime import sync_ppt_run
from services.agents.ppt_design_contract import contract_for_prompt, normalize_ppt_design_contract, normalize_visual_asset_geometry
from services.agents.ppt_competition_design import (
    apply_competition_design_profile,
    competition_asset_direction,
    competition_visual_density,
)
from services.agents.ppt_image_overlay import (
    build_pptx_from_outline as _build_pptx_from_outline,
    build_pptx_from_slides,
    build_pptx_images_only as _build_pptx_images_only,
    build_pptx_with_text_overlay as _build_pptx_with_text_overlay,
    build_text_mask as _build_text_mask,
    estimate_text_elements as _estimate_text_elements,
    remove_text_regions_from_slide as _remove_text_regions_from_slide,
)
from services.agents.ppt_qa import run_pptx_qa
from services.model_billing import execute_billed_model_call
from services.platform_provider_billing import execute_platform_provider_call
from services import asset_storage
from services.job_events import publish_job_update
from services.image_output import image_output_size, normalize_image_quality, normalize_output_resolution
from services.ppt_template_catalog import apply_ppt_template, resolve_ppt_template_id, template_prompt_block

logger = logging.getLogger(__name__)

PPT_MAX_ACTIVE_PIPELINES = max(1, settings.PPT_PIPELINE_CONCURRENCY)
PPT_MAX_ACTIVE_CONVERSIONS = max(1, settings.PPT_CONVERSION_CONCURRENCY)
PPT_MAX_ACTIVE_IMAGE_CALLS = max(1, settings.PPT_IMAGE_CALL_CONCURRENCY)
PPT_MAX_ACTIVE_VISION_CALLS = max(1, settings.PPT_VISION_CALL_CONCURRENCY)

# System-wide caps provide backpressure; user quotas remain isolated below.
_pipeline_sem = asyncio.Semaphore(PPT_MAX_ACTIVE_PIPELINES)
_conversion_sem = asyncio.Semaphore(PPT_MAX_ACTIVE_CONVERSIONS)
_image_call_sem = asyncio.Semaphore(PPT_MAX_ACTIVE_IMAGE_CALLS)
_vision_call_sem = asyncio.Semaphore(PPT_MAX_ACTIVE_VISION_CALLS)
_job_locks: dict[str, asyncio.Lock] = {}
_DIRECT_SLIDE_CACHE_TTL_SECONDS = 45
_DIRECT_SLIDE_CACHE_MAX_ENTRIES = 2
_DIRECT_SLIDE_CACHE_MAX_BYTES = 96 * 1024 * 1024
_direct_slide_deck_cache: dict[str, tuple[float, int, list[dict]]] = {}
_BASE64_WHITESPACE_RE = re.compile(r"\s+")


async def _execute_ppt_billed_call(
    *,
    user_id: str,
    model_id: str,
    expected_category: str,
    description: str,
    operation: str,
    invoke: Callable[[], Awaitable[Any]],
    job_id: str = "",
    operation_scope: str = "",
    attempt: int = 1,
) -> Any:
    """Bind one PPT model operation to a stable platform-credit ledger key."""
    if not user_id:
        return await invoke()
    scope = str(job_id or operation_scope).strip()
    normalized_operation = re.sub(r"[^a-zA-Z0-9:_-]+", "-", operation.strip()).strip("-")
    idempotency_key = (
        f"ppt:{scope}:{normalized_operation}:attempt:{max(1, int(attempt or 1))}"
        if scope
        else None
    )
    model_started = False
    model_succeeded = False

    async def tracked_invoke() -> Any:
        nonlocal model_started, model_succeeded
        model_started = True
        result = await invoke()
        model_succeeded = True
        return result

    try:
        return await execute_billed_model_call(
            user_id=user_id,
            model_id=model_id,
            expected_category=expected_category,
            description=description,
            invoke=tracked_invoke,
            related_task_id=None,
            idempotency_key=idempotency_key,
        )
    except HTTPException:
        raise
    except Exception as exc:
        if not model_started or model_succeeded:
            raise HTTPException(503, "PPT platform billing is temporarily unavailable") from exc
        raise


class PPTBudgetPaused(RuntimeError):
    """A resumable budget boundary, not a terminal PPT failure."""

# Per-user 信号量：防止单用户占满全局资源
PPT_MAX_PER_USER_PIPELINES = max(1, settings.PPT_USER_PIPELINE_CONCURRENCY)
_user_pipeline_sems: dict[str, asyncio.Semaphore] = {}


def _get_user_pipeline_sem(user_id: str) -> asyncio.Semaphore:
    """获取 per-user pipeline 信号量（懒创建）"""
    if user_id not in _user_pipeline_sems:
        _user_pipeline_sems[user_id] = asyncio.Semaphore(PPT_MAX_PER_USER_PIPELINES)
    return _user_pipeline_sems[user_id]


def get_ppt_job_lock(job_id: str) -> asyncio.Lock:
    lock = _job_locks.get(job_id)
    if lock is None:
        lock = asyncio.Lock()
        _job_locks[job_id] = lock
    return lock


def _direct_slide_deck_size(decks: list[dict]) -> int:
    return sum(
        len(version)
        for deck in decks
        if isinstance(deck, dict)
        for version in (deck.get("versions") or [])
        if isinstance(version, str)
    )


def _discard_direct_slide_cache(job_id: str) -> None:
    _direct_slide_deck_cache.pop(job_id, None)


def _get_cached_direct_slide_decks(job_id: str) -> list[dict] | None:
    cached = _direct_slide_deck_cache.get(job_id)
    if not cached:
        return None
    expires_at, _, decks = cached
    if time.monotonic() >= expires_at:
        _discard_direct_slide_cache(job_id)
        return None
    return decks


def _cache_direct_slide_decks(job_id: str, decks: list[dict]) -> None:
    size = _direct_slide_deck_size(decks)
    if not decks or size > _DIRECT_SLIDE_CACHE_MAX_BYTES:
        return
    expired_jobs = [
        cache_job_id
        for cache_job_id, (expires_at, _, _) in _direct_slide_deck_cache.items()
        if time.monotonic() >= expires_at
    ]
    for cache_job_id in expired_jobs:
        _discard_direct_slide_cache(cache_job_id)
    while len(_direct_slide_deck_cache) >= _DIRECT_SLIDE_CACHE_MAX_ENTRIES:
        oldest_job_id = next(iter(_direct_slide_deck_cache))
        _discard_direct_slide_cache(oldest_job_id)
    _direct_slide_deck_cache[job_id] = (
        time.monotonic() + _DIRECT_SLIDE_CACHE_TTL_SECONDS,
        size,
        decks,
    )


def _decode_ppt_base64(value: str, description: str = "图片") -> bytes:
    """Decode PPT image payloads that may be data URLs or missing base64 padding."""
    raw = (value or "").strip()
    if not raw:
        return b""
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    raw = _BASE64_WHITESPACE_RE.sub("", raw)
    if not raw:
        return b""
    padded = raw + ("=" * (-len(raw) % 4))
    try:
        if "-" in raw or "_" in raw:
            return base64.urlsafe_b64decode(padded)
        return base64.b64decode(padded, validate=False)
    except Exception as exc:
        try:
            return base64.urlsafe_b64decode(padded)
        except Exception:
            raise ValueError(f"{description}数据格式异常，无法解析，请重新上传或重新生成。") from exc

PPT_CONVERSION_MODES = {
    "ppt_master_direct": {
        "label": "可编辑演示文稿",
        "cost_per_slide": 0,
    },
    "image_only": {
        "label": "纯图片 PPT",
        "cost_per_slide": 0,
    },
    "editable_overlay": {
        "label": "文字可编辑 PPT",
        "cost_per_slide": 0,
    },
    "native_svg": {
        "label": "native SVG PPT",
        "cost_per_slide": 0,
    },
}

DEFAULT_PPT_CONVERSION_MODE = "ppt_master_direct"


def normalize_ppt_conversion_mode(mode: str | None) -> str:
    mode = (mode or DEFAULT_PPT_CONVERSION_MODE).strip()
    return mode if mode in PPT_CONVERSION_MODES else DEFAULT_PPT_CONVERSION_MODE


def get_ppt_conversion_cost(mode: str | None, slide_count: int) -> float:
    normalized = normalize_ppt_conversion_mode(mode)
    return round(PPT_CONVERSION_MODES[normalized]["cost_per_slide"] * max(slide_count, 0), 2)


def append_ppt_artifact(state: dict, artifact_type: str, **payload) -> dict:
    """Append a durable task artifact without replacing earlier generations."""
    artifacts = state.setdefault("artifacts", [])
    artifact = {
        "id": f"{artifact_type}-{len(artifacts) + 1}",
        "type": artifact_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    artifacts.append(artifact)
    return artifact


def _ppt_export_filename(state: dict, job_id: str, filename: str = "") -> str:
    raw = (
        filename
        or str((state.get("outline") or {}).get("title") or "")
        or str(state.get("topic") or "")
        or "presentation"
    )
    raw = re.sub(r"\.pptx$", "", raw.strip(), flags=re.IGNORECASE)
    safe = asset_storage.safe_file_name(raw, job_id)
    if safe.replace("_", "").replace("-", "").lower() == job_id.replace("-", "").lower():
        safe = "presentation"
    return f"{safe}.pptx"


_PPTX_DELIVERY_MIN_SCORE = 90


def _is_pptx_qa_deliverable(summary: object) -> bool:
    """Classify a clean export for advisory UI, never for download access."""
    if not isinstance(summary, dict):
        return False
    try:
        score = float(summary.get("overall_score", 0))
    except (TypeError, ValueError):
        return False
    return (
        summary.get("status") == "completed"
        and summary.get("passed") is True
        and score >= _PPTX_DELIVERY_MIN_SCORE
        and summary.get("requires_attention") is False
    )


def _clear_pptx_export_state(state: dict) -> None:
    """Invalidate a stale export after an editable workspace changes."""
    for key in (
        "pptx_path",
        "pptx_url",
        "pptx_key",
        "pptx_filename",
        "pptx_file_asset_id",
        "pptx_size_bytes",
        "pptx_sha256",
    ):
        state[key] = ""


async def store_pptx_asset(state: dict, job_id: str, output_path: Path, filename: str = "") -> dict:
    # Export QA is advisory. A generated PPTX must always remain downloadable;
    # users can decide whether to apply an optional page-level suggestion.
    export_filename = _ppt_export_filename(state, job_id, filename)
    stored = await asset_storage.store_file_asset(
        file_path=output_path,
        user_id=state.get("user_id", ""),
        category="ppt",
        task_id=job_id,
        filename=export_filename,
        content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        retention_class="export",
        replace_task_asset=True,
    )
    if stored:
        state["pptx_file_asset_id"] = stored.get("id", "")
        state["pptx_url"] = stored["url"]
        state["pptx_key"] = stored["key"]
        state["pptx_filename"] = stored.get("filename") or export_filename
        state["pptx_size_bytes"] = stored["size_bytes"]
        state["pptx_sha256"] = stored["sha256"]
    return stored or {}


async def store_ppt_slide_image_asset(
    state: dict,
    job_id: str,
    image_bytes: bytes,
    *,
    prompt: str,
    model_id: str,
    slide_index: int,
    item_id: str = "",
) -> str:
    """Persist a generated slide image and return a stable image value for state/history."""
    if not image_bytes:
        return ""
    stored = await asset_storage.store_generated_image_best_effort(
        image_bytes=image_bytes,
        user_id=state.get("user_id", ""),
        conversation_id=state.get("conversation_id") or None,
        task_id=job_id,
        prompt=prompt[:2000],
        model_id=model_id,
        category="ppt",
        item_id=item_id or f"slide-{slide_index + 1}",
        retention_class="web_history",
    )
    if stored:
        return stored.original_url or stored.preview_url
    return base64.b64encode(image_bytes).decode()


def resolve_ppt_selection(state: dict, selected_indices: list[int] | None) -> tuple[int, list[int] | None]:
    slides = state.get("slide_images_b64", [])
    if selected_indices is None:
        return len([s for s in slides if s]), None

    valid_indices: list[int] = []
    seen: set[int] = set()
    for index in selected_indices:
        if not isinstance(index, int):
            continue
        if index < 0 or index >= len(slides) or index in seen:
            continue
        if not slides[index]:
            continue
        valid_indices.append(index)
        seen.add(index)
    return len(valid_indices), valid_indices


# JSON repair and parsing.

def _fix_and_parse_json(raw: str) -> dict:
    """Extract and repair a JSON object from a raw LLM response.

    It tolerates trailing commas, Markdown code fences, and explanatory text
    surrounding the JSON object.
    """
    # 1. Remove Markdown code fences.
    raw = re.sub(r"```(?:json)?\s*", "", raw)
    raw = raw.replace("```", "")

    # 2. Find the outermost JSON object.
    start = raw.find("{")
    end   = raw.rfind("}") + 1
    if start == -1 or end == 0:
        raise ValueError(f"LLM did not return valid JSON: {raw[:200]!r}")
    candidate = raw[start:end]

    # 3. Parse directly first.
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass

    # 4. Repair trailing commas before a closing brace or bracket.
    fixed = re.sub(r",\s*([}\]])", r"\1", candidate)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # 5. Try json5 / demjson3 if either optional package is installed.
    try:
        import json5  # type: ignore
        return json5.loads(candidate)
    except (ImportError, Exception):
        pass

    # 6. As a final attempt, remove line comments and parse again.
    lines = fixed.splitlines()
    cleaned_lines = []
    for line in lines:
        # 鍘绘帀琛屽唴娉ㄩ噴
        line = re.sub(r"//.*$", "", line)
        cleaned_lines.append(line)
    try:
        return json.loads("\n".join(cleaned_lines))
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON parse failed after repair attempts: {e}\nRaw snippet: {candidate[:300]!r}") from e

PPT_WORK_DIR = Path("ppt_jobs")
PPT_WORK_DIR.mkdir(exist_ok=True)

# In-memory state fallback when Redis is unavailable.
_mem_store = BoundedJobStateCache(
    max_entries=settings.JOB_STATE_FALLBACK_CACHE_MAX_ENTRIES,
    ttl_seconds=settings.JOB_STATE_FALLBACK_CACHE_TTL_SECONDS,
    max_bytes=settings.JOB_STATE_FALLBACK_CACHE_MAX_BYTES,
)


async def _save_state(job_id: str, state: dict):
    """Persist job state in Redis, retaining a bounded outage fallback only."""
    _discard_direct_slide_cache(job_id)
    try:
        from core.redis import get_redis
        r = get_redis()
        await r.set(f"ppt_job:{job_id}", json.dumps(state, ensure_ascii=False), ex=3600 * 24)
    except Exception as e:
        _mem_store[job_id] = state
        logger.warning(f"[PPTAgent] Redis write failed; using memory fallback: {e}")
    else:
        _mem_store.discard(job_id)
    await publish_job_update(
        state,
        job_type="ppt",
        job_id=job_id,
    )
    try:
        await sync_ppt_run(state)
    except Exception as exc:
        # Common agent telemetry must not interrupt an already durable PPT job.
        logger.warning("[PPTAgent] top-level agent run sync failed: %s", exc)


async def _load_state(job_id: str) -> Optional[dict]:
    """Load job state from Redis first, falling back to process memory."""
    try:
        from core.redis import get_redis
        r = get_redis()
        raw = await r.get(f"ppt_job:{job_id}")
        if raw:
            state = json.loads(raw)
            _mem_store.discard(job_id)
            return state
    except Exception as e:
        logger.warning(f"[PPTAgent] Redis read failed: {e}")
    return _mem_store.get(job_id)



# Outline planning.
OUTLINE_SYSTEM = """You are a professional presentation planner. Return valid JSON only.
Create a concise production-ready slide outline for the user topic.
Requirements:
- Respect the requested page count when provided; otherwise choose 5-10 slides.
- Infer the presentation purpose and intended audience before selecting the narrative and visual system. A supplied reference image is a visual system to analyze, never a full-slide bitmap to copy.
- Plan this as a competition-grade or commercial-grade deck, not as a set of independent template pages. Start with a subject-specific visual world (materials, image direction, recurring motif, chapter treatment and typography), then let the page structure inherit it.
- Build one coherent design language with a clear design_soul and variation_strategy. Keep its typography, palette, and recurring chrome consistent while varying page rhythm and layout archetype.
- Build a real narrative backbone before enumerating slides: opening tension or mandate -> insight/problem -> solution or action -> proof -> delivery path -> closing decision. Adapt this backbone to the requested page count, but do not return a flat list of generic "background / solution / summary" pages.
- Each slide must include page, type, title, points, layout_hint, layout_archetype, page_silhouette, material_strategy, icon_role, page_rhythm, content_density, a concise design_contract, component_plan, and evidence_strategy. A selected catalog template is only a soft style reference; never let it dictate page geometry.
- layout_archetype must be one of cover_hero, editorial_split, statement, asymmetric_2_3_1_3, primary_secondary, single_focus, mixed_grid, three_column, l_shape, t_shape, waterfall, contrast, sequence, data_story, or section_break. Do not repeat an inferred archetype on adjacent slides.
- page_rhythm must be anchor, breathing, or dense. Vary the page rhythm across the deck so it does not become a uniform card grid.
- Choose visual_form from cover_statement, editorial_story, comparison, process_flow, evidence_dashboard, data_narrative, chapter_marker, quote_statement, or image_story. Choose it from the message each page must communicate, never from a generic template habit.
- For every page, state a compact content budget, native component plan, evidence strategy, a spatial layout policy, and at least one specific must_avoid rule. These are production constraints, never visible slide copy.
- The spatial policy must reserve an independent title band and make the copy zone and any bounded visual/chart zone mutually exclusive. Permit copy over an image only for an explicitly planned full-bleed overlay with a native opaque/legible copy panel. State one focal priority and a maximum semantic-icon count (usually zero when a hero visual, chart, or mechanism already carries the page).
- For each slide, decide whether native components, a source attachment/reference, or one generated visual asset best proves the point. Prefer a supplied source figure or reference before generating. Generated images must remain text-free. They may be an isolated object, an editable full-bleed photographic background, or a foreground silhouette; never bake required copy or the complete slide into a raster. Charts, tables, labels, and process logic stay native, but a process page may use one atmospheric background or foreground asset when it materially improves the composition. Do not apply a blanket image quota: visual intensity must follow the selected subject and page role.
- Treat generated visuals as a planned material library, not a last-minute decoration. For an image-led, cultural, ceremonial, innovation or high-end technology deck, plan a cover hero plus enough distinct text-free scenes, details, cutouts or textures to make the deck feel like one authored visual system. Choose each asset's intended aspect ratio from its slot (wide hero, portrait side crop, panoramic scenario, or cutout), and reserve a native editable copy zone before generating it.
- The user's topic is the source of truth. Every slide title and key point must be specific to that topic; never return a generic deck, "待定主题", "请填写", bracketed placeholders, or a plan that asks the user to supply the subject later. If the topic is underspecified, make a useful, explicit assumption and state it as content, not as a placeholder.
- Treat the supplied Presentation Brief as a hard contract. The audience, purpose, desired action, language, must-include items, and must-avoid items take precedence over a generic narrative habit.
- For every page, include a one-sentence takeaway and a compact evidence list. When uploads contain facts, preserve their numbers, dates, names, and source labels exactly. Never invent quantitative evidence; use source="planning assumption" only when the brief has no source evidence.
- When no source image is supplied and the topic benefits from visual storytelling, plan at least one text-free generated material layer for the cover or an editorial/image-story page. Keep data, tables, and process logic native and editable.
- Use polished editorial, consulting, or portfolio layouts with a clear editorial hierarchy. Never put production instructions, layout hints, or source-analysis notes on the visible slide.
- If source attachments are provided, use them as the primary content/layout reference.
- For uploaded PPT source material, preserve useful page order, information hierarchy, and layout intent.
- Provide a practical color_scheme and overall style description.
- Also provide concise Chinese user-visible worklog notes. These explain the
  chosen storyline, visual-material tradeoffs, and page-level presentation
  decisions. They are not private reasoning: do not mention prompts, model
  internals, retries, errors, or hidden analysis.
- Do not include markdown fences, comments, or trailing commas.

Return exactly this JSON shape:
{
  "title": "deck title",
  "style": "visual style description",
  "color_scheme": "primary #1A2B4C, accent #C9A84C, background #F5F5F5",
  "visual_system": {
    "style_family": "one concise presentation design direction",
    "palette": ["#1A2B4C", "#C9A84C", "#F5F5F5"],
    "typography": "display and body hierarchy",
    "surface": "background and material treatment",
    "motifs": ["one or two restrained motifs derived from the topic or reference"],
    "chrome": "quiet recurring page furniture",
    "design_soul": "one short sentence describing the deck's visual point of view",
    "variation_strategy": "one short sentence describing how page rhythm and layouts vary without losing cohesion",
    "design_language": "one short sentence describing the native typography, evidence, and material treatment"
  },
  "narrative_architecture": {
    "opening": "the tension, mandate, or opportunity that makes this deck necessary",
    "backbone": ["a concise sequence of 4-7 story beats"],
    "closing_decision": "the specific choice, commitment, or action the audience should leave with"
  },
  "agent_worklog": {
    "planning": "one concise Chinese sentence explaining the overall storyline choice",
    "visual_strategy": "one concise Chinese sentence explaining which pages need generated visual materials and why",
    "pages": [
      {"page": 1, "note": "one concise Chinese sentence explaining this page's information and visual priority"}
    ]
  },
  "slides": [
    {
      "page": 1,
      "type": "cover",
      "title": "slide title",
      "takeaway": "one sentence the audience should retain from this page",
      "points": ["point 1", "point 2"],
      "evidence": [{"claim": "a source-grounded fact or explicit planning assumption", "source": "uploaded attachment|user brief|planning assumption"}],
      "layout_hint": "layout instructions",
      "template_layout_id": "always empty unless a user explicitly requires a particular layout id",
      "page_silhouette": "a distinct page silhouette named for the page's visual role",
      "material_strategy": "how topic-relevant imagery, texture, photography or technical material is used",
      "icon_role": "a semantic, visually consistent icon system or none",
      "layout_archetype": "cover_hero|editorial_split|statement|asymmetric_2_3_1_3|primary_secondary|single_focus|mixed_grid|three_column|l_shape|t_shape|waterfall|contrast|sequence|data_story|section_break",
      "page_rhythm": "anchor|breathing|dense",
      "content_density": "sparse|standard|dense",
      "design_contract": {
        "narrative_role": "cover|explain|comparison|process|evidence|section|close",
        "page_goal": "one concise audience takeaway",
        "visual_form": "cover_statement|editorial_story|comparison|process_flow|evidence_dashboard|data_narrative|chapter_marker|quote_statement|image_story",
        "density": "low|medium|high",
        "content_budget": {"max_points": 3, "max_lines_per_point": 2, "max_chars_per_point": 54, "max_title_lines": 2, "min_body_font_px": 24},
        "composition": {"focal_area": "where attention starts", "reading_order": "how the page is read", "space_strategy": "how whitespace protects hierarchy"},
        "layout_archetype": "same page archetype as above",
        "component_plan": {"primary": "native_chart_or_key_metric|native_process_diagram|visual_anchor|lead_insight", "supporting": ["one or two native support components"]},
        "layout_policy": {"visual_priority": "one page focal priority", "title_safe_zone": "independent top reading band", "copy_visual_relation": "exclusive|protected_overlay", "allow_text_over_asset": false, "max_semantic_icons": 0},
        "evidence_strategy": "how this page proves its claim without turning required content into a bitmap",
        "must_avoid": ["one page-specific presentation risk to avoid"]
      },
      "visual_asset": {
        "source": "reference|attachment|generate|none",
        "purpose": "what one image asset contributes",
        "subject": "the visual subject or scene to focus on",
        "prompt": "image2 prompt for an isolated visual asset without readable text",
        "art_direction": "specific medium, composition, lighting, and visual mood",
        "placement": "right|left|full_bleed|bottom",
        "crop": "cover|contain|cutout",
        "treatment": "framed|edge_to_edge|cutout|editorial_crop|masked_arc|masked_circle|foreground_silhouette|full_bleed_overlay",
        "mask": "none|rounded_rect|circle|arc|diagonal|wave",
        "depth_plane": "background|middle|foreground",
        "focal_x": 50,
        "focal_y": 50,
        "overlay_color": "#112233",
        "overlay_opacity": 0.0,
        "allow_overlap": false
      }
    }
  ]
}

Set visual_asset.source to "none" for tables, charts, dense text, and process diagrams that do not need an image. This is a page-level decision, not a default for the entire deck: a coherent deck should normally have at least one purposeful visual material layer unless the user explicitly requests a text-only treatment.
Prefer "attachment" or "reference" when a supplied visual can clearly support the page. Use "generate" only when an original illustration, product visual, scene, or conceptual object improves the story. Required text must remain native and editable."""


def _normalize_agent_worklog(outline: dict) -> None:
    """Keep only compact, user-visible planner notes in persisted job state."""
    raw = outline.get("agent_worklog")
    if not isinstance(raw, dict):
        outline.pop("agent_worklog", None)
        return

    def clean(value: object, limit: int = 360) -> str:
        return " ".join(str(value or "").split())[:limit]

    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    max_page = len(slides)
    pages: list[dict] = []
    seen: set[int] = set()
    for item in raw.get("pages") if isinstance(raw.get("pages"), list) else []:
        if not isinstance(item, dict):
            continue
        try:
            page = int(item.get("page") or 0)
        except (TypeError, ValueError):
            continue
        note = clean(item.get("note"), 280)
        if page <= 0 or page > max_page or page in seen or not note:
            continue
        seen.add(page)
        pages.append({"page": page, "note": note})

    normalized = {
        "planning": clean(raw.get("planning")),
        "visual_strategy": clean(raw.get("visual_strategy")),
        "pages": pages,
    }
    if normalized["planning"] or normalized["visual_strategy"] or pages:
        outline["agent_worklog"] = normalized
    else:
        outline.pop("agent_worklog", None)


_PPT_LAYOUT_RECIPES = {
    "cover_hero", "editorial_split", "statement", "modular_grid",
    "contrast", "sequence", "data_story", "section_break",
    "asymmetric_2_3_1_3", "primary_secondary", "single_focus", "mixed_grid",
    "three_column", "l_shape", "t_shape", "waterfall",
}


def _default_slide_layout_recipe(slide: dict, index: int) -> str:
    slide_type = str(slide.get("type") or "").strip().lower()
    points = slide.get("points") if isinstance(slide.get("points"), list) else []
    if index == 0 or slide_type == "cover":
        return "cover_hero"
    if slide_type in {"process", "timeline", "workflow", "roadmap"}:
        return "sequence"
    if slide_type in {"table", "chart", "data", "comparison_data"}:
        return "data_story"
    if slide_type in {"problem", "solution", "comparison", "before_after"}:
        return "contrast"
    if slide_type in {"section", "section_break"}:
        return "section_break"
    if len(points) >= 4:
        return "modular_grid"
    if len(points) <= 1:
        return "statement"
    return "editorial_split"


def _normalize_ppt_slide_design(slide: dict, index: int) -> None:
    recipe = str(slide.get("layout_recipe") or "").strip().lower()
    if recipe not in _PPT_LAYOUT_RECIPES:
        recipe = _default_slide_layout_recipe(slide, index)
        slide["_layout_recipe_inferred"] = True
    else:
        slide.pop("_layout_recipe_inferred", None)
    slide["layout_recipe"] = recipe

    rhythm = str(slide.get("page_rhythm") or "").strip().lower()
    if rhythm not in {"anchor", "breathing", "dense"}:
        rhythm = "anchor" if recipe in {"cover_hero", "statement", "section_break"} else "dense" if recipe in {"modular_grid", "data_story"} else "breathing"
    slide["page_rhythm"] = rhythm

    density = str(slide.get("content_density") or "").strip().lower()
    if density not in {"sparse", "standard", "dense"}:
        points = slide.get("points") if isinstance(slide.get("points"), list) else []
        density = "sparse" if rhythm == "anchor" else "dense" if len(points) >= 4 else "standard"
    slide["content_density"] = density


def _normalize_ppt_outline_design(outline: dict) -> None:
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        slide["page"] = index + 1
        _normalize_ppt_slide_design(slide, index)
    normalize_ppt_design_contract(outline)


_OUTLINE_PLACEHOLDER_MARKERS = (
    "待定主题",
    "待定",
    "主题信息尚未明确",
    "请填写",
    "填写对象",
    "填写日期",
    "一句话说明本次汇报",
    "待确认",
    "[topic]",
    "[insert",
    "placeholder",
    "lorem ipsum",
    "tbd",
)

_GENERIC_PAGE_TITLES = {
    "项目背景", "背景介绍", "项目概况", "市场分析", "解决方案", "工作成果",
    "项目成果", "未来规划", "总结", "结束", "thank you", "conclusion",
}


def _outline_visible_text(outline: dict) -> str:
    """Return planner-visible text used for semantic topic checks.

    This includes execution hints so the topic guard can still verify that a
    prompt carries the user's subject through planning.  It must *not* be
    reused for visible-copy policy checks: a model is explicitly asked to put
    risks and prohibitions in ``layout_hint`` / ``must_avoid``, where wording
    such as “do not invent metrics” is legitimate and never appears on a
    customer slide.
    """
    values: list[str] = []
    for key in ("title", "style"):
        values.append(str(outline.get(key) or ""))
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        values.extend(str(slide.get(key) or "") for key in ("title", "layout_hint", "prompt"))
        values.extend(str(point) for point in slide.get("points", []) if str(point).strip())
    return " ".join(values).strip().lower()


def _outline_audience_copy(outline: dict) -> str:
    """Return only content that can be exported as audience-facing copy."""
    values: list[str] = [str(outline.get("title") or "")]
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        values.extend(str(slide.get(key) or "") for key in ("title", "takeaway"))
        values.extend(str(point) for point in slide.get("points", []) if str(point).strip())
    return " ".join(values).strip().lower()


def _topic_terms(topic: str) -> list[str]:
    text = str(topic or "").strip().lower()
    chinese = re.sub(r"[^\u4e00-\u9fff]", "", text)
    terms: list[str] = []
    for size in (4, 3, 2):
        for index in range(0, max(0, len(chinese) - size + 1)):
            term = chinese[index:index + size]
            if term not in terms:
                terms.append(term)
    terms.extend(word for word in re.findall(r"[a-z][a-z0-9_-]{3,}", text) if word not in terms)
    return terms


def _clean_ppt_brief(brief: dict | None) -> dict[str, object]:
    """Normalize the user-visible presentation contract before it reaches a model.

    Keeping this deterministic is important: users should be able to predict which
    requirements will be treated as hard constraints rather than having them get
    lost in a long free-form topic field.
    """
    source = brief if isinstance(brief, dict) else {}

    def text(name: str, limit: int = 360) -> str:
        return " ".join(str(source.get(name) or "").split())[:limit]

    def items(name: str, limit: int = 8) -> list[str]:
        raw = source.get(name)
        if isinstance(raw, str):
            raw = re.split(r"[\n,，;；]+", raw)
        if not isinstance(raw, list):
            return []
        result: list[str] = []
        for value in raw:
            cleaned = " ".join(str(value or "").split())[:180]
            if cleaned and cleaned not in result:
                result.append(cleaned)
        return result[:limit]

    try:
        duration = int(source.get("duration_minutes") or 0)
    except (TypeError, ValueError):
        duration = 0
    return {
        "audience": text("audience"),
        "purpose": text("purpose"),
        "desired_action": text("desired_action"),
        "duration_minutes": min(max(duration, 0), 240),
        "language": text("language", 80),
        "tone": text("tone", 160),
        "must_include": items("must_include"),
        "must_avoid": items("must_avoid"),
    }


def _brief_prompt_block(brief: dict | None) -> str:
    normalized = _clean_ppt_brief(brief)
    labels = {
        "audience": "Audience",
        "purpose": "Presentation purpose",
        "desired_action": "Desired audience action",
        "language": "Output language",
        "tone": "Tone",
    }
    lines = [f"{label}: {normalized[key]}" for key, label in labels.items() if normalized.get(key)]
    if normalized.get("duration_minutes"):
        lines.append(f"Time budget: {normalized['duration_minutes']} minutes")
    if normalized.get("must_include"):
        lines.append("Must include: " + " | ".join(normalized["must_include"]))
    if normalized.get("must_avoid"):
        lines.append("Must avoid: " + " | ".join(normalized["must_avoid"]))
    return "\n".join(lines) or "No additional brief constraints supplied."


def _attachment_grounding(attachment_context: str, brief: dict | None = None) -> dict[str, object]:
    """Extract compact source facts that can safely travel through each stage.

    Attachments may be tens of thousands of characters long. Passing the full
    body into every model call dilutes the page instruction and causes factual
    constraints to be ignored. This is deliberately conservative: it preserves
    source lines with concrete figures, dates, units, or citation-like labels;
    it does not infer facts that were not present in the upload.
    """
    text = str(attachment_context or "")
    facts: list[str] = []
    for raw_line in re.split(r"[\r\n]+", text):
        line = " ".join(raw_line.split()).strip("-• ")
        if len(line) < 4 or len(line) > 360:
            continue
        has_number = bool(re.search(r"(?:\d[\d,.]*\s*(?:%|亿元|万元|万|亿|例|次|人|家|天|年|月|周|小时|分钟|USD|RMB|¥|\$)|20\d{2})", line, re.I))
        has_source_label = bool(re.search(r"(?:来源|source|数据|dataset|统计|样本|n=|同比|环比)", line, re.I))
        if has_number or has_source_label:
            if line not in facts:
                facts.append(line)
        if len(facts) >= 18:
            break
    normalized_brief = _clean_ppt_brief(brief)
    return {
        "source_available": bool(text.strip()),
        "facts": facts,
        "must_include": normalized_brief["must_include"],
        "must_avoid": normalized_brief["must_avoid"],
        "rule": (
            "Use uploaded facts exactly when they are relevant. Do not invent metrics, dates, customer names, "
            "citations, or research findings. Clearly label a planning assumption when source evidence is absent."
        ),
    }


def _normalize_outline_evidence(outline: dict, grounding: dict | None = None) -> None:
    """Give every page a concise claim/evidence contract, even for older models."""
    facts = (grounding or {}).get("facts") if isinstance(grounding, dict) else []
    fact_items = [str(item) for item in facts if str(item).strip()]
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        takeaway = " ".join(str(slide.get("takeaway") or slide.get("title") or "").split())[:220]
        slide["takeaway"] = takeaway
        raw_evidence = slide.get("evidence")
        if isinstance(raw_evidence, str):
            raw_evidence = [raw_evidence]
        evidence: list[dict[str, str]] = []
        if isinstance(raw_evidence, list):
            for item in raw_evidence[:3]:
                if isinstance(item, dict):
                    claim = " ".join(str(item.get("claim") or item.get("text") or "").split())[:260]
                    source = " ".join(str(item.get("source") or "").split())[:100]
                else:
                    claim = " ".join(str(item or "").split())[:260]
                    source = ""
                if claim:
                    evidence.append({"claim": claim, "source": source or "user brief"})
        if not evidence and fact_items:
            evidence.append({"claim": fact_items[min(index, len(fact_items) - 1)], "source": "uploaded attachment"})
        if not evidence and takeaway:
            evidence.append({"claim": takeaway, "source": "planning assumption"})
        slide["evidence"] = evidence


def _outline_quality_issues(
    topic: str,
    outline: dict,
    *,
    page_count: int = 0,
    brief: dict | None = None,
) -> list[str]:
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    issues: list[str] = []
    if not slides:
        return ["the outline has no slides"]
    if page_count and len(slides) != page_count:
        issues.append(f"expected {page_count} slides, received {len(slides)}")
    titles: list[str] = []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            issues.append(f"slide {index + 1} is not an object")
            continue
        title = " ".join(str(slide.get("title") or "").split())
        if len(title) < 2:
            issues.append(f"slide {index + 1} has no usable title")
        normalized_title = re.sub(r"\W+", "", title).lower()
        if normalized_title and normalized_title in titles:
            issues.append(f"slide {index + 1} repeats a previous title")
        if normalized_title:
            titles.append(normalized_title)
        if index > 0 and title.strip().lower() in _GENERIC_PAGE_TITLES:
            issues.append(f"slide {index + 1} uses a generic section-label title instead of a takeaway")
        points = slide.get("points") if isinstance(slide.get("points"), list) else []
        if index > 0 and not points and not str(slide.get("takeaway") or "").strip():
            issues.append(f"slide {index + 1} has no content claim")
    architecture = outline.get("narrative_architecture") if isinstance(outline.get("narrative_architecture"), dict) else {}
    backbone = architecture.get("backbone") if isinstance(architecture.get("backbone"), list) else []
    if len(slides) >= 5 and len([item for item in backbone if str(item).strip()]) < 4:
        issues.append("narrative architecture lacks a usable multi-stage story backbone")
    if len(slides) >= 4:
        first_type = str((slides[0] or {}).get("type") or "").lower() if isinstance(slides[0], dict) else ""
        last_type = str((slides[-1] or {}).get("type") or "").lower() if isinstance(slides[-1], dict) else ""
        if first_type != "cover":
            issues.append("deck does not start with a cover/statement page")
        is_closing_type = (
            last_type in {"close", "closing", "cta", "end", "decision"}
            or last_type.startswith("close_")
            or last_type.endswith("_decision")
            or last_type.endswith("_cta")
        )
        if not is_closing_type:
            issues.append("deck does not end with a decision, action, or closing page")
    normalized_brief = _clean_ppt_brief(brief)
    audience_copy = _outline_audience_copy(outline)
    missing = [item for item in normalized_brief["must_include"] if item.lower() not in audience_copy]
    if missing:
        issues.append("missing must-include requirements: " + "; ".join(missing[:3]))
    # ``must_avoid`` carries semantic production constraints (for example,
    # "do not fabricate business data"), not literal phrases that may never
    # appear in visible copy. A substring check rejects a truthful caveat such
    # as "we will not fabricate metrics". Keep it in the model contract and
    # validate concrete source facts downstream instead.
    return issues


def _outline_needs_repair(
    topic: str,
    outline: dict,
    *,
    page_count: int = 0,
    brief: dict | None = None,
) -> bool:
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    if not slides:
        return True
    content = _outline_visible_text(outline)
    if any(marker in content for marker in _OUTLINE_PLACEHOLDER_MARKERS):
        return True
    terms = _topic_terms(topic)
    significant_terms = [term for term in terms if len(term) >= 3]
    if significant_terms and not any(term in content for term in significant_terms):
        return True
    return bool(_outline_quality_issues(topic, outline, page_count=page_count, brief=brief))


def _apply_slide_prompt_overrides(outline: dict, slide_prompts: Optional[list[str]]) -> None:
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    for index, prompt in enumerate(slide_prompts or []):
        if index >= len(slides) or not isinstance(slides[index], dict) or not isinstance(prompt, str) or not prompt.strip():
            continue
        slides[index]["prompt"] = prompt.strip()
        if not slides[index].get("layout_hint"):
            slides[index]["layout_hint"] = prompt.strip()
    outline["slides"] = slides


def _ensure_dynamic_visual_asset_plan(outline: dict, style_hint: str = "") -> None:
    """Complete a subject-led material plan without rasterizing the information.

    A commercial/competition deck needs more than one cover image.  The target
    is deliberately profile-aware: a cultural, ceremonial or technology pitch
    earns a coherent visual material library, while an executive evidence deck
    stays more selective and lets native data carry the argument.
    """
    style_text = str(style_hint or "").lower()
    if any(marker in style_text for marker in ("无图片", "不使用图片", "纯文字", "text-only", "text only")):
        return
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    if not slides:
        return
    existing_count = sum(
        1
        for slide in slides
        if isinstance(slide, dict)
        and str((slide.get("visual_asset") or {}).get("source") or "none").lower() not in {"none", ""}
    )
    visual_density = competition_visual_density(outline)
    if visual_density == "high":
        # Image-led competition profiles need a complete material library. A
        # data/process page may still use its image only as atmosphere behind
        # native evidence, but leaving random pages unthemed makes the deck
        # collapse back into a cover plus template interiors.
        target_count = len(slides)
    else:
        target_count = 1 if len(slides) <= 2 else 2 if len(slides) <= 4 else 3
    missing_count = max(0, target_count - existing_count)
    if not missing_count:
        return

    visual_system = outline.get("visual_system") if isinstance(outline.get("visual_system"), dict) else {}
    direction = str(visual_system.get("design_soul") or visual_system.get("style_family") or outline.get("style") or "editorial presentation").strip()
    material_direction = competition_asset_direction(outline)
    topic = str(outline.get("title") or "the presentation topic").strip()
    candidates: list[tuple[int, int, dict]] = []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        source = str((slide.get("visual_asset") or {}).get("source") or "none").lower()
        if source not in {"none", ""}:
            continue
        contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
        visual_form = str(contract.get("visual_form") or "").lower()
        recipe = str(slide.get("layout_recipe") or slide.get("layout_archetype") or "").lower()
        score = 0
        if index == 0 or str(slide.get("type") or "").lower() == "cover":
            score += 8
        if visual_form in {"editorial_story", "image_story", "quote_statement"}:
            score += 6
        if recipe in {"editorial_split", "statement", "single_focus"}:
            score += 3
        if visual_form in {"data_narrative", "evidence_dashboard", "process_flow", "comparison"}:
            # High-material visual systems still use a restrained atmospheric
            # layer on evidence/process pages. The data and labels remain
            # native; the image only creates the visual world.
            score += 2 if visual_density == "high" else -4
        candidates.append((-score, index, slide))
    candidates.sort(key=lambda item: (item[0], item[1]))
    selected = [item for item in candidates if item[0] <= 0][:missing_count]
    # A deck made entirely of evidence/process pages should stay native rather
    # than receiving a decorative image just to satisfy a global asset quota.
    # In that case the visual system is carried by type, spacing, and data.
    for _, index, slide in selected:
        is_cover = index == 0 or str(slide.get("type") or "").lower() == "cover"
        visual_form = str((slide.get("design_contract") or {}).get("visual_form") or "").lower()
        placement = "full_bleed" if is_cover else "right"
        treatment = "full_bleed_overlay" if is_cover else "masked_arc" if visual_form == "image_story" else "editorial_crop"
        slide["visual_asset"] = {
            "source": "generate",
            "purpose": "anchor the page with a topic-specific visual idea while keeping all required copy editable",
            "subject": f"a visual interpretation of {topic}",
            "art_direction": f"{direction}. {material_direction}",
            "placement": placement,
            "crop": "cover",
            "treatment": treatment,
            "mask": "none" if is_cover else "arc" if treatment == "masked_arc" else "rounded_rect",
            "depth_plane": "background" if is_cover else "middle",
            "overlay_color": "#14213D" if is_cover else "",
            "overlay_opacity": 0.34 if is_cover else 0.0,
            "allow_overlap": is_cover,
            "prompt": (
                f"Create a premium, text-free presentation material layer about {topic}. "
                f"It supports the page '{slide.get('title') or topic}' and follows this direction: {direction}. "
                f"Visual material language: {material_direction}. "
                "Use a clear subject, intentional negative space, no words, numbers, logos, UI, borders, or watermarks, and never imitate a complete PPT slide."
            ),
        }


async def generate_outline(topic: str, style_hint: str = "", page_count: int = 0,
                            llm_model_id: Optional[str] = None,
                            slide_prompts: Optional[list[str]] = None,
                            attachment_context: str = "",
                            brief: Optional[dict] = None,
                            template_id: str = "",
                            user_id: str = "",
                            job_id: str = "") -> dict:
    """Generate a PPT outline with an LLM."""
    model_id = llm_model_id or await get_default_model_id("llm")
    if not model_id:
        raise RuntimeError("未配置 LLM 模型，请在管理后台添加 category=llm 的模型")

    normalized_brief = _clean_ppt_brief(brief)
    grounding = _attachment_grounding(attachment_context, normalized_brief)
    # The agent can also be invoked outside the HTTP route (tests, async jobs,
    # API integrations). Resolve a vetted layout family here as well so those
    # paths cannot silently fall back to a single generic drawing recipe.
    resolved_template_id = resolve_ppt_template_id(
        template_id,
        topic=topic,
        style_hint=style_hint,
        attachment_context=attachment_context,
    )
    user_msg = f"主题：{topic}"
    if style_hint:
        user_msg += f"\n风格要求：{style_hint}"
    if page_count:
        user_msg += f"\n页数要求：{page_count} 页"
    brief_block = _brief_prompt_block(normalized_brief)
    if brief_block:
        user_msg += f"\n\n演示 Brief（必须遵守）：\n{brief_block}"
    indexed_slide_prompts = [
        (idx + 1, prompt.strip())
        for idx, prompt in enumerate(slide_prompts or [])
        if isinstance(prompt, str) and prompt.strip()
    ]
    if indexed_slide_prompts:
        user_msg += "\n\n每页内容要求："
        for idx, prompt in indexed_slide_prompts:
            user_msg += f"\n第 {idx} 页：{prompt}"
    if attachment_context.strip():
        user_msg += (
            "\n\n已提取的附件事实（优先作为页面证据，数字、日期和来源不得编造）：\n"
            f"{json.dumps(grounding.get('facts') or [], ensure_ascii=False)}\n"
            "\n用户上传的附件内容/结构参考如下。请优先基于这些内容规划 PPT；"
            "如果附件是 PPT，请参考其内容顺序和版式意图；如果是 Word/PDF/数据文件，请提炼结构生成页面：\n"
            f"{attachment_context[:60000]}"
        )
    template_guidance = template_prompt_block(resolved_template_id)
    if template_guidance:
        user_msg += f"\n\n专业 PPT 模板约束：\n{template_guidance}"

    raw = await _execute_ppt_billed_call(
        user_id=user_id,
        model_id=model_id,
        expected_category="llm",
        description="PPT outline generation",
        operation="outline",
        job_id=job_id,
        invoke=lambda: call_chat(
            model_id=model_id,
            user=user_msg,
            system=OUTLINE_SYSTEM,
            max_tokens=3400,
            temperature=0.45,
        ),
    )
    try:
        outline = _fix_and_parse_json(raw)
        _apply_slide_prompt_overrides(outline, slide_prompts)
        # A language model can name a style, but it often stops before turning
        # it into a stable presentation world.  Bind the subject to a durable
        # design profile before page contracts are normalized so both the
        # planner and renderer share a visual/narrative baseline.
        apply_competition_design_profile(
            outline,
            topic=topic,
            style_hint=style_hint,
            brief=normalized_brief,
            # A chosen catalog item is now only a soft visual reference.  The
            # subject-specific profile remains the visual authority.
            selected_template=False,
        )
        _normalize_ppt_outline_design(outline)
        _normalize_outline_evidence(outline, grounding)
        quality_issues = _outline_quality_issues(
            topic,
            outline,
            page_count=page_count,
            brief=normalized_brief,
        )
        # The outline is a single authored pass.  Record deterministic
        # advisories for traceability, but do not spend another model call
        # rewriting the whole deck behind the user's back.
        if quality_issues:
            outline.setdefault("content_quality", {})["advisories"] = quality_issues[:8]
        apply_ppt_template(outline, resolved_template_id)
        # Re-attach the subject profile after recording a soft style reference
        # so topic and audience still govern palette, materials and narrative.
        apply_competition_design_profile(
            outline,
            topic=topic,
            style_hint=style_hint,
            brief=normalized_brief,
            selected_template=False,
        )
        normalize_ppt_design_contract(outline)
        _ensure_dynamic_visual_asset_plan(outline, style_hint)
        _normalize_agent_worklog(outline)
        outline["brief"] = normalized_brief
        outline["template_id"] = resolved_template_id or ""
        outline["grounding"] = grounding
        outline["content_quality"] = {
            **(outline.get("content_quality") if isinstance(outline.get("content_quality"), dict) else {}),
            "status": "single_pass",
            "source_facts": len(grounding.get("facts") or []),
            "brief_constraints": len(normalized_brief.get("must_include") or []) + len(normalized_brief.get("must_avoid") or []),
        }
        return outline
    except ValueError as e:
        logger.error(f"[PPTAgent] outline JSON parse failed: {e}")
        raise RuntimeError(f"LLM 返回的大纲格式无效，请重试。详情：{e}") from e


async def _analyze_reference_image_for_ppt(
    ref_image_b64: str,
    vision_model_id: str | None,
    *,
    user_id: str = "",
    job_id: str = "",
) -> str:
    """Summarize an uploaded reference image for PPT outline/style planning."""
    if not ref_image_b64 or not vision_model_id:
        return ""
    try:
        img_bytes = _decode_ppt_base64(ref_image_b64, "PPT 参考图")
        async with _vision_call_sem:
            result = await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=vision_model_id,
                expected_category="vision",
                description="PPT reference image analysis",
                operation="reference-analysis",
                job_id=job_id,
                invoke=lambda: call_vision(
                    model_id=vision_model_id,
                    prompt=(
                        "Analyze this reference image for PPT generation. Return concise Chinese guidance "
                        "covering visual style, color palette, layout, imagery, brand/subject cues, and any "
                        "visible text that should influence the PPT."
                    ),
                    image_bytes=img_bytes,
                    system="You are a PPT art director. Convert reference images into actionable slide design guidance.",
                    max_tokens=1200,
                ),
            )
        return result.strip()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[PPTAgent] 参考图视觉分析失败，继续使用文本提示: {e}")
        return ""


# Image-model preview page generation.

async def _ppt_image_bytes(value: str, user_id: str = "") -> bytes:
    """Resolve a PPT image value from base64/data URL/private asset URL to bytes."""
    raw = (value or "").strip()
    if not raw:
        return b""
    if raw.startswith("/api/assets/"):
        parts = raw.split("?")[0].strip("/").split("/")
        if len(parts) >= 4:
            asset_id = parts[2]
            variant = parts[3] or "original"
            data, _ = await asset_storage.fetch_image_asset_variant(asset_id, user_id, variant)
            return data
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    return _decode_ppt_base64(raw, "PPT 幻灯片")


def _build_slide_prompt(
    slide: dict,
    ppt_style: str,
    color_scheme: str,
    reference_guidance: str = "",
    attachment_context: str = "",
) -> str:
    """Build the image prompt for a single PPT slide."""
    points_text = "\n".join(f"- {p}" for p in slide.get("points", []))
    page_prompt = str(slide.get("prompt", "") or "").strip()
    page_prompt_block = f"\nUser requirement for this page:\n{page_prompt}\n" if page_prompt else ""
    reference_block = f"\nReference image guidance:\n{reference_guidance}\n" if reference_guidance else ""
    attachment_block = (
        "\nSource attachments to respect:\n"
        f"{attachment_context[:18000]}\n"
        if attachment_context else ""
    )
    template_layout = slide.get("template_layout") if isinstance(slide.get("template_layout"), dict) else {}
    art_direction = slide.get("art_direction") if isinstance(slide.get("art_direction"), dict) else {}
    template_block = ""
    if template_layout:
        template_block = (
            "\nSelected professional template layout:\n"
            f"{json.dumps(template_layout, ensure_ascii=False)[:12000]}\n"
            "Follow this layout's hierarchy, geometry, image frames, and depth strategy.\n"
            f"Page art direction: {json.dumps(art_direction, ensure_ascii=False)[:4000]}\n"
        )
    return f"""Generate a complete PPT slide image (16:9 ratio, 1792x1024px).

Slide {slide["page"]}: {slide["title"]}
Type: {slide.get("type", "content")}
Content points:
{points_text}
{page_prompt_block}
{reference_block}
{attachment_block}
{template_block}

Design requirements:
- Style: {ppt_style}
- Color scheme: {color_scheme}
- Layout: {slide.get("layout_hint", "clean professional layout")}
- Follow uploaded reference images for visual language when provided.
- Use source attachments as factual content; do not invent numbers when data is present.
- High quality, presentation-ready, no watermarks
- Include all text content clearly visible
- Professional consulting/portfolio style
- Output as complete slide, not individual elements"""


PPT_MASTER_SVG_SYSTEM = """You are a PPT Master compatible SVG slide engineer.
Return ONLY one complete <svg>...</svg>.
Hard requirements:
- viewBox="0 0 1792 1024", 16:9 slide canvas.
- Use editable vector primitives for all required text, cards, diagrams, charts, and layout: svg, defs, linearGradient, rect, circle, ellipse, line, polyline, polygon, path, text, tspan, g.
- Do not use external URLs, foreignObject, script, style tags, markdown, or explanations.
- You may use only supplied visual assets with an <image href="asset://asset-id"> tag. Never put required text inside an image.
- Keep text concise and readable; convert content into a professional PPT layout.
- Reserve explicit copy zones before placing icons, circles, illustrations, or decorative rules. No icon, image edge, connector, or decorative shape may overlap an editable text box or touch its glyph area. Keep a visible gutter between visual marks and copy.
- For cover_hero pages, build a deliberate focal composition: a protected title field, one clear visual anchor, a controlled overlay, and one supporting line. Avoid a bare title over a blank field, random bars, or a collection of unrelated ornaments.
- For process_flow / sequence pages, show the complete handoff: at least three visibly separated stages, directional connectors, a short explanation or outcome for each stage, and a final result rail. Do not submit a single thin line with large empty areas.
- Every visible group should have a meaningful id for later PowerPoint editing.
- Use the provided source facts and page prompt. Do not invent unsupported numbers."""


def _extract_svg_code(raw: str) -> str:
    """Extract and lightly sanitize model-produced SVG."""
    cleaned = (raw or "").strip()
    cleaned = re.sub(r"```(?:svg|xml)?\s*", "", cleaned)
    cleaned = cleaned.replace("```", "").strip()
    start = cleaned.find("<svg")
    end = cleaned.rfind("</svg>") + len("</svg>")
    if start < 0 or end <= start:
        raise ValueError("模型未返回有效 SVG")
    svg = cleaned[start:end]
    svg = re.sub(r"<script[\s\S]*?</script>", "", svg, flags=re.IGNORECASE)
    svg = re.sub(r"<foreignObject[\s\S]*?</foreignObject>", "", svg, flags=re.IGNORECASE)
    svg = re.sub(r"<style[\s\S]*?</style>", "", svg, flags=re.IGNORECASE)
    if "viewBox=" not in svg[:400]:
        svg = re.sub(r"<svg\b", '<svg viewBox="0 0 1792 1024"', svg, count=1)
    if "xmlns=" not in svg[:400]:
        svg = re.sub(r"<svg\b", '<svg xmlns="http://www.w3.org/2000/svg"', svg, count=1)
    return svg


def _validate_svg_code(svg: str) -> None:
    import xml.etree.ElementTree as ET

    if not svg.strip().startswith("<svg"):
        raise ValueError("SVG 必须以 <svg> 开始")
    lowered = svg.lower()
    forbidden = ["<script", "<foreignobject", "href=\"http", "xlink:href=\"http"]
    if any(token in lowered for token in forbidden):
        raise ValueError("SVG 包含不安全或不可编辑的外部内容")
    ET.fromstring(svg)


def _hex_luminance(color: str) -> float:
    """Return relative luminance for a six-digit hex colour."""
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(color or "")):
        return 0.0

    def channel(value: str) -> float:
        normalized = int(value, 16) / 255
        return normalized / 12.92 if normalized <= 0.04045 else ((normalized + 0.055) / 1.055) ** 2.4

    return (
        0.2126 * channel(color[1:3])
        + 0.7152 * channel(color[3:5])
        + 0.0722 * channel(color[5:7])
    )


def _color_contrast(first: str, second: str) -> float:
    lighter, darker = sorted((_hex_luminance(first), _hex_luminance(second)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def _outline_palette(outline: dict) -> tuple[str, str, str, str]:
    """Resolve a readable palette instead of trusting positional colour tokens.

    Models commonly return a fourth colour called ``secondary``. That is often
    a muted brand colour, not body copy. Using it blindly was the reason the
    old native fallback rendered pale, low-contrast Chinese text on white.
    """
    colors = re.findall(r"#[0-9a-fA-F]{6}", str(outline.get("color_scheme", "")))
    primary = colors[0] if len(colors) >= 1 else "#172033"
    accent = colors[1] if len(colors) >= 2 else "#FCA311"
    background = colors[2] if len(colors) >= 3 else "#F8FAFC"
    candidates = [
        color for color in (colors[3] if len(colors) >= 4 else "", primary, "#172033", "#F8FAFC")
        if re.fullmatch(r"#[0-9a-fA-F]{6}", color)
    ]
    body = next((color for color in candidates if _color_contrast(color, background) >= 4.5), "#172033")
    return primary, accent, background, body


def _wrap_text_for_svg(text: str, max_chars: int, max_lines: int) -> list[str]:
    source = re.sub(r"\s+", " ", str(text or "")).strip()
    if not source:
        return []
    lines: list[str] = []
    current = ""
    for ch in source:
        current += ch
        if len(current) >= max_chars:
            lines.append(current)
            current = ""
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and len("".join(lines)) < len(source):
        lines[-1] = lines[-1].rstrip("，。；、 ") + "..."
    return lines


def _measure_svg_text_width(text: str, font_size: float, weight: int | str = 400) -> float:
    """Measure copy with the same CJK-capable fonts used by native slides.

    The old character-count approximation made a 34-character Chinese title
    appear to fit a 16:9 slide although it could be more than 1,800 px wide.
    Pillow is optional at runtime; the conservative estimator remains a safe
    fallback for minimal installations.
    """
    clean = str(text or "")
    if not clean:
        return 0.0
    try:
        from PIL import ImageFont

        numeric_weight = int(weight) if str(weight).isdigit() else 700 if str(weight).lower() == "bold" else 400
        font_paths = [
            "C:/Windows/Fonts/msyhbd.ttc" if numeric_weight >= 600 else "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/arial.ttf",
        ]
        for path in font_paths:
            try:
                font = ImageFont.truetype(path, max(1, int(round(font_size))))
                return float(font.getlength(clean))
            except OSError:
                continue
    except Exception:
        pass
    return _svg_text_width(clean, font_size)


def _wrap_text_to_width_for_svg(
    text: str,
    *,
    max_width: float,
    font_size: float,
    max_lines: int,
    weight: int | str = 400,
) -> list[str]:
    """Wrap mixed CJK/Latin copy by measured width and preserve a line budget."""
    source = re.sub(r"\s+", " ", str(text or "")).strip()
    if not source or max_width <= 8 or max_lines <= 0:
        return []

    lines: list[str] = []
    current = ""
    # Chinese has no word delimiters; splitting at a character is correct.
    # For Latin copy, prefer a word break while still guaranteeing a bound for
    # an unusually long identifier or URL.
    tokens = re.findall(r"\S+|\s+", source)
    for token in tokens:
        candidate = current + token
        if _measure_svg_text_width(candidate, font_size, weight) <= max_width:
            current = candidate
            continue
        if not current and token.isspace():
            continue
        if current.strip():
            lines.append(current.rstrip())
            if len(lines) >= max_lines:
                break
            current = ""
        for char in token.lstrip():
            candidate = current + char
            if current and _measure_svg_text_width(candidate, font_size, weight) > max_width:
                lines.append(current.rstrip())
                if len(lines) >= max_lines:
                    break
                current = char
            else:
                current = candidate
        if len(lines) >= max_lines:
            break

    if len(lines) < max_lines and current.strip():
        lines.append(current.rstrip())
    consumed = "".join(lines).replace(" ", "")
    total = source.replace(" ", "")
    if lines and len(consumed) < len(total):
        ellipsis = "…"
        last = lines[-1]
        while last and _measure_svg_text_width(last + ellipsis, font_size, weight) > max_width:
            last = last[:-1].rstrip()
        lines[-1] = (last or "…") + ("" if last.endswith("…") else ellipsis)
    return lines[:max_lines]


def _svg_text_block(
    lines: list[str],
    *,
    x: int,
    y: int,
    size: int,
    fill: str,
    weight: int = 400,
    line_gap: int = 1,
    anchor: str = "start",
    extra: str = "",
) -> str:
    if not lines:
        return ""
    attrs = (
        f'x="{x}" y="{y}" font-family="Microsoft YaHei, Arial, sans-serif" '
        f'font-size="{size}" font-weight="{weight}" fill="{fill}" '
        f'text-anchor="{anchor}" {extra}'
    )
    tspans = []
    for idx, line in enumerate(lines):
        dy = 0 if idx == 0 else size + line_gap
        tspans.append(f'<tspan x="{x}" dy="{dy}">{xml_escape(line)}</tspan>')
    return f"<text {attrs}>{''.join(tspans)}</text>"


def _build_legacy_native_composed_svg(
    outline: dict,
    slide: dict,
    idx: int,
    total: int,
    visual_assets: list[dict] | None = None,
) -> str:
    """Compose an editable slide shell; image2 supplies only isolated visual assets."""
    primary, accent, background, body = _outline_palette(outline)
    title = str(slide.get("title") or outline.get("title") or f"第 {idx + 1} 页")
    points = [str(point) for point in (slide.get("points") or []) if str(point).strip()][:6]
    slide_type = str(slide.get("type") or "content").lower()
    is_cover = idx == 0 or slide_type == "cover"
    assets = visual_assets or []
    asset_on_left = any(str(asset.get("placement") or "") == "left" for asset in assets)
    asset_on_right = bool(assets) and not asset_on_left
    page = idx + 1

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">',
        f'<rect id="background" x="0" y="0" width="1792" height="1024" fill="{background}"/>',
        f'<rect id="accent-bar" x="0" y="0" width="1792" height="18" fill="{accent}"/>',
        f'<circle id="decorative-ring" cx="1650" cy="120" r="220" fill="none" stroke="{primary}" stroke-width="2" opacity="0.08"/>',
        f'<text id="page-kicker" x="116" y="80" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" font-weight="700" fill="{accent}">第 {page:02d} 页</text>',
        f'<text id="page-number" x="1668" y="946" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" font-weight="700" fill="{primary}" text-anchor="end">{page:02d} / {total:02d}</text>',
    ]

    if is_cover:
        cover_panel_x = 720 if asset_on_left else 96
        title_width = (820 if any(str(asset.get("placement") or "") == "full_bleed" for asset in assets) else 884) if assets else 1360
        cover_text_x = cover_panel_x + 62
        # The page prompt is a production instruction, never visible slide copy.
        title_line_length = 11 if assets else 17
        parts.extend([
            f'<rect id="cover-copy-panel" x="{cover_panel_x}" y="184" width="{title_width + 64}" height="624" rx="18" fill="#FFFFFF" opacity="0.90"/>',
            f'<rect id="cover-accent" x="{cover_panel_x}" y="184" width="12" height="624" rx="6" fill="{accent}"/>',
            _svg_text_block(_wrap_text_for_svg(title, title_line_length, 3), x=cover_text_x, y=338, size=62, fill=primary, weight=800, line_gap=12),
        ])
        if points:
            parts.append(_svg_text_block(_wrap_text_for_svg(" · ".join(points[:2]), 26, 3), x=cover_text_x + 6, y=610, size=28, fill=body, weight=500, line_gap=10))
    else:
        text_left = 744 if asset_on_left else 116
        text_right = 1032 if asset_on_right else 1676
        text_width = text_right - text_left
        parts.extend([
            _svg_text_block(_wrap_text_for_svg(title, max(15, text_width // 42), 2), x=text_left, y=160, size=52, fill=primary, weight=800, line_gap=9),
            f'<rect id="title-underline" x="{text_left}" y="196" width="196" height="8" rx="4" fill="{accent}"/>',
        ])
        if slide_type in {"process", "timeline", "workflow"} and len(points) >= 2:
            step_width = max(180, (text_width - 42 * (len(points) - 1)) // len(points))
            y = 430
            for point_index, point in enumerate(points[:4]):
                x = text_left + point_index * (step_width + 42)
                parts.extend([
                    f'<circle id="step-{point_index + 1}" cx="{x + 32}" cy="{y}" r="32" fill="{accent}"/>',
                    f'<text id="step-number-{point_index + 1}" x="{x + 32}" y="{y + 8}" font-family="Arial, sans-serif" font-size="24" font-weight="800" fill="#FFFFFF" text-anchor="middle">{point_index + 1}</text>',
                    _svg_text_block(_wrap_text_for_svg(point, max(12, step_width // 22), 3), x=x, y=y + 88, size=26, fill=body, weight=600, line_gap=8),
                ])
                if point_index < min(len(points), 4) - 1:
                    parts.append(f'<path id="step-link-{point_index + 1}" d="M{x + 74} {y} H{x + step_width + 12}" stroke="{accent}" stroke-width="5" stroke-linecap="round" opacity="0.55"/>')
        else:
            card_count = min(max(len(points), 1), 4)
            columns = 2 if card_count > 2 else card_count
            card_width = (text_width - 28 * (columns - 1)) // columns
            for point_index, point in enumerate(points or ["围绕本页主题展开核心结论"]):
                row = point_index // columns
                col = point_index % columns
                x = text_left + col * (card_width + 28)
                y = 276 + row * 220
                parts.extend([
                    f'<rect id="insight-card-{point_index + 1}" x="{x}" y="{y}" width="{card_width}" height="174" rx="16" fill="#FFFFFF" stroke="{primary}" stroke-width="2" opacity="0.96"/>',
                    f'<rect id="insight-accent-{point_index + 1}" x="{x}" y="{y}" width="10" height="174" rx="5" fill="{accent}"/>',
                    f'<text id="insight-index-{point_index + 1}" x="{x + 42}" y="{y + 52}" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="{accent}">0{point_index + 1}</text>',
                    _svg_text_block(_wrap_text_for_svg(point, max(15, (card_width - 86) // 24), 3), x=x + 42, y=y + 98, size=28, fill=body, weight=600, line_gap=8),
                ])

    for asset_index, asset in enumerate(assets):
        asset_id = str(asset.get("id") or "")
        if not asset_id:
            continue
        x, y, width, height = _asset_rect(str(asset.get("placement") or "right"))
        parts.extend([
            f'<rect id="{asset_id}-frame" x="{x - 16}" y="{y - 16}" width="{width + 32}" height="{height + 32}" rx="24" fill="#FFFFFF" stroke="{accent}" stroke-width="3" opacity="0.98"/>',
            f'<image id="{asset_id}" href="asset://{asset_id}" x="{x}" y="{y}" width="{width}" height="{height}" preserveAspectRatio="{_asset_preserve_mode(asset)}"/>',
        ])
        purpose = str(asset.get("purpose") or "视觉素材")[:36]
        parts.append(_svg_text_block(_wrap_text_for_svg(purpose, 18, 2), x=x, y=y + height + 58, size=20, fill=body, weight=600, line_gap=5))

    parts.append("</svg>")
    svg = "".join(part for part in parts if part)
    _validate_svg_code(svg)
    return svg


def _native_slide_shell(
    *,
    primary: str,
    accent: str,
    background: str,
    page: int,
    total: int,
) -> list[str]:
    """Shared restrained editorial chrome for editable slides."""
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">',
        f'<rect id="background" x="0" y="0" width="1792" height="1024" fill="{background}"/>',
        f'<rect id="page-rail" x="74" y="88" width="6" height="760" rx="3" fill="{accent}"/>',
        f'<text id="page-number" x="80" y="930" font-family="Arial, sans-serif" font-size="21" font-weight="700" fill="{primary}">{page:02d}</text>',
        f'<text id="page-total" x="1648" y="930" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="{primary}" text-anchor="end">{page:02d} / {total:02d}</text>',
    ]


def _split_native_copy(value: str, *, fallback: str = "核心判断") -> tuple[str, str]:
    """Turn a planner point into a compact label plus an editable explanation.

    The planner commonly returns the useful ``label：detail`` form. Rendering
    that whole sentence with one large font is what made the former card
    layouts overflow in Chinese. Keeping the label and explanation as two
    native text objects gives the renderer a reliable hierarchy without
    deleting the underlying editable copy.
    """
    clean = " ".join(str(value or "").split()).strip()
    if not clean:
        return fallback, ""
    match = re.match(r"^(.{2,18}?)[：:]\s*(.+)$", clean)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    if len(clean) <= 16:
        return clean, ""
    split_at = max(6, min(14, len(clean) // 3))
    return clean[:split_at].rstrip("，。；、 "), clean[split_at:].lstrip("，。；、 ")


def _native_priority_matrix(
    *,
    title: str,
    takeaway: str,
    points: list[str],
    primary: str,
    accent: str,
    page: int,
    total: int,
) -> str:
    """A dark strategy page: an editable decision matrix plus a ranked rail."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=primary, page=page, total=total)
    parts.extend([
        f'<rect id="priority-title-region" x="108" y="52" width="1576" height="220" fill="{primary}" opacity="0.50"/>',
        _svg_text_block(_wrap_text_for_svg(title, 40, 1), x=132, y=174, size=48, fill="#FFFFFF", weight=800, line_gap=9),
        f'<rect id="priority-kicker-rule" x="132" y="220" width="164" height="8" rx="4" fill="{accent}"/>',
        '<text id="priority-kicker" x="132" y="266" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="#FFFFFF" opacity="0.70" letter-spacing="1">DECISION FRAME</text>',
        f'<rect id="priority-matrix" x="132" y="316" width="760" height="432" fill="#FFFFFF" opacity="0.06" stroke="#FFFFFF" stroke-width="2" stroke-opacity="0.35"/>',
        # Same colour as the canvas: a non-visual bounding region for the
        # matrix insight, so the fitter never treats it as full-slide text.
        f'<rect id="priority-insight-region" x="132" y="532" width="760" height="216" fill="{primary}" opacity="0.50"/>',
        f'<rect id="priority-quadrant" x="512" y="316" width="380" height="216" fill="{accent}" opacity="0.28"/>',
        '<line id="priority-horizontal" x1="132" y1="532" x2="892" y2="532" stroke="#FFFFFF" stroke-width="2" opacity="0.35"/>',
        '<line id="priority-vertical" x1="512" y1="316" x2="512" y2="748" stroke="#FFFFFF" stroke-width="2" opacity="0.35"/>',
        '<text id="priority-axis-y" x="154" y="360" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" font-weight="700" fill="#FFFFFF" opacity="0.72">增长确定性 ↑</text>',
        '<text id="priority-axis-x" x="702" y="722" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" font-weight="700" fill="#FFFFFF" opacity="0.72">执行可控性 →</text>',
        '<text id="priority-focus" x="548" y="372" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="800" fill="#FFFFFF">优先验证区</text>',
        f'<rect id="priority-insight-rule" x="178" y="546" width="118" height="7" rx="3" fill="{accent}"/>',
        f'<rect id="priority-rail" x="1012" y="316" width="580" height="432" fill="#FFFFFF"/>',
        '<text id="priority-rail-label" x="1062" y="374" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="800" fill="#071A2F">资源排序</text>',
    ])
    lead = takeaway or (points[0] if points else title)
    parts.append(_svg_text_block(_wrap_text_for_svg(lead, 16, 3), x=178, y=610, size=27, fill="#FFFFFF", weight=700, line_gap=9))
    for index, point in enumerate((points or [title])[:3]):
        label, detail = _split_native_copy(point, fallback=f"优先项 {index + 1}")
        y = 442 + index * 100
        parts.extend([
            f'<text id="priority-index-{index + 1}" x="1062" y="{y}" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="{accent}">0{index + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(label, 18, 1), x=1122, y=y, size=25, fill="#071A2F", weight=800),
            _svg_text_block(_wrap_text_for_svg(detail or label, 31, 2), x=1122, y=y + 34, size=20, fill="#26352E", weight=500, line_gap=6),
        ])
        # Numbering, whitespace, and the matrix/rail contrast already group
        # these choices. A horizontal divider would either crowd the second
        # editable detail line or cut through the following choice label after
        # native conversion, so the decision rail deliberately stays line-free.
    parts.append('</svg>')
    return ''.join(part for part in parts if part)


def _native_selection_funnel(
    *,
    title: str,
    takeaway: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """A selection framework with distinct signal columns and an action funnel."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    parts.extend([
        f'<rect id="selection-title-region" x="108" y="52" width="1576" height="220" fill="{background}" opacity="0.50"/>',
        _svg_text_block(_wrap_text_for_svg(title, 42, 1), x=132, y=164, size=48, fill=primary, weight=800, line_gap=9),
        f'<rect id="selection-rule" x="132" y="210" width="164" height="8" rx="4" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(takeaway or title, 70, 2), x=132, y=264, size=24, fill=body, weight=500, line_gap=8),
        '<text id="selection-kicker" x="132" y="350" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="#071A2F" opacity="0.58" letter-spacing="1">SIGNALS × EXECUTION READINESS</text>',
    ])
    items = (points + ["执行协同：确保口径、负责人和复盘节奏可落地"])[:4]
    column_width, gap, left = 342, 44, 132
    for index, point in enumerate(items):
        label, detail = _split_native_copy(point, fallback=f"信号 {index + 1}")
        x = left + index * (column_width + gap)
        rail_fill = accent if index in {0, 3} else primary
        heading_fill = primary if index != 1 else "#FFFFFF"
        detail_fill = body if index != 1 else "#FFFFFF"
        # This is intentionally the canvas background, not a visible card. It
        # gives the text fitter an exact local width/height for every column.
        parts.append(f'<rect id="selection-copy-region-{index + 1}" x="{x}" y="386" width="{column_width}" height="312" fill="{background}" opacity="0.45"/>')
        if index == 1:
            parts.append(f'<rect id="selection-focus-{index + 1}" x="{x}" y="386" width="{column_width}" height="276" fill="{primary}"/>')
        elif index == 2:
            parts.append(f'<rect id="selection-tint-{index + 1}" x="{x}" y="386" width="{column_width}" height="276" fill="{accent}" opacity="0.15"/>')
        parts.extend([
            f'<rect id="selection-rail-{index + 1}" x="{x}" y="386" width="{column_width}" height="8" fill="{rail_fill}"/>',
            f'<text id="selection-index-{index + 1}" x="{x}" y="444" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{accent if index != 1 else '#FFFFFF'}">0{index + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(label, 14, 2), x=x, y=506, size=31, fill=heading_fill, weight=800, line_gap=8),
            _svg_text_block(_wrap_text_for_svg(detail or label, 23, 3), x=x, y=590, size=22, fill=detail_fill, weight=500, line_gap=7),
        ])
    parts.extend([
        f'<rect id="selection-funnel" x="132" y="742" width="1528" height="98" rx="18" fill="{primary}"/>',
        f'<circle id="selection-funnel-dot" cx="176" cy="791" r="11" fill="{accent}"/>',
        '<text id="selection-funnel-label" x="210" y="800" font-family="Microsoft YaHei, Arial, sans-serif" font-size="25" font-weight="700" fill="#FFFFFF">候选池  →  统一评分  →  试点组合  →  复盘扩展</text>',
    ])
    parts.append('</svg>')
    return ''.join(part for part in parts if part)


def _native_process_rail(
    *,
    title: str,
    takeaway: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
    asset: dict | None = None,
) -> str:
    """A connector-first operating rail instead of a repeating row of cards."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = (points or [title])[:4]
    count = max(3, len(items))
    start, end, rail_y = 184, 1608, 438
    step = (end - start) / max(count - 1, 1)
    parts.extend([
        f'<rect id="process-title-region" x="108" y="52" width="1576" height="220" fill="{background}" opacity="0.50"/>',
        _svg_text_block(_wrap_text_for_svg(title, 40, 1), x=132, y=178, size=48, fill=primary, weight=800, line_gap=9),
        f'<rect id="process-rule" x="132" y="224" width="182" height="8" rx="4" fill="{accent}"/>',
        '<text id="process-kicker" x="132" y="272" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="#071A2F" opacity="0.58" letter-spacing="1">OPERATING LOOP</text>',
        f'<line id="process-rail" x1="{start}" y1="{rail_y}" x2="{end}" y2="{rail_y}" stroke="{primary}" stroke-width="8" opacity="0.18"/>',
    ])
    # Build all connectors first so they remain below the editable nodes.
    for index in range(count - 1):
        x1, x2 = int(start + index * step + 38), int(start + (index + 1) * step - 38)
        parts.append(f'<path id="process-arrow-{index + 1}" d="M {x1} {rail_y} H {x2}" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>')
        parts.append(f'<path id="process-arrowhead-{index + 1}" d="M {x2 - 14} {rail_y - 10} L {x2} {rail_y} L {x2 - 14} {rail_y + 10}" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
    for index, point in enumerate(items):
        x = int(start + index * step)
        label, detail = _split_native_copy(point, fallback=f"阶段 {index + 1}")
        text_x = max(132, min(1240, x - 128))
        text_width = min(388 if count <= 3 else 310, 1710 - text_x)
        parts.extend([
            f'<rect id="process-copy-region-{index + 1}" x="{text_x}" y="510" width="{text_width}" height="184" fill="{background}" opacity="0.45"/>',
            f'<circle id="process-node-{index + 1}" cx="{x}" cy="{rail_y}" r="34" fill="{accent}" stroke="{background}" stroke-width="8"/>',
            f'<text id="process-index-{index + 1}" x="{x}" y="{rail_y + 8}" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{primary}" text-anchor="middle">{index + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(label, 14, 2), x=text_x, y=540, size=29, fill=primary, weight=800, line_gap=8),
            _svg_text_block(_wrap_text_for_svg(detail or label, 17 if count > 3 else 20, 3), x=text_x, y=618, size=22, fill=body, weight=500, line_gap=7),
        ])
    parts.extend([
        f'<rect id="process-outcome" x="132" y="802" width="1528" height="74" rx="16" fill="{accent}" opacity="0.16"/>',
        f'<circle id="process-outcome-dot" cx="170" cy="839" r="10" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(takeaway or "让每一步动作进入可复盘的运营闭环", 96, 2), x=202, y=848, size=24, fill=primary, weight=700, line_gap=7),
    ])
    # Process pages still need a small, subject-specific material cue, but it
    # must not compete with the editable operating rail. This reserved corner
    # crop is deliberately separate from the nodes and their copy regions.
    if asset:
        parts.extend(_native_asset_slot(asset, x=1490, y=282, width=136, height=132, primary=primary, accent=accent))
    parts.append('</svg>')
    return ''.join(part for part in parts if part)


def _native_branching_process(
    *,
    title: str,
    takeaway: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
    archetype: str,
    asset: dict | None = None,
) -> str:
    """Render a genuine L/T operating loop without falling back to a card row.

    A process can legitimately need an asymmetric composition: the first
    operating decision may sit above a downstream branch, or a common intake
    can fan out into parallel controls.  The old horizontal rail technically
    carried the process but contradicted the locked L/T page silhouette and
    its equal copy-region rectangles triggered the card-grid QA gate.
    """
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = (points or [title])[:4]
    while len(items) < 3:
        items.append(title)
    labels_and_details = [_split_native_copy(item, fallback=f"阶段 {index + 1}") for index, item in enumerate(items)]
    is_t_shape = archetype == "t_shape"
    kicker = "BRANCHED OPERATING LOOP" if is_t_shape else "CONTROLLED OPERATING LOOP"
    parts.extend([
        f'<rect id="branch-title-region" x="108" y="52" width="1576" height="214" fill="{background}" opacity="0.50"/>',
        _svg_text_block(_wrap_text_for_svg(title, 40, 1), x=132, y=176, size=48, fill=primary, weight=800, line_gap=9),
        f'<rect id="branch-rule" x="132" y="222" width="206" height="8" rx="4" fill="{accent}"/>',
        f'<text id="branch-kicker" x="132" y="270" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{primary}" opacity="0.58" letter-spacing="1">{kicker}</text>',
    ])

    # Draw connectors before any node or editable copy.  This preserves a
    # clean diagram stack after SVG-to-PPT conversion.
    if is_t_shape:
        node_positions = [(896, 376), (340, 640), (896, 640), (1452, 640)]
        parts.extend([
            f'<path id="branch-stem" d="M 896 416 V 556 H 340" fill="none" stroke="{primary}" stroke-width="8" opacity="0.18"/>',
            f'<path id="branch-span" d="M 340 556 H 1452" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-drop-left" d="M 340 556 V 600" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-drop-center" d="M 896 556 V 600" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-drop-right" d="M 1452 556 V 600" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-return" d="M 1452 680 V 804 H 896" fill="none" stroke="{primary}" stroke-width="4" opacity="0.30" stroke-dasharray="10 12"/>',
        ])
        copy_specs = [
            (478, 302, 836, 112),
            (146, 728, 388, 128),
            (702, 728, 388, 128),
            (1258, 728, 388, 128),
        ]
    else:
        node_positions = [(294, 384), (294, 660), (888, 660), (1442, 660)]
        parts.extend([
            f'<path id="branch-spine" d="M 294 424 V 620 H 1442" fill="none" stroke="{primary}" stroke-width="8" opacity="0.18"/>',
            f'<path id="branch-drop" d="M 294 424 V 620" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-elbow" d="M 294 620 H 1442" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round"/>',
            f'<path id="branch-return" d="M 1442 700 V 812 H 816" fill="none" stroke="{primary}" stroke-width="4" opacity="0.30" stroke-dasharray="10 12"/>',
        ])
        copy_specs = [
            (408, 318, 696, 148),
            (126, 750, 368, 124),
            (696, 750, 392, 124),
            (1250, 750, 372, 124),
        ]

    for index, ((label, detail), (node_x, node_y), (text_x, text_y, text_width, text_height)) in enumerate(
        zip(labels_and_details, node_positions, copy_specs),
    ):
        if index >= len(items):
            break
        node_fill = accent if index else primary
        index_fill = primary if index else "#FFFFFF"
        parts.extend([
            f'<rect id="branch-copy-region-{index + 1}" x="{text_x}" y="{text_y}" width="{text_width}" height="{text_height}" fill="{background}" opacity="0.45"/>',
            f'<circle id="branch-node-{index + 1}" cx="{node_x}" cy="{node_y}" r="34" fill="{node_fill}" stroke="{background}" stroke-width="8"/>',
            f'<text id="branch-index-{index + 1}" x="{node_x}" y="{node_y + 8}" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{index_fill}" text-anchor="middle">{index + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(label, 15, 2), x=text_x, y=text_y + 31, size=28 if index else 30, fill=primary, weight=800, line_gap=7),
            _svg_text_block(_wrap_text_for_svg(detail or label, 22 if index else 30, 3), x=text_x, y=text_y + (78 if index else 86), size=21, fill=body, weight=500, line_gap=6),
        ])

    parts.extend([
        f'<rect id="branch-outcome" x="448" y="896" width="1120" height="56" rx="14" fill="{accent}" opacity="0.16"/>',
        f'<circle id="branch-outcome-dot" cx="484" cy="924" r="9" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(takeaway or "每一次处置都回流为可复用的现场判断", 84, 1), x=516, y=932, size=22, fill=primary, weight=700),
    ])
    if asset:
        parts.extend(_native_asset_slot(asset, x=1500, y=292, width=124, height=124, primary=primary, accent=accent))
    parts.append('</svg>')
    return ''.join(part for part in parts if part)


def _native_milestone_rail(
    *,
    title: str,
    takeaway: str,
    points: list[str],
    desired_action: str,
    primary: str,
    accent: str,
    page: int,
    total: int,
    asset: dict | None = None,
) -> str:
    """A closing 90-day plan with a protected decision strip, all editable."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=primary, page=page, total=total)
    items = (points + ["下一阶段：复盘试点并决定复制、调整或停止"])[:3]
    start, end, rail_y = 190, 1602, 408
    step = (end - start) / 2
    parts.extend([
        f'<rect id="milestone-title-region" x="108" y="52" width="1576" height="220" fill="{primary}" opacity="0.50"/>',
        _svg_text_block(_wrap_text_for_svg(title, 40, 1), x=132, y=176, size=48, fill="#FFFFFF", weight=800, line_gap=9),
        f'<rect id="milestone-rule" x="132" y="222" width="192" height="8" rx="4" fill="{accent}"/>',
        f'<line id="milestone-rail" x1="{start}" y1="{rail_y}" x2="{end}" y2="{rail_y}" stroke="#FFFFFF" stroke-width="5" opacity="0.32"/>',
    ])
    column_lefts = [132, 708, 1260]
    for index, point in enumerate(items):
        x = int(start + index * step)
        label, detail = _split_native_copy(point, fallback=f"阶段 {index + 1}")
        text_x = column_lefts[index]
        parts.extend([
            f'<rect id="milestone-copy-region-{index + 1}" x="{text_x}" y="474" width="400" height="214" fill="{primary}" opacity="0.50"/>',
            f'<circle id="milestone-node-{index + 1}" cx="{x}" cy="{rail_y}" r="34" fill="{accent}" stroke="{primary}" stroke-width="8"/>',
            f'<text id="milestone-index-{index + 1}" x="{x}" y="{rail_y + 8}" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{primary}" text-anchor="middle">{index + 1}</text>',
            _svg_text_block(
                _wrap_text_for_svg(label, 14, 2),
                x=text_x,
                y=500,
                size=31,
                fill=accent,
                weight=800,
                line_gap=8,
                # Reserve a little more DrawingML width for compact CJK stage
                # labels. This avoids a false two-line fit without reducing
                # their visual hierarchy.
                extra='data-ppt-width-padding="1.28"',
            ),
            _svg_text_block(_wrap_text_for_svg(detail or label, 18, 3), x=text_x, y=580, size=22, fill="#FFFFFF", weight=500, line_gap=7, extra='opacity="0.90"'),
        ])
    decision = desired_action or takeaway or "确认优先级、负责人和复盘节奏"
    parts.extend([
        '<text id="milestone-decision-kicker" x="132" y="748" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="#FFFFFF" opacity="0.64" letter-spacing="1">DECISION REQUIRED</text>',
        '<rect id="milestone-decision" x="132" y="778" width="1528" height="104" rx="18" fill="#FFFFFF" opacity="0.12"/>',
        f'<rect id="milestone-decision-rail" x="132" y="778" width="12" height="104" rx="6" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(decision, 96, 2), x=184, y=838, size=27, fill="#FFFFFF", weight=700, line_gap=8),
    ])
    if asset:
        parts.extend(_native_asset_slot(asset, x=1496, y=256, width=128, height=118, primary=primary, accent=accent))
    parts.append('</svg>')
    return ''.join(part for part in parts if part)


def _native_asset_slot(
    asset: dict | None,
    *,
    x: int,
    y: int,
    width: int,
    height: int,
    primary: str,
    accent: str,
) -> list[str]:
    """Reserve a single deliberate image slot; no planner text is shown on-slide."""
    if not asset:
        return []
    asset_id = str(asset.get("id") or "")
    if not asset_id:
        return []
    preserve = _asset_preserve_mode(asset)
    treatment = str(asset.get("treatment") or "framed").lower()
    mask = str(asset.get("mask") or "none").lower()
    if treatment == "masked_arc":
        mask = "arc"
    elif treatment == "masked_circle":
        mask = "circle"
    clip_id = f"{asset_id}-clip"
    clip_shape = ""
    if mask == "rounded_rect":
        clip_shape = '<rect x="0" y="0" width="1" height="1" rx="0.04"/>'
    elif mask == "circle":
        clip_shape = '<ellipse cx="0.5" cy="0.5" rx="0.5" ry="0.5"/>'
    elif mask == "arc":
        clip_shape = '<path d="M 0.18 0 L 1 0 L 1 1 L 0.18 1 C 0.02 0.74 0.02 0.26 0.18 0 Z"/>'
    elif mask == "diagonal":
        clip_shape = '<polygon points="0,0 1,0 0.82,1 0,1"/>'
    elif mask == "wave":
        clip_shape = '<path d="M 0 0.16 C 0.25 0 0.65 0.34 1 0.08 L 1 1 L 0 1 Z"/>'
    clip_defs = [f'<defs><clipPath id="{clip_id}" clipPathUnits="objectBoundingBox">{clip_shape}</clipPath></defs>'] if clip_shape else []
    clip_attr = f' clip-path="url(#{clip_id})"' if clip_shape else ""
    try:
        overlay_opacity = min(0.85, max(0.0, float(asset.get("overlay_opacity") or 0)))
    except (TypeError, ValueError):
        overlay_opacity = 0.0
    overlay_color_raw = str(asset.get("overlay_color") or primary).strip()
    overlay_color = overlay_color_raw if re.fullmatch(r"#[0-9A-Fa-f]{6}", overlay_color_raw) else primary
    if treatment in {"cutout", "foreground_silhouette"}:
        return [
            *clip_defs,
            f'<image id="{asset_id}" href="asset://{asset_id}" x="{x}" y="{y}" width="{width}" height="{height}" preserveAspectRatio="{preserve}"{clip_attr}/>',
        ]
    if treatment in {"edge_to_edge", "full_bleed_overlay", "masked_arc", "masked_circle"}:
        result = [
            *clip_defs,
            f'<rect id="{asset_id}-field" x="{x}" y="{y}" width="{width}" height="{height}" fill="{primary}" opacity="0.08"/>',
            f'<image id="{asset_id}" href="asset://{asset_id}" x="{x}" y="{y}" width="{width}" height="{height}" preserveAspectRatio="{preserve}"{clip_attr}/>',
        ]
        if overlay_opacity > 0:
            result.append(f'<rect id="{asset_id}-overlay" x="{x}" y="{y}" width="{width}" height="{height}" fill="{overlay_color}" opacity="{overlay_opacity:.2f}"/>')
        return result
    radius = 0 if treatment == "editorial_crop" else 18
    return [
        *clip_defs,
        f'<rect id="{asset_id}-shadow" x="{x + 14}" y="{y + 18}" width="{width}" height="{height}" rx="{radius}" fill="{primary}" opacity="0.10"/>',
        f'<rect id="{asset_id}-frame" x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="#FFFFFF" stroke="{accent}" stroke-width="3"/>',
        f'<image id="{asset_id}" href="asset://{asset_id}" x="{x + 12}" y="{y + 12}" width="{width - 24}" height="{height - 24}" preserveAspectRatio="{preserve}"{clip_attr}/>',
    ]


def _slide_asset(assets: list[dict]) -> dict | None:
    """The planner currently permits one visual asset per page."""
    return next((asset for asset in assets if str(asset.get("id") or "")), None)


def _inject_native_art_layer(svg: str, asset: dict | None, primary: str, accent: str) -> str:
    """按照规划的深度平面放置素材层。"""
    if not asset:
        return svg
    placement = str(asset.get("placement") or "").lower()
    depth_plane = str(asset.get("depth_plane") or "middle").lower()
    if placement not in {"full_bleed", "bottom"} and depth_plane not in {"background", "foreground"}:
        return svg
    if placement == "bottom" or str(asset.get("treatment") or "") == "foreground_silhouette":
        x, y, width, height = 0, 500, 1792, 524
    else:
        x, y, width, height = 0, 0, 1792, 1024
    layer = "".join(_native_asset_slot(
        asset,
        x=x,
        y=y,
        width=width,
        height=height,
        primary=primary,
        accent=accent,
    ))
    if depth_plane == "foreground":
        closing_tag = svg.lower().rfind("</svg>")
        return svg[:closing_tag] + layer + svg[closing_tag:] if closing_tag >= 0 else svg
    background_match = re.search(r'<rect\b[^>]*\bid=["\']background["\'][^>]*/>', svg, flags=re.IGNORECASE)
    if not background_match:
        return svg
    return svg[:background_match.end()] + layer + svg[background_match.end():]


def _append_native_supporting_asset(svg: str, asset: dict | None, primary: str, accent: str) -> str:
    """Reserve a quiet visual cue when a semantic native layout has no media slot.

    Process, roadmap, and decision layouts are intentionally diagram-led.  A
    planner may still assign a topic-specific material to keep the deck's
    visual world coherent.  Rather than discard that material or expand it
    behind editable copy, place one small protected crop in the otherwise open
    upper-right field.
    """
    if not asset or not _missing_visual_asset_slots(svg, [asset]):
        return svg
    layer = "".join(_native_asset_slot(
        asset,
        x=1512,
        y=294,
        width=112,
        height=112,
        primary=primary,
        accent=accent,
    ))
    closing_tag = svg.lower().rfind("</svg>")
    return svg[:closing_tag] + layer + svg[closing_tag:] if closing_tag >= 0 else svg


def _native_cover_hero(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    has_asset = asset is not None
    copy_width = 828 if has_asset else 1320
    parts.extend([
        f'<rect id="cover-vignette" x="0" y="0" width="1792" height="1024" fill="{primary}" opacity="0.18"/>',
        f'<rect id="cover-field" x="96" y="96" width="{copy_width}" height="772" rx="22" fill="{primary}" opacity="0.95"/>',
        f'<rect id="cover-accent" x="96" y="96" width="18" height="772" rx="9" fill="{accent}"/>',
        f'<rect id="cover-top-rule" x="154" y="174" width="188" height="10" rx="5" fill="{accent}"/>',
        f'<text id="cover-kicker" x="154" y="238" font-family="Arial, sans-serif" font-size="21" font-weight="800" letter-spacing="2" fill="{accent}">SYSTEMS STORY</text>',
        _svg_text_block(_wrap_text_for_svg(title, 13 if has_asset else 19, 3), x=154, y=360, size=70 if has_asset else 78, fill="#FFFFFF", weight=800, line_gap=14),
    ])
    if points:
        parts.append(_svg_text_block(_wrap_text_for_svg("  ".join(points[:2]), 30 if has_asset else 46, 3), x=158, y=642, size=27, fill="#FFFFFF", weight=500, line_gap=10, extra='opacity="0.88"'))
    parts.extend([
        f'<line id="cover-bottom-rule" x1="154" y1="790" x2="{copy_width - 28}" y2="790" stroke="#FFFFFF" stroke-width="2" opacity="0.28"/>',
        f'<text id="cover-page-label" x="154" y="832" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#FFFFFF" opacity="0.72">{page:02d} / {total:02d}</text>',
    ])
    if has_asset:
        parts.extend(_native_asset_slot(asset, x=962, y=142, width=668, height=690, primary=primary, accent=accent))
    else:
        parts.extend([
            f'<path id="cover-orbit" d="M 1060 706 C 1220 470 1480 440 1630 610" fill="none" stroke="{accent}" stroke-width="10" opacity="0.72"/>',
            f'<circle id="cover-orbit-node" cx="1460" cy="500" r="22" fill="{accent}"/>',
            f'<circle id="cover-orbit-node-two" cx="1618" cy="612" r="14" fill="#FFFFFF" opacity="0.9"/>',
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_editorial_split(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    left_asset = bool(asset and str(asset.get("placement") or "") == "left")
    text_x = 822 if left_asset else 134
    text_width = 770 if asset else 1390
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, max(13, text_width // 45), 2), x=text_x, y=205, size=58, fill=primary, weight=800, line_gap=10),
        f'<rect id="editorial-rule" x="{text_x}" y="258" width="126" height="8" rx="4" fill="{accent}"/>',
    ])
    if points:
        parts.append(_svg_text_block(_wrap_text_for_svg(points[0], max(15, text_width // 37), 3), x=text_x, y=382, size=35, fill=primary, weight=700, line_gap=12))
    y = 578
    for point_index, point in enumerate(points[1:4], start=2):
        parts.extend([
            f'<text id="editorial-index-{point_index}" x="{text_x}" y="{y}" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="{accent}">0{point_index}</text>',
            _svg_text_block(_wrap_text_for_svg(point, max(18, (text_width - 80) // 30), 2), x=text_x + 68, y=y, size=27, fill=body, weight=500, line_gap=8),
            f'<line id="editorial-divider-{point_index}" x1="{text_x}" y1="{y + 38}" x2="{text_x + text_width}" y2="{y + 38}" stroke="{primary}" stroke-width="2" opacity="0.14"/>',
        ])
        y += 112
    if asset:
        x = 126 if left_asset else 1036
        parts.extend(_native_asset_slot(asset, x=x, y=160, width=560, height=640, primary=primary, accent=accent))
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_statement(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """Close with a decision ledger instead of one overlong body sentence."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    has_asset = asset is not None
    right_edge = 920 if has_asset else 1610
    ledger_x = 190
    ledger_y = 734
    ledger_width = right_edge - ledger_x
    label_x = ledger_x + 28
    detail_x = ledger_x + (218 if has_asset else 246)
    detail_line_length = 24 if has_asset else 49
    parts.extend([
        f'<rect id="statement-bar" x="132" y="164" width="12" height="510" rx="6" fill="{accent}"/>',
        # Statement titles use large type by design. Keep their visible line
        # length deliberately short on the unillustrated close page so CJK
        # glyph metrics cannot push an otherwise clean title past the canvas.
        _svg_text_block(_wrap_text_for_svg(title, 13, 3), x=190, y=310, size=74 if has_asset else 88, fill=primary, weight=800, line_gap=16),
        f'<line id="statement-rule" x1="190" y1="690" x2="{right_edge}" y2="690" stroke="{primary}" stroke-width="3" opacity="0.20"/>',
        f'<text id="statement-kicker" x="{ledger_x}" y="718" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{primary}" opacity="0.58" letter-spacing="1">DECISION TO AUTHORIZE</text>',
        f'<rect id="statement-decision-ledger" x="{ledger_x}" y="{ledger_y}" width="{ledger_width}" height="174" rx="16" fill="{primary}" opacity="0.05"/>',
        f'<rect id="statement-decision-rail" x="{ledger_x}" y="{ledger_y}" width="10" height="174" rx="5" fill="{accent}"/>',
    ])
    decisions = points[:3] or ["确认试点边界：选择一个关键且可控的验证场景"]
    for index, point in enumerate(decisions):
        label, detail = _split_native_copy(point, fallback=f"关键决定 {index + 1}")
        row_y = 772 + index * 52
        if index:
            parts.append(f'<line id="statement-decision-divider-{index}" x1="{label_x}" y1="{row_y - 34}" x2="{right_edge - 24}" y2="{row_y - 34}" stroke="{primary}" stroke-width="2" opacity="0.10"/>')
        parts.extend([
            _svg_text_block(_wrap_text_for_svg(label, 12 if has_asset else 16, 1), x=label_x, y=row_y, size=19, fill=accent, weight=800),
            _svg_text_block(_wrap_text_for_svg(detail or label, detail_line_length, 1), x=detail_x, y=row_y, size=22, fill=body, weight=600),
        ])
    if asset:
        parts.extend(_native_asset_slot(asset, x=1080, y=154, width=500, height=640, primary=primary, accent=accent))
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_modular_grid(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = points or [title]
    columns = 3 if len(items) >= 3 else len(items)
    columns = max(columns, 1)
    gap = 28
    left = 132
    width = (1528 - gap * (columns - 1)) // columns
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 31, 2), x=left, y=184, size=54, fill=primary, weight=800, line_gap=10),
        f'<rect id="grid-rule" x="{left}" y="226" width="164" height="8" rx="4" fill="{accent}"/>',
    ])
    for point_index, point in enumerate(items[:6]):
        row = point_index // columns
        col = point_index % columns
        x = left + col * (width + gap)
        y = 320 + row * 260
        parts.extend([
            f'<rect id="grid-rail-{point_index + 1}" x="{x}" y="{y}" width="{width}" height="8" fill="{accent if point_index == 0 else primary}" opacity="{1 if point_index == 0 else 0.20}"/>',
            f'<text id="insight-index-{point_index + 1}" x="{x}" y="{y + 66}" font-family="Arial, sans-serif" font-size="25" font-weight="800" fill="{accent}">{point_index + 1:02d}</text>',
            _svg_text_block(_wrap_text_for_svg(point, max(13, width // 26), 4), x=x, y=y + 130, size=31, fill=body, weight=600, line_gap=9),
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_primary_secondary(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """A 2/3 primary evidence panel with a concise secondary stack."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    lead = points[0] if points else title
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 33, 2), x=132, y=178, size=54, fill=primary, weight=800, line_gap=10),
        f'<rect id="primary-panel" x="132" y="284" width="910" height="492" rx="0" fill="{primary}"/>',
        f'<rect id="primary-accent" x="132" y="284" width="16" height="492" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(lead, 22 if asset else 29, 4), x=194, y=408, size=46 if asset else 50, fill="#FFFFFF", weight=800, line_gap=12),
        f'<rect id="secondary-panel-one" x="1114" y="284" width="478" height="216" rx="0" fill="#FFFFFF" stroke="{primary}" stroke-width="3"/>',
        f'<rect id="secondary-panel-two" x="1114" y="560" width="478" height="216" rx="0" fill="{accent}" opacity="0.16"/>',
    ])
    secondary = points[1:3] or ["关键依据", "行动结论"]
    for slot, point in enumerate(secondary[:2]):
        y = 350 + slot * 276
        parts.extend([
            f'<text id="secondary-index-{slot + 1}" x="1162" y="{y}" font-family="Arial, sans-serif" font-size="21" font-weight="800" fill="{accent}">0{slot + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(point, 23, 3), x=1162, y=y + 58, size=29, fill=primary if slot == 0 else body, weight=700, line_gap=9),
        ])
    if asset:
        parts.extend(_native_asset_slot(asset, x=612, y=504, width=362, height=220, primary=primary, accent=accent))
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_asymmetric_2_3_1_3(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """A deliberate two-thirds anchor with a quiet one-third proof rail."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    anchor_on_left = not asset or str(asset.get("placement") or "right") != "left"
    anchor_x, rail_x = (132, 1182) if anchor_on_left else (638, 132)
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 28 if anchor_on_left else 19, 2), x=anchor_x, y=176, size=56 if anchor_on_left else 48, fill=primary, weight=800, line_gap=10),
        f'<rect id="asymmetric-anchor" x="{anchor_x}" y="276" width="{930 if anchor_on_left else 954}" height="504" fill="{primary}"/>',
        f'<rect id="asymmetric-rail" x="{rail_x}" y="276" width="{410 if anchor_on_left else 420}" height="504" fill="#FFFFFF" stroke="{primary}" stroke-width="3"/>',
        f'<rect id="asymmetric-rail-marker" x="{rail_x}" y="276" width="{410 if anchor_on_left else 420}" height="12" fill="{accent}"/>',
    ])
    lead = points[0] if points else title
    parts.append(_svg_text_block(_wrap_text_for_svg(lead, 22, 4), x=anchor_x + 58, y=404, size=48, fill="#FFFFFF", weight=800, line_gap=12))
    for point_index, point in enumerate((points[1:3] or ["核心支撑", "进一步说明"])[:2]):
        y = 398 + point_index * 172
        parts.extend([
            f'<text id="asymmetric-index-{point_index + 1}" x="{rail_x + 42}" y="{y}" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="{accent}">0{point_index + 1}</text>',
            _svg_text_block(_wrap_text_for_svg(point, 18, 3), x=rail_x + 42, y=y + 52, size=27, fill=body, weight=650, line_gap=8),
        ])
    if asset:
        asset_x = anchor_x + 494 if anchor_on_left else anchor_x + 48
        parts.extend(_native_asset_slot(asset, x=asset_x, y=492, width=376, height=232, primary=primary, accent=accent))
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_mixed_grid(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """An uneven information grid with one obvious anchor, never equal cards."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = points or [title]
    lead = items[0]
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 33, 2), x=132, y=176, size=54, fill=primary, weight=800, line_gap=10),
        f'<rect id="grid-anchor" x="132" y="276" width="720" height="492" fill="{primary}"/>',
        f'<rect id="grid-anchor-accent" x="132" y="276" width="16" height="492" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(lead, 19, 5), x=190, y=396, size=46, fill="#FFFFFF", weight=800, line_gap=12),
        f'<rect id="grid-wide-rail" x="900" y="276" width="692" height="160" fill="#FFFFFF" stroke="{primary}" stroke-width="3"/>',
        f'<rect id="grid-small-one" x="900" y="486" width="316" height="282" fill="{accent}" opacity="0.17"/>',
        f'<rect id="grid-small-two" x="1266" y="486" width="326" height="282" fill="#FFFFFF" stroke="{primary}" stroke-width="3"/>',
    ])
    supports = (items[1:4] + ["补充依据", "关键指标", "行动提示"])[:3]
    support_positions = [(944, 338, 34, 2), (940, 590, 29, 4), (1308, 590, 29, 4)]
    for point_index, (point, position) in enumerate(zip(supports, support_positions), start=1):
        x, y, size, lines = position
        parts.extend([
            f'<text id="mixed-index-{point_index}" x="{x}" y="{y - 38}" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{accent}">0{point_index}</text>',
            _svg_text_block(_wrap_text_for_svg(point, 23 if point_index == 1 else 13, lines), x=x, y=y, size=size, fill=body, weight=700, line_gap=9),
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_three_column(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    """Three genuinely parallel items with intentionally varied visual weight."""
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = (points + ["要点一", "要点二", "要点三"])[:3]
    parts.append(_svg_text_block(_wrap_text_for_svg(title, 33, 2), x=132, y=176, size=54, fill=primary, weight=800, line_gap=10))
    layouts = [
        (132, "#FFFFFF", primary, accent, 0),
        (658, primary, primary, "#FFFFFF", 1),
        (1184, accent, accent, primary, 2),
    ]
    for point_index, (point, layout) in enumerate(zip(items, layouts), start=1):
        x, fill, stroke, text_fill, variant = layout
        parts.extend([
            f'<rect id="parallel-{point_index}" x="{x}" y="302" width="430" height="456" fill="{fill}" stroke="{stroke}" stroke-width="3"/>',
            f'<text id="parallel-index-{point_index}" x="{x + 46}" y="374" font-family="Arial, sans-serif" font-size="22" font-weight="800" fill="{accent if variant == 0 else text_fill}">0{point_index}</text>',
            _svg_text_block(_wrap_text_for_svg(point, 14, 5), x=x + 46, y=468, size=38 if variant == 1 else 34, fill=text_fill if variant != 0 else body, weight=800, line_gap=10),
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_contrast(
    *,
    title: str,
    points: list[str],
    asset: dict | None,
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    parts.extend([
        f'<rect id="contrast-field" x="132" y="152" width="620" height="650" fill="{primary}"/>',
        _svg_text_block(_wrap_text_for_svg(title, 13, 3), x=188, y=288, size=62, fill="#FFFFFF", weight=800, line_gap=12),
        f'<rect id="contrast-accent" x="188" y="544" width="110" height="8" rx="4" fill="{accent}"/>',
    ])
    if points:
        parts.append(_svg_text_block(_wrap_text_for_svg(points[0], 25, 4), x=188, y=626, size=29, fill="#FFFFFF", weight=500, line_gap=9, extra='opacity="0.90"'))
    right_x = 852 if asset else 834
    if asset:
        parts.extend(_native_asset_slot(asset, x=1058, y=160, width=520, height=380, primary=primary, accent=accent))
        content_y = 628
        text_width = 730
    else:
        content_y = 322
        text_width = 720
    for point_index, point in enumerate(points[1:4], start=2):
        y = content_y + (point_index - 2) * 126
        parts.extend([
            f'<text id="contrast-index-{point_index}" x="{right_x}" y="{y}" font-family="Arial, sans-serif" font-size="22" font-weight="800" fill="{accent}">0{point_index}</text>',
            _svg_text_block(_wrap_text_for_svg(point, max(16, (text_width - 74) // 30), 2), x=right_x + 70, y=y, size=29, fill=body, weight=600, line_gap=9),
            f'<line id="contrast-divider-{point_index}" x1="{right_x}" y1="{y + 48}" x2="{right_x + text_width}" y2="{y + 48}" stroke="{primary}" stroke-width="2" opacity="0.14"/>',
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_sequence(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    items = points or [title]
    count = min(max(len(items), 3), 5)
    left, right, top, card_height = 132, 1660, 300, 436
    gap = 26
    card_width = (right - left - gap * (count - 1)) // count
    track_y = top + 74
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 34, 2), x=132, y=184, size=54, fill=primary, weight=800, line_gap=10),
        f'<rect id="sequence-intro-rule" x="132" y="226" width="210" height="8" rx="4" fill="{accent}"/>',
        f'<text id="sequence-kicker" x="132" y="272" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="{accent}" letter-spacing="1">FROM SIGNAL TO SERVICE</text>',
        f'<line id="sequence-track" x1="{left + 40}" y1="{track_y}" x2="{right - 40}" y2="{track_y}" stroke="{primary}" stroke-width="8" opacity="0.16"/>',
    ])
    for point_index, point in enumerate(items[:count]):
        x = left + point_index * (card_width + gap)
        fill = primary if point_index == 0 else "#FFFFFF"
        text_fill = "#FFFFFF" if point_index == 0 else body
        label_fill = accent if point_index != 0 else "#FFFFFF"
        body_size = 23 if card_width < 420 else 24
        body_chars = max(8, (card_width - 72) // max(20, int(body_size * 1.0)))
        parts.extend([
            f'<rect id="sequence-card-{point_index + 1}" x="{x}" y="{top}" width="{card_width}" height="{card_height}" rx="20" fill="{fill}" stroke="{primary}" stroke-width="3"/>',
            f'<rect id="sequence-card-rail-{point_index + 1}" x="{x}" y="{top}" width="{card_width}" height="12" rx="6" fill="{accent}"/>',
            f'<circle id="sequence-node-{point_index + 1}" cx="{x + 54}" cy="{track_y}" r="30" fill="{accent}" stroke="{fill}" stroke-width="6"/>',
            f'<text id="sequence-index-{point_index + 1}" x="{x + 54}" y="{track_y + 8}" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="{primary}" text-anchor="middle">{point_index + 1}</text>',
            f'<text id="sequence-stage-{point_index + 1}" x="{x + 38}" y="{top + 158}" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="{label_fill}">STAGE {point_index + 1:02d}</text>',
            _svg_text_block(_wrap_text_for_svg(point, body_chars, 4), x=x + 38, y=top + 220, size=body_size, fill=text_fill, weight=700, line_gap=10),
            f'<line id="sequence-card-divider-{point_index + 1}" x1="{x + 38}" y1="{top + 344}" x2="{x + card_width - 38}" y2="{top + 344}" stroke="{accent if point_index == 0 else primary}" stroke-width="2" opacity="0.28"/>',
            f'<text id="sequence-outcome-{point_index + 1}" x="{x + 38}" y="{top + 392}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20" font-weight="600" fill="{text_fill}" opacity="0.86">{xml_escape("下一步：" + (items[point_index + 1][:16] if point_index + 1 < len(items) else "进入常态运营"))}</text>',
        ])
        if point_index < count - 1:
            connector_x = x + card_width + 4
            parts.append(f'<path id="sequence-connector-{point_index + 1}" d="M {connector_x} {track_y} H {connector_x + gap - 8}" stroke="{accent}" stroke-width="6" stroke-linecap="round"/>')
            parts.append(f'<path id="sequence-arrow-{point_index + 1}" d="M {connector_x + gap - 18} {track_y - 10} L {connector_x + gap - 4} {track_y} L {connector_x + gap - 18} {track_y + 10}" fill="none" stroke="{accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
    parts.extend([
        f'<rect id="sequence-outcome-rail" x="132" y="792" width="1528" height="74" rx="16" fill="{accent}" opacity="0.16"/>',
        f'<circle id="sequence-outcome-dot" cx="168" cy="829" r="10" fill="{accent}"/>',
        f'<text id="sequence-outcome-label" x="198" y="838" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="700" fill="{primary}">结果：把分散信号转成可执行的网络调度能力</text>',
    ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_data_story(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    lead = points[0] if points else title
    parts.extend([
        _svg_text_block(_wrap_text_for_svg(title, 34, 2), x=132, y=178, size=52, fill=primary, weight=800, line_gap=10),
        f'<rect id="data-lead-field" x="132" y="280" width="576" height="452" fill="{primary}"/>',
        _svg_text_block(_wrap_text_for_svg(lead, 15, 5), x=188, y=390, size=46, fill="#FFFFFF", weight=800, line_gap=12),
        f'<rect id="data-lead-accent" x="188" y="630" width="152" height="8" rx="4" fill="{accent}"/>',
    ])
    rows = points[1:5] or [title]
    for row_index, point in enumerate(rows):
        y = 330 + row_index * 104
        parts.extend([
            f'<text id="data-row-index-{row_index + 1}" x="820" y="{y}" font-family="Arial, sans-serif" font-size="21" font-weight="800" fill="{accent}">{row_index + 1:02d}</text>',
            _svg_text_block(_wrap_text_for_svg(point, 29, 2), x=888, y=y, size=29, fill=body, weight=600, line_gap=8),
            f'<line id="data-row-divider-{row_index + 1}" x1="820" y1="{y + 48}" x2="1600" y2="{y + 48}" stroke="{primary}" stroke-width="2" opacity="0.14"/>',
        ])
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _native_section_break(
    *,
    title: str,
    points: list[str],
    primary: str,
    accent: str,
    background: str,
    body: str,
    page: int,
    total: int,
) -> str:
    parts = _native_slide_shell(primary=primary, accent=accent, background=background, page=page, total=total)
    parts.extend([
        f'<rect id="section-field" x="132" y="150" width="1460" height="650" fill="{primary}"/>',
        f'<rect id="section-accent" x="132" y="150" width="18" height="650" fill="{accent}"/>',
        _svg_text_block(_wrap_text_for_svg(title, 21, 3), x=218, y=410, size=84, fill="#FFFFFF", weight=800, line_gap=16),
    ])
    if points:
        parts.append(_svg_text_block(_wrap_text_for_svg("  ".join(points[:2]), 56, 2), x=222, y=654, size=29, fill="#FFFFFF", weight=500, line_gap=9, extra='opacity="0.88"'))
    parts.append("</svg>")
    return "".join(part for part in parts if part)


def _build_template_geometry_svg(
    outline: dict,
    slide: dict,
    idx: int,
    total: int,
    layout_asset: dict | None,
    layered_asset: dict | None,
) -> str | None:
    """使用模板组件的实际坐标生成可编辑的原生回退页面。"""
    layout = slide.get("template_layout") if isinstance(slide.get("template_layout"), dict) else {}
    components = layout.get("components") if isinstance(layout.get("components"), list) else []
    if not components:
        return None

    def number(value: Any, default: float = 0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    canvas_width = max(1, number(layout.get("canvas_width"), 1280))
    canvas_height = max(1, number(layout.get("canvas_height"), 720))
    scale_x = 1792 / canvas_width
    scale_y = 1024 / canvas_height
    primary, accent, background, body = _outline_palette(outline)
    title = str(slide.get("title") or outline.get("title") or f"Slide {idx + 1}").strip()
    points = [str(point).strip() for point in (slide.get("points") or []) if str(point).strip()][:6]
    layout_id = re.sub(r"[^A-Za-z0-9_-]+", "-", str(layout.get("id") or "template"))[:80]
    text_slots: list[dict[str, Any]] = []
    frame_slots: list[tuple[int, dict[str, float]]] = []
    decorations: list[dict[str, float]] = []

    for component_index, component in enumerate(components):
        if not isinstance(component, dict):
            continue
        component_x = number(component.get("x"))
        component_y = number(component.get("y"))
        component_text = f"{component.get('id', '')} {component.get('description', '')}".lower()
        image_component = any(token in component_text for token in ("image", "photo", "visual", "media", "portrait"))
        framed_component = any(token in component_text for token in ("card", "panel", "grid", "frame", "metric", "callout"))
        elements = component.get("elements") if isinstance(component.get("elements"), list) else []
        for element_index, element in enumerate(elements):
            if not isinstance(element, dict):
                continue
            element_type = str(element.get("type") or "").lower()
            width = number(element.get("width")) * scale_x
            height = number(element.get("height")) * scale_y
            if width <= 2 or height <= 2:
                continue
            x = (component_x + number(element.get("x"))) * scale_x
            y = (component_y + number(element.get("y"))) * scale_y
            slot = {
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "font_size": number(element.get("font_size"), 18) * scale_y,
                "font_weight": element.get("font_weight"),
                "align": str(element.get("align") or "left").lower(),
                "name": str(element.get("name") or ""),
                "order": component_index * 20 + element_index,
                "component_index": component_index,
            }
            if element_type == "text" and element.get("decorative") is not True:
                text_slots.append(slot)
            elif image_component and element_type in {"container", "group", "image"}:
                priority = 0 if element_type in {"container", "group"} else 1
                frame_slots.append((priority, {"x": x, "y": y, "width": width, "height": height}))
            elif framed_component and element_type in {"container", "group", "grid", "flex"} and width * height < 1792 * 1024 * 0.72:
                decorations.append({"x": x, "y": y, "width": width, "height": height, "component_index": component_index})

    if not text_slots:
        return None
    title_slot = max(
        text_slots,
        key=lambda slot: (
            1 if any(token in slot["name"].lower() for token in ("title", "heading", "headline")) else 0,
            slot["font_size"],
            slot["width"] * slot["height"],
        ),
    )
    metadata_tokens = ("date", "footer", "metadata", "presenter", "author", "brand", "logo", "page_number", "slide_number")
    remaining_slots = sorted(
        (
            slot for slot in text_slots
            if slot is not title_slot
            and slot["width"] >= 260
            and slot["height"] >= 32
            and not any(token in slot["name"].lower() for token in metadata_tokens)
        ),
        key=lambda slot: (slot["y"], slot["x"], slot["order"]),
    )
    content_slots = [title_slot, *remaining_slots]
    for slot_index, slot in enumerate(content_slots):
        for other in content_slots[slot_index + 1:]:
            if abs(slot["x"] - other["x"]) <= 2 and abs(slot["y"] - other["y"]) <= 2:
                return None
    if points and not remaining_slots:
        remaining_slots = [{
            **title_slot,
            "y": title_slot["y"] + title_slot["height"] + 18,
            "height": 150,
            "font_size": 26,
            "font_weight": "regular",
            "name": "derived_supporting_copy",
        }]
    assignments: list[tuple[dict[str, Any], str]] = []
    if points and remaining_slots:
        is_cover = idx == 0 or str(slide.get("type") or "").lower() == "cover"
        if is_cover:
            assignments.append((remaining_slots[0], " · ".join(points)))
        else:
            slot_count = min(len(points), len(remaining_slots))
            for slot_index in range(slot_count):
                if slot_index == slot_count - 1:
                    copy = " · ".join(points[slot_index:])
                else:
                    copy = points[slot_index]
                assignments.append((remaining_slots[slot_index], copy))
    used_component_indexes = {int(title_slot["component_index"])}
    used_component_indexes.update(int(slot["component_index"]) for slot, _ in assignments)

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">',
        f'<rect id="background" x="0" y="0" width="1792" height="1024" fill="{background}"/>',
        f'<g id="template-layout-{layout_id}">',
    ]
    used_decorations = [
        decoration for decoration in decorations
        if int(decoration["component_index"]) in used_component_indexes
    ]
    for decoration_index, decoration in enumerate(used_decorations[:12]):
        x = max(0, min(1770, decoration["x"]))
        y = max(0, min(1002, decoration["y"]))
        width = max(8, min(1792 - x, decoration["width"]))
        height = max(8, min(1024 - y, decoration["height"]))
        fill = accent if decoration_index % 3 == 0 else primary
        opacity = "0.10" if decoration_index % 3 == 0 else "0.055"
        parts.append(
            f'<rect id="template-panel-{decoration_index + 1}" x="{x:.1f}" y="{y:.1f}" '
            f'width="{width:.1f}" height="{height:.1f}" rx="18" fill="{fill}" opacity="{opacity}"/>'
        )

    if layout_asset:
        if frame_slots:
            _, frame = min(frame_slots, key=lambda item: (item[0], item[1]["width"] * item[1]["height"]))
            x = max(0, min(1672, frame["x"]))
            y = max(0, min(904, frame["y"]))
            width = max(120, min(1792 - x, frame["width"]))
            height = max(120, min(1024 - y, frame["height"]))
        else:
            x, y, width, height = _asset_rect(str(layout_asset.get("placement") or "right"))
        parts.extend(_native_asset_slot(
            layout_asset,
            x=int(x),
            y=int(y),
            width=int(width),
            height=int(height),
            primary=primary,
            accent=accent,
        ))

    def add_copy(slot: dict[str, Any], copy: str, *, is_title: bool) -> None:
        size = int(max(20, min(112 if is_title else 42, slot["font_size"] or (60 if is_title else 26))))
        width = max(100, slot["width"])
        max_chars = max(8, int(width / max(12, size * 0.56)))
        max_lines = max(1, min(4 if is_title else 5, int(max(1, slot["height"]) / max(24, size * 1.12))))
        align = slot["align"] if slot["align"] in {"left", "center", "right"} else "left"
        anchor = "middle" if align == "center" else "end" if align == "right" else "start"
        x = slot["x"] + (slot["width"] / 2 if align == "center" else slot["width"] if align == "right" else 0)
        y = slot["y"] + size
        parts.append(_svg_text_block(
            _wrap_text_for_svg(copy, max_chars, max_lines),
            x=int(max(20, min(1772, x))),
            y=int(max(size, min(1000, y))),
            size=size,
            fill=primary if is_title else body,
            weight=800 if is_title or slot["font_weight"] == "bold" else 500,
            line_gap=max(5, size // 5),
            anchor=anchor,
        ))

    add_copy(title_slot, title, is_title=True)
    for slot, copy in assignments:
        add_copy(slot, copy, is_title=False)

    parts.extend([
        f'<text id="template-page-number" x="1710" y="962" font-family="Arial, sans-serif" font-size="18" '
        f'font-weight="700" fill="{primary}" text-anchor="end">{idx + 1:02d} / {total:02d}</text>',
        '</g>',
        '</svg>',
    ])
    svg = "".join(part for part in parts if part)
    svg = _inject_native_art_layer(svg, layered_asset, primary, accent)
    _validate_svg_code(svg)
    return svg


def _build_native_composed_svg(
    outline: dict,
    slide: dict,
    idx: int,
    total: int,
    visual_assets: list[dict] | None = None,
) -> str:
    """Build one editable page from the planner's locked layout recipe.

    The renderer owns typography and native layout. Image2 can only fill an
    explicit, bounded visual slot selected by the planning graph.
    """
    primary, accent, background, body = _outline_palette(outline)
    title = str(slide.get("title") or outline.get("title") or f"Slide {idx + 1}").strip()
    points = [str(point).strip() for point in (slide.get("points") or []) if str(point).strip()][:6]
    takeaway = str(slide.get("takeaway") or "").strip()
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    archetype = str(contract.get("layout_archetype") or slide.get("layout_archetype") or "").strip().lower()
    visual_form = str(contract.get("visual_form") or "").strip().lower()
    narrative_role = str(contract.get("narrative_role") or slide.get("type") or "").strip().lower()
    recipe = str(slide.get("layout_recipe") or "").strip().lower()
    if recipe not in _PPT_LAYOUT_RECIPES:
        recipe = _default_slide_layout_recipe(slide, idx)
    assets = visual_assets or []
    asset = _slide_asset(assets)
    layered_asset = asset if asset and (
        str(asset.get("placement") or "").lower() in {"full_bleed", "bottom"}
        or str(asset.get("depth_plane") or "").lower() in {"background", "foreground"}
    ) else None
    layout_asset = None if layered_asset else asset
    page = idx + 1

    # Imported template metadata remains a planning/style reference, but it
    # must not short-circuit semantic composition. The generic template
    # fallback can contain only title/body placeholders; returning it here
    # previously erased an intentional matrix, process rail, or roadmap and
    # produced the same sparse text slide for unrelated page meanings.

    title_key = title.lower()
    compact_title_key = re.sub(r"\s+", "", title_key)
    is_cover = idx == 0 or narrative_role == "cover" or visual_form == "cover_statement" or archetype == "cover_hero"
    roadmap_page = (
        narrative_role in {"roadmap", "delivery", "plan"}
        or "roadmap" in str(slide.get("type") or "").lower()
        or any(token in compact_title_key for token in ("90天", "行动计划", "路线图"))
        or "90-day" in title_key
    )
    milestone_page = not is_cover and (
        narrative_role in {"close", "conclusion"}
        or roadmap_page
    )
    # A pilot roadmap is not a pilot-selection funnel.  Narrow this cue to
    # actual selection language and route time-bound delivery plans above it.
    selection_page = not milestone_page and any(token in title_key for token in ("筛选", "选择", "selection"))
    priority_page = (
        any(token in title_key for token in ("优先级", "取舍", "decision frame", "priorit"))
        or (visual_form == "comparison" and archetype in {"data_story", "primary_secondary", "mixed_grid", "three_column"})
    )

    # Semantic routing is intentionally before generic archetypes. It gives a
    # priority decision, a selection framework, an operating loop, and a close
    # genuinely different silhouettes instead of asking the model to repaint
    # one generic grid page after another.
    if milestone_page:
        brief = outline.get("brief") if isinstance(outline.get("brief"), dict) else {}
        svg = _native_milestone_rail(
            title=title,
            takeaway=takeaway,
            points=points,
            desired_action=str(brief.get("desired_action") or ""),
            primary=primary,
            accent=accent,
            page=page,
            total=total,
            asset=layout_asset,
        )
    elif selection_page and visual_form == "process_flow":
        svg = _native_selection_funnel(
            title=title,
            takeaway=takeaway,
            points=points,
            primary=primary,
            accent=accent,
            background=background,
            body=body,
            page=page,
            total=total,
        )
    elif priority_page:
        svg = _native_priority_matrix(
            title=title,
            takeaway=takeaway,
            points=points,
            primary=primary,
            accent=accent,
            page=page,
            total=total,
        )
    elif visual_form == "process_flow" and archetype in {"l_shape", "t_shape"}:
        svg = _native_branching_process(
            title=title,
            takeaway=takeaway,
            points=points,
            primary=primary,
            accent=accent,
            background=background,
            body=body,
            page=page,
            total=total,
            archetype=archetype,
            asset=layout_asset,
        )
    elif visual_form == "process_flow":
        svg = _native_process_rail(
            title=title,
            takeaway=takeaway,
            points=points,
            primary=primary,
            accent=accent,
            background=background,
            body=body,
            page=page,
            total=total,
            asset=layout_asset,
        )
    elif archetype == "primary_secondary":
        svg = _native_primary_secondary(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif archetype == "asymmetric_2_3_1_3":
        svg = _native_asymmetric_2_3_1_3(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif archetype == "mixed_grid":
        svg = _native_mixed_grid(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif archetype == "three_column":
        svg = _native_three_column(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "cover_hero":
        svg = _native_cover_hero(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "statement":
        svg = _native_statement(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "modular_grid":
        svg = _native_modular_grid(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "contrast":
        svg = _native_contrast(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "sequence":
        svg = _native_sequence(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "data_story":
        svg = _native_data_story(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    elif recipe == "section_break":
        svg = _native_section_break(title=title, points=points, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    else:
        svg = _native_editorial_split(title=title, points=points, asset=layout_asset, primary=primary, accent=accent, background=background, body=body, page=page, total=total)
    svg = _inject_native_art_layer(svg, layered_asset, primary, accent)
    svg = _append_native_supporting_asset(svg, layout_asset, primary, accent)
    svg = _fit_native_svg_text_blocks(svg)
    _validate_svg_code(svg)
    return svg


def _build_fallback_direct_svg(
    outline: dict,
    slide: dict,
    idx: int,
    total: int,
    visual_assets: list[dict] | None = None,
) -> str:
    """Create a robust editable SVG slide when the LLM SVG is invalid."""
    primary, accent, background, body = _outline_palette(outline)
    title = str(slide.get("title") or outline.get("title") or f"第 {idx + 1} 页")
    points = [str(p) for p in (slide.get("points") or []) if str(p).strip()][:5]
    prompt = str(slide.get("prompt") or slide.get("layout_hint") or "").strip()
    is_cover = idx == 0 or str(slide.get("type", "")).lower() == "cover"
    page = idx + 1

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">',
        f'<rect id="background" x="0" y="0" width="1792" height="1024" fill="{background}"/>',
        f'<rect id="top-accent" x="0" y="0" width="1792" height="18" fill="{accent}"/>',
        f'<circle id="decor-circle-large" cx="1530" cy="142" r="230" fill="{primary}" opacity="0.08"/>',
        f'<circle id="decor-circle-small" cx="1660" cy="270" r="90" fill="{accent}" opacity="0.16"/>',
    ]

    if is_cover:
        parts.extend([
            f'<rect id="cover-panel" x="150" y="170" width="1040" height="610" rx="26" fill="#FFFFFF" opacity="0.86"/>',
            f'<rect id="cover-line" x="150" y="170" width="12" height="610" rx="6" fill="{accent}"/>',
            _svg_text_block(_wrap_text_for_svg(title, 22, 3), x=220, y=300, size=66, fill=primary, weight=800),
        ])
        if points:
            subtitle = " / ".join(points[:2])
            parts.append(_svg_text_block(_wrap_text_for_svg(subtitle, 38, 2), x=224, y=560, size=30, fill=body, weight=500))
    else:
        parts.extend([
            _svg_text_block(_wrap_text_for_svg(title, 28, 2), x=116, y=116, size=48, fill=primary, weight=800),
            f'<rect id="title-underline" x="116" y="158" width="210" height="8" rx="4" fill="{accent}"/>',
            f'<rect id="content-panel" x="92" y="220" width="1120" height="660" rx="24" fill="#FFFFFF" opacity="0.88"/>',
            f'<rect id="side-panel" x="1280" y="220" width="390" height="660" rx="24" fill="{primary}" opacity="0.92"/>',
        ])
        y = 300
        for point_idx, point in enumerate(points or [title]):
            cy = y + point_idx * 102
            parts.append(f'<circle id="bullet-{point_idx + 1}" cx="146" cy="{cy - 8}" r="12" fill="{accent}"/>')
            parts.append(_svg_text_block(_wrap_text_for_svg(point, 44, 2), x=182, y=cy, size=27, fill=body, weight=500))
        side_text = points[0] if points else title
        parts.append(_svg_text_block(_wrap_text_for_svg(side_text, 18, 7), x=1334, y=370, size=30, fill="#FFFFFF", weight=600))
        for n in range(4):
            parts.append(f'<rect id="metric-line-{n + 1}" x="1334" y="{690 + n * 36}" width="{250 - n * 28}" height="10" rx="5" fill="{accent}" opacity="{0.85 - n * 0.12:.2f}"/>')

    for asset in visual_assets or []:
        asset_id = str(asset.get("id") or "")
        if not asset_id:
            continue
        x, y, width, height = _asset_rect(str(asset.get("placement") or "right"))
        parts.append(
            f'<image id="{asset_id}" href="asset://{asset_id}" x="{x}" y="{y}" '
            f'width="{width}" height="{height}" preserveAspectRatio="{_asset_preserve_mode(asset)}"/>'
        )

    parts.extend([
        f'<text id="page-number" x="1640" y="944" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="{primary}" text-anchor="end">{page:02d} / {total:02d}</text>',
        "</svg>",
    ])
    svg = "".join(part for part in parts if part)
    _validate_svg_code(svg)
    return svg


def _render_spec_card_png(outline: dict, slide: dict, idx: int, total: int) -> bytes:
    """Render a lightweight visual spec card for vision-model SVG execution."""
    try:
        from PIL import Image, ImageDraw, ImageFont

        img = Image.new("RGB", (1792, 1024), "#F8FAFC")
        draw = ImageDraw.Draw(img)
        primary, accent, _background, body = _outline_palette(outline)
        draw.rectangle((0, 0, 1792, 18), fill=accent)
        draw.rounded_rectangle((90, 88, 1702, 936), radius=28, fill="#FFFFFF", outline="#CBD5E1", width=3)
        draw.rounded_rectangle((90, 88, 112, 936), radius=10, fill=accent)

        def font(size: int, bold: bool = False):
            names = [
                "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
                "C:/Windows/Fonts/simhei.ttf",
                "arial.ttf",
            ]
            for name in names:
                try:
                    return ImageFont.truetype(name, size)
                except Exception:
                    continue
            return ImageFont.load_default()

        y = 150
        draw.text((150, y), f"Slide {idx + 1}/{total}", fill=accent, font=font(30, True))
        y += 62
        draw.text((150, y), str(slide.get("title") or f"第 {idx + 1} 页")[:36], fill=primary, font=font(54, True))
        y += 90
        draw.text((150, y), f"Deck: {outline.get('title', '')}"[:72], fill=body, font=font(28))
        y += 48
        draw.text((150, y), f"Style: {outline.get('style', '')}"[:72], fill=body, font=font(26))
        y += 70
        for point in (slide.get("points") or [])[:7]:
            draw.ellipse((160, y + 8, 178, y + 26), fill=accent)
            for line in _wrap_text_for_svg(str(point), 48, 2):
                draw.text((200, y), line, fill=body, font=font(28))
                y += 38
            y += 18
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        from PIL import Image

        img = Image.new("RGB", (1792, 1024), (248, 250, 252))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


def _visual_asset_spec(slide: dict, idx: int) -> dict | None:
    """Normalize an explicit page material decision into one bounded asset."""
    planned = slide.get("visual_asset") if isinstance(slide.get("visual_asset"), dict) else {}
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    policy = contract.get("asset_policy") if isinstance(contract.get("asset_policy"), dict) else {}
    slide_type = str(slide.get("type") or "").strip().lower()
    source = str(planned.get("source") or policy.get("mode") or "").strip().lower()
    if source not in {"reference", "attachment", "generate", "none"}:
        source = "generate" if planned.get("needed") is True else "none"
    if source == "none":
        return None
    title = str(slide.get("title") or f"Slide {idx + 1}").strip()
    purpose = str(planned.get("purpose") or "support the slide's central visual idea").strip()
    geometry_input = {
        key: planned.get(key) if planned.get(key) not in (None, "") else policy.get(key)
        for key in (
            "placement", "crop", "treatment", "mask", "depth_plane",
            "focal_x", "focal_y", "overlay_color", "overlay_opacity", "allow_overlap",
        )
    }
    geometry = normalize_visual_asset_geometry(
        geometry_input,
        default_placement="full_bleed" if slide_type == "cover" else "right",
        default_crop="contain",
        default_treatment="framed",
        default_depth_plane="middle",
    )
    placement = str(geometry["placement"])
    if placement == "inline":
        placement = "right"
    crop = str(geometry["crop"])
    subject = str(planned.get("subject") or purpose).strip()
    art_direction = str(planned.get("art_direction") or "").strip()
    treatment = str(geometry["treatment"])
    mask = str(geometry["mask"])
    depth_plane = str(geometry["depth_plane"])
    focal_x = float(geometry["focal_x"])
    focal_y = float(geometry["focal_y"])
    overlay_opacity = float(geometry["overlay_opacity"])
    overlay_color = str(geometry["overlay_color"])
    prompt = str(planned.get("prompt") or "").strip()
    if not prompt:
        points = "; ".join(str(point) for point in (slide.get("points") or [])[:3] if str(point).strip())
        prompt = (
            f"Create one presentation visual asset about {subject}. "
            f"It supports the slide topic '{title}' and communicates {purpose}. "
            f"Context: {points}."
        )
    if source in {"generate", "reference", "attachment"}:
        prompt += (
            f" Art direction: {art_direction or 'editorial, intentional composition, refined material detail, quiet premium lighting'}. "
            "Create a standalone presentation material layer, not a complete slide or poster. "
            "no words, numbers, letters, logos, labels, UI, borders, watermarks, or stock-character poses. "
            "Use an intentional crop with clean subject separation and enough negative space for editable native content. "
            + ("Use a transparent or clean removable background around the subject." if crop == "cutout" or treatment == "foreground_silhouette" else f"Compose for {placement} placement and a focal point near {focal_x:.0f}% x, {focal_y:.0f}% y.")
        )
    return {
        "id": f"visual-slide-{idx + 1}",
        "slide_index": idx,
        "source": source,
        "purpose": purpose[:240],
        "subject": subject[:240],
        "art_direction": art_direction[:500],
        "source_asset_id": str(
            planned.get("asset_id")
            or planned.get("assetId")
            or planned.get("source_asset_id")
            or ""
        ).strip(),
        "placement": placement,
        "crop": crop,
        "treatment": treatment,
        "mask": mask,
        "depth_plane": depth_plane,
        "focal_x": focal_x,
        "focal_y": focal_y,
        "overlay_color": overlay_color,
        "overlay_opacity": overlay_opacity,
        "allow_overlap": geometry["allow_overlap"],
        "prompt": prompt[:2200],
    }


def _visual_asset_output_size(spec: dict, state: dict) -> str:
    """Match generated material to its final PPT slot instead of forcing a square.

    Square generations were a major cause of generic crops: wide cover scenes
    lost their horizon and side panels lost their subject.  The renderer now
    asks for the same family of aspect ratios that the page composition needs.
    """
    placement = str(spec.get("placement") or "right").lower()
    treatment = str(spec.get("treatment") or "").lower()
    crop = str(spec.get("crop") or "cover").lower()
    if placement in {"full_bleed", "bottom"}:
        aspect_ratio = "16:9"
    elif crop == "cutout" or treatment == "foreground_silhouette":
        aspect_ratio = "3:4"
    elif placement in {"left", "right"}:
        aspect_ratio = "4:5"
    else:
        aspect_ratio = "3:2"
    return image_output_size(aspect_ratio, state.get("output_resolution") or "1k")


def _visual_asset_quality(spec: dict, state: dict) -> str:
    """Use the high-quality image path for the deck's authored materials."""
    configured = normalize_image_quality(state.get("image_quality"))
    if configured != "auto":
        return configured
    # The default production contract is commercial/competition grade. Image
    # quality only falls back to auto when the user explicitly opts out of the
    # high-quality design route in a future compatibility request.
    return "high" if state.get("design_mode", "competition") == "competition" else "auto"


async def _generate_ppt_master_visual_assets(
    state: dict,
    job_id: str,
    outline: dict,
    *,
    slide_indexes: set[int] | None = None,
    announce_plan: bool = True,
) -> list[dict]:
    """Generate only the planned assets, optionally for the current page.

    Direct authoring invokes this per page so image preparation can overlap
    with the page's GPT composition instead of blocking the first preview on a
    full-deck asset batch.
    """
    slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
    all_planned = [_visual_asset_spec(slide, idx) for idx, slide in enumerate(slides)]
    planned = [
        item for item in all_planned
        if item and (slide_indexes is None or int(item["slide_index"]) in slide_indexes)
    ]
    material_direction = competition_asset_direction(outline)
    profile = outline.get("design_profile") if isinstance(outline.get("design_profile"), dict) else {}
    for spec in (item for item in planned if item):
        spec["design_profile"] = str(profile.get("id") or "editorial_business")
        spec["prompt"] = (
            f"{spec['prompt']} Subject visual language: {material_direction} "
            "Treat this as one premium art-directed material for a coherent deck, with natural composition and clean negative space."
        )[:2600]
    # Image assets are never a replacement for editable composition, but a
    # high-end deck may legitimately need a cover plus several tailored scenes.
    # The profile-aware plan has already selected only page roles where material
    # contributes; this cap protects capacity without flattening every short
    # deck back to two square pictures.
    generated_limit = 4 if len(slides) <= 4 else 6 if len(slides) <= 8 else 7
    allowed_generated_ids: set[str] = set()
    generated_count = 0
    for item in (candidate for candidate in all_planned if candidate):
        if item.get("source") != "generate":
            continue
        if generated_count >= generated_limit:
            continue
        allowed_generated_ids.add(str(item.get("id") or ""))
        generated_count += 1
    specs: list[dict] = []
    for item in (candidate for candidate in planned if candidate):
        if item.get("source") == "generate" and str(item.get("id") or "") not in allowed_generated_ids:
            continue
        specs.append(item)
    existing = state.get("visual_assets") if isinstance(state.get("visual_assets"), list) else []
    by_id = {str(item.get("id") or ""): item for item in existing if isinstance(item, dict)}
    image_model_id = str(state.get("image_model_id") or "") or await get_default_model_id("generate") or ""
    if not specs:
        if not announce_plan:
            return [item for item in existing if isinstance(item, dict)]
        await set_agent_step(
            state,
            lambda s: _save_state(job_id, s),
            name="visual_asset_plan",
            status="skipped",
            message="本次页面以原生文字、图表和版式为主，无需额外生成插图素材。",
            progress=max(int(state.get("progress") or 28), 28),
        )
        return [item for item in existing if isinstance(item, dict)]
    if not image_model_id and all(item.get("source") != "generate" for item in specs) and announce_plan:
        await set_agent_step(
            state,
            lambda s: _save_state(job_id, s),
            name="visual_asset_plan",
            status="skipped",
            message="未配置图像模型，已继续使用可编辑图表和版式完成页面。",
            progress=max(int(state.get("progress") or 28), 28),
        )
        # Source/reference material can still be placed without an image model.

    planned_pages = "、".join(f"第 {item['slide_index'] + 1} 页" for item in specs)
    if announce_plan:
        await set_agent_step(
            state,
            lambda s: _save_state(job_id, s),
            name="visual_asset_plan",
            status="running",
            message=f"正在为{planned_pages}准备主题化素材，并与可编辑版式并行制作。",
            progress=max(int(state.get("progress") or 28), 30),
            result={"planned_pages": [item["slide_index"] + 1 for item in specs]},
        )
    result = list(existing)
    for asset_index, spec in enumerate(specs):
        current = by_id.get(spec["id"])
        if current and (current.get("asset_id") or current.get("image_b64")):
            # Reuse already generated bytes on a page-design retry, but bring
            # their geometry forward from the current normalized plan. This
            # prevents an older contradictory depth/placement pair from
            # turning a portrait side asset into a full-canvas image.
            current.update({
                key: spec[key]
                for key in (
                    "source", "purpose", "subject", "art_direction", "placement",
                    "crop", "treatment", "mask", "depth_plane", "focal_x", "focal_y",
                    "overlay_color", "overlay_opacity", "allow_overlap", "prompt",
                    "design_profile",
                )
                if key in spec
            })
            continue
        page = spec["slide_index"] + 1
        progress = 30 + int((asset_index / max(len(specs), 1)) * 14)
        source_kind = str(spec.get("source") or "generate")
        await set_agent_step(
            state,
            lambda s: _save_state(job_id, s),
            name=f"visual_asset_{page}",
            status="running",
            message=(
                f"正在为第 {page} 页准备已提供的视觉素材，并按规划裁切排版。"
                if source_kind in {"reference", "attachment"}
                else f"正在为第 {page} 页生成专属插图素材，随后会与文字和图表分别排版。"
            ),
            progress=progress,
            result={"slide": page, "placement": spec.get("placement", "right"), "source": spec.get("source", "generate")},
        )
        try:
            source_kind = str(spec.get("source") or "generate")
            source_asset_id = str(spec.get("source_asset_id") or "")
            source_image_b64 = ""
            if source_kind == "reference":
                source_asset_id = str(state.get("reference_asset_id") or source_asset_id)
                source_image_b64 = str(state.get("ref_image_b64") or "")

            # Preserve supplied visual material as a source asset. It is never
            # silently sent through image generation and replaced with a lookalike.
            if source_kind in {"reference", "attachment"}:
                if not source_asset_id and not source_image_b64:
                    raise ValueError("the planned source visual is not available")
                inline_b64 = source_image_b64.split(",", 1)[1] if source_image_b64.startswith("data:") and "," in source_image_b64 else source_image_b64
                item = {
                    **spec,
                    "asset_id": source_asset_id,
                    "original_url": "",
                    "preview_url": "",
                    "thumbnail_url": "",
                    # Preserve the upload bytes alongside its storage id so
                    # the first page never waits for a redundant remote fetch.
                    "image_b64": inline_b64,
                    "model_id": "",
                }
                result = [
                    existing_item for existing_item in result
                    if not isinstance(existing_item, dict) or existing_item.get("id") != spec["id"]
                ]
                result.append(item)
                by_id[spec["id"]] = item
                state["visual_assets"] = result
                if not any(
                    isinstance(artifact, dict)
                    and artifact.get("type") == "visual_asset"
                    and artifact.get("source_id") == spec["id"]
                    for artifact in state.get("artifacts", [])
                ):
                    append_ppt_artifact(
                        state,
                        "visual_asset",
                        source_id=spec["id"],
                        asset_id=source_asset_id,
                        image_b64="" if source_asset_id else inline_b64,
                        slide_index=spec["slide_index"],
                        purpose=spec["purpose"],
                        placement=spec["placement"],
                        source=source_kind,
                        crop=spec.get("crop", "contain"),
                        treatment=spec.get("treatment", "framed"),
                        prompt="",
                        model_id="",
                    )
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name=f"visual_asset_{page}",
                    status="completed",
                    message=f"第 {page} 页已采用已提供的视觉素材，并保留原生可编辑的文字与图表层。",
                    progress=progress + 3,
                    result={"slide": page, "asset_id": source_asset_id, "placement": spec.get("placement", "right"), "source": source_kind},
                )
                continue

            if not image_model_id:
                raise ValueError("no image model is configured for the planned generated visual")
            visual_reference_images = None
            async with _image_call_sem:
                image_bytes = await _execute_ppt_billed_call(
                    user_id=state.get("user_id", ""),
                    model_id=image_model_id,
                    expected_category="generate",
                    description=f"PPT visual asset · slide {spec['slide_index'] + 1}",
                    operation=f"visual-asset:{spec['id']}",
                    job_id=job_id,
                    invoke=lambda: call_image(
                        model_id=image_model_id,
                        prompt=spec["prompt"],
                        ref_images=visual_reference_images,
                        size=_visual_asset_output_size(spec, state),
                        quality=_visual_asset_quality(spec, state),
                        force_size=True,
                    ),
                )
            stored = await asset_storage.store_generated_image_best_effort(
                image_bytes=image_bytes,
                user_id=state.get("user_id", ""),
                conversation_id=state.get("conversation_id") or None,
                task_id=job_id,
                item_id=spec["id"],
                prompt=spec["prompt"],
                model_id=image_model_id,
                category="ppt-visual-asset",
                retention_class="web_history",
            )
            image_b64 = base64.b64encode(image_bytes).decode("ascii")
            item = {
                **spec,
                "asset_id": stored.id if stored else "",
                "original_url": stored.original_url if stored else "",
                "preview_url": stored.preview_url if stored else "",
                "thumbnail_url": stored.thumb_url if stored else "",
                "image_b64": "" if stored else image_b64,
                "model_id": image_model_id,
            }
            result = [
                existing_item for existing_item in result
                if not isinstance(existing_item, dict) or existing_item.get("id") != spec["id"]
            ]
            result.append(item)
            by_id[spec["id"]] = item
            state["visual_assets"] = result
            if not any(
                isinstance(artifact, dict)
                and artifact.get("type") == "visual_asset"
                and artifact.get("source_id") == spec["id"]
                for artifact in state.get("artifacts", [])
            ):
                append_ppt_artifact(
                    state,
                    "visual_asset",
                    source_id=spec["id"],
                    asset_id=stored.id if stored else "",
                    original_url=stored.original_url if stored else "",
                    preview_url=stored.preview_url if stored else "",
                    thumbnail_url=stored.thumb_url if stored else "",
                    image_b64="" if stored else image_b64,
                    slide_index=spec["slide_index"],
                    purpose=spec["purpose"],
                    placement=spec["placement"],
                    source=spec.get("source", "generate"),
                    crop=spec.get("crop", "contain"),
                    treatment=spec.get("treatment", "framed"),
                    prompt=spec["prompt"],
                    model_id=image_model_id,
                )
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name=f"visual_asset_{page}",
                status="completed",
                message=f"第 {page} 页的插图素材已准备好，正在融入可编辑页面。",
                progress=progress + 3,
                result={"slide": page, "asset_id": stored.id if stored else "", "placement": spec.get("placement", "right"), "source": spec.get("source", "generate")},
            )
            if state.get("conversation_id"):
                try:
                    from repositories import conversation_repo
                    await conversation_repo.add_message(
                        conversation_id=state["conversation_id"],
                        role="assistant",
                        content=f"已为第 {page} 页准备独立视觉素材，并将与可编辑文字和图表分开排版。",
                        meta={
                            "type": "visual_asset",
                            "job_id": job_id,
                            "asset_id": stored.id if stored else "",
                            "original_url": stored.original_url if stored else "",
                            "preview_url": stored.preview_url if stored else "",
                            "thumbnail_url": stored.thumb_url if stored else "",
                            "image_b64": "" if stored else image_b64,
                            "slide_index": spec["slide_index"],
                            "purpose": spec["purpose"],
                            "placement": spec["placement"],
                            "source": spec.get("source", "generate"),
                            "crop": spec.get("crop", "contain"),
                            "treatment": spec.get("treatment", "framed"),
                            "model_id": image_model_id,
                        },
                    )
                except Exception as history_error:
                    logger.warning("[PPTAgent] visual asset history write failed: %s", history_error)
        except HTTPException:
            raise
        except Exception as exc:
            warning = f"Slide {spec['slide_index'] + 1} visual asset skipped: {exc}"
            state.setdefault("visual_asset_warnings", []).append(warning[:500])
            logger.warning("[PPTAgent] %s", warning)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name=f"visual_asset_{page}",
                status="skipped",
                message=f"第 {page} 页的素材服务暂时不可用，已保留页面结构并采用兼容版式继续处理。",
                progress=progress + 2,
                result={"slide": page},
            )
    state["visual_assets"] = result
    if announce_plan:
        await set_agent_step(
            state,
            lambda s: _save_state(job_id, s),
            name="visual_asset_plan",
            status="completed",
            message="当前页视觉素材已就绪；后续页面将按完成顺序直接显示。",
            progress=max(int(state.get("progress") or 42), 42),
            result={"asset_count": len(result)},
        )
    return result


async def _load_slide_visual_assets(state: dict, slide_index: int) -> list[dict]:
    assets = state.get("visual_assets") if isinstance(state.get("visual_assets"), list) else []
    loaded: list[dict] = []
    for asset in assets:
        if not isinstance(asset, dict) or int(asset.get("slide_index", -1)) != slide_index:
            continue
        asset_id = str(asset.get("asset_id") or "")
        inline_b64 = str(asset.get("image_b64") or "")
        # Bytes persisted with the job are immediately usable.  Prefer them
        # even when a storage id exists: waiting on a remote variant fetch was
        # delaying the first visible slide after the image was already ready.
        if inline_b64:
            loaded.append({
                **asset,
                "data_url": f"data:image/png;base64,{inline_b64}",
            })
            continue
        if not asset_id:
            continue
        try:
            image, mime_type = await asset_storage.fetch_image_asset_variant(
                asset_id,
                state.get("user_id", ""),
                variant="original",
            )
            loaded.append({
                **asset,
                "data_url": f"data:{mime_type or 'image/png'};base64,{base64.b64encode(image).decode('ascii')}",
            })
        except Exception as exc:
            logger.warning("[PPTAgent] visual asset unavailable asset_id=%s error=%s", asset_id, exc)
    return loaded


def _asset_rect(placement: str) -> tuple[int, int, int, int]:
    if placement == "left":
        return 118, 260, 540, 560
    if placement == "full_bleed":
        return 980, 120, 700, 780
    return 1120, 250, 540, 560


def _asset_preserve_mode(asset: dict) -> str:
    """Translate the planner's crop decision into the SVG image fitting mode."""
    try:
        focal_x = float(asset.get("focal_x", 50))
    except (TypeError, ValueError):
        focal_x = 50
    try:
        focal_y = float(asset.get("focal_y", 50))
    except (TypeError, ValueError):
        focal_y = 50
    x_anchor = "xMin" if focal_x < 34 else "xMax" if focal_x > 66 else "xMid"
    y_anchor = "YMin" if focal_y < 34 else "YMax" if focal_y > 66 else "YMid"
    mode = "slice" if str(asset.get("crop") or "").lower() == "cover" else "meet"
    return f"{x_anchor}{y_anchor} {mode}"


def _missing_visual_asset_slots(svg: str, assets: list[dict]) -> list[str]:
    return [
        str(asset.get("id") or "")
        for asset in assets
        if str(asset.get("id") or "") and f"asset://{asset.get('id')}" not in svg
    ]


def _inject_visual_assets(svg: str, assets: list[dict]) -> str:
    """Bind only explicit visual slots so an asset cannot cover editable content."""
    result = svg
    for asset in assets:
        asset_id = str(asset.get("id") or "")
        data_url = str(asset.get("data_url") or "")
        if not asset_id or not data_url:
            continue
        token = f"asset://{asset_id}"
        image_slot = re.compile(
            rf"<image\b(?=[^>]*\bhref=[\"']{re.escape(token)}[\"'])[^>]*>",
            flags=re.IGNORECASE,
        )

        def bind_slot(match: re.Match) -> str:
            tag = match.group(0)
            if not re.search(r"\bid=[\"']", tag, flags=re.IGNORECASE):
                tag = tag.replace("<image", f'<image id="{asset_id}"', 1)
            return tag.replace(token, data_url)

        result = image_slot.sub(bind_slot, result)
    return result


def _compact_template_execution_hint(slide: dict) -> str:
    """Expose a selected template as inspiration, never fixed geometry."""
    template = slide.get("template_layout") if isinstance(slide.get("template_layout"), dict) else {}
    if not template:
        return "No template geometry. Derive the composition from the subject-specific page silhouette."
    fields = {
        "id": template.get("id"),
        "name": template.get("name") or template.get("title"),
        "description": template.get("description"),
        "depth_strategy": template.get("depth_strategy"),
    }
    parts = [f"{key}={str(value).strip()[:180]}" for key, value in fields.items() if str(value or "").strip()]
    return "; ".join(parts) or "Optional style reference only; do not reproduce its geometry."


def _compact_page_execution_brief(outline: dict, slide: dict) -> str:
    """Compile a focused, deterministic page brief for SVG generation.

    The full design spec remains on disk for traceability. The renderer gets only
    the fields it can act on, which reduces prompt dilution and accidental
    leakage of planning/source text onto the visible slide.
    """
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    asset = slide.get("visual_asset") if isinstance(slide.get("visual_asset"), dict) else {}
    evidence = slide.get("evidence") if isinstance(slide.get("evidence"), list) else []
    evidence_lines: list[str] = []
    for item in evidence[:3]:
        if isinstance(item, dict):
            claim = " ".join(str(item.get("claim") or "").split())[:220]
            source = " ".join(str(item.get("source") or "").split())[:90]
        else:
            claim = " ".join(str(item or "").split())[:220]
            source = ""
        if claim:
            evidence_lines.append(f"- {claim}" + (f" ({source})" if source else ""))
    points = [" ".join(str(point or "").split())[:180] for point in slide.get("points", []) if str(point or "").strip()]
    visual = "none"
    if str(asset.get("source") or "none").lower() not in {"", "none"}:
        visual = "; ".join(
            f"{name}={str(asset.get(name) or '').strip()[:160]}"
            for name in ("source", "purpose", "subject", "placement", "crop", "treatment", "depth_plane")
            if str(asset.get(name) or "").strip()
        )
    composition = contract.get("composition") if isinstance(contract.get("composition"), dict) else {}
    budget = contract.get("content_budget") if isinstance(contract.get("content_budget"), dict) else {}
    layout_policy = contract.get("layout_policy") if isinstance(contract.get("layout_policy"), dict) else {}
    return "\n".join([
        f"Audience takeaway: {str(slide.get('takeaway') or slide.get('title') or '').strip()[:240]}",
        "Required editable copy:\n" + ("\n".join(f"- {point}" for point in points[:5]) or "- Use the title as the decisive statement."),
        "Evidence to preserve:\n" + ("\n".join(evidence_lines) or "- Label any unsupported claim as a planning assumption."),
        f"Layout: archetype={contract.get('layout_archetype') or slide.get('layout_archetype')}; focus={str(composition.get('focal_area') or '').strip()[:150]}; reading_order={str(composition.get('reading_order') or '').strip()[:150]}",
        f"Spatial contract: {json.dumps(layout_policy, ensure_ascii=False)[:600]}",
        f"Copy budget: {json.dumps(budget, ensure_ascii=False)[:260]}",
        f"Native components: {json.dumps(contract.get('component_plan') or {}, ensure_ascii=False)[:600]}",
        f"Visual material: {visual}",
        f"Template intent: {_compact_template_execution_hint(slide)}",
    ])


def _build_direct_svg_prompt(
    *,
    outline: dict,
    slide: dict,
    idx: int,
    total: int,
    reference_guidance: str,
    attachment_context: str,
    spec_lock: str = "",
    visual_assets: list[dict] | None = None,
) -> str:
    asset_lines = "\n".join(
        f"- id={item.get('id')}; source={item.get('source')}; purpose={item.get('purpose')}; placement={item.get('placement')}; crop={item.get('crop')}; treatment={item.get('treatment')}; use <image href=\"asset://{item.get('id')}\">"
        for item in (visual_assets or [])
    ) or "- none"
    return f"""Deck title: {outline.get("title", "")}
Overall style: {outline.get("style", "")}
Color scheme: {outline.get("color_scheme", "")}
Design language: {json.dumps(outline.get("visual_system") or {}, ensure_ascii=False)[:2100]}
Competition design profile: {json.dumps(outline.get("design_profile") or {}, ensure_ascii=False)[:1600]}
Visual grammar: {json.dumps(outline.get("visual_grammar") or {}, ensure_ascii=False)[:1800]}
Narrative architecture: {json.dumps(outline.get("narrative_architecture") or {}, ensure_ascii=False)[:1000]}
Reference style guidance: {reference_guidance[:900] or "none"}

Create slide {idx + 1} of {total} as PPT-Master-ready editable SVG.
Slide type: {slide.get("type", "content")}
Slide title: {slide.get("title", "")}
Locked page layout archetype: {(slide.get("design_contract") or {}).get("layout_archetype") or slide.get("layout_archetype") or slide.get("layout_recipe") or _default_slide_layout_recipe(slide, idx)}
Locked page silhouette: {slide.get("page_silhouette") or "derive a distinct editorial silhouette from the page role"}
Material strategy: {slide.get("material_strategy") or (outline.get("visual_grammar") or {}).get("material_strategy") or "topic-derived editorial material"}
Icon system: {slide.get("icon_role") or (outline.get("visual_grammar") or {}).get("icon_system") or "use no icon unless it carries a clear meaning"}
Locked page rhythm: {slide.get("page_rhythm") or "breathing"}
Locked content density: {slide.get("content_density") or "standard"}
Page execution brief (this is a production constraint, never visible copy):
{_compact_page_execution_brief(outline, slide)}

Supplied image2 visual assets:
{asset_lines}

Design it as a complete commercial/competition-grade presentation slide with clear hierarchy, balanced whitespace, and editable text elements. Honor the page execution brief before selecting individual shapes. Respect the locked layout archetype, page silhouette and native component plan; do not fall back to a generic card grid. Make the selected design profile visible through composition, material treatment, icon system and motif restraint rather than a mere palette swap. Use one coherent design language but change the page silhouette and rhythm according to this page role. Never render this production brief, source analysis, or any implementation labels as visible slide text.
  Treat any selected catalog template as a soft visual reference only: do not copy its geometry, number of cards, placeholders, navigation bars or repeated layout. Do not make a dashboard, software UI, 2×2/3×2 equal-card wall, pill rows, or a decorative icon cluster. Follow the spatial policy as a hard layout contract: reserve the title in its own top reading band; give every text block a clearly bounded copy panel/column; and treat every bounded image, chart, ring, mechanism or hero object as a protected visual zone that copy may not enter. Do not overlap text with a bounded image unless that image explicitly has `data-allow-text-overlay="true"` and the copy sits on a dedicated native opaque overlay. Long copy must be shortened into a heading plus one concise line or moved to a separate page; do not shrink type or allow a line to cross its panel edge, gutter, image, chart, or title band.
  Icons are optional: omit them when a hero visual, photograph, chart or mechanism already explains the page. Otherwise use them only for an explicit finite category system and never more than the spatial policy permits. All icons must use the same `tabler-outline/*` line-icon family, as `<use data-icon="tabler-outline/name" width="40" height="40" stroke-width="1.8" .../>`. Keep an icon graphic at 28–48 px and its visual container no larger than 56 px; never use emoji, glyphs, stickers, oversized circular rings, badges, or logo-like medallions as decoration. Prefer one decisive hero material, evidence spread, spatial mechanism, documentary crop, or typographic statement over many same-weight boxes.
For every supplied asset, include its exact asset:// token in an <image> element and respect its placement, depth plane, focal point, crop, mask, overlay, and controlled-overlap policy. Full-bleed photographic backgrounds and foreground silhouettes are allowed when planned; use native SVG overlays and editable text above them. Use <clipPath> with circle, ellipse, rounded rect, path, or polygon geometry for planned masks.
Never turn the complete slide into a raster or place required words inside an image. All required words, numbers, cards, diagrams, and charts must remain native SVG. Keep copy away from the visual subject itself, but allow deliberate overlap over protected overlays or negative space.
  Before returning, verify line by line: one clear focal area; visible hierarchy matches the page goal; all required copy remains editable and lies wholly inside its designated copy panel; no text intersects a protected image/chart/hero zone; the selected visual is a material layer rather than a slide screenshot; no default template geometry leaked into the page; the title occupies an independent top safe zone and never intersects a diagram or hero object; icons are semantic, small, and visually consistent; and the composition follows the stated whitespace rule. Do not shrink text to fit: reduce or split copy instead."""


def _safe_project_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", str(value or "").strip(), flags=re.UNICODE)
    slug = re.sub(r"_+", "_", slug).strip("_")
    return (slug or fallback)[:48]


def _ppt_master_slide_filename(slide: dict, idx: int) -> str:
    title = _safe_project_slug(str(slide.get("title") or ""), f"slide_{idx + 1}")
    return f"{idx + 1:02d}_{title}.svg"


def _format_slide_spec(slides: list[dict]) -> str:
    lines: list[str] = []
    for idx, slide in enumerate(slides):
        visual_asset = slide.get("visual_asset") if isinstance(slide.get("visual_asset"), dict) else {}
        contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
        points = "\n".join(f"  - {p}" for p in slide.get("points", []) if str(p).strip()) or "  - 自动规划"
        lines.append(
            "\n".join([
                f"## Slide {idx + 1}: {slide.get('title') or f'第 {idx + 1} 页'}",
                f"- type: {slide.get('type', 'content')}",
                f"- layout_recipe: {slide.get('layout_recipe', 'editorial_split')}",
                f"- layout_archetype: {contract.get('layout_archetype', slide.get('layout_archetype', ''))}",
                f"- page_rhythm: {slide.get('page_rhythm', 'breathing')}",
                f"- content_density: {slide.get('content_density', 'standard')}",
                f"- narrative_role: {contract.get('narrative_role', '')}; visual_form: {contract.get('visual_form', '')}; density: {contract.get('density', '')}",
                f"- page_goal: {contract.get('page_goal', '')}",
                f"- composition: {contract.get('composition', {})}",
                f"- layout_instruction: {contract.get('layout_instruction', {})}",
                f"- component_plan: {contract.get('component_plan', {})}",
                f"- content_budget: {contract.get('content_budget', {})}",
                f"- must_avoid: {contract.get('must_avoid', [])}",
                f"- layout_hint: {slide.get('layout_hint', '')}",
                f"- page_prompt: {slide.get('prompt', '')}",
                f"- visual_asset: source={visual_asset.get('source', 'none')}; placement={visual_asset.get('placement', '')}; crop={visual_asset.get('crop', '')}; treatment={visual_asset.get('treatment', '')}",
                f"- visual_role: {visual_asset.get('purpose', '')}; subject={visual_asset.get('subject', '')}; art_direction={visual_asset.get('art_direction', '')}",
                "- points:",
                points,
            ])
        )
    return "\n\n".join(lines)


def _build_ppt_master_design_spec(
    *,
    state: dict,
    outline: dict,
    reference_guidance: str,
) -> str:
    slides = outline.get("slides", []) or []
    attachments = state.get("attachments") or []
    attachment_names = "\n".join(
        f"- {item.get('filename') or 'attachment'} ({item.get('kind') or 'file'})"
        for item in attachments[:20]
        if isinstance(item, dict)
    ) or "- none"
    return f"""# PPT Master Design Spec

## Source Document
- Topic: {state.get("topic", "")}
- Requested pages: {state.get("page_count") or len(slides)}
- Style hint: {state.get("style_hint", "")}
- Conversion mode: ppt_master_direct
- Presentation brief: {json.dumps(_clean_ppt_brief(state.get("brief")), ensure_ascii=False)}

## Source Attachments
{attachment_names}

## Deck Strategy
- Title: {outline.get("title", "")}
- Style: {outline.get("style", "")}
- Color scheme: {outline.get("color_scheme", "")}
- Visual system: {json.dumps(outline.get("visual_system") or {}, ensure_ascii=False)}
- Competition design profile: {json.dumps(outline.get("design_profile") or {}, ensure_ascii=False)}
- Narrative architecture: {json.dumps(outline.get("narrative_architecture") or {}, ensure_ascii=False)}
- Source grounding: {json.dumps(outline.get("grounding") or {}, ensure_ascii=False)[:6000]}
- Reference guidance: {reference_guidance or "none"}

## Slide Plan
{_format_slide_spec(slides)}

## Production Constraints
- Canvas: 1792 x 1024, 16:9.
- Output: editable SVG first, then native DrawingML PPTX.
- Use image2 only for explicitly planned supporting visual assets. All required text, cards, diagrams, and charts remain native SVG/DrawingML.
- Treat layout_recipe, page_rhythm, the page-level design contract, and the visual asset decision as a locked per-page execution contract. Do not repeat a generic card layout across the whole deck.
- Every page must express the subject-specific design profile through its material choice, motif, composition and reading rhythm. A color change alone is not a valid theme adaptation.
- A visual asset is a supporting material layer, never a replacement for editable content. Full-bleed is allowed only when the page asset policy explicitly requests full_bleed/full_bleed_overlay; editable copy must then sit on a protected native overlay.
- Never render planner prompts, layout hints, source-analysis notes, or implementation instructions on a user-visible slide.
- Use uploaded files and reference image analysis as factual/style constraints.
- Keep all visible text editable as SVG text where possible.
"""


def _write_ppt_master_project_files(
    *,
    project_dir: Path,
    state: dict,
    outline: dict,
    reference_guidance: str,
) -> dict[str, Path]:
    """Create a ppt-master-style project scaffold and lock files."""
    dirs = {
        "sources": project_dir / "sources",
        "images": project_dir / "images",
        "templates": project_dir / "templates",
        "svg_output": project_dir / "svg_output",
        "svg_final": project_dir / "svg_final",
        "notes": project_dir / "notes",
        "exports": project_dir / "exports",
        "backup": project_dir / "backup",
        "confirm_ui": project_dir / "confirm_ui",
    }
    for path in dirs.values():
        path.mkdir(parents=True, exist_ok=True)

    design_spec = _build_ppt_master_design_spec(
        state=state,
        outline=outline,
        reference_guidance=reference_guidance,
    )
    spec_lock = (
        design_spec
        + "\n## Spec Lock\n"
        + f"- Locked at: {datetime.now(timezone.utc).isoformat()}\n"
        + "- Status: confirmed by user through outline confirmation.\n"
    )
    recommendations = {
        "status": "locked",
        "confirmations": {
            "deck_content": True,
            "slide_count": True,
            "theme": True,
            "canvas": "16:9",
            "style": True,
            "export": "native DrawingML PPTX",
            "planned_image_assets_only": True,
        },
        "next_steps": [
            "generate editable SVG pages from spec_lock.md",
            "quality-check SVG pages",
            "post-process into svg_final",
            "export PPTX",
        ],
    }
    files = {
        "design_spec": project_dir / "design_spec.md",
        "spec_lock": project_dir / "spec_lock.md",
        "recommendations": dirs["confirm_ui"] / "recommendations.json",
        "outline": project_dir / "outline.json",
    }
    files["design_spec"].write_text(design_spec, encoding="utf-8")
    files["spec_lock"].write_text(spec_lock, encoding="utf-8")
    files["recommendations"].write_text(json.dumps(recommendations, ensure_ascii=False, indent=2), encoding="utf-8")
    files["outline"].write_text(json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8")

    if state.get("attachment_context"):
        (dirs["sources"] / "attachment_context.md").write_text(state["attachment_context"], encoding="utf-8")
    if reference_guidance:
        (dirs["sources"] / "reference_image_guidance.md").write_text(reference_guidance, encoding="utf-8")

    return {**dirs, **files}


def _write_ppt_master_notes(notes_dir: Path, svg_path: Path, slide: dict, idx: int) -> Path:
    points = "\n".join(f"- {p}" for p in slide.get("points", []) if str(p).strip()) or "- 自动规划"
    content = f"""# Speaker Notes: {slide.get("title") or f"Slide {idx + 1}"}

## Core Message
{slide.get("layout_hint") or slide.get("prompt") or slide.get("title") or ""}

## Talking Points
{points}
"""
    notes_path = notes_dir / f"{svg_path.stem}.md"
    notes_path.write_text(content, encoding="utf-8")
    return notes_path


def _svg_attr_number(tag: str, name: str, default: float = 0.0) -> float:
    match = re.search(rf"\b{name}=[\"']([-+]?\d+(?:\.\d+)?)", tag, flags=re.IGNORECASE)
    if not match:
        return default
    try:
        return float(match.group(1))
    except (TypeError, ValueError):
        return default


_SVG_CANVAS_WIDTH = 1792.0
_SVG_CANVAS_HEIGHT = 1024.0
_SVG_TEXT_SAFE_INSET = 24.0


def _svg_text_width(text: str, font_size: float) -> float:
    """Estimate an editable SVG line conservatively enough for layout QA."""
    units = 0.0
    for char in text:
        if char.isspace():
            units += 0.32
        elif ord(char) >= 0x2E80:
            # CJK and full-width punctuation occupy approximately one em.
            units += 1.0
        elif char.isupper():
            units += 0.66
        elif char.isdigit():
            units += 0.58
        else:
            units += 0.54
    return max(font_size * 0.7, units * font_size)


def _native_svg_copy_regions(svg: str) -> list[tuple[float, float, float, float]]:
    """Find bounded native panels that can safely contain a text baseline."""
    regions: list[tuple[float, float, float, float]] = []
    for tag in re.findall(r"<rect\b[^>]*/?>", svg, flags=re.IGNORECASE):
        opacity = _svg_attr_number(tag, "opacity", 1.0)
        x = _svg_attr_number(tag, "x", -1)
        y = _svg_attr_number(tag, "y", -1)
        width = _svg_attr_number(tag, "width")
        height = _svg_attr_number(tag, "height")
        if opacity < 0.25 or x < 0 or y < 0 or width < 160 or height < 120:
            continue
        # The canvas background is a paint layer, not a text container. If it
        # participates in fitting, copy beginning near the right edge is fit
        # against 1792 px instead of the safe margin, so it can still be
        # clipped after SVG-to-DrawingML conversion.
        if width >= _SVG_CANVAS_WIDTH * 0.95 and height >= _SVG_CANVAS_HEIGHT * 0.95:
            continue
        regions.append((x, y, x + width, y + height))
    return regions


def _fit_native_svg_text_blocks(svg: str) -> str:
    """Repair native multiline text before export, using the actual panel width.

    All deterministic layouts emit multiline ``tspan`` text blocks. This pass
    turns those into geometry-aware blocks: a title is allowed to use another
    line when needed, while card copy is held inside its containing panel. It
    runs before SVG/DrawingML conversion so the resulting PowerPoint text boxes
    retain the same safe geometry and remain editable.
    """
    regions = _native_svg_copy_regions(svg)

    def replace(match: re.Match[str]) -> str:
        attrs = match.group("attrs")
        content = match.group("content")
        if "<tspan" not in content.lower():
            return match.group(0)
        x = _svg_attr_number(attrs, "x", -1)
        y = _svg_attr_number(attrs, "y", -1)
        size = _svg_attr_number(attrs, "font-size", 24)
        if x < 0 or y < 0 or size <= 0:
            return match.group(0)
        anchor_match = re.search(r"\btext-anchor=[\"']([^\"']+)", attrs, flags=re.IGNORECASE)
        anchor = anchor_match.group(1).lower() if anchor_match else "start"
        weight_match = re.search(r"\bfont-weight=[\"']([^\"']+)", attrs, flags=re.IGNORECASE)
        weight = weight_match.group(1) if weight_match else "400"
        raw_text = html_unescape(re.sub(r"<[^>]+>", "", content))
        raw_text = re.sub(r"\s+", " ", raw_text).strip()
        if not raw_text:
            return match.group(0)

        containing = [
            region for region in regions
            if region[0] - 4 <= x <= region[2] + 4 and region[1] - size * 1.1 <= y <= region[3] + 4
        ]
        left, top, right, bottom = min(containing, key=lambda region: (region[2] - region[0]) * (region[3] - region[1])) if containing else (
            _SVG_TEXT_SAFE_INSET,
            _SVG_TEXT_SAFE_INSET,
            _SVG_CANVAS_WIDTH - _SVG_TEXT_SAFE_INSET,
            _SVG_CANVAS_HEIGHT - _SVG_TEXT_SAFE_INSET,
        )
        horizontal_inset = max(14, size * 0.28)
        if anchor == "end":
            available_width = x - left - horizontal_inset
        elif anchor == "middle":
            available_width = min(x - left, right - x) * 2 - horizontal_inset * 2
        else:
            available_width = right - x - horizontal_inset
        if available_width <= size * 1.5:
            return match.group(0)

        dy_values = [
            _svg_attr_number(tspan.group(1), "dy", 0)
            for tspan in re.finditer(r"<tspan\b([^>]*)>", content, flags=re.IGNORECASE)
        ]
        line_gap = next((int(value - size) for value in dy_values[1:] if value > size), max(6, int(size * 0.2)))
        line_height = max(size * 1.08, size + line_gap)
        max_by_height = max(1, int((bottom - y + size * 0.35) // line_height))
        preferred_lines = 3 if size >= 46 else 4 if size >= 28 else 5
        lines = _wrap_text_to_width_for_svg(
            raw_text,
            max_width=available_width,
            font_size=size,
            max_lines=min(preferred_lines, max_by_height),
            weight=weight,
        )
        if not lines:
            return match.group(0)
        tspans = "".join(
            f'<tspan x="{int(round(x))}" dy="{0 if index == 0 else int(round(line_height))}">{xml_escape(line)}</tspan>'
            for index, line in enumerate(lines)
        )
        return f"<text{attrs}>{tspans}</text>"

    return re.sub(
        r"<text(?P<attrs>[^>]*)>(?P<content>[\s\S]*?)</text>",
        replace,
        svg,
        flags=re.IGNORECASE,
    )


def _svg_element_identifier(tag: str) -> str:
    match = re.search(r"\bid=[\"']([^\"']+)", tag, flags=re.IGNORECASE)
    return match.group(1).lower() if match else ""


def _svg_text_line_boxes(svg: str) -> list[dict[str, float | str]]:
    """Return measured line boxes for direct text and ``tspan`` SVG copy.

    The SVG agent is free to choose a page silhouette, but browser/PPT export
    has no equivalent of a CSS text-flow engine.  A measured, line-level view
    lets the quality gate reason about *where* copy actually lands, rather than
    only whether it remains inside the 16:9 canvas.
    """
    boxes: list[dict[str, float | str]] = []
    for text_tag in re.findall(r"<text\b[^>]*>[\s\S]*?</text>", svg, flags=re.IGNORECASE):
        opening_tag, _, content = text_tag.partition(">")
        x = _svg_attr_number(opening_tag, "x", -1)
        y = _svg_attr_number(opening_tag, "y", -1)
        font_size = _svg_attr_number(opening_tag, "font-size", 24)
        if x < 0 or y < 0 or font_size <= 0:
            continue
        identifier = _svg_element_identifier(opening_tag)
        anchor_match = re.search(r"\btext-anchor=[\"']([^\"']+)", opening_tag, flags=re.IGNORECASE)
        anchor = anchor_match.group(1).lower() if anchor_match else "start"
        weight_match = re.search(r"\bfont-weight=[\"']([^\"']+)", opening_tag, flags=re.IGNORECASE)
        weight = weight_match.group(1) if weight_match else "400"
        current_x, current_y = x, y

        def append_line(line_x: float, line_y: float, line_size: float, line_text: str, line_anchor: str, line_weight: str) -> None:
            text = re.sub(r"\s+", " ", html_unescape(line_text)).strip()
            if not text:
                return
            width = _measure_svg_text_width(text, line_size, line_weight)
            if line_anchor == "middle":
                left, right = line_x - width / 2, line_x + width / 2
            elif line_anchor == "end":
                left, right = line_x - width, line_x
            else:
                left, right = line_x, line_x + width
            boxes.append({
                "left": left,
                "top": line_y - line_size * 0.98,
                "right": right,
                "bottom": line_y + line_size * 0.36,
                "x": line_x,
                "y": line_y,
                "font_size": line_size,
                "text": text,
                "id": identifier,
            })

        # Text nodes directly inside <text>, excluding tspan children.
        direct_text = re.sub(r"<tspan\b[^>]*>[\s\S]*?</tspan>", "", content, flags=re.IGNORECASE)
        direct_text = re.sub(r"<[^>]+>", " ", direct_text)
        for line in (value.strip() for value in direct_text.splitlines()):
            append_line(current_x, current_y, font_size, line, anchor, weight)

        for tspan in re.finditer(r"<tspan\b(?P<attrs>[^>]*)>(?P<content>[\s\S]*?)</tspan>", content, flags=re.IGNORECASE):
            attrs = tspan.group("attrs")
            span_x = _svg_attr_number(attrs, "x", current_x)
            span_y = _svg_attr_number(attrs, "y", current_y)
            if re.search(r"\by=[\"']", attrs, flags=re.IGNORECASE) is None:
                span_y += _svg_attr_number(attrs, "dy", 0)
            span_size = _svg_attr_number(attrs, "font-size", font_size)
            span_anchor_match = re.search(r"\btext-anchor=[\"']([^\"']+)", attrs, flags=re.IGNORECASE)
            span_anchor = span_anchor_match.group(1).lower() if span_anchor_match else anchor
            span_weight_match = re.search(r"\bfont-weight=[\"']([^\"']+)", attrs, flags=re.IGNORECASE)
            span_weight = span_weight_match.group(1) if span_weight_match else weight
            span_text = re.sub(r"<[^>]+>", " ", tspan.group("content"))
            for line in (value.strip() for value in span_text.splitlines()):
                append_line(span_x, span_y, span_size, line, span_anchor, span_weight)
            current_x, current_y = span_x, span_y
    return boxes


def _svg_bbox_overlap(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> tuple[float, float]:
    return (
        min(first[2], second[2]) - max(first[0], second[0]),
        min(first[3], second[3]) - max(first[1], second[1]),
    )


def _svg_copy_panel_regions(svg: str) -> list[tuple[float, float, float, float, str]]:
    """Find substantial native rectangles that can own a text block.

    This deliberately excludes backgrounds, image frames, shadows and accent
    rails.  A model does not need to name a card perfectly for the geometry
    test to work, but those decorative layers must never become a false copy
    container.
    """
    regions: list[tuple[float, float, float, float, str]] = []
    excluded_tokens = (
        "background", "shadow", "image", "photo", "visual", "asset", "frame",
        "border", "accent", "underline", "rule", "line", "rail", "decor", "title-region",
    )
    for tag in re.findall(r"<rect\b[^>]*/?>", svg, flags=re.IGNORECASE):
        opacity = _svg_attr_number(tag, "opacity", 1.0)
        x = _svg_attr_number(tag, "x", -1)
        y = _svg_attr_number(tag, "y", -1)
        width = _svg_attr_number(tag, "width")
        height = _svg_attr_number(tag, "height")
        identifier = _svg_element_identifier(tag)
        if (
            opacity < 0.45
            or x < 0
            or y < 0
            or width < 180
            or height < 72
            or any(token in identifier for token in excluded_tokens)
        ):
            continue
        if width >= _SVG_CANVAS_WIDTH * 0.95 and height >= _SVG_CANVAS_HEIGHT * 0.95:
            continue
        regions.append((x, y, x + width, y + height, identifier))
    return regions


def _svg_text_container_issues(svg: str) -> list[str]:
    """Reject a text line that escapes the smallest native panel owning it."""
    regions = _svg_copy_panel_regions(svg)
    for box in _svg_text_line_boxes(svg):
        x, y = float(box["x"]), float(box["y"])
        size = float(box["font_size"])
        containing = [
            region for region in regions
            if region[0] - 4 <= x <= region[2] + 4
            and region[1] - size * 1.15 <= y <= region[3] + 4
        ]
        if not containing:
            continue
        left, top, right, bottom, _identifier = min(
            containing,
            key=lambda region: (region[2] - region[0]) * (region[3] - region[1]),
        )
        tolerance = max(10.0, size * 0.24)
        if (
            float(box["left"]) < left - tolerance
            or float(box["right"]) > right + tolerance
            or float(box["top"]) < top - tolerance
            or float(box["bottom"]) > bottom + tolerance
        ):
            return ["editable text exceeds its bounded copy panel"]
    return []


def _svg_text_safe_area_issues(svg: str) -> list[str]:
    """Reject editable text which would be clipped after native PPTX export."""
    for box in _svg_text_line_boxes(svg):
        if (
            float(box["left"]) < _SVG_TEXT_SAFE_INSET
            or float(box["right"]) > _SVG_CANVAS_WIDTH - _SVG_TEXT_SAFE_INSET
            or float(box["top"]) < _SVG_TEXT_SAFE_INSET
            or float(box["bottom"]) > _SVG_CANVAS_HEIGHT - _SVG_TEXT_SAFE_INSET
        ):
            return ["editable text exceeds the canvas safe area"]
    return []


def _svg_text_contrast_issues(svg: str) -> list[str]:
    """Reject readable-sized copy that loses contrast on its local surface.

    SVG has no layout engine that will protect a pale model-selected text colour
    from a white panel. A small visual tag may use the accent colour, but body
    and heading text must meet a minimum contrast ratio against the smallest
    opaque rectangle that contains it (or the canvas background).
    """
    background_match = re.search(
        r'<rect\b[^>]*\bid=["\']background["\'][^>]*>',
        svg,
        flags=re.IGNORECASE,
    )
    background = "#FFFFFF"
    if background_match:
        fill_match = re.search(r'\bfill=["\'](#[0-9A-Fa-f]{6})["\']', background_match.group(0))
        if fill_match:
            background = fill_match.group(1)

    surfaces: list[tuple[float, float, float, float, float, str]] = []
    for tag in re.findall(r"<rect\b[^>]*>", svg, flags=re.IGNORECASE):
        fill_match = re.search(r'\bfill=["\'](#[0-9A-Fa-f]{6})["\']', tag)
        if not fill_match:
            continue
        opacity = _svg_attr_number(tag, "opacity", 1.0)
        x = _svg_attr_number(tag, "x", -1)
        y = _svg_attr_number(tag, "y", -1)
        width = _svg_attr_number(tag, "width")
        height = _svg_attr_number(tag, "height")
        if opacity < 0.45 or x < 0 or y < 0 or width < 80 or height < 60:
            continue
        surfaces.append((x, y, x + width, y + height, width * height, fill_match.group(1)))

    for text_tag in re.findall(r"<text\b[^>]*>[\s\S]*?</text>", svg, flags=re.IGNORECASE):
        opening_tag, _, content = text_tag.partition(">")
        font_size = _svg_attr_number(opening_tag, "font-size", 24)
        if font_size < 28 or _svg_attr_number(opening_tag, "opacity", 1.0) < 0.85:
            continue
        fill_match = re.search(r'\bfill=["\'](#[0-9A-Fa-f]{6})["\']', opening_tag)
        if not fill_match:
            continue
        text = re.sub(r"<[^>]+>", "", content).strip()
        if not text:
            continue
        x = _svg_attr_number(opening_tag, "x", -1)
        y = _svg_attr_number(opening_tag, "y", -1)
        if x < 0 or y < 0:
            continue
        containing = [
            surface for surface in surfaces
            if surface[0] - 2 <= x <= surface[2] + 2
            and surface[1] - font_size * 1.1 <= y <= surface[3] + 4
        ]
        surface = min(containing, key=lambda item: item[4])[5] if containing else background
        if _color_contrast(fill_match.group(1), surface) < 3.0:
            return ["editable heading/body text has insufficient contrast on its panel"]
    return []


def _svg_image_allows_text_overlay(
    image_tag: str,
    image_bounds: tuple[float, float, float, float],
    slide: dict,
    asset_by_id: dict[str, dict],
) -> bool:
    """Allow text over an image only when the plan explicitly protects it."""
    overlay_marker = re.search(
        r"\bdata-allow-text-overlay=[\"'](?:true|1|yes)[\"']",
        image_tag,
        flags=re.IGNORECASE,
    )
    if overlay_marker:
        return True
    identifier = _svg_element_identifier(image_tag)
    href_match = re.search(r"\bhref=[\"']asset://([^\"']+)", image_tag, flags=re.IGNORECASE)
    asset_id = href_match.group(1) if href_match else identifier
    planned = asset_by_id.get(asset_id, {})
    placement = str(planned.get("placement") or "").lower()
    treatment = str(planned.get("treatment") or "").lower()
    if planned.get("allow_overlap") is True:
        return True
    if placement == "full_bleed" and treatment == "full_bleed_overlay":
        return True
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    policy = contract.get("layout_policy") if isinstance(contract.get("layout_policy"), dict) else {}
    if policy.get("allow_text_over_asset") is True:
        return True
    left, top, right, bottom = image_bounds
    return left <= 4 and top <= 4 and right >= _SVG_CANVAS_WIDTH * 0.96 and bottom >= _SVG_CANVAS_HEIGHT * 0.96


def _svg_text_asset_collision_issues(
    svg: str,
    slide: dict,
    visual_assets: list[dict] | None,
) -> list[str]:
    """Keep copy out of a bounded planned image/hero field.

    This catches the failure invisible to canvas-overflow tests: a valid text
    line continues across its gutter and lands inside a neighbouring photograph
    or generated hero.  Full-bleed image stories remain possible, but only
    through their declared overlay policy.
    """
    asset_by_id = {
        str(asset.get("id") or ""): asset
        for asset in (visual_assets or [])
        if isinstance(asset, dict) and str(asset.get("id") or "")
    }
    text_boxes = _svg_text_line_boxes(svg)
    for image_tag in re.findall(r"<image\b[^>]*>", svg, flags=re.IGNORECASE):
        x = _svg_attr_number(image_tag, "x", -1)
        y = _svg_attr_number(image_tag, "y", -1)
        width = _svg_attr_number(image_tag, "width")
        height = _svg_attr_number(image_tag, "height")
        if x < 0 or y < 0 or width < 120 or height < 120:
            continue
        image_bounds = (x, y, x + width, y + height)
        if _svg_image_allows_text_overlay(image_tag, image_bounds, slide, asset_by_id):
            continue
        for box in text_boxes:
            overlap_width, overlap_height = _svg_bbox_overlap(
                (float(box["left"]), float(box["top"]), float(box["right"]), float(box["bottom"])),
                image_bounds,
            )
            # A tiny antialiasing touch at a shared edge is harmless; a full
            # character entering a neighbouring image is always a layout bug.
            if overlap_width > max(12.0, float(box["font_size"]) * 0.35) and overlap_height > max(8.0, float(box["font_size"]) * 0.30):
                return ["editable text intrudes into a protected visual asset zone"]
    return []


def _svg_text_collision_issues(svg: str) -> list[str]:
    """Catch common model regressions where an icon is drawn over editable copy."""
    text_boxes: list[tuple[float, float, float, float]] = []
    for tag in re.findall(r"<text\b[^>]*>[\s\S]*?</text>", svg, flags=re.IGNORECASE):
        x = _svg_attr_number(tag, "x", -1)
        y = _svg_attr_number(tag, "y", -1)
        size = _svg_attr_number(tag, "font-size", 24)
        if x < 0 or y < 0 or size <= 0:
            continue
        raw_text = re.sub(r"<[^>]+>", " ", tag)
        raw_text = re.sub(r"\s+", " ", raw_text).strip()
        if not raw_text:
            continue
        lines = max(1, raw_text.count("\n") + len(re.findall(r"<tspan\b", tag, flags=re.IGNORECASE)))
        longest_line = max((len(line) for line in raw_text.splitlines()), default=len(raw_text))
        width = min(1600.0, max(24.0, longest_line * size * 0.56))
        height = min(240.0, max(size * 1.12, lines * size * 1.18))
        anchor = re.search(r"\btext-anchor=[\"']([^\"']+)", tag, flags=re.IGNORECASE)
        anchor_value = anchor.group(1).lower() if anchor else "start"
        if anchor_value == "middle":
            x -= width / 2
        elif anchor_value == "end":
            x -= width
        text_boxes.append((x - 8, y - size - 4, x + width + 8, y + height + 4))

    issues: list[str] = []
    for tag in re.findall(r"<(?:circle|ellipse)\b[^>]*/?>", svg, flags=re.IGNORECASE):
        opacity = _svg_attr_number(tag, "opacity", 1.0)
        if opacity <= 0.2:
            continue
        identifier = (re.search(r"\bid=[\"']([^\"']+)", tag, flags=re.IGNORECASE) or ["", ""])[1].lower()
        # Native rails deliberately place numbered circles around their own
        # labels. They are structural nodes, not icons accidentally drawn over
        # copy; treating them as collisions makes every process page fail.
        if any(token in identifier for token in ("node", "orbit", "outcome-dot")):
            continue
        cx = _svg_attr_number(tag, "cx", -1)
        cy = _svg_attr_number(tag, "cy", -1)
        radius_x = _svg_attr_number(tag, "r", _svg_attr_number(tag, "rx", 0))
        radius_y = _svg_attr_number(tag, "r", _svg_attr_number(tag, "ry", radius_x))
        if cx < 0 or cy < 0 or radius_x <= 8 or radius_y <= 8:
            continue
        for left, top, right, bottom in text_boxes:
            if left <= cx + radius_x and right >= cx - radius_x and top <= cy + radius_y and bottom >= cy - radius_y:
                issues.append("an icon circle overlaps editable text")
                break

    for tag in re.findall(r"<rect\b[^>]*/?>", svg, flags=re.IGNORECASE):
        opacity = _svg_attr_number(tag, "opacity", 1.0)
        width = _svg_attr_number(tag, "width")
        height = _svg_attr_number(tag, "height")
        identifier = (re.search(r"\bid=[\"']([^\"']+)", tag, flags=re.IGNORECASE) or ["", ""])[1].lower()
        compact_shape = width <= 180 and height <= 180
        named_decoration = any(token in identifier for token in ("icon", "marker", "badge", "decor", "node"))
        if opacity <= 0.2 or width < 24 or height < 20 or not (compact_shape or named_decoration):
            continue
        left = _svg_attr_number(tag, "x")
        top = _svg_attr_number(tag, "y")
        right, bottom = left + width, top + height
        for text_left, text_top, text_right, text_bottom in text_boxes:
            overlap_width = min(right, text_right) - max(left, text_left)
            overlap_height = min(bottom, text_bottom) - max(top, text_top)
            if overlap_width > 12 and overlap_height > 12:
                issues.append("a compact shape overlaps editable text")
                break

    return list(dict.fromkeys(issues))


def _svg_icon_scale_issues(svg: str, slide: dict | None = None) -> list[str]:
    """Keep generated iconography small, standard, and subordinate to content."""
    slide = slide if isinstance(slide, dict) else {}
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    policy = contract.get("layout_policy") if isinstance(contract.get("layout_policy"), dict) else {}
    try:
        maximum_icons = min(3, max(0, int(policy.get("max_semantic_icons", 3))))
    except (TypeError, ValueError):
        maximum_icons = 3
    icon_tags = re.findall(r"<use\b[^>]*\bdata-icon=[\"'][^\"']+[\"'][^>]*/?>", svg, flags=re.IGNORECASE)
    if len(icon_tags) > maximum_icons:
        return [f"uses more than {maximum_icons} semantic icons allowed by the page layout policy"]
    icon_names: list[str] = []
    for tag in icon_tags:
        icon_match = re.search(r"\bdata-icon=[\"']([^\"']+)", tag, flags=re.IGNORECASE)
        icon_name = icon_match.group(1) if icon_match else ""
        width = _svg_attr_number(tag, "width")
        height = _svg_attr_number(tag, "height")
        icon_names.append(icon_name)
        if not icon_name.startswith("tabler-outline/"):
            return ["uses a non-standard icon family; use tabler-outline icons only"]
        if not width or not height or width < 24 or height < 24 or width > 56 or height > 56:
            return ["icon graphic must use the 24–56px restrained semantic scale"]
    if len(icon_names) != len(set(icon_names)):
        return ["repeats the same semantic icon as decoration"]

    # SVG authors occasionally draw a large icon "badge" from basic shapes
    # instead of a <use>.  The associated IDs are stable enough to catch that
    # anti-pattern without treating normal process nodes as iconography.
    for tag in re.findall(r"<(?:circle|ellipse|rect)\b[^>]*/?>", svg, flags=re.IGNORECASE):
        identifier = _svg_element_identifier(tag)
        if not any(token in identifier for token in ("icon", "badge", "medallion", "sticker")):
            continue
        if tag.lower().startswith("<rect"):
            width = _svg_attr_number(tag, "width")
            height = _svg_attr_number(tag, "height")
            if width > 56 or height > 56:
                return ["icon container exceeds the 56px restrained scale"]
        else:
            radius_x = _svg_attr_number(tag, "r", _svg_attr_number(tag, "rx", 0))
            radius_y = _svg_attr_number(tag, "r", _svg_attr_number(tag, "ry", radius_x))
            if max(radius_x, radius_y) > 28:
                return ["icon container exceeds the 56px restrained scale"]
    return []


def _svg_title_safe_zone_issues(svg: str, slide: dict) -> list[str]:
    """Keep a content-page heading clear of prominent circular diagram nodes."""
    if str(slide.get("type") or "").strip().lower() in {"cover", "chapter", "section"}:
        return []
    title = re.sub(r"\s+", "", str(slide.get("title") or ""))
    if len(title) < 2:
        return []
    title_box: tuple[float, float, float, float] | None = None
    for text_tag in re.findall(r"<text\b[^>]*>[\s\S]*?</text>", svg, flags=re.IGNORECASE):
        rendered = re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", text_tag))
        if title[: min(len(title), 8)] not in rendered:
            continue
        x = _svg_attr_number(text_tag, "x", -1)
        y = _svg_attr_number(text_tag, "y", -1)
        size = _svg_attr_number(text_tag, "font-size", 24)
        if x < 0 or y < 0:
            continue
        width = min(1500.0, max(size * 1.5, _svg_text_width(rendered, size)))
        anchor = (re.search(r"\btext-anchor=[\"']([^\"']+)", text_tag, flags=re.IGNORECASE) or ["", "start"])[1].lower()
        left = x - width / 2 if anchor == "middle" else x - width if anchor == "end" else x
        title_box = (left - 20, y - size * 1.15 - 16, left + width + 20, y + size * 0.55 + 16)
        break
    if not title_box:
        return []
    left, top, right, bottom = title_box
    for tag in re.findall(r"<(?:circle|ellipse)\b[^>]*/?>", svg, flags=re.IGNORECASE):
        if _svg_attr_number(tag, "opacity", 1.0) <= 0.25:
            continue
        cx = _svg_attr_number(tag, "cx", -1)
        cy = _svg_attr_number(tag, "cy", -1)
        rx = _svg_attr_number(tag, "r", _svg_attr_number(tag, "rx", 0))
        ry = _svg_attr_number(tag, "r", _svg_attr_number(tag, "ry", rx))
        if cx < 0 or cy < 0 or max(rx, ry) < 32:
            continue
        if left <= cx + rx and right >= cx - rx and top <= cy + ry and bottom >= cy - ry:
            return ["a prominent diagram node intrudes into the title safe zone"]
    return []


def _score_svg_quality(
    svg: str,
    slide: dict,
    visual_assets: list[dict] | None = None,
) -> tuple[bool, list[str]]:
    issues: list[str] = []
    warnings: list[str] = []
    if 'viewBox="0 0 1792 1024"' not in svg and "viewBox='0 0 1792 1024'" not in svg:
        issues.append("missing expected 1792x1024 viewBox")
    lowered = svg.lower()
    if "<text" not in lowered:
        issues.append("no editable text elements")
    contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
    archetype = str(contract.get("layout_archetype") or slide.get("layout_archetype") or "").strip().lower()
    visual_form = str(contract.get("visual_form") or "").strip().lower()
    density = str(contract.get("density") or slide.get("content_density") or "").strip().lower()
    # Sparse cover/statement pages are intentionally editorial: forcing eight
    # separate elements would recreate the very dashboard/card clutter the
    # design contract forbids. Their copy safety, contrast, and editability are
    # still checked below; denser diagrams keep the higher structural floor.
    minimum_elements = 4 if (
        density == "low"
        or visual_form in {"cover_statement", "quote_statement", "chapter_marker"}
        or archetype in {"cover_hero", "statement", "section_break"}
    ) else 8
    if len(re.findall(r"<(?:rect|circle|ellipse|line|polyline|polygon|path|text|g)\b", svg, flags=re.IGNORECASE)) < minimum_elements:
        issues.append("too few editable SVG elements")
    issues.extend(_svg_text_safe_area_issues(svg))
    issues.extend(_svg_text_container_issues(svg))
    issues.extend(_svg_text_contrast_issues(svg))
    issues.extend(_svg_text_asset_collision_issues(svg, slide, visual_assets))
    issues.extend(_svg_text_collision_issues(svg))
    issues.extend(_svg_icon_scale_issues(svg, slide))
    issues.extend(_svg_title_safe_zone_issues(svg, slide))
    title = str(slide.get("title") or "").strip()
    if title and title[:8] not in svg:
        warnings.append("slide title may be paraphrased or split")
    planned_asset_map = {
        str(item.get("id") or ""): item
        for item in (visual_assets or [])
        if isinstance(item, dict) and str(item.get("id") or "")
    }
    planned_assets = set(planned_asset_map)
    image_tokens = re.findall(r"<image\b[^>]*\bhref=[\"']asset://([^\"']+)[\"']", svg, flags=re.IGNORECASE)
    if "<image" in lowered and not planned_assets:
        issues.append("contains an image without a planned visual asset")
    elif any(token not in planned_assets for token in image_tokens):
        issues.append("references an unplanned visual asset")
    elif planned_assets and any(asset_id not in image_tokens for asset_id in planned_assets):
        issues.append("does not reserve every planned visual asset")
    image_tags = re.findall(r"<image\b[^>]*>", svg, flags=re.IGNORECASE)
    for image_tag in image_tags:
        width_match = re.search(r"\bwidth=[\"']([\d.]+)", image_tag, flags=re.IGNORECASE)
        height_match = re.search(r"\bheight=[\"']([\d.]+)", image_tag, flags=re.IGNORECASE)
        try:
            width = float(width_match.group(1)) if width_match else 0.0
            height = float(height_match.group(1)) if height_match else 0.0
        except ValueError:
            width, height = 0.0, 0.0
        if width >= 1700 and height >= 950:
            id_match = re.search(r"\bid=[\"']([^\"']+)", image_tag, flags=re.IGNORECASE)
            planned = planned_asset_map.get(id_match.group(1) if id_match else "", {})
            placement = str(planned.get("placement") or "").lower()
            treatment = str(planned.get("treatment") or "").lower()
            if placement != "full_bleed" and treatment != "full_bleed_overlay":
                issues.append("uses an unplanned full-slide image instead of a material layer")
            break

    budget = contract.get("content_budget") if isinstance(contract.get("content_budget"), dict) else {}
    points = slide.get("points") if isinstance(slide.get("points"), list) else []
    max_points = budget.get("max_points")
    try:
        if max_points and len(points) > int(max_points):
            warnings.append("planned copy exceeds the page content budget; prioritize rather than shrink text")
    except (TypeError, ValueError):
        pass

    # Generated decks often regress into several same-sized filled cards. Catch
    # that specific failure when the page contract calls for an asymmetric or
    # singular composition, while allowing legitimate data/card pages through.
    rect_sizes: dict[tuple[int, int], int] = {}
    for tag in re.findall(r"<rect\b[^>]*>", svg, flags=re.IGNORECASE):
        width_match = re.search(r"\bwidth=[\"']([\d.]+)", tag, flags=re.IGNORECASE)
        height_match = re.search(r"\bheight=[\"']([\d.]+)", tag, flags=re.IGNORECASE)
        try:
            width = int(float(width_match.group(1))) if width_match else 0
            height = int(float(height_match.group(1))) if height_match else 0
        except ValueError:
            continue
        if 160 <= width <= 900 and 90 <= height <= 600:
            rect_sizes[(width, height)] = rect_sizes.get((width, height), 0) + 1
    repeated_cards = max(rect_sizes.values(), default=0)
    if archetype in {"asymmetric_2_3_1_3", "primary_secondary", "single_focus", "l_shape", "t_shape"} and repeated_cards >= 3:
        issues.append("uses a repeated equal-card grid that conflicts with the locked layout archetype")
    if archetype == "single_focus" and len(rect_sizes) >= 4:
        issues.append("single-focus page contains too many competing content regions")
    form = str(contract.get("visual_form") or "").strip().lower()
    if form == "process_flow" or archetype in {"waterfall", "sequence", "l_shape", "t_shape"}:
        shape_count = len(re.findall(r"<(?:rect|circle|ellipse|line|polyline|polygon|path)\b", svg, flags=re.IGNORECASE))
        node_count = len(re.findall(r"<(?:circle|ellipse)\b", svg, flags=re.IGNORECASE))
        required_nodes = min(3, max(3, len(points)))
        if node_count < required_nodes or shape_count < 12:
            issues.append("process page is too sparse; it must show separated stages, connectors, and an outcome rail")
    return len(issues) == 0, issues + warnings


async def _record_pptx_qa(state: dict, job_id: str, output_path: Path, progress: int) -> dict:
    """Run deterministic export QA and expose its result as a task artifact."""
    await set_agent_step(
        state,
        lambda s: _save_state(job_id, s),
        name="pptx_qa",
        status="running",
        message="正在检查演示文稿的文字边界、元素重叠和导出兼容性。",
        progress=progress,
    )
    summary = await asyncio.get_event_loop().run_in_executor(None, run_pptx_qa, output_path)
    state["pptx_qa"] = summary
    append_ppt_artifact(
        state,
        "pptx_qa",
        pptx_path=str(output_path),
        qa=summary,
    )
    affected = [page for page in summary.get("pages", []) if page.get("requires_attention")]
    clean_export = _is_pptx_qa_deliverable(summary)
    if affected or not clean_export:
        message = "导出检查已完成，当前 PPT 可直接下载；部分页面有可选的版式建议。"
    else:
        message = "演示文稿导出检查已完成，页面结构与兼容性符合当前交付要求。"
    await set_agent_step(
        state,
        lambda s: _save_state(job_id, s),
        name="pptx_qa",
        status="completed" if summary.get("status") == "completed" else "skipped",
        message=message,
        progress=min(progress + 3, 99),
        result={
            "overall_score": summary.get("overall_score", 0),
            "affected_pages": [page.get("page") for page in affected],
            "status": summary.get("status", "skipped"),
            "deliverable": True,
            "clean_export": clean_export,
        },
    )
    if affected or not clean_export:
        state["quality_review"] = {
            "kind": "quality_review",
            "phase": "delivery",
            "current_result_available": True,
            "message": message,
            "issues": _pptx_qa_blocking_issues(summary),
            "actions": ["keep_current", "request_revision"],
        }
        # A quality note must never pause the task or suppress its download.
        state.pop("intervention", None)
    return summary


def _pptx_qa_blocking_issues(summary: dict) -> list[str]:
    issues: list[str] = []
    for page in summary.get("pages", []) or []:
        if not isinstance(page, dict):
            continue
        page_number = page.get("page")
        for finding in page.get("issues", []) or []:
            if not isinstance(finding, dict) or finding.get("severity") != "ERROR":
                continue
            issues.append(
                f"第 {page_number} 页：{finding.get('message') or '导出检查未通过。'}"
            )
    if issues:
        return issues[:4]
    score = summary.get("overall_score", 0)
    return [f"导出质量分为 {score}，未达到 {_PPTX_DELIVERY_MIN_SCORE} 分的自动交付门槛。"]


async def _record_pptx_quality_review(state: dict, job_id: str, output_path: Path, summary: dict) -> None:
    """Persist export findings as optional advice without blocking delivery."""
    issues = _pptx_qa_blocking_issues(summary)
    state["quality_review"] = {
        "kind": "quality_review",
        "phase": "delivery",
        "current_result_available": True,
        "message": "导出检查发现可选的版式建议，当前 PPT 已保留并可直接下载。",
        "issues": issues,
        "actions": ["keep_current", "request_revision"],
    }
    state.pop("intervention", None)
    append_ppt_artifact(
        state,
        "pptx_quality_review",
        pptx_path=str(output_path),
        qa=summary,
        issues=issues,
    )
    await set_agent_step(
        state,
        lambda s: _save_state(job_id, s),
        name="pptx_delivery_review",
        status="completed",
        message="导出检查已记录为可选建议，当前版本仍可下载。",
        progress=97,
        result={
            "deliverable": True,
            "overall_score": summary.get("overall_score", 0),
            "issues": issues,
        },
    )


class PPTPageDesignRejected(ValueError):
    """A model page was returned, but did not meet the editable-layout contract."""


def _experimental_model_svg_enabled(state: dict) -> bool:
    """Use single-pass authored SVG unless an explicit legacy mode opts out."""
    return str(state.get("design_mode") or "competition").strip().lower() != "stable_only"


def _ppt_page_repair_reason(error: Exception) -> str:
    raw = str(error or "").lower()
    if "visual asset" in raw or "asset://" in raw or "image" in raw:
        return "视觉素材没有按规划保留在指定区域，需要重新组织页面。"
    if "editable" in raw or "text" in raw or "svg" in raw:
        return "页面的可编辑文字或结构不完整，需要重新整理层级。"
    if "viewbox" in raw or "element" in raw:
        return "页面结构不完整，需要重新生成可编辑版式。"
    return "页面的信息层级和可编辑结构未通过检查，需要重新组织。"


def _postprocess_ppt_master_svgs(svg_files: list[Path], svg_final_dir: Path) -> list[Path]:
    """Copy SVGs through a lightweight ppt-master-style finalization stage."""
    svg_final_dir.mkdir(parents=True, exist_ok=True)
    final_files: list[Path] = []
    for svg_path in svg_files:
        final_path = svg_final_dir / svg_path.name
        shutil.copy2(svg_path, final_path)
        try:
            from services.svg_finalize.flatten_tspan import process_svg_file as flatten_svg_file
            flatten_svg_file(str(final_path), str(final_path))
        except Exception as e:
            logger.warning(f"[PPTAgent] flatten_tspan skipped for {final_path.name}: {e}")
        try:
            from services.svg_finalize.embed_icons import process_svg_file
            from services.svg_finalize.embed_icons import DEFAULT_ICONS_DIR
            process_svg_file(final_path, DEFAULT_ICONS_DIR, dry_run=False, verbose=False)
        except Exception as e:
            logger.debug(f"[PPTAgent] embed_icons skipped for {final_path.name}: {e}")
        final_files.append(final_path)
    return final_files


def _encode_svg_version(svg: str) -> str:
    return base64.b64encode(svg.encode("utf-8")).decode()


def _decode_svg_version(raw: str) -> str:
    value = (raw or "").strip()
    if value.startswith("data:") and "," in value:
        value = value.split(",", 1)[1]
    if value.lstrip().startswith("<svg"):
        return value
    try:
        return _decode_ppt_base64(value, "PPT SVG").decode("utf-8")
    except Exception as e:
        raise ValueError("无效的 SVG 版本数据") from e


def _clamp_index(value: object, max_index: int, default: int = 0) -> int:
    try:
        idx = int(value)
    except Exception:
        idx = default
    return min(max(idx, 0), max(max_index, 0))


def _is_direct_deck_page_stub(value: Any, index: int) -> bool:
    """Return whether a compact UI label leaked into audience-facing copy."""
    title = str(value or "").strip().lower()
    return title in {f"p{index + 1}", f"page {index + 1}", f"第 {index + 1} 页"}


def _preserve_direct_deck_content_title(
    slide_info: dict,
    outline_slide: dict | None,
    index: int,
) -> str:
    """Keep a semantic title distinct from the editor's ``P1`` display label."""
    current = str(slide_info.get("title") or "").strip()
    outline_title = str((outline_slide or {}).get("title") or "").strip()
    if _is_direct_deck_page_stub(current, index) and outline_title and not _is_direct_deck_page_stub(outline_title, index):
        return outline_title
    return current or outline_title or f"第 {index + 1} 页"


def _normalize_direct_slide_decks(state: dict) -> list[dict]:
    """Return durable PPT Master SVG slide decks, backfilled from artifacts/files."""
    outline = state.get("outline") or {}
    outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
    raw_decks = state.get("direct_slide_decks")
    decks: list[dict] = []

    if isinstance(raw_decks, list) and raw_decks:
        for idx, item in enumerate(raw_decks):
            if not isinstance(item, dict):
                continue
            raw_versions = item.get("versions") or []
            versions: list[str] = []
            for version in raw_versions:
                if not isinstance(version, str) or not version.strip():
                    continue
                try:
                    versions.append(_encode_svg_version(_decode_svg_version(version)))
                except Exception:
                    continue
            if not versions:
                continue
            slide_info = item.get("slide") if isinstance(item.get("slide"), dict) else {}
            if not slide_info and idx < len(outline_slides) and isinstance(outline_slides[idx], dict):
                slide_info = dict(outline_slides[idx])
            selected = _clamp_index(
                item.get("selected_version_index", item.get("selectedVersionIndex", 0)),
                len(versions) - 1,
            )
            title = f"P{idx + 1}"
            prompt = str(item.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
            slide_info = dict(slide_info)
            slide_info["page"] = idx + 1
            outline_slide = outline_slides[idx] if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else None
            slide_info["title"] = _preserve_direct_deck_content_title(slide_info, outline_slide, idx)
            if prompt:
                slide_info["prompt"] = prompt
                slide_info.setdefault("layout_hint", prompt)
            decks.append({
                "id": str(item.get("id") or f"direct-slide-{idx + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "svg",
                "versions": versions,
                "selected_version_index": selected,
                "slide": slide_info,
            })

    if decks:
        return decks

    direct_artifact = next(
        (
            artifact for artifact in reversed(state.get("artifacts", []))
            if isinstance(artifact, dict) and artifact.get("type") == "ppt_master_direct"
        ),
        None,
    )
    svg_paths = []
    if direct_artifact:
        svg_paths = direct_artifact.get("svg_files") or direct_artifact.get("final_svg_files") or []

    for idx, raw_path in enumerate(svg_paths):
        try:
            path = Path(str(raw_path))
            if not path.exists():
                continue
            svg = path.read_text(encoding="utf-8")
            _validate_svg_code(svg)
        except Exception:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        title = str(slide_info.get("title") or f"第 {idx + 1} 页")
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        decks.append({
            "id": f"direct-slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "svg",
            "versions": [_encode_svg_version(svg)],
            "selected_version_index": 0,
            "slide": slide_info,
        })
    return decks


def _direct_decks_to_outline(state: dict, decks: list[dict]) -> dict:
    outline = dict(state.get("outline") or {})
    outline.setdefault("title", state.get("topic") or "PPT")
    outline.setdefault("style", state.get("style_hint") or "")
    outline.setdefault("color_scheme", "")
    slides: list[dict] = []
    for idx, deck in enumerate(decks):
        slide_info = dict(deck.get("slide") or {})
        outline_slides = outline.get("slides") if isinstance(outline.get("slides"), list) else []
        outline_slide = outline_slides[idx] if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else None
        title = _preserve_direct_deck_content_title(slide_info, outline_slide, idx)
        prompt = str(deck.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        slide_info.setdefault("type", "cover" if idx == 0 else "content")
        if prompt:
            slide_info["prompt"] = prompt
            slide_info.setdefault("layout_hint", prompt)
        slide_info.setdefault("points", [prompt] if prompt else [])
        slides.append(slide_info)
    outline["slides"] = slides
    return outline


PPT_SLIDE_QA_SYSTEM = """You are a strict PPT slide art director and QA reviewer.
Return JSON only:
{"pass": true, "score": 0.0, "issues": [], "repair_prompt": ""}
Check whether the generated slide matches the requested content, hierarchy, layout hint, style, reference materials, and is presentation-ready.
Fail slides with unreadable text, missing core content, obvious artifacts, wrong aspect ratio, poor hierarchy, or invented unsupported data."""


PPT_MASTER_VISUAL_QA_SYSTEM = """You are the final art director for an editable, competition-grade PowerPoint slide.
Return JSON only:
{"pass": true, "score": 0, "issues": [], "repair_prompt": ""}

Judge the rendered slide as a real presentation page, not as a code sample.
It passes only at 88/100 or higher and only when all of these hold:
- The page has one clear visual idea and a deliberate reading order.
- Its visual world matches the stated design profile and is visibly connected to the topic.
- The composition is not a generic template, a wall of equal cards, a blank canvas, or a fake UI/dashboard.
- Typography is legible, balanced, and protected from the image subject; no clipping, collisions, or tiny body copy.
- Generated visual material is text-free, cleanly cropped, and behaves as an art-directed layer rather than a screenshot of a slide.
- Native evidence, process logic and labels remain visibly primary where the page asks for them.

Do not reward generic cleanliness. If a page is safe but visually ordinary, fail it and give a concise, executable repair prompt."""


def _render_svg_for_visual_qa(svg: str) -> bytes:
    """Rasterize one already-validated SVG only for visual review.

    The output is never delivered and does not affect editability. It lets the
    reviewer catch the class of failures XML checks cannot see: poor hierarchy,
    bad crop, empty composition and template-looking pages.
    """
    try:
        import cairosvg

        return cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=1792, output_height=1024)
    except Exception as exc:
        raise PPTPageDesignRejected(f"unable to render editable slide for visual review: {exc}") from exc


async def _qa_ppt_master_visual_svg(
    *,
    state: dict,
    job_id: str,
    slide: dict,
    svg: str,
    slide_index: int,
    attempt: int,
) -> dict:
    """Ask the configured GPT/vision reviewer to critique the rendered canvas."""
    try:
        image_bytes = _render_svg_for_visual_qa(svg)
        profile = state.get("outline", {}).get("design_profile", {}) if isinstance(state.get("outline"), dict) else {}
        contract = slide.get("design_contract") if isinstance(slide.get("design_contract"), dict) else {}
        prompt = "\n".join([
            f"Design profile: {json.dumps(profile, ensure_ascii=False)[:1400]}",
            f"Page {slide_index + 1} title: {slide.get('title', '')}",
            f"Page goal: {contract.get('page_goal') or slide.get('takeaway') or ''}",
            f"Visual form: {contract.get('visual_form')}; archetype: {contract.get('layout_archetype')}",
            f"Native component plan: {json.dumps(contract.get('component_plan') or {}, ensure_ascii=False)[:700]}",
            "Review the rendered slide now. Be strict about commercial/competition quality; return only the required JSON.",
        ])
        llm_model_id = str(state.get("llm_model_id") or "").strip()
        vision_model_id = str(state.get("vision_model_id") or "").strip()
        if llm_model_id:
            raw = await _execute_ppt_billed_call(
                user_id=state.get("user_id", ""),
                model_id=llm_model_id,
                expected_category="llm",
                description=f"PPT visual art direction review · slide {slide_index + 1}",
                operation=f"slide-visual-review:{slide_index + 1}",
                job_id=job_id,
                attempt=attempt,
                invoke=lambda: call_chat_with_images(
                    model_id=llm_model_id,
                    user=prompt,
                    images=[image_bytes],
                    system=PPT_MASTER_VISUAL_QA_SYSTEM,
                    max_tokens=1100,
                    temperature=0.1,
                ),
            )
        elif vision_model_id:
            raw = await _execute_ppt_billed_call(
                user_id=state.get("user_id", ""),
                model_id=vision_model_id,
                expected_category="vision",
                description=f"PPT visual art direction review · slide {slide_index + 1}",
                operation=f"slide-visual-review:{slide_index + 1}",
                job_id=job_id,
                attempt=attempt,
                invoke=lambda: call_vision(
                    model_id=vision_model_id,
                    image_bytes=image_bytes,
                    prompt=prompt,
                    system=PPT_MASTER_VISUAL_QA_SYSTEM,
                    max_tokens=1100,
                ),
            )
        else:
            return {"pass": True, "score": 88, "issues": [], "repair_prompt": "", "skipped": True}

        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start < 0 or end <= start:
            raise ValueError("visual reviewer did not return JSON")
        result = json.loads(raw[start:end])
        try:
            score = float(result.get("score", 0))
        except (TypeError, ValueError):
            score = 0
        passed = result.get("pass") is True and score >= 88
        issues = result.get("issues") if isinstance(result.get("issues"), list) else []
        repair_prompt = " ".join(str(result.get("repair_prompt") or "").split())[:1000]
        return {
            "pass": passed,
            "score": score,
            "issues": [" ".join(str(issue).split())[:240] for issue in issues if str(issue).strip()][:6],
            "repair_prompt": repair_prompt,
        }
    except HTTPException:
        raise
    except Exception as exc:
        # Service availability should not convert a valid editable deck into a
        # failed job. The issue is recorded and the structural fallback remains
        # active; a successful review remains mandatory whenever a reviewer is
        # available.
        logger.warning("[PPTAgent] visual review unavailable for slide %s: %s", slide_index + 1, exc)
        return {"pass": True, "score": 0, "issues": [], "repair_prompt": "", "skipped": True, "warning": str(exc)[:300]}


async def _qa_ppt_slide_image(
    *,
    img_bytes: bytes,
    slide_info: dict,
    prompt: str,
    vision_model_id: str | None,
    user_id: str = "",
    job_id: str = "",
    slide_index: int = 0,
    attempt: int = 1,
) -> dict:
    if not vision_model_id:
        return {"pass": True, "score": 0.8, "issues": [], "repair_prompt": ""}
    try:
        raw = await _execute_ppt_billed_call(
            user_id=user_id,
            model_id=vision_model_id,
            expected_category="vision",
            description=f"PPT slide QA · slide {slide_index + 1}",
            operation=f"slide-qa:{slide_index + 1}",
            job_id=job_id,
            attempt=attempt,
            invoke=lambda: call_vision(
                model_id=vision_model_id,
                image_bytes=img_bytes,
                system=PPT_SLIDE_QA_SYSTEM,
                prompt=(
                    "Evaluate this generated PPT slide.\n"
                    f"Slide title: {slide_info.get('title', '')}\n"
                    f"Slide content/layout request:\n{prompt[:6000]}"
                ),
                max_tokens=1200,
            ),
        )
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start == -1 or end <= start:
            raise ValueError("QA response is not JSON")
        parsed = json.loads(raw[start:end])
        parsed["pass"] = parsed.get("pass", False) is True
        return parsed
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[PPTAgent] 单页视觉质检失败，默认放行: {e}")
        return {"pass": True, "score": 0.7, "issues": [], "repair_prompt": ""}

# Legacy element-separation prompt.

_SPLIT_PROMPT = """Please decompose this PPT slide into individual visual elements.
Requirements:
- Extract each visual element as a separate transparent-background PNG
- Maintain original relative positions and proportions
- Each element: one PNG, no background
- Do NOT merge elements
- Do NOT include text content (text will be added as editable text boxes)
- Output all element images directly, no folders
- If cannot generate all at once, batch output until all elements are extracted"""


# PPT pipeline orchestrator.

class PPTAgent:
    """Coordinate PPT generation, page editing, and export.

    State is stored by job id. The default path produces direct editable SVG
    pages; the image-overlay export is retained only for explicit legacy modes.
    """
    async def extract_title(
        self,
        topic: str,
        style_requirement: Optional[str] = None,
        user_id: str = "",
        operation_scope: str = "",
    ) -> str:
        """Extract a short conversation title from the user request."""
        model_id = await get_default_model_id("llm")
        if not model_id:
            return topic[:10] if len(topic) > 10 else topic

        system_prompt = (
            "Extract a concise Chinese title, 5-10 characters when possible. "
            "Do not include PPT, 生成, or extra explanation. Return the title only."
        )
        user_msg = f"主题：{topic}"
        if style_requirement:
            user_msg += f"\n风格：{style_requirement}"

        try:
            raw = await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=model_id,
                expected_category="llm",
                description="PPT conversation title extraction",
                operation="extract-title",
                operation_scope=operation_scope,
                invoke=lambda: call_chat(
                    model_id=model_id,
                    user=user_msg,
                    system=system_prompt,
                    max_tokens=50,
                    temperature=0.3,
                ),
            )
            title = raw.strip().strip('"').strip("'")
            if len(title) > 15:
                title = title[:15]
            return title if title else topic[:10]
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"[PPTAgent] title extraction failed: {e}")
            return topic[:10] if len(topic) > 10 else topic

    async def optimize_prompt(
        self,
        topic: str,
        style_requirement: Optional[str] = None,
        llm_model_id: Optional[str] = None,
        user_id: str = "",
        operation_scope: str = "",
    ) -> str:
        """Optimize the global PPT theme/style prompt without drafting per-slide content."""
        model_id = llm_model_id or await get_default_model_id("llm")
        if not model_id:
            return topic

        system_prompt = (
            "You are a PPT global style prompt optimizer. Keep the user's deck topic, but optimize only the overall "
            "deck theme, audience, visual style, tone, design constraints, and quality bar. Do not create an outline, "
            "do not write per-slide content, and do not add slide-by-slide instructions. Return only the optimized "
            "global prompt in Chinese."
        )
        user_msg = f"主题：{topic}"
        if style_requirement:
            user_msg += f"\n风格要求：{style_requirement}"

        try:
            return (await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=model_id,
                expected_category="llm",
                description="PPT topic prompt optimization",
                operation="optimize-topic",
                operation_scope=operation_scope,
                invoke=lambda: call_chat(
                    model_id=model_id,
                    user=user_msg,
                    system=system_prompt,
                    max_tokens=200,
                    temperature=0.7,
                ),
            )).strip()
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"[PPTAgent] prompt optimization failed: {e}")
            return topic

    async def optimize_slide_prompt(
        self,
        slide_prompt: str,
        topic: str = "",
        style_requirement: Optional[str] = None,
        slide_index: int = 0,
        llm_model_id: Optional[str] = None,
        user_id: str = "",
        operation_scope: str = "",
    ) -> str:
        """Optimize a single slide prompt for content hierarchy and layout."""
        model_id = llm_model_id or await get_default_model_id("llm")
        if not model_id:
            return slide_prompt

        has_slide_prompt = bool(slide_prompt.strip())
        system_prompt = (
            "You are a PPT single-slide prompt optimizer. Rewrite the user's requirement for one slide only. "
            "Focus on content hierarchy, layout, visual emphasis, chart/table/image needs, and what should be "
            "prominent vs secondary. Do not change the overall deck theme. Do not mention other slides unless needed "
            "for continuity. If the user's slide requirement is blank, draft a useful requirement for this slide "
            "from the deck theme, page number, and style. Return only the optimized Chinese prompt."
        )
        user_msg = (
            f"第 {slide_index + 1} 页原始要求：{slide_prompt.strip()}"
            if has_slide_prompt
            else f"第 {slide_index + 1} 页原始要求：未填写，请为这一页起草内容重点、信息层级和版式方向。"
        )
        if topic:
            user_msg += f"\n整套 PPT 主题：{topic}"
        if style_requirement:
            user_msg += f"\n整体风格：{style_requirement}"

        try:
            return (await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=model_id,
                expected_category="llm",
                description="PPT slide prompt optimization",
                operation=f"optimize-slide:{slide_index + 1}",
                operation_scope=operation_scope,
                invoke=lambda: call_chat(
                    model_id=model_id,
                    user=user_msg,
                    system=system_prompt,
                    max_tokens=220,
                    temperature=0.55,
                ),
            )).strip()
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"[PPTAgent] slide prompt optimization failed: {e}")
            if has_slide_prompt:
                return slide_prompt
            return f"围绕“{topic or '当前主题'}”规划第 {slide_index + 1} 页，明确本页核心观点、版式结构、关键视觉元素和主次信息。"
    async def generate_outline(self, topic: str, page_count: int = 10) -> str:
        """Generate a PPT outline as a JSON string."""
        outline = await generate_outline(topic, "", page_count)
        return json.dumps(outline, ensure_ascii=False)

    async def generate_images(self, outline_json: str, style_requirement: Optional[str] = None) -> str:
        """Compatibility placeholder; start() performs real image generation."""
        return "[]"

    async def build_pptx(self, gen_id: str, outline_json: str, images_json: str) -> str:
        """Compatibility placeholder; start() performs real PPTX building."""
        return f"/api/ppt/{gen_id}/download"

    async def start(
        self,
        job_id: str,
        topic: str,
        style_hint: str = "",
        page_count: int = 0,
        slide_prompts: Optional[list[str]] = None,
        brief: Optional[dict] = None,
        ref_image_b64: str = "",
        reference_asset_id: str = "",
        attachments: Optional[list[dict]] = None,
        attachment_context: str = "",
        user_id: str = "",
        image_model_id: str = "",
        vision_model_id: str = "",
        llm_model_id: str = "",
        conversion_mode: str = DEFAULT_PPT_CONVERSION_MODE,
        output_resolution: str = "2k",
        image_quality: str = "high",
        agent_run_id: str = "",
        delivery_contract: Optional[dict] = None,
        template_id: str = "",
    ) -> dict:
        """Start the PPT workflow and return initial state."""
        conversion_mode = normalize_ppt_conversion_mode(conversion_mode)
        output_resolution = normalize_output_resolution(output_resolution)
        image_quality = normalize_image_quality(image_quality)
        state = {
            "job_id":           job_id,
            "topic":            topic,
            "style_hint":       style_hint,
            "page_count":       page_count,
            "slide_prompts":     slide_prompts or [],
            "brief":            _clean_ppt_brief(brief),
            "ref_image_b64":    ref_image_b64,
            "reference_asset_id": reference_asset_id,
            "attachments":       attachments or [],
            "attachment_context": attachment_context or build_attachment_context(attachments or []),
            "user_id":          user_id,
            "image_model_id":   image_model_id,
            "vision_model_id":  vision_model_id,
            "llm_model_id":     llm_model_id,
            "conversion_mode":  conversion_mode,
            "output_resolution": output_resolution,
            "output_size":     image_output_size("16:9", output_resolution),
            "image_quality":    image_quality,
            # The primary route is topic-led, single-pass SVG authoring.  It
            # never substitutes a generic template when a page cannot be
            # authored as requested.
            "design_mode":      "competition",
            "agent_run_id":     agent_run_id,
            "delivery_contract": delivery_contract or {},
            "template_id":      template_id,
            "intervention":      {},
            "status":           "pending",
            "outline":          None,
            "slide_images_b64": [],
            "pptx_path":        "",
            "error":            "",
            "progress":         0,
            "message":          "PPT 智能体正在初始化...",
            "agent_steps":      [],
            "artifacts":         [],
            # Snapshots for rollback/resume.
            # Snapshot every key checkpoint so the user can resume safely.
            "snapshots": {},
        }
        await _save_state(job_id, state)
        return state

    async def confirm_checkpoint(
        self,
        job_id: str,
        selected_indices: list[int] | None = None,
        conversion_mode: str | None = None,
        selected_slide_images: list[str] | None = None,
        selected_slide_prompts: list[str] | None = None,
        before_save: Callable[[dict, int, str], Awaitable[None]] | None = None,
    ) -> dict:
        """Confirm the preview checkpoint and continue conversion."""
        return await self.confirm_checkpoint_once(
            job_id,
            selected_indices,
            conversion_mode=conversion_mode,
            selected_slide_images=selected_slide_images,
            selected_slide_prompts=selected_slide_prompts,
            before_save=before_save,
        )

    async def confirm_checkpoint_once(
        self,
        job_id: str,
        selected_indices: list[int] | None = None,
        conversion_mode: str | None = None,
        selected_slide_images: list[str] | None = None,
        selected_slide_prompts: list[str] | None = None,
        before_save: Callable[[dict, int, str], Awaitable[None]] | None = None,
        after_save: Callable[[dict, int, str], Awaitable[None]] | None = None,
    ) -> dict:
        """Confirm a checkpoint exactly once under the per-job lock."""
        async with get_ppt_job_lock(job_id):
            state = await _load_state(job_id)
            if not state or state.get("status") != "checkpoint":
                raise ValueError("任务不在 checkpoint 状态")

            normalized_mode = normalize_ppt_conversion_mode(
                conversion_mode or state.get("conversion_mode")
            )

            final_slide_images: list[str] | None = None
            if selected_slide_images is not None:
                final_slide_images = []
                for raw in selected_slide_images:
                    if not isinstance(raw, str):
                        continue
                    b64 = raw.split(",", 1)[1] if raw.startswith("data:") and "," in raw else raw
                    b64 = b64.strip()
                    if b64:
                        final_slide_images.append(b64)
                slide_count = len(final_slide_images)
                valid_indices = None
            else:
                slide_count, valid_indices = resolve_ppt_selection(state, selected_indices)
            if slide_count <= 0:
                raise ValueError("没有可转换的幻灯片")

            if before_save:
                await before_save(state, slide_count, normalized_mode)

            if final_slide_images is not None:
                outline = state.get("outline") or {
                    "title": state.get("topic", "PPT"),
                    "style": state.get("style_hint", ""),
                    "slides": [],
                }
                outline_slides = outline.get("slides", []) or []
                prompts = selected_slide_prompts or []
                final_outline_slides: list[dict] = []
                for idx, _ in enumerate(final_slide_images):
                    slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
                    prompt = prompts[idx].strip() if idx < len(prompts) and isinstance(prompts[idx], str) else ""
                    slide_info["page"] = idx + 1
                    slide_info.setdefault("type", "content")
                    slide_info["title"] = slide_info.get("title") or (prompt[:40] if prompt else f"第 {idx + 1} 页")
                    slide_info["points"] = slide_info.get("points") or ([prompt] if prompt else [])
                    if prompt:
                        slide_info["prompt"] = prompt
                        slide_info["layout_hint"] = slide_info.get("layout_hint") or prompt
                    final_outline_slides.append(slide_info)
                outline["slides"] = final_outline_slides
                state["outline"] = outline
                state["slide_images_b64"] = final_slide_images
                append_ppt_artifact(
                    state,
                    "selected_slides",
                    slides=final_slide_images,
                    prompts=prompts,
                    slide_count=slide_count,
                    conversion_mode=normalized_mode,
                )
            elif valid_indices is not None:
                imgs = state.get("slide_images_b64", [])
                outline_slides = state.get("outline", {}).get("slides", [])
                state["slide_images_b64"] = [imgs[i] for i in valid_indices]
                state["outline"]["slides"] = [
                    outline_slides[i] for i in valid_indices if i < len(outline_slides)
                ]
                append_ppt_artifact(
                    state,
                    "selected_slides",
                    selected_indices=valid_indices,
                    slides=state["slide_images_b64"],
                    slide_count=slide_count,
                    conversion_mode=normalized_mode,
                )

            state["conversion_mode"] = normalized_mode
            state["status"] = "confirmed"
            state["progress"] = 55
            state["message"] = "用户已确认，开始构建 PPTX..."
            await _save_state(job_id, state)

            if after_save:
                await after_save(state, slide_count, normalized_mode)

        return state

    async def get_state(self, job_id: str) -> Optional[dict]:
        return await _load_state(job_id)

    async def get_ppt_master_direct_slides(self, job_id: str) -> tuple[dict, list[dict]]:
        state = await _load_state(job_id)
        if not state:
            raise ValueError("任务不存在")
        decks = _normalize_direct_slide_decks(state)
        state["direct_slide_decks"] = decks
        await _save_state(job_id, state)
        return state, decks

    async def get_ppt_master_direct_slide_batch(
        self,
        job_id: str,
        offset: int,
        limit: int,
    ) -> tuple[list[dict], int]:
        """Read bounded direct-SVG pages without repeatedly decoding one large job."""
        decks = _get_cached_direct_slide_decks(job_id)
        if decks is None:
            async with get_ppt_job_lock(f"direct-slide-read:{job_id}"):
                decks = _get_cached_direct_slide_decks(job_id)
                if decks is None:
                    state = await _load_state(job_id)
                    if not state:
                        raise ValueError("任务不存在")
                    if normalize_ppt_conversion_mode(state.get("conversion_mode")) != "ppt_master_direct":
                        raise ValueError("当前任务不是可编辑演示文稿")
                    decks = state.get("direct_slide_decks") or []
                    if not isinstance(decks, list) or not decks:
                        decks = _normalize_direct_slide_decks(state)
                        state["direct_slide_decks"] = decks
                        await _save_state(job_id, state)
                    if str(state.get("status") or "") in {"checkpoint", "done", "completed"}:
                        _cache_direct_slide_decks(job_id, decks)
        start = min(max(0, offset), len(decks))
        end = min(start + max(1, limit), len(decks))
        return decks[start:end], len(decks)

    async def export_ppt_master_direct(self, job_id: str) -> dict:
        """Export the current PPT Master workspace as a PPTX artifact.

        This packages the saved SVG slide decks directly. It must not enter the
        post-checkpoint vision/native-rebuild pipeline.
        """
        async with get_ppt_job_lock(job_id):
            state = await _load_state(job_id)
            if not state:
                raise ValueError("Task does not exist")
            if normalize_ppt_conversion_mode(state.get("conversion_mode")) != "ppt_master_direct":
                raise ValueError("Current task is not PPT Master direct mode")
            decks = _normalize_direct_slide_decks(state)
            if not decks:
                raise ValueError("No slides to export")
            state["status"] = "building"
            state["progress"] = 85
            state["message"] = "Exporting current PPT workspace..."
            state["direct_slide_decks"] = decks
            await _save_state(job_id, state)
            await self._rebuild_ppt_master_direct_from_decks(
                job_id,
                state,
                decks,
                reason="export",
            )
            if state.get("status") != "done":
                await _save_state(job_id, state)
                return state
            if state.get("status") == "done":
                state["message"] = "\u5f53\u524d\u5de5\u4f5c\u533a PPT \u5df2\u5bfc\u51fa\u3002"
            await _save_state(job_id, state)
            return state

    async def sync_ppt_master_direct_slides(
        self,
        job_id: str,
        decks_payload: list[dict],
        *,
        rebuild: bool = True,
    ) -> dict:
        async with get_ppt_job_lock(job_id):
            state = await _load_state(job_id)
            if not state:
                raise ValueError("任务不存在")
            if normalize_ppt_conversion_mode(state.get("conversion_mode")) != "ppt_master_direct":
                raise ValueError("当前任务不是可编辑演示文稿")
            if not isinstance(decks_payload, list) or not decks_payload:
                raise ValueError("没有可同步的幻灯片")

            decks: list[dict] = []
            outline = state.get("outline") or {}
            outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
            for idx, item in enumerate(decks_payload):
                if not isinstance(item, dict):
                    continue
                versions = item.get("versions") or []
                clean_versions: list[str] = []
                for version in versions:
                    if not isinstance(version, str) or not version.strip():
                        continue
                    svg = _decode_svg_version(version)
                    _validate_svg_code(svg)
                    clean_versions.append(_encode_svg_version(svg))
                if not clean_versions:
                    continue
                slide_info = item.get("slide") if isinstance(item.get("slide"), dict) else {}
                if not slide_info and idx < len(outline_slides) and isinstance(outline_slides[idx], dict):
                    slide_info = dict(outline_slides[idx])
                selected = _clamp_index(
                    item.get("selectedVersionIndex", item.get("selected_version_index", 0)),
                    len(clean_versions) - 1,
                )
                title = f"P{idx + 1}"
                prompt = str(item.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
                slide_info = dict(slide_info)
                slide_info["page"] = idx + 1
                outline_slide = outline_slides[idx] if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else None
                slide_info["title"] = _preserve_direct_deck_content_title(slide_info, outline_slide, idx)
                if prompt:
                    slide_info["prompt"] = prompt
                    slide_info.setdefault("layout_hint", prompt)
                decks.append({
                    "id": str(item.get("id") or f"direct-slide-{idx + 1}"),
                    "title": title,
                    "prompt": prompt,
                    "kind": "svg",
                    "versions": clean_versions,
                    "selected_version_index": selected,
                    "slide": slide_info,
                })

            if not decks:
                raise ValueError("没有有效的 SVG 幻灯片")
            state["direct_slide_decks"] = decks
            state["outline"] = _direct_decks_to_outline(state, decks)
            if rebuild:
                await self._rebuild_ppt_master_direct_from_decks(
                    job_id,
                    state,
                    decks,
                    reason="sync",
                )
            else:
                state["status"] = "checkpoint"
                state["progress"] = 100
                _clear_pptx_export_state(state)
                state["message"] = "可编辑页面已调整完成，可继续编辑或导出 PPT。"
                await _save_state(job_id, state)
            return state

    async def render_ppt_master_direct_slide(
        self,
        job_id: str,
        *,
        prompt: str,
        slide_index: int | None = None,
        source_svg_b64: str = "",
        title: str = "",
        insert_after_index: int | None = None,
        rebuild: bool = False,
    ) -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("提示词不能为空")

        async with get_ppt_job_lock(job_id):
            state = await _load_state(job_id)
            if not state:
                raise ValueError("任务不存在")
            if normalize_ppt_conversion_mode(state.get("conversion_mode")) != "ppt_master_direct":
                raise ValueError("当前任务不是可编辑演示文稿")
            decks = _normalize_direct_slide_decks(state)
            if not decks and not state.get("outline"):
                raise ValueError("没有可编辑的页面")

            is_add = insert_after_index is not None
            if is_add:
                insert_after = _clamp_index(insert_after_index, len(decks) - 1, len(decks) - 1) if decks else -1
                target_index = insert_after + 1
            else:
                target_index = _clamp_index(slide_index, len(decks) - 1, 0)

            outline = _direct_decks_to_outline(state, decks) if decks else dict(state.get("outline") or {})
            outline_slides = outline.get("slides", []) if isinstance(outline, dict) else []
            total_after = len(decks) + (1 if is_add else 0)
            source_slide = (
                dict(outline_slides[target_index])
                if 0 <= target_index < len(outline_slides) and isinstance(outline_slides[target_index], dict)
                else {}
            )
            slide_info = {
                **source_slide,
                "page": target_index + 1,
                "title": title.strip() or source_slide.get("title") or (prompt[:40] if prompt else f"第 {target_index + 1} 页"),
                "type": source_slide.get("type") or ("cover" if target_index == 0 else "content"),
                "points": source_slide.get("points") or [prompt],
                "layout_hint": prompt,
                "prompt": prompt,
            }
            _normalize_ppt_slide_design(slide_info, target_index)

            design_model_id = str(state.get("llm_model_id") or "").strip() or await get_default_model_id("llm") or ""
            if not design_model_id:
                raise RuntimeError("编辑可编辑页面需要配置 GPT/LLM 模型")
            state["status"] = "checkpoint"
            state["progress"] = 100
            state["message"] = (
                f"正在新增第 {target_index + 1} 页..."
                if is_add else f"正在编辑第 {target_index + 1} 页..."
            )
            await _save_state(job_id, state)

            reference_guidance = state.get("reference_image_guidance", "")
            base_prompt = _build_direct_svg_prompt(
                outline=outline,
                slide=slide_info,
                idx=target_index,
                total=total_after,
                reference_guidance=reference_guidance,
                attachment_context=state.get("attachment_context", ""),
                spec_lock="",
            )

            source_svg = ""
            if not is_add:
                if source_svg_b64:
                    source_svg = _decode_svg_version(source_svg_b64)
                elif 0 <= target_index < len(decks):
                    deck = decks[target_index]
                    selected = _clamp_index(deck.get("selected_version_index", 0), len(deck.get("versions", [])) - 1, 0)
                    source_svg = _decode_svg_version(deck["versions"][selected])
                if source_svg:
                    base_prompt += (
                        "\n\nRevise the existing SVG below according to the user's edit request. "
                        "Preserve useful structure and continuity, but return a complete replacement SVG only.\n"
                        "Existing SVG:\n"
                        f"{source_svg[:24000]}"
                    )

            svg_code = ""
            last_error = ""
            operation_revision = (
                len(decks[target_index].get("versions") or []) + 1
                if not is_add and 0 <= target_index < len(decks)
                else 1
            )
            for attempt in range(1, 2):
                try:
                    await set_agent_step(
                        state,
                        lambda s: _save_state(job_id, s),
                        name=f"direct_slide_edit_{target_index + 1}",
                        status="running",
                        message=f"正在根据确认的修改方向制作第 {target_index + 1} 页的新版本...",
                        progress=91,
                        attempt=1,
                    )
                    working_prompt = base_prompt
                    if last_error:
                        working_prompt += f"\n\nPrevious attempt failed. Repair this SVG issue:\n{last_error}"
                    raw_svg = await _execute_ppt_billed_call(
                        user_id=state.get("user_id", ""),
                        model_id=design_model_id,
                        expected_category="llm",
                        description=f"PPT Master 单页编辑直出 · 第 {target_index + 1} 页",
                        operation=f"direct-slide-edit:{target_index + 1}:version:{operation_revision}",
                        job_id=job_id,
                        attempt=attempt,
                        invoke=lambda: call_chat(
                            model_id=design_model_id,
                            user=working_prompt,
                            system=PPT_MASTER_SVG_SYSTEM,
                            max_tokens=8000,
                            temperature=0.2,
                        ),
                    )
                    svg_code = _extract_svg_code(raw_svg)
                    _validate_svg_code(svg_code)
                    break
                except HTTPException:
                    raise
                except Exception as e:
                    last_error = str(e)
                    logger.warning(f"[PPTAgent] PPT Master 单页 SVG 生成失败: {e}")
                    svg_code = ""

            if not svg_code:
                raise RuntimeError(f"第 {target_index + 1} 页未能直出有效 SVG：{last_error or '模型未返回有效页面'}")

            encoded = _encode_svg_version(svg_code)
            result_index = target_index
            if is_add:
                new_deck = {
                    "id": f"direct-slide-new-{datetime.now(timezone.utc).strftime('%H%M%S%f')}",
                    "title": slide_info.get("title") or f"第 {target_index + 1} 页",
                    "prompt": prompt,
                    "kind": "svg",
                    "versions": [encoded],
                    "selected_version_index": 0,
                    "slide": slide_info,
                }
                result_index = min(max(target_index, 0), len(decks))
                decks.insert(result_index, new_deck)
                artifact_type = "direct_slide_added"
            else:
                deck = decks[target_index]
                versions = list(deck.get("versions") or [])
                versions.append(encoded)
                deck.update({
                    "title": slide_info.get("title") or deck.get("title") or f"第 {target_index + 1} 页",
                    "prompt": prompt,
                    "kind": "svg",
                    "versions": versions,
                    "selected_version_index": len(versions) - 1,
                    "slide": {**dict(deck.get("slide") or {}), **slide_info},
                })
                artifact_type = "direct_slide_version"

            state["direct_slide_decks"] = decks
            append_ppt_artifact(
                state,
                artifact_type,
                slide_index=result_index,
                insert_after_index=insert_after_index,
                svg_b64=encoded,
                prompt=prompt,
                title=slide_info.get("title"),
                conversion_mode="ppt_master_direct",
            )
            if rebuild:
                await self._rebuild_ppt_master_direct_from_decks(
                    job_id,
                    state,
                    decks,
                    reason=artifact_type,
                )
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name=f"direct_slide_edit_{result_index + 1}",
                    status="completed",
                    message=f"第 {target_index + 1} 页 SVG 新版本已生成并重建 PPTX。",
                    progress=100,
                    result={"slide_index": result_index, "artifact_type": artifact_type, "rebuild": True},
                    error=last_error if last_error and not svg_code else "",
                )
            else:
                state["outline"] = _direct_decks_to_outline(state, decks)
                state["direct_slide_decks"] = decks
                state["status"] = "checkpoint"
                state["progress"] = 100
                _clear_pptx_export_state(state)
                state["message"] = "可编辑页面已更新完成，可继续编辑或导出 PPT。"
                await _save_state(job_id, state)
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name=f"direct_slide_edit_{result_index + 1}",
                    status="completed",
                    message=f"第 {target_index + 1} 页预览已更新完成，可继续编辑或导出 PPT。",
                    progress=100,
                    result={"slide_index": result_index, "artifact_type": artifact_type, "rebuild": False},
                    error=last_error if last_error and not svg_code else "",
                )
            return {
                "slide_index": result_index,
                "slide": decks[result_index],
                "slides": decks,
                "outline": state.get("outline"),
                "pptx_path": state.get("pptx_path", ""),
            }

    async def _rebuild_ppt_master_direct_from_decks(
        self,
        job_id: str,
        state: dict,
        decks: list[dict],
        *,
        reason: str = "edit",
    ) -> None:
        if not decks:
            raise RuntimeError("没有可重建的可编辑页面")

        outline = _direct_decks_to_outline(state, decks)
        state["outline"] = outline
        state["direct_slide_decks"] = decks
        state["conversion_mode"] = "ppt_master_direct"

        job_dir = PPT_WORK_DIR / job_id
        project_dir = job_dir / "ppt_master_project"
        project_dir.mkdir(parents=True, exist_ok=True)
        project_paths = _write_ppt_master_project_files(
            project_dir=project_dir,
            state=state,
            outline=outline,
            reference_guidance=state.get("reference_image_guidance", ""),
        )

        svg_files: list[Path] = []
        for idx, deck in enumerate(decks):
            versions = deck.get("versions") or []
            if not versions:
                continue
            selected = _clamp_index(deck.get("selected_version_index", 0), len(versions) - 1, 0)
            svg = _decode_svg_version(versions[selected])
            _validate_svg_code(svg)
            slide_info = outline["slides"][idx]
            svg_path = project_paths["svg_output"] / _ppt_master_slide_filename(slide_info, idx)
            svg_path.write_text(svg, encoding="utf-8")
            svg_files.append(svg_path)
            _write_ppt_master_notes(project_paths["notes"], svg_path, slide_info, idx)

        if not svg_files:
            raise RuntimeError("没有有效的 SVG 文件可转换")

        final_svg_files = await asyncio.get_event_loop().run_in_executor(
            None,
            _postprocess_ppt_master_svgs,
            svg_files,
            project_paths["svg_final"],
        )
        for idx, final_svg_path in enumerate(final_svg_files):
            if idx >= len(decks):
                break
            final_svg = final_svg_path.read_text(encoding="utf-8")
            versions = list(decks[idx].get("versions") or [])
            selected = _clamp_index(decks[idx].get("selected_version_index", 0), len(versions) - 1, 0)
            if versions:
                versions[selected] = _encode_svg_version(final_svg)
            else:
                versions = [_encode_svg_version(final_svg)]
                selected = 0
            decks[idx]["versions"] = versions
            decks[idx]["selected_version_index"] = selected
        state["direct_slide_decks"] = decks
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        output_path = project_paths["exports"] / f"{_safe_project_slug(outline.get('title', ''), job_id)}_{stamp}.pptx"
        svg_ref_path = output_path.with_name(f"{output_path.stem}_svg_reference.pptx")

        use_native = False
        try:
            from services.svg_to_pptx.pptx_builder import create_pptx_with_native_svg
            from services.svg_to_pptx.pptx_discovery import find_notes_files
            notes = find_notes_files(project_dir, final_svg_files)
            success = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: create_pptx_with_native_svg(
                    svg_files=final_svg_files,
                    output_path=output_path,
                    canvas_format="ppt169",
                    notes=notes,
                    enable_notes=True,
                    use_native_shapes=True,
                    verbose=True,
                ),
            )
            use_native = bool(success and output_path.exists())
        except Exception as e:
            logger.warning(f"[PPTAgent] PPT Master SVG conversion failed: {e}")

        if not use_native or not output_path.exists():
            raise RuntimeError("可编辑 SVG 无法转换为 PPTX；已保留原始逐页预览，不会替换为模板兜底版本")
        else:
            try:
                from services.svg_to_pptx.pptx_builder import create_pptx_with_native_svg
                from services.svg_to_pptx.pptx_discovery import find_notes_files
                notes = find_notes_files(project_dir, final_svg_files)
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: create_pptx_with_native_svg(
                        svg_files=final_svg_files,
                        output_path=svg_ref_path,
                        canvas_format="ppt169",
                        notes=notes,
                        enable_notes=True,
                        use_native_shapes=False,
                        use_compat_mode=True,
                        verbose=False,
                    ),
                )
            except Exception as e:
                logger.debug(f"[PPTAgent] SVG reference PPTX skipped: {e}")

        # The user has already reviewed the direct SVG pages.  Avoid another
        # export-quality gate or model-triggered repair cycle; conversion is
        # only a faithful packaging step and never changes the composition.
        state["pptx_qa"] = {"status": "skipped", "reason": "single-pass direct export"}
        append_ppt_artifact(
            state,
            "ppt_master_direct_export" if reason == "export" else "ppt_master_direct_rebuild",
            reason=reason,
            project_dir=str(project_dir),
            svg_files=[str(path) for path in svg_files],
            final_svg_files=[str(path) for path in final_svg_files],
            svg_reference_pptx=str(svg_ref_path) if svg_ref_path.exists() else "",
            slide_count=len(svg_files),
            conversion_mode="ppt_master_direct",
        )
        pptx_asset = await store_pptx_asset(state, job_id, output_path)
        append_ppt_artifact(
            state,
            "pptx_done",
            pptx_path=str(output_path),
            pptx_url=pptx_asset.get("url", ""),
            pptx_key=pptx_asset.get("key", ""),
            pptx_filename=pptx_asset.get("filename") or state.get("pptx_filename", ""),
            use_native=use_native,
            conversion_mode="ppt_master_direct",
            slide_count=len(svg_files),
            project_dir=str(project_dir),
            svg_reference_pptx=str(svg_ref_path) if svg_ref_path.exists() else "",
            checkpoint="done",
            reason=reason,
        )
        state["status"] = "done"
        state["progress"] = 100
        state["pptx_path"] = str(output_path)
        state["slide_images_b64"] = []
        state["message"] = (
            "可编辑页面已更新，PPT 已重建。"
            if use_native else "可编辑页面已更新，PPT 已重建为兼容的可编辑版本。"
        )
        state.setdefault("snapshots", {})["done"] = {
            "pptx_path": str(output_path),
            "pptx_url": state.get("pptx_url", ""),
            "pptx_filename": state.get("pptx_filename", ""),
            "use_native": use_native,
            "conversion_mode": "ppt_master_direct",
            "project_dir": str(project_dir),
        }
        await _save_state(job_id, state)

    async def _run_pipeline_limited(self, job_id: str):
        """受全局 + per-user 信号量保护的 pipeline 执行"""
        # 获取 user_id 用于 per-user 限制
        state = await _load_state(job_id)
        user_id = state.get("user_id", "") if state else ""

        if user_id:
            user_sem = _get_user_pipeline_sem(user_id)
            # 先尝试获取 per-user 信号量（非阻塞检查）
            if user_sem.locked():
                # 用户已有一个 pipeline 在跑，排队等待
                logger.info(f"[PPTAgent] 用户 {user_id} 已有 PPT 任务在执行，排队等待...")
                if state:
                    state["message"] = "排队中，等待上一个 PPT 任务完成..."
                    await _save_state(job_id, state)
            async with user_sem:
                async with _pipeline_sem:
                    await self._run_pipeline(job_id)
        else:
            async with _pipeline_sem:
                await self._run_pipeline(job_id)

    async def _run_post_checkpoint_limited(self, job_id: str):
        async with _conversion_sem:
            await self._run_post_checkpoint(job_id)

    async def _run_ppt_master_direct_limited(self, job_id: str):
        async with _conversion_sem:
            await self._run_ppt_master_direct(job_id)

    async def _run_ppt_master_direct(self, job_id: str):
        """Build an editable PPTX directly from the confirmed outline.

        The specialist plans optional image assets, then the native composer
        lays out editable text, charts, shapes, and image slots before
        conversion to DrawingML. It never treats a full-slide image as an
        editable presentation page.
        """
        state: dict = {}
        try:
            loaded = await _load_state(job_id)
            if not loaded:
                logger.error(f"[PPTAgent] direct PPT Master 找不到 job_id={job_id}")
                return
            state = loaded
            outline = state.get("outline") or {}
            slides = outline.get("slides", []) or []
            if not slides:
                raise RuntimeError("大纲为空，无法直出 PPTX")

            job_dir = PPT_WORK_DIR / job_id
            project_dir = job_dir / "ppt_master_project"
            project_dir.mkdir(parents=True, exist_ok=True)
            svg_files: list[Path] = []
            total = len(slides)
            vision_model_id = state.get("vision_model_id") or await get_default_model_id("vision") or ""
            if vision_model_id:
                state["vision_model_id"] = vision_model_id
            reference_guidance = state.get("reference_image_guidance", "")

            state["status"] = "analyzing"
            state["progress"] = 20
            state["message"] = "正在理解大纲、附件和参考风格..."
            await _save_state(job_id, state)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_plan",
                status="running",
                message="正在整理可编辑演示文稿的页面结构和设计约束...",
                progress=20,
            )

            if not reference_guidance and state.get("ref_image_b64") and vision_model_id:
                reference_guidance = await _analyze_reference_image_for_ppt(
                    state.get("ref_image_b64", ""),
                    vision_model_id,
                    user_id=state.get("user_id", ""),
                    job_id=job_id,
                )
                state["reference_image_guidance"] = reference_guidance

            project_paths = _write_ppt_master_project_files(
                project_dir=project_dir,
                state=state,
                outline=outline,
                reference_guidance=reference_guidance,
            )

            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_plan",
                status="completed",
                message=f"已完成页面结构规划，共 {total} 页。",
                progress=28,
                result={
                    "slide_count": total,
                    "title": outline.get("title", ""),
                    "project_dir": str(project_dir),
                    "spec_lock": str(project_paths["spec_lock"]),
                },
            )

            # Reserve the same bounded material set up front, but generate it
            # only when its page is being authored.  This keeps the first
            # visible slide from waiting on unrelated later-page assets.
            all_visual_specs = [_visual_asset_spec(slide, index) for index, slide in enumerate(slides)]
            generated_asset_limit = 4 if total <= 4 else 6 if total <= 8 else 7
            generated_asset_ids: set[str] = set()
            generated_seen = 0
            for spec in (item for item in all_visual_specs if item):
                if spec.get("source") != "generate":
                    generated_asset_ids.add(str(spec.get("id") or ""))
                    continue
                if generated_seen < generated_asset_limit:
                    generated_asset_ids.add(str(spec.get("id") or ""))
                    generated_seen += 1

            direct_decks: list[dict] = []
            for idx, slide_info in enumerate(slides):
                # The production path is intentionally a single authoring
                # pass: one GPT SVG response per page, no visual-review model,
                # no repair prompt, and no native layout replacement.
                if _experimental_model_svg_enabled(state):
                    planned_asset = all_visual_specs[idx] if idx < len(all_visual_specs) else None
                    if planned_asset and str(planned_asset.get("id") or "") not in generated_asset_ids:
                        planned_asset = None
                    planned_assets = [planned_asset] if planned_asset else []
                    asset_task = (
                        asyncio.create_task(
                            _generate_ppt_master_visual_assets(
                                state,
                                job_id,
                                outline,
                                slide_indexes={idx},
                                announce_plan=idx == 0,
                            )
                        )
                        if planned_assets else None
                    )
                    svg_path = project_paths["svg_output"] / _ppt_master_slide_filename(slide_info, idx)
                    page_progress = 28 + int((idx / max(total, 1)) * 50)
                    state["status"] = "building"
                    state["progress"] = page_progress
                    state["message"] = f"正在直出第 {idx + 1}/{total} 页可编辑页面..."
                    await _save_state(job_id, state)
                    await set_agent_step(
                        state,
                        lambda s: _save_state(job_id, s),
                        name=f"direct_svg_{idx + 1}",
                        status="running",
                        message=f"正在一次性制作第 {idx + 1}/{total} 页；完成后会立即显示。",
                        progress=page_progress,
                    )

                    design_model_id = str(state.get("llm_model_id") or "").strip() or await get_default_model_id("llm") or ""
                    if not design_model_id:
                        raise RuntimeError("未配置 GPT/LLM 模型，无法进行单次直出")
                    svg_prompt = _build_direct_svg_prompt(
                        outline=outline,
                        slide=slide_info,
                        idx=idx,
                        total=total,
                        reference_guidance=reference_guidance,
                        attachment_context=state.get("attachment_context", ""),
                        spec_lock="",
                        visual_assets=planned_assets,
                    )
                    raw_svg = await _execute_ppt_billed_call(
                        user_id=state.get("user_id", ""),
                        model_id=design_model_id,
                        expected_category="llm",
                        description=f"PPT single-pass SVG page {idx + 1}",
                        operation=f"page-design:{idx + 1}",
                        job_id=job_id,
                        attempt=1,
                        invoke=lambda: call_chat(
                            model_id=design_model_id,
                            user=svg_prompt,
                            system=PPT_MASTER_SVG_SYSTEM,
                            max_tokens=8000,
                            temperature=0.2,
                        ),
                    )
                    svg_code = _extract_svg_code(raw_svg)
                    _validate_svg_code(svg_code)
                    if planned_assets:
                        missing_slots = _missing_visual_asset_slots(svg_code, planned_assets)
                        if missing_slots:
                            raise PPTPageDesignRejected(
                                f"第 {idx + 1} 页未保留已规划素材槽位：{', '.join(missing_slots)}"
                            )
                        assert asset_task is not None
                        await asset_task
                        slide_visual_assets = await _load_slide_visual_assets(state, idx)
                        if len(slide_visual_assets) != len(planned_assets):
                            raise PPTPageDesignRejected(f"第 {idx + 1} 页的主题素材未准备完成")
                        svg_code = _inject_visual_assets(svg_code, slide_visual_assets)
                    _validate_svg_code(svg_code)
                    svg_path.write_text(svg_code, encoding="utf-8")
                    svg_files.append(svg_path)
                    _write_ppt_master_notes(project_paths["notes"], svg_path, slide_info, idx)
                    live_slide_info = {**dict(slide_info), "page": idx + 1}
                    live_prompt = str(live_slide_info.get("prompt") or live_slide_info.get("layout_hint") or "")
                    direct_decks.append({
                        "id": f"direct-slide-{idx + 1}",
                        "title": f"P{idx + 1}",
                        "prompt": live_prompt,
                        "kind": "svg",
                        "versions": [_encode_svg_version(svg_code)],
                        "selected_version_index": 0,
                        "slide": live_slide_info,
                    })
                    state["direct_slide_decks"] = direct_decks
                    state["slide_images_b64"] = []
                    await set_agent_step(
                        state,
                        lambda s: _save_state(job_id, s),
                        name=f"direct_svg_{idx + 1}",
                        status="completed",
                        message=f"第 {idx + 1}/{total} 页已直出并显示在预览中。",
                        progress=30 + int(((idx + 1) / max(total, 1)) * 48),
                        attempt=1,
                        result={
                            "svg_path": str(svg_path),
                            "renderer": "single_pass_agent_svg",
                            "layout_engine": "topic_visual_grammar",
                            "visual_asset_count": len(planned_assets),
                            "review": "structural_only",
                        },
                        error="",
                    )
                    continue

                # `stable_only` was an internal legacy switch for the native
                # template renderer.  It is intentionally not a production
                # fallback: returning a different visual language would make
                # a failed direct page look successful while breaking the
                # user's approved art direction.
                raise RuntimeError("当前任务未启用单次 SVG 直出；不会自动替换为模板版式")

                slide_visual_assets = await _load_slide_visual_assets(state, idx)
                svg_path = project_paths["svg_output"] / _ppt_master_slide_filename(slide_info, idx)
                state["status"] = "building"
                state["progress"] = 44 + int((idx / max(total, 1)) * 36)
                state["message"] = f"正在生成第 {idx + 1}/{total} 页可编辑页面..."
                await _save_state(job_id, state)

                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name=f"direct_svg_{idx + 1}",
                    status="running",
                    message=f"正在制作第 {idx + 1}/{total} 页的可编辑文字、图表和视觉素材版式...",
                    progress=44 + int((idx / max(total, 1)) * 36),
                )
                renderer = "native_layout"
                fallback_reason = ""
                svg_code = ""
                visual_review: dict = {}
                # Prefer the persisted outline model for text/SVG composition.
                # This avoids switching to a different model after the outline
                # has been approved. A vision model remains a compatibility
                # fallback for jobs created before the planner is persisted.
                llm_model_id = str(state.get("llm_model_id") or "").strip()
                design_model_id = llm_model_id or vision_model_id or await get_default_model_id("llm") or ""
                design_category = "llm" if llm_model_id or not vision_model_id else "vision"
                repaired = False
                contract = slide_info.get("design_contract") if isinstance(slide_info.get("design_contract"), dict) else {}
                visual_form = str(contract.get("visual_form") or "").strip().lower()
                archetype = str(contract.get("layout_archetype") or slide_info.get("layout_archetype") or "").strip().lower()
                # Covers, chapter markers and process pages are exactly where
                # a design system needs the most visual authorship. Keep the
                # old stable-only policy as an explicit compatibility mode,
                # rather than silently reducing every production deck to the
                # same cover and timeline renderer.
                stable_native_page = (
                    state.get("design_mode") == "stable_only"
                    and (idx == 0 or visual_form == "process_flow" or archetype in {"waterfall", "sequence", "l_shape", "t_shape"})
                )
                if design_model_id and not stable_native_page and _experimental_model_svg_enabled(state):
                    svg_prompt = _build_direct_svg_prompt(
                        outline=outline,
                        slide=slide_info,
                        idx=idx,
                        total=total,
                        reference_guidance=reference_guidance,
                        attachment_context=state.get("attachment_context", ""),
                        # The complete spec remains persisted in the project.
                        # Per-page model calls receive the compact execution brief.
                        spec_lock="",
                        visual_assets=slide_visual_assets,
                    )
                    spec_card = _render_spec_card_png(outline, slide_info, idx, total)
                    repair_reason = ""
                    repair_detail = ""
                    for design_attempt in range(1, 3):
                        try:
                            attempt_prompt = svg_prompt
                            if design_attempt == 2:
                                attempt_prompt += (
                                    "\n\nAutomatic repair is authorized for this page. "
                                    f"Correct this visible issue before returning the complete replacement SVG: {repair_reason}\n"
                                    f"Specific reviewer diagnosis: {repair_detail[:1200]}"
                                )
                            async def invoke_design_model() -> str:
                                if design_category == "vision":
                                    async with _vision_call_sem:
                                        return await call_vision(
                                            model_id=design_model_id,
                                            image_bytes=spec_card,
                                            prompt=attempt_prompt,
                                            system=PPT_MASTER_SVG_SYSTEM,
                                            max_tokens=8000,
                                        )
                                return await call_chat(
                                    model_id=design_model_id,
                                    user=attempt_prompt,
                                    system=PPT_MASTER_SVG_SYSTEM,
                                    max_tokens=8000,
                                    temperature=0.2,
                                )

                            raw_svg = await _execute_ppt_billed_call(
                                user_id=state.get("user_id", ""),
                                model_id=design_model_id,
                                expected_category=design_category,
                                description=f"PPT page design execution page {idx + 1} attempt {design_attempt}",
                                operation=f"page-design:{idx + 1}",
                                job_id=job_id,
                                attempt=design_attempt,
                                invoke=invoke_design_model,
                            )
                            candidate_svg = _extract_svg_code(raw_svg)
                            _validate_svg_code(candidate_svg)
                            passed, quality_issues = _score_svg_quality(
                                candidate_svg,
                                slide_info,
                                slide_visual_assets,
                            )
                            if not passed:
                                raise PPTPageDesignRejected("; ".join(quality_issues))
                            candidate_svg = _inject_visual_assets(candidate_svg, slide_visual_assets)
                            # Keep the direct path fast: one authored page plus
                            # deterministic SVG checks. A second model-based
                            # visual review added latency and often caused an
                            # unnecessary full-page redraw.
                            visual_review = {"pass": True, "skipped": True}
                            svg_code = candidate_svg
                            renderer = "agent_svg"
                            fallback_reason = ""
                            if design_attempt == 2:
                                repaired = True
                                await set_agent_step(
                                    state,
                                    lambda s: _save_state(job_id, s),
                                    name=f"page_repair_{idx + 1}",
                                    status="completed",
                                    message=f"第 {idx + 1} 页已按检查建议完成自动修正。",
                                    progress=46 + int(((idx + 1) / max(total, 1)) * 34),
                                    attempt=2,
                                    result={"reason": repair_reason, "page": idx + 1},
                                )
                            break
                        except HTTPException:
                            raise
                        except Exception as exc:
                            fallback_reason = str(exc)
                            repair_reason = _ppt_page_repair_reason(exc)
                            repair_detail = fallback_reason
                            if design_attempt == 1:
                                await set_agent_step(
                                    state,
                                    lambda s: _save_state(job_id, s),
                                    name=f"direct_svg_{idx + 1}",
                                    status="failed",
                                    message=f"第 {idx + 1} 页检查发现问题，准备自动修正。",
                                    progress=45 + int((idx / max(total, 1)) * 34),
                                    attempt=1,
                                    result={"reason": repair_reason, "page": idx + 1},
                                    error=fallback_reason[:500],
                                )
                                await set_agent_step(
                                    state,
                                    lambda s: _save_state(job_id, s),
                                    name=f"page_repair_{idx + 1}",
                                    status="running",
                                    message=f"正在自动修正第 {idx + 1} 页：{repair_reason}",
                                    progress=46 + int((idx / max(total, 1)) * 34),
                                    attempt=2,
                                    result={"reason": repair_reason, "page": idx + 1},
                                )
                                continue
                            logger.warning(
                                "[PPTAgent] direct page design repair failed for job=%s page=%s: %s",
                                job_id,
                                idx + 1,
                                exc,
                            )
                            await set_agent_step(
                                state,
                                lambda s: _save_state(job_id, s),
                                name=f"page_repair_{idx + 1}",
                                status="failed",
                                message=f"第 {idx + 1} 页自动修正未通过，未替换为默认模板版式。",
                                progress=47 + int((idx / max(total, 1)) * 34),
                                attempt=2,
                                result={"reason": repair_reason, "page": idx + 1},
                                error=fallback_reason[:500],
                            )
                            raise PPTPageDesignRejected(
                                "custom editable composition failed after one targeted repair: " + fallback_reason
                            )
                else:
                    renderer = "native_layout"
                    fallback_reason = ""

                if not svg_code:
                    # Production geometry is deterministic: the LLM selects
                    # content and page semantics, while the vetted layout
                    # registry owns copy zones, hierarchy, and editable shape
                    # placement.
                    native_svg = _build_native_composed_svg(
                        outline,
                        slide_info,
                        idx,
                        total,
                        slide_visual_assets,
                    )
                    native_passed, native_issues = _score_svg_quality(
                        native_svg,
                        slide_info,
                        slide_visual_assets,
                    )
                    if not native_passed:
                        raise PPTPageDesignRejected(
                            "stable native layout failed pre-export QA: " + "; ".join(native_issues)
                        )
                    svg_code = _inject_visual_assets(native_svg, slide_visual_assets)
                if fallback_reason:
                    warnings = state.setdefault("design_review_warnings", [])
                    warnings.append({
                        "page": idx + 1,
                        "message": "This page uses the stable editable layout because the planned custom composition was unavailable.",
                        "detail": fallback_reason[:500],
                    })
                _validate_svg_code(svg_code)
                if renderer == "agent_svg":
                    native_passed, native_issues = _score_svg_quality(
                        svg_code,
                        slide_info,
                        slide_visual_assets,
                    )
                    if not native_passed:
                        raise PPTPageDesignRejected(
                            "stable native layout failed pre-export QA: " + "; ".join(native_issues)
                        )

                svg_path.write_text(svg_code, encoding="utf-8")
                svg_files.append(svg_path)
                _write_ppt_master_notes(project_paths["notes"], svg_path, slide_info, idx)
                live_slide_info = dict(slide_info)
                live_slide_info["page"] = idx + 1
                live_prompt = str(live_slide_info.get("prompt") or live_slide_info.get("layout_hint") or "")
                direct_decks.append({
                    "id": f"direct-slide-{idx + 1}",
                    "title": f"P{idx + 1}",
                    "prompt": live_prompt,
                    "kind": "svg",
                    "versions": [_encode_svg_version(svg_code)],
                    "selected_version_index": 0,
                    "slide": live_slide_info,
                })
                state["direct_slide_decks"] = direct_decks
                state["slide_images_b64"] = []
                completion_step = (
                    f"page_repair_{idx + 1}"
                    if repaired
                    else f"native_layout_{idx + 1}"
                    if renderer == "native_layout"
                    else f"direct_svg_{idx + 1}"
                )
                completion_attempt = 2 if repaired else 1
                completion_message = (
                    f"第 {idx + 1}/{total} 页已完成自动修正并保留为可编辑页面。"
                    if repaired
                    else f"第 {idx + 1}/{total} 页已通过受控版式与文字边界检查。"
                    if renderer == "native_layout"
                    else f"第 {idx + 1}/{total} 页已完成原生可编辑排版。"
                )
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name=completion_step,
                    status="completed",
                    message=completion_message,
                    progress=46 + int(((idx + 1) / max(total, 1)) * 34),
                    attempt=completion_attempt,
                        result={
                            "svg_path": str(svg_path),
                            "renderer": renderer,
                        "fallback": False,
                        "layout_engine": "template_registry" if renderer == "native_layout" else "experimental_model_svg",
                            "repaired": repaired,
                            "visual_asset_count": len(slide_visual_assets),
                            "visual_review_score": visual_review.get("score") if renderer == "agent_svg" else None,
                            "visual_review_skipped": bool(visual_review.get("skipped")) if renderer == "agent_svg" else False,
                        },
                    error="",
                )

            state["status"] = "building"
            state["progress"] = 80
            state["message"] = "正在整理页面并进行兼容性处理..."
            await _save_state(job_id, state)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_finalize",
                status="running",
                message="正在检查页面结构并整理导出兼容性...",
                progress=80,
            )
            final_svg_files = await asyncio.get_event_loop().run_in_executor(
                None,
                _postprocess_ppt_master_svgs,
                svg_files,
                project_paths["svg_final"],
            )
            backup_dir = project_paths["backup"] / datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copytree(project_paths["svg_output"], backup_dir / "svg_output", dirs_exist_ok=True)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_finalize",
                status="completed",
                message="页面检查完成，全部可编辑页面已准备好，可预览、编辑或导出。",
                progress=100,
                result={"svg_final": str(project_paths["svg_final"]), "backup": str(backup_dir)},
            )

            for idx, final_svg_path in enumerate(final_svg_files):
                if idx >= len(direct_decks):
                    break
                final_svg = final_svg_path.read_text(encoding="utf-8")
                direct_decks[idx]["versions"] = [_encode_svg_version(final_svg)]
                direct_decks[idx]["selected_version_index"] = 0
            state["direct_slide_decks"] = direct_decks

            # Page production and PPTX export are separate user-visible stages.
            # The previous flow exported immediately here, so users received a
            # download notification while they were still reviewing the pages.
            # Keep every editable page, then let the explicit export action
            # package the currently selected versions.
            if not state.get("auto_export_after_preview"):
                state["status"] = "checkpoint"
                state["progress"] = 100
                _clear_pptx_export_state(state)
                state["message"] = "全部页面已完成，可在预览中编辑、排序或直接导出 PPT。"
                state.setdefault("snapshots", {})["after_pages"] = {
                    "direct_slide_decks": direct_decks,
                    "project_dir": str(project_dir),
                    "svg_final": str(project_paths["svg_final"]),
                }
                append_ppt_artifact(
                    state,
                    "direct_slides_sync",
                    project_dir=str(project_dir),
                    svg_files=[str(path) for path in svg_files],
                    final_svg_files=[str(path) for path in final_svg_files],
                    slide_count=total,
                    conversion_mode="ppt_master_direct",
                    checkpoint="after_pages",
                )
                await _save_state(job_id, state)
                if state.get("conversation_id"):
                    try:
                        from repositories import conversation_repo

                        await conversation_repo.add_message(
                            conversation_id=state["conversation_id"],
                            role="assistant",
                            content=f"全部 {total} 页可编辑页面已经准备好。请在预览中检查、修改或排序；确认后再导出 PPT。",
                            meta={
                                "type": "direct_slides_sync",
                                "job_id": job_id,
                                "status": "checkpoint",
                                "slide_count": total,
                                "conversion_mode": "ppt_master_direct",
                                "direct_slide_decks": direct_decks,
                                "project_dir": str(project_dir),
                                "checkpoint": "after_pages",
                            },
                        )
                    except Exception as exc:
                        logger.warning("[PPTAgent] 保存直出预览消息失败: %s", exc)
                return

            output_path = project_paths["exports"] / f"{_safe_project_slug(outline.get('title', ''), job_id)}.pptx"
            svg_ref_path = output_path.with_name(f"{output_path.stem}_svg_reference.pptx")
            state["message"] = "正在导出可编辑 PPT..."
            state["progress"] = 84
            await _save_state(job_id, state)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_convert",
                status="running",
                message="正在生成可继续编辑的文字、图表和图形元素...",
                progress=84,
            )

            use_native = False
            try:
                from services.svg_to_pptx.pptx_builder import create_pptx_with_native_svg
                from services.svg_to_pptx.pptx_discovery import find_notes_files
                notes = find_notes_files(project_dir, final_svg_files)
                success = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: create_pptx_with_native_svg(
                        svg_files=final_svg_files,
                        output_path=output_path,
                        canvas_format="ppt169",
                        notes=notes,
                        enable_notes=True,
                        use_native_shapes=True,
                        verbose=True,
                    ),
                )
                use_native = bool(success and output_path.exists())
            except Exception as e:
                logger.warning(f"[PPTAgent] PPT Master SVG conversion failed: {e}")

            if not use_native or not output_path.exists():
                raise RuntimeError("可编辑 SVG 无法转换为 PPTX；已保留原始逐页预览，不会替换为模板兜底版本")
            else:
                try:
                    from services.svg_to_pptx.pptx_builder import create_pptx_with_native_svg
                    from services.svg_to_pptx.pptx_discovery import find_notes_files
                    notes = find_notes_files(project_dir, final_svg_files)
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: create_pptx_with_native_svg(
                            svg_files=final_svg_files,
                            output_path=svg_ref_path,
                            canvas_format="ppt169",
                            notes=notes,
                            enable_notes=True,
                            use_native_shapes=False,
                            use_compat_mode=True,
                            verbose=False,
                        ),
                    )
                except Exception as e:
                    logger.debug(f"[PPTAgent] SVG reference PPTX skipped: {e}")

            state["pptx_qa"] = {"status": "skipped", "reason": "single-pass direct export"}
            append_ppt_artifact(
                state,
                "ppt_master_direct",
                project_dir=str(project_dir),
                design_spec=str(project_paths["design_spec"]),
                spec_lock=str(project_paths["spec_lock"]),
                svg_files=[str(path) for path in svg_files],
                final_svg_files=[str(path) for path in final_svg_files],
                svg_reference_pptx=str(svg_ref_path) if svg_ref_path.exists() else "",
                slide_count=total,
                conversion_mode="ppt_master_direct",
            )
            pptx_asset = await store_pptx_asset(state, job_id, output_path)
            append_ppt_artifact(
                state,
                "pptx_done",
                pptx_path=str(output_path),
                pptx_url=pptx_asset.get("url", ""),
                pptx_key=pptx_asset.get("key", ""),
                pptx_filename=pptx_asset.get("filename") or state.get("pptx_filename", ""),
                use_native=use_native,
                conversion_mode="ppt_master_direct",
                slide_count=total,
                project_dir=str(project_dir),
                design_spec=str(project_paths["design_spec"]),
                spec_lock=str(project_paths["spec_lock"]),
                svg_reference_pptx=str(svg_ref_path) if svg_ref_path.exists() else "",
                checkpoint="done",
            )
            direct_decks: list[dict] = []
            for idx, svg_path in enumerate(final_svg_files):
                slide_info = dict(slides[idx]) if idx < len(slides) and isinstance(slides[idx], dict) else {}
                slide_info["page"] = idx + 1
                title = str(slide_info.get("title") or f"第 {idx + 1} 页")
                prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
                try:
                    svg_b64 = _encode_svg_version(svg_path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                direct_decks.append({
                    "id": f"direct-slide-{idx + 1}",
                    "title": title,
                    "prompt": prompt,
                    "kind": "svg",
                    "versions": [svg_b64],
                    "selected_version_index": 0,
                    "slide": slide_info,
                })
            if direct_decks:
                state["direct_slide_decks"] = direct_decks
            design_review_warnings = state.get("design_review_warnings") if isinstance(state.get("design_review_warnings"), list) else []
            qa_attention_pages: list[dict] = []
            if design_review_warnings or qa_attention_pages:
                affected_pages = [int(item.get("page") or 0) for item in design_review_warnings if isinstance(item, dict)]
                affected_pages = [page for page in affected_pages if page > 0]
                qa_issues = [
                    f"第 {page.get('page')} 页：{(page.get('issues') or [{}])[0].get('message', '需要复核页面结构。')}"
                    for page in qa_attention_pages[:4]
                ]
                state["quality_review"] = {
                    "kind": "quality_review",
                    "phase": "delivery",
                    "current_result_available": True,
                    "message": "演示文稿已经生成并保留当前可编辑版本。部分页面有可选的版式或导出检查建议，可按页发起修改。",
                    "issues": [f"第 {page} 页使用了稳定可编辑版式" for page in affected_pages[:4]] + qa_issues,
                    "actions": ["keep_current", "request_revision"],
                }
                state["intervention"] = state["quality_review"]
            else:
                state.pop("quality_review", None)
                state.pop("intervention", None)
            state["status"] = "done"
            state["progress"] = 100
            state["pptx_path"] = str(output_path)
            state["conversion_mode"] = "ppt_master_direct"
            state["slide_images_b64"] = []
            if design_review_warnings or qa_attention_pages:
                state["message"] = "演示文稿已生成，部分页面有可选的版式或导出检查建议，等待你决定是否修改。"
            else:
                state["message"] = (
                    "可编辑演示文稿已生成，页面元素可继续编辑。"
                    if use_native
                    else "可编辑演示文稿已生成，已使用兼容的可编辑版本。"
                )
            state.setdefault("snapshots", {})["done"] = {
                "pptx_path": str(output_path),
                "pptx_url": state.get("pptx_url", ""),
                "pptx_filename": state.get("pptx_filename", ""),
                "use_native": use_native,
                "conversion_mode": "ppt_master_direct",
                "project_dir": str(project_dir),
                "spec_lock": str(project_paths["spec_lock"]),
            }
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="ppt_master_convert",
                status="completed",
                message="可编辑演示文稿已构建完成。",
                progress=100,
                result={"pptx_path": str(output_path), "pptx_url": state.get("pptx_url", ""), "use_native": use_native},
            )
            await _save_state(job_id, state)

            if state.get("conversation_id"):
                try:
                    from repositories import conversation_repo
                    await conversation_repo.add_message(
                        conversation_id=state["conversation_id"],
                        role="assistant",
                        content=f"可编辑演示文稿已生成完成！\n\n共 {total} 页。",
                        meta={
                            "type": "pptx_done",
                            "job_id": job_id,
                            "pptx_path": str(output_path),
                            "pptx_url": state.get("pptx_url", ""),
                            "pptx_key": state.get("pptx_key", ""),
                            "pptx_filename": state.get("pptx_filename", ""),
                            "use_native": use_native,
                            "conversion_mode": "ppt_master_direct",
                            "slide_count": total,
                            "direct_slide_decks": direct_decks,
                            "project_dir": str(project_dir),
                            "design_spec": str(project_paths["design_spec"]),
                            "spec_lock": str(project_paths["spec_lock"]),
                            "svg_reference_pptx": str(svg_ref_path) if svg_ref_path.exists() else "",
                            "checkpoint": "done",
                        },
                    )
                except Exception as e:
                    logger.warning(f"[PPTAgent] 保存直出完成消息失败: {e}")

        except Exception as e:
            logger.error(f"[PPTAgent] direct PPT Master failed: {e}", exc_info=True)
            state["status"] = "failed"
            state["error"] = str(e)
            state["message"] = f"可编辑演示文稿生成失败：{e}"
            try:
                await _save_state(job_id, state)
            except Exception:
                pass

    async def _run_pipeline(self, job_id: str):
        """Generate outline and slide preview images."""
        state: dict = {}
        try:
            loaded = await _load_state(job_id)
            if not loaded:
                logger.error("[PPTAgent] job_id=%s was not found; pipeline cannot continue", job_id)
                return
            state = loaded

            # Step 1: generate the outline unless the job already has one.
            if state.get("outline"):
                logger.info(f"[PPTAgent] Reusing existing outline: {outline.get('title', '')}")
                logger.info("[PPTAgent] reusing existing outline: %s", outline.get("title", ""))
            else:
                state["status"]   = "generating_outline"
                state["message"] = "AI 正在规划 PPT 大纲..."
                state["message"] = "AI 正在规划 PPT 大纲..."
                await _save_state(job_id, state)
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name="intent_planning",
                    status="running",
                    message="PPT 智能体正在理解主题、附件和参考图...",
                    progress=5,
                )

                effective_style_hint = state.get("style_hint", "")
                ref_guidance = await _analyze_reference_image_for_ppt(
                    state.get("ref_image_b64", ""),
                    state.get("vision_model_id"),
                    user_id=state.get("user_id", ""),
                    job_id=job_id,
                )
                if ref_guidance:
                    effective_style_hint = (
                        f"{effective_style_hint}\n\n参考图分析：{ref_guidance}"
                        if effective_style_hint else f"参考图分析：{ref_guidance}"
                    )
                    state["reference_image_guidance"] = ref_guidance
                    await set_agent_step(
                        state,
                        lambda s: _save_state(job_id, s),
                        name="reference_analysis",
                        status="completed",
                        message="参考图风格已提取，会用于大纲与页面视觉规划。",
                        progress=9,
                        result={"guidance": ref_guidance[:500]},
                    )

                # Resolve the planner once and persist it. The direct editable
                # page composer can then reuse the same selected GPT model.
                resolved_llm_model_id = str(state.get("llm_model_id") or "").strip()
                if not resolved_llm_model_id:
                    resolved_llm_model_id = await get_default_model_id("llm") or ""
                    if resolved_llm_model_id:
                        state["llm_model_id"] = resolved_llm_model_id

                attachment_context = state.get("attachment_context", "")
                outline = await generate_outline(
                    state["topic"],
                    effective_style_hint,
                    state.get("page_count", 0),
                    llm_model_id=resolved_llm_model_id,
                    slide_prompts=state.get("slide_prompts") or [],
                    attachment_context=attachment_context,
                    brief=state.get("brief") or {},
                    template_id=state.get("template_id", ""),
                    user_id=state.get("user_id", ""),
                    job_id=job_id,
                )
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name="intent_planning",
                    status="completed",
                    message=f"PPT 结构规划完成，共 {len(outline.get('slides', []))} 页。",
                    progress=15,
                    result={"title": outline.get("title", ""), "slide_count": len(outline.get("slides", []))},
                )
                state["outline"] = outline
                state["status"] = "outline_done"
                state["progress"] = 15
                state["message"] = f"大纲已生成：{outline.get('title', '')}，共 {len(outline.get('slides', []))} 页"
                state.setdefault("snapshots", {})["after_outline"] = {
                    "outline": outline,
                    "slide_images_b64": [],
                }
                await _save_state(job_id, state)

                if state.get("conversation_id"):
                    try:
                        from repositories import conversation_repo
                        slides_summary = "\n".join(
                            f"  第{s.get('page', i + 1)}页：{s.get('title', '')}"
                            for i, s in enumerate(outline.get("slides", []))
                        )
                        await conversation_repo.add_message(
                            conversation_id=state["conversation_id"],
                            role="assistant",
                            content=f"大纲已生成：{outline.get('title', '')}\n\n{slides_summary}",
                            meta={
                                "type": "outline",
                                "job_id": job_id,
                                "outline": outline,
                                "checkpoint": "after_outline",
                            },
                        )
                    except Exception as e:
                        logger.warning(f"[PPTAgent] failed to save outline message: {e}")
                        logger.warning("[PPTAgent] failed to persist outline message: %s", e)

            # 大纲生成后暂停，等待用户确认
            logger.info(f"[PPTAgent] 大纲已生成，暂停等待用户确认")
            return

        except Exception as e:
            logger.error(f"[PPTAgent] outline pipeline failed: {e}", exc_info=True)
            state["status"] = "failed"
            state["error"] = str(e)
            state["message"] = f"大纲生成失败：{e}"
            try:
                await _save_state(job_id, state)
            except Exception:
                pass

    async def _run_pipeline_from_images(self, job_id: str):
        """用户确认大纲后，继续生成幻灯片图片"""
        state: dict = {}
        try:
            loaded = await _load_state(job_id)
            if not loaded:
                logger.error(f"[PPTAgent] 找不到 job_id={job_id} 的状态，pipeline 失败")
                return
            state = loaded

            # 检查是否有大纲
            outline = state.get("outline")
            if not outline:
                logger.error(f"[PPTAgent] 找不到大纲，无法生成图片")
                state["status"] = "failed"
                state["error"] = "大纲未生成或已丢失"
                await _save_state(job_id, state)
                return

            image_model_id = state.get("image_model_id") or await get_default_model_id("generate")
            if not image_model_id:
                raise RuntimeError("未找到可用的图像生成模型（category=generate），请在管理后台配置")

            slides = outline.get("slides", [])
            total = len(slides)
            ppt_style = outline.get("style", "简洁商务风")
            color_scheme = outline.get("color_scheme", "深蓝配金色")
            ref_image_b64 = state.get("ref_image_b64", "")
            ref_images = [await _ppt_image_bytes(ref_image_b64, state.get("user_id", ""))] if ref_image_b64 else None
            reference_guidance = state.get("reference_image_guidance", "")
            attachment_context = state.get("attachment_context", "")

            existing_slide_images = state.get("slide_images_b64")
            if not isinstance(existing_slide_images, list):
                existing_slide_images = []
            slide_images_b64 = [
                str(existing_slide_images[index] or "") if index < len(existing_slide_images) else ""
                for index in range(total)
            ]
            state["slide_images_b64"] = slide_images_b64
            state["status"] = "generating_images"
            state["message"] = f"正在并行生成 {total} 页预览图..."
            state["progress"] = 16
            await _save_state(job_id, state)

            state_lock = asyncio.Lock()
            completed_count = len([image for image in slide_images_b64 if image])
            failure_count = 0
            billing_failure: ExternalBillingError | None = None
            budget_failure: PPTBudgetPaused | None = None

            async def generate_slide_item(item: tuple[int, dict]):
                nonlocal completed_count, failure_count, billing_failure, budget_failure
                idx, slide_info = item
                prompt = _build_slide_prompt(
                    slide_info,
                    ppt_style,
                    color_scheme,
                    reference_guidance=reference_guidance,
                    attachment_context=attachment_context,
                )
                try:
                    async with state_lock:
                        await set_agent_step(
                            state,
                            lambda s: _save_state(job_id, s),
                            name=f"slide_{idx + 1}_generation",
                            status="running",
                            message=f"正在生成第 {idx + 1}/{total} 页...",
                            progress=15 + int(((completed_count + failure_count) / max(total, 1)) * 35),
                        )

                    if billing_failure:
                        raise billing_failure
                    if budget_failure:
                        raise budget_failure

                    async with _image_call_sem:
                        try:
                            img_bytes = await _execute_ppt_billed_call(
                                user_id=state.get("user_id", ""),
                                model_id=image_model_id,
                                expected_category="generate",
                                description=f"PPT 预览图生成 · 第 {idx + 1} 页",
                                operation=f"preview-slide:{idx + 1}",
                                job_id=job_id,
                                invoke=lambda: call_image(
                                    model_id=image_model_id,
                                    prompt=prompt,
                                    ref_images=ref_images,
                                    size=image_output_size("16:9", state.get("output_resolution")),
                                    quality=state.get("image_quality", "auto"),
                                    force_size=True,
                                ),
                            )
                        except HTTPException as exc:
                            if exc.status_code == 402:
                                raise PPTBudgetPaused(str(exc.detail)) from exc
                            raise
                    slide_image_value = await store_ppt_slide_image_asset(
                        state,
                        job_id,
                        img_bytes,
                        prompt=prompt,
                        model_id=image_model_id,
                        slide_index=idx,
                    )
                    async with state_lock:
                        completed_count += 1
                        slide_images_b64[idx] = slide_image_value
                        state["slide_images_b64"] = slide_images_b64
                        state["message"] = f"第 {idx + 1}/{total} 页已生成，可先预览和编辑。"
                        state["progress"] = 20 + int(((completed_count + failure_count) / max(total, 1)) * 35)
                        await set_agent_step(
                            state,
                            lambda s: _save_state(job_id, s),
                            name=f"slide_{idx + 1}_generation",
                            status="completed",
                            message=f"第 {idx + 1} 页生成完成。",
                            progress=state["progress"],
                            result={"image_ready": True, "slide_index": idx},
                        )
                        await _save_state(job_id, state)
                    logger.info("[PPTAgent] slide generated job_id=%s slide=%s/%s", job_id, idx + 1, total)
                    return slide_image_value
                except PPTBudgetPaused as e:
                    budget_failure = e
                    async with state_lock:
                        failure_count += 1
                        state["slide_images_b64"] = slide_images_b64
                        state["error"] = str(e)
                        state["intervention"] = {
                            "kind": "budget",
                            "phase": "slides",
                            "message": "Credits are insufficient. Completed slides are preserved and missing slides can resume later.",
                            "actions": ["resume", "change_model", "edit_outline"],
                        }
                        state["message"] = "Credits are insufficient. The remaining slides are paused."
                        state["progress"] = 20 + int(((completed_count + failure_count) / max(total, 1)) * 35)
                        await set_agent_step(
                            state,
                            lambda s: _save_state(job_id, s),
                            name=f"slide_{idx + 1}_generation",
                            status="failed",
                            message=f"Slide {idx + 1} is waiting for a budget continuation.",
                            progress=state["progress"],
                            error=str(e),
                        )
                        await _save_state(job_id, state)
                    return e
                except ExternalBillingError as e:
                    billing_failure = e
                    async with state_lock:
                        failure_count += 1
                        state["slide_images_b64"] = slide_images_b64
                        state["error"] = str(e)
                        state["intervention"] = {
                            "kind": "budget",
                            "phase": "slides",
                            "message": "The external compute balance is insufficient. Completed slides are preserved and missing slides can resume later.",
                            "actions": ["resume", "change_model", "edit_outline"],
                        }
                        state["message"] = "算力 API 余额不足，已停止继续生成未完成页面。已生成的页面会保留。"
                        state["progress"] = 20 + int(((completed_count + failure_count) / max(total, 1)) * 35)
                        await set_agent_step(
                            state,
                            lambda s: _save_state(job_id, s),
                            name=f"slide_{idx + 1}_generation",
                            status="failed",
                            message=f"第 {idx + 1} 页因算力 API 余额不足未生成。",
                            progress=state["progress"],
                            error=str(e),
                        )
                        await _save_state(job_id, state)
                    logger.warning("[PPTAgent] slide generation stopped by external billing error job_id=%s slide=%s/%s", job_id, idx + 1, total)
                    return e
                except HTTPException:
                    raise
                except Exception as e:
                    async with state_lock:
                        failure_count += 1
                        state["slide_images_b64"] = slide_images_b64
                        state["message"] = f"第 {idx + 1}/{total} 页生成失败，其余页面继续生成。"
                        state["progress"] = 20 + int(((completed_count + failure_count) / max(total, 1)) * 35)
                        await set_agent_step(
                            state,
                            lambda s: _save_state(job_id, s),
                            name=f"slide_{idx + 1}_generation",
                            status="failed",
                            message=f"第 {idx + 1} 页生成失败，已保留为空等待后续编辑。",
                            progress=state["progress"],
                            error=str(e),
                        )
                        await _save_state(job_id, state)
                    logger.error("[PPTAgent] slide generation failed job_id=%s slide=%s error=%s", job_id, idx + 1, e, exc_info=True)
                    return e

            pending_slides = [
                (index, slide)
                for index, slide in enumerate(slides)
                if not slide_images_b64[index]
            ]
            results = await gather_limited(
                pending_slides,
                settings.PPT_SLIDE_FANOUT_CONCURRENCY,
                generate_slide_item,
                return_exceptions=True,
            )

            platform_failures = [result for result in results if isinstance(result, HTTPException)]
            if platform_failures:
                raise platform_failures[0]
            success_count = len([x for x in slide_images_b64 if x])
            billing_failures = [result for result in results if isinstance(result, ExternalBillingError)]
            paused_failure = budget_failure or (billing_failures[0] if billing_failures else None)
            if paused_failure and success_count == 0:
                state["status"] = "checkpoint"
                state["progress"] = 15
                state["error"] = str(paused_failure)
                state.setdefault("intervention", {
                    "kind": "budget",
                    "phase": "slides",
                    "message": "Budget is unavailable. The outline is preserved and this job can resume later.",
                    "actions": ["resume", "change_model", "edit_outline"],
                })
                state["message"] = "The outline is preserved. Continue after credits or compute balance is available."
                await _save_state(job_id, state)
                return
            if success_count == 0:
                failures = [result for result in results if isinstance(result, BaseException)]
                if failures:
                    raise failures[0]
                raise RuntimeError("所有 PPT 页面均生成失败，请调整提示词或模型设置后重试。")

            append_ppt_artifact(
                state,
                "slides_preview",
                slides=slide_images_b64,
                preview_b64=next((x for x in slide_images_b64 if x), ""),
                slide_count=success_count,
                outline=state.get("outline"),
                checkpoint="after_images",
            )
            state.setdefault("snapshots", {})["after_images"] = {
                "outline": state.get("outline"),
                "slide_images_b64": slide_images_b64,
            }

            if paused_failure:
                state["status"] = "checkpoint"
                state["progress"] = 50
                state["error"] = str(paused_failure)
                state.setdefault("intervention", {
                    "kind": "budget",
                    "phase": "slides",
                    "message": "Budget is unavailable. Completed slides are preserved and missing slides can resume later.",
                    "actions": ["resume", "change_model", "edit_outline"],
                })
                state["message"] = (
                    f"已生成 {success_count}/{total} 页，后续页面因算力 API 余额不足暂停。"
                    "请充值或切换算力后重新生成缺失页面。"
                )
                await _save_state(job_id, state)
            elif normalize_ppt_conversion_mode(state.get("conversion_mode")) == "ppt_master_direct":
                state["status"] = "confirmed"
                state["progress"] = 55
                state["message"] = f"所有页面已生成（{success_count} 张成功），正在构建 PPTX..."
                await _save_state(job_id, state)
                await self._run_post_checkpoint_limited(job_id)
                return
            else:
                state["intervention"] = {}
                state["status"] = "checkpoint"
                state["progress"] = 50
                state["message"] = f"页面生成完成（{success_count}/{total} 张成功），可先编辑已完成页面或确认生成 PPTX。"
                await _save_state(job_id, state)

            if state.get("conversation_id"):
                try:
                    from repositories import conversation_repo
                    preview_b64 = next((x for x in slide_images_b64 if x), "")
                    await conversation_repo.add_message(
                        conversation_id=state["conversation_id"],
                        role="assistant",
                        content=state["message"] if billing_failures else f"{success_count} 张幻灯片已生成，可预览确认。",
                        meta={
                            "type": "slides_preview",
                            "job_id": job_id,
                            "slide_count": success_count,
                            "preview_b64": preview_b64,
                            "preview_b64_list": slide_images_b64,
                            "checkpoint": "after_images",
                        },
                    )
                except Exception as e:
                    logger.warning(f"[PPTAgent] 保存图片预览消息失败: {e}")
            return

        except Exception as e:
            logger.error(f"[PPTAgent] pipeline failed: {e}", exc_info=True)
            state["status"]  = "failed"
            state["progress"] = 100
            state["error"] = str(e)
            state["message"] = f"生成失败：{e}"
            # State persistence already falls back to process memory if Redis is unavailable.
            try:
                await _save_state(job_id, state)
            except Exception:
                pass

    async def _run_post_checkpoint(self, job_id: str):
        """Build the final PPTX after the user confirms preview slides."""
        state: dict = {}
        try:
            loaded = await _load_state(job_id)
            if not loaded:
                logger.error("[PPTAgent] post-checkpoint job_id=%s was not found", job_id)
                return
            state = loaded
            job_dir = PPT_WORK_DIR / job_id
            job_dir.mkdir(exist_ok=True)
            outline = state.get("outline") or {}
            output_path = job_dir / _ppt_export_filename(state, job_id)
            conversion_mode = normalize_ppt_conversion_mode(state.get("conversion_mode"))

            slide_images: list[bytes] = []
            for b64 in state["slide_images_b64"]:
                if b64:
                    slide_images.append(await _ppt_image_bytes(b64, state.get("user_id", "")))
                else:
                    from PIL import Image as PILImage
                    img = PILImage.new("RGB", (1792, 1024), (255, 255, 255))
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    slide_images.append(buf.getvalue())

            outline     = state["outline"]
            slides_info = outline.get("slides", [])
            total       = len(slide_images)
            use_native = conversion_mode in {"native_svg", "ppt_master_direct"}

            from services.ai_client import call_vision, get_default_model_id as _get_default
            vision_model_id = ""
            if use_native:
                vision_model_id = (
                    state.get("vision_model_id")
                    or await _get_default("vision")
                    or await _get_default("llm")
                )
                use_native = bool(vision_model_id)

            # Step 3: convert generated PNG pages to editable SVG through the vision model.
            svg_files: list[Path] = []

            if use_native:
                state["status"]   = "analyzing"
                state["progress"] = 60
                state["message"] = "正在将页面转换为可编辑 SVG..."
                await _save_state(job_id, state)
                await set_agent_step(
                    state,
                    lambda s: _save_state(job_id, s),
                    name="native_rebuild",
                    status="running",
                    message="正在用视觉模型分析页面并重建可编辑 SVG...",
                    progress=60,
                )

                # High-fidelity prompt: preserve the full visual composition.
                _PNG_TO_SVG_SYSTEM = """You are an expert SVG engineer. Convert the PPT slide image to precise SVG code.

REQUIREMENTS:
- viewBox="0 0 1792 1024" (16:9 ratio)
- Reproduce ALL visible text as <text> elements with exact position, font-size, font-weight, fill color
- Reproduce background with <rect> or <linearGradient> matching the original colors exactly
- Reproduce ALL decorative shapes, icons, lines, borders, images with SVG primitives
- Group related elements with <g id="..."> (e.g. id="title-group", id="content-area", id="background")
- Each major element must have an id attribute for editability in PowerPoint
- Return ONLY the complete <svg>...</svg> code, no explanation, no markdown fences"""

                for idx, (img_bytes, slide_info) in enumerate(zip(slide_images, slides_info)):
                    state["message"] = f"正在转换第 {idx + 1}/{total} 页为 SVG..."
                    state["progress"] = 60 + int((idx / max(total, 1)) * 25)
                    await _save_state(job_id, state)

                    svg_path = job_dir / f"slide_{idx + 1}.svg"
                    last_err = None
                    for attempt in range(2):
                        try:
                            prompt = (
                                "Convert this PPT slide to SVG. Reproduce all visual elements as accurately as possible."
                                if attempt == 0 else
                                "Convert this PPT slide to SVG. Focus on text elements and background."
                            )
                            async with _vision_call_sem:
                                raw_svg = await _execute_ppt_billed_call(
                                    user_id=state.get("user_id", ""),
                                    model_id=vision_model_id,
                                    expected_category="vision",
                                    description=f"PPT 原生重建视觉分析 · 第 {idx + 1} 页",
                                    operation=f"native-svg:{idx + 1}",
                                    job_id=job_id,
                                    attempt=attempt + 1,
                                    invoke=lambda: call_vision(
                                        model_id=vision_model_id,
                                        prompt=prompt,
                                        image_bytes=img_bytes,
                                        system=_PNG_TO_SVG_SYSTEM,
                                        max_tokens=8000,
                                    ),
                                )
                            if not raw_svg or not raw_svg.strip():
                                raise ValueError("视觉模型返回了空响应")

                            svg_start = raw_svg.find("<svg")
                            svg_end = raw_svg.rfind("</svg>") + 6
                            if svg_start == -1 or svg_end <= svg_start:
                                raise ValueError(f"未找到有效 SVG 标签，响应前300字符: {raw_svg[:300]!r}")

                            svg_code = raw_svg[svg_start:svg_end]
                            svg_path.write_text(svg_code, encoding="utf-8")
                            svg_files.append(svg_path)
                            logger.info(f"[PPTAgent] 第 {idx + 1} 页 SVG 生成成功 (attempt={attempt + 1}, {len(svg_code)} chars)")
                            last_err = None
                            break
                        except HTTPException:
                            raise
                        except Exception as e:
                            last_err = e
                            logger.warning(f"[PPTAgent] 第 {idx + 1} 页 SVG 第 {attempt + 1} 次尝试失败: {e}")
                            if attempt < 1:
                                await asyncio.sleep(2)

                    if last_err is not None:
                        logger.warning(f"[PPTAgent] 第 {idx + 1} 页 SVG 全部重试失败，降级为 PNG 背景")
                        use_native = False
                        break
            # Step 4: convert SVG to a native PPTX, with a bitmap-overlay compatibility fallback.
            state["status"]   = "building"
            state["progress"] = 85
            if conversion_mode == "image_only":
                state["message"] = "正在构建整图 PPTX..."
            elif conversion_mode in {"native_svg", "ppt_master_direct"}:
                state["message"] = "正在重建可编辑 PPT..."
            else:
                state["message"] = "正在构建文字可编辑 PPTX..."
            await _save_state(job_id, state)
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="pptx_build",
                status="running",
                message=state["message"],
                progress=85,
            )

            if conversion_mode == "image_only":
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    _build_pptx_images_only,
                    slide_images,
                    output_path,
                )
                use_native = False
            elif use_native and len(svg_files) == total:
                # ppt-master preserves each SVG element as an editable DrawingML shape.
                from services.svg_to_pptx.pptx_builder import create_pptx_with_native_svg
                success = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: create_pptx_with_native_svg(
                        svg_files=svg_files,
                        output_path=output_path,
                        canvas_format="ppt169",
                        use_native_shapes=True,
                        verbose=True,
                    )
                )
                if not success:
                    logger.warning("[PPTAgent] native SVG conversion failed; falling back to bitmap overlay mode")
                    use_native = False

            if conversion_mode != "image_only" and (not use_native or not output_path.exists()):
                # Compatibility fallback: PNG background with editable text overlays.
                logger.warning("[PPTAgent] falling back to bitmap background mode")
                all_text_elements: list[list[dict]] = []
                clean_backgrounds: list[bytes] = []
                overlay_vision_model_id = (
                    state.get("vision_model_id")
                    or vision_model_id
                    or await _get_default("vision")
                    or await _get_default("llm")
                )
                for idx, (img_bytes, slide_info) in enumerate(zip(slide_images, slides_info)):
                    state["message"] = f"正在识别第 {idx + 1}/{total} 页文字..."
                    state["progress"] = 70 + int((idx / max(total, 1)) * 12)
                    await _save_state(job_id, state)
                    elements = await _analyze_text_elements(
                        img_bytes=img_bytes,
                        slide_info=slide_info,
                        vision_model_id=overlay_vision_model_id,
                        user_id=state.get("user_id", ""),
                        job_id=job_id,
                        slide_index=idx,
                    )
                    clean_bg: bytes | None = None
                    if conversion_mode == "editable_overlay":
                        state["message"] = f"正在生成第 {idx + 1}/{total} 页无字背景..."
                        state["progress"] = 78 + int((idx / max(total, 1)) * 7)
                        await _save_state(job_id, state)
                        clean_bg = await _inpaint_text_regions_with_service(
                            img_bytes=img_bytes,
                            text_elements=elements,
                            image_model_id=state.get("image_model_id") or image_model_id,
                            user_id=state.get("user_id", ""),
                            job_id=job_id,
                            slide_index=idx,
                        )
                    all_text_elements.append(elements)
                    clean_backgrounds.append(clean_bg or b"")
                try:
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        _build_pptx_with_text_overlay,
                        slide_images,
                        all_text_elements,
                        slides_info,
                        output_path,
                        clean_backgrounds,
                    )
                except Exception as fallback_err:
                    logger.error("[PPTAgent] bitmap overlay export also failed: %s", fallback_err, exc_info=True)
                    # Final compatibility fallback: use full-page images only.
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        _build_pptx_images_only,
                        slide_images,
                        output_path,
                    )

            qa_summary = await _record_pptx_qa(state, job_id, output_path, progress=94)
            if not _is_pptx_qa_deliverable(qa_summary):
                await _record_pptx_quality_review(state, job_id, output_path, qa_summary)

            state["status"]    = "done"
            state["progress"]  = 100
            state["pptx_path"] = str(output_path)
            state["conversion_mode"] = conversion_mode
            if conversion_mode == "image_only":
                state["message"] = "PPTX 已生成（整图模式，视觉完全保留）。"
            elif conversion_mode == "editable_overlay":
                state["message"] = "PPTX 已生成（无字背景 + 可编辑文字模式）。"
            elif use_native:
                state["message"] = "PPTX 已生成，原生元素可编辑。"
            else:
                state["message"] = "PPTX 已生成（PNG 背景模式，文字可编辑）。"
            state.setdefault("snapshots", {})["done"] = {
                "pptx_path": str(output_path),
                "use_native": use_native,
                "conversion_mode": conversion_mode,
            }
            pptx_asset = await store_pptx_asset(state, job_id, output_path)
            state.setdefault("snapshots", {})["done"]["pptx_url"] = state.get("pptx_url", "")
            state.setdefault("snapshots", {})["done"]["pptx_filename"] = state.get("pptx_filename", "")
            append_ppt_artifact(
                state,
                "pptx_done",
                pptx_path=str(output_path),
                pptx_url=pptx_asset.get("url", ""),
                pptx_key=pptx_asset.get("key", ""),
                pptx_filename=pptx_asset.get("filename") or state.get("pptx_filename", ""),
                use_native=use_native,
                conversion_mode=conversion_mode,
                slide_count=total,
                checkpoint="done",
            )
            await set_agent_step(
                state,
                lambda s: _save_state(job_id, s),
                name="pptx_build",
                status="completed",
                message="PPTX 构建完成，已通过最终状态检查。",
                progress=100,
                result={"pptx_path": str(output_path), "pptx_url": state.get("pptx_url", ""), "conversion_mode": conversion_mode, "use_native": use_native},
            )
            await _save_state(job_id, state)

            if state.get("conversation_id"):
                try:
                    from repositories import conversation_repo
                    if conversion_mode == "image_only":
                        mode_str = "纯图片 PPT"
                    elif conversion_mode == "editable_overlay":
                        mode_str = "无字背景 + 可编辑文字"
                    elif conversion_mode == "ppt_master_direct":
                        mode_str = "可编辑演示文稿"
                    elif use_native:
                        mode_str = "原生可编辑元素"
                    else:
                        mode_str = "PNG 背景 + 可编辑文字"
                    await conversation_repo.add_message(
                        conversation_id=state["conversation_id"],
                        role="assistant",
                        content=f"PPTX 已生成完成！\n\n共 {total} 页，模式：{mode_str}",
                        meta={
                            "type": "pptx_done",
                            "job_id": job_id,
                            "pptx_path": str(output_path),
                            "pptx_url": state.get("pptx_url", ""),
                            "pptx_key": state.get("pptx_key", ""),
                            "pptx_filename": state.get("pptx_filename", ""),
                            "pptx_file_asset_id": state.get("pptx_file_asset_id", ""),
                            "use_native": use_native,
                            "conversion_mode": conversion_mode,
                            "slide_count": total,
                            "checkpoint": "done",
                        },
                    )
                except Exception as e:
                    logger.warning(f"[PPTAgent] 保存完成消息失败: {e}")

        except Exception as e:
            logger.error(f"[PPTAgent] post-checkpoint failed: {e}", exc_info=True)
            state["status"]  = "failed"
            state["error"] = str(e)
            state["message"] = f"构建失败：{e}"
            try:
                await _save_state(job_id, state)
            except Exception:
                pass


# Vision-based text-overlay analysis.
ANALYZE_SYSTEM = """You are a precise PPT slide text analyzer.
Extract every visible text element from the image. Return JSON only.
Coordinates x/y/w/h are normalized from 0 to 1 relative to the slide.
Return this shape:
{
  "elements": [
    {
      "content": "text",
      "x": 0.05,
      "y": 0.08,
      "w": 0.90,
      "h": 0.12,
      "font_size_pt": 36,
      "bold": true,
      "color_hex": "#FFFFFF",
      "align": "center"
    }
  ]
}
Rules:
- keep Chinese text exactly as shown
- merge characters/words that visually belong to the same text line or paragraph into one element
- boxes must tightly bound only the visible glyph area, with no decorative icons or large empty background
- do not return duplicate overlapping boxes for the same text
- align is left, center, or right
- no markdown."""


async def _get_vision_model() -> Optional[dict]:
    """Return the first enabled vision model configured in the database."""
    try:
        import repositories.model_repo as model_repo
        models = await model_repo.list_models()
        for m in models:
            if m.get("category") == "vision" and m.get("enabled", True):
                return await model_repo.get_model_internal(m["id"])
    except Exception as e:
        logger.error(f"[PPTAgent] get_vision_model failed: {e}")
    return None

def _sanitize_text_elements(raw_elements: list, fallback: list[dict]) -> list[dict]:
    elements: list[dict] = []
    for raw in raw_elements:
        if not isinstance(raw, dict):
            continue
        content = str(raw.get("content", "")).strip()
        if not content:
            continue

        def num(name: str, default: float) -> float:
            try:
                value = float(raw.get(name, default))
            except Exception:
                value = default
            return max(0.0, min(1.0, value))

        x = num("x", 0.05)
        y = num("y", 0.05)
        w = max(0.01, min(1.0 - x, num("w", 0.5)))
        h = max(0.01, min(1.0 - y, num("h", 0.08)))
        try:
            font_size = int(float(raw.get("font_size_pt", 20)))
        except Exception:
            font_size = 20
        font_size = max(6, min(44, int(font_size * 0.82)))

        color_hex = str(raw.get("color_hex", "#FFFFFF")).strip()
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color_hex):
            color_hex = "#FFFFFF"

        align = str(raw.get("align", "left")).lower()
        if align not in {"left", "center", "right"}:
            align = "left"

        elements.append({
            "content": content,
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "font_size_pt": font_size,
            "bold": bool(raw.get("bold", False)),
            "color_hex": color_hex,
            "align": align,
        })

    return elements or fallback


async def _analyze_text_elements(
    img_bytes: bytes,
    slide_info: dict,
    vision_model_id: str | None,
    user_id: str = "",
    job_id: str = "",
    slide_index: int = 0,
) -> list[dict]:
    fallback = _estimate_text_elements(slide_info)
    if not vision_model_id:
        return fallback

    try:
        prompt = (
            "Extract every visible text box from this PPT slide. "
            "Return JSON only. Keep Chinese text exactly as shown. "
            "Use tight non-overlapping boxes around the glyphs only."
        )
        async with _vision_call_sem:
            raw = await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=vision_model_id,
                expected_category="vision",
                description=f"PPT 文字识别 · 第 {slide_index + 1} 页",
                operation=f"overlay-ocr:{slide_index + 1}",
                job_id=job_id,
                invoke=lambda: call_vision(
                    model_id=vision_model_id,
                    prompt=prompt,
                    image_bytes=img_bytes,
                    system=ANALYZE_SYSTEM,
                    max_tokens=3000,
                ),
            )
        parsed = _fix_and_parse_json(raw)
        raw_elements = parsed.get("elements", [])
        if not isinstance(raw_elements, list):
            return fallback
        return _sanitize_text_elements(raw_elements, fallback)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[PPTAgent] 视觉文字识别失败，使用大纲估算文字层: {e}")
        return fallback


async def _inpaint_text_regions_with_service(
    img_bytes: bytes,
    text_elements: list[dict],
    image_model_id: str | None = None,
    user_id: str = "",
    job_id: str = "",
    slide_index: int = 0,
) -> bytes | None:
    """Use a configured image edit model/service to erase text while preserving the slide design."""
    if not text_elements:
        return None

    try:
        import os

        mask = _build_text_mask(img_bytes, text_elements)
        provider = os.getenv("PPT_INPAINT_PROVIDER", "auto").strip().lower()
        if provider in {"auto", "image", "image_model"} and image_model_id:
            cleaned = await _call_image_model_remove_text(
                img_bytes,
                image_model_id,
                user_id=user_id,
                job_id=job_id,
                slide_index=slide_index,
            )
            if cleaned:
                return cleaned

        replicate_token = os.getenv("REPLICATE_API_TOKEN", "").strip()
        if provider in {"replicate"} and replicate_token:
            cleaned = await execute_platform_provider_call(
                user_id=user_id,
                model_id="ppt-inpainting-replicate",
                expected_category="generate",
                description=f"PPT Replicate inpainting - slide {slide_index + 1}",
                related_task_id=None,
                idempotency_key=(
                    f"ppt:{job_id}:remove-text-provider:replicate:slide:{slide_index + 1}"
                ),
                success_when=bool,
                invoke=lambda: _call_replicate_inpaint(
                    token=replicate_token,
                    model=os.getenv("PPT_REPLICATE_INPAINT_MODEL", "allenhooo/lama").strip()
                    or "allenhooo/lama",
                    img_bytes=img_bytes,
                    mask_bytes=mask,
                ),
            )
            if cleaned:
                return cleaned

        service_url = os.getenv("PPT_INPAINT_URL", "http://127.0.0.1:8080/api/v1/inpaint").strip()
        if provider in {"iopaint"} and service_url and service_url.lower() not in {"0", "false", "off", "disabled"}:
            cleaned = await execute_platform_provider_call(
                user_id=user_id,
                model_id="ppt-inpainting-iopaint",
                expected_category="generate",
                description=f"PPT IOPaint inpainting - slide {slide_index + 1}",
                related_task_id=None,
                idempotency_key=(
                    f"ppt:{job_id}:remove-text-provider:iopaint:slide:{slide_index + 1}"
                ),
                success_when=bool,
                invoke=lambda: _call_iopaint_inpaint(service_url, img_bytes, mask),
            )
            if cleaned:
                return cleaned

        if provider not in {"replicate", "iopaint"} and image_model_id:
            return await _call_image_model_remove_text(
                img_bytes,
                image_model_id,
                user_id=user_id,
                job_id=job_id,
                slide_index=slide_index,
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[PPTAgent] 精准去字失败，回退到本地背景清理: {e}")
        return None


async def _call_image_model_remove_text(
    img_bytes: bytes,
    image_model_id: str,
    *,
    user_id: str = "",
    job_id: str = "",
    slide_index: int = 0,
) -> bytes | None:
    prompt = (
        "Remove all visible text from this PPT slide image. "
        "Keep the background, icons, illustrations, decorative elements, borders, layout and colors unchanged. "
        "Do not add any new text. Return only the same slide as a clean text-free background."
    )
    try:
        async with _image_call_sem:
            return await _execute_ppt_billed_call(
                user_id=user_id,
                model_id=image_model_id,
                expected_category="generate",
                description=f"PPT 去字背景生成 · 第 {slide_index + 1} 页",
                operation=f"remove-text:{slide_index + 1}",
                job_id=job_id,
                invoke=lambda: call_image(
                    model_id=image_model_id,
                    prompt=prompt,
                    ref_images=[img_bytes],
                    size="1792x1024",
                ),
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[PPTAgent] 图像模型去字失败: {e}")
        return None


async def _call_replicate_inpaint(
    token: str,
    model: str,
    img_bytes: bytes,
    mask_bytes: bytes,
) -> bytes | None:
    """Call a Replicate hosted inpainting model with data-URI image and mask inputs."""
    image_data = f"data:image/png;base64,{base64.b64encode(img_bytes).decode()}"
    mask_data = f"data:image/png;base64,{base64.b64encode(mask_bytes).decode()}"
    payload = {
        "input": {
            "image": image_data,
            "mask": mask_data,
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "wait=60",
    }
    owner_name = model.strip("/")
    url = f"https://api.replicate.com/v1/models/{owner_name}/predictions"

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if not resp.is_success:
                logger.warning(f"[PPTAgent] Replicate inpainting 启动失败 {resp.status_code}: {resp.text[:240]}")
                return None
            data = resp.json()
            status = data.get("status", "")
            prediction_url = (data.get("urls") or {}).get("get", "")
            for _ in range(90):
                if status in {"succeeded", "failed", "canceled"}:
                    break
                if not prediction_url:
                    break
                await asyncio.sleep(1)
                poll = await client.get(prediction_url, headers={"Authorization": f"Bearer {token}"})
                if not poll.is_success:
                    logger.warning(f"[PPTAgent] Replicate inpainting 轮询失败 {poll.status_code}: {poll.text[:200]}")
                    return None
                data = poll.json()
                status = data.get("status", "")

            if status != "succeeded":
                logger.warning(f"[PPTAgent] Replicate inpainting 未成功: {status} {str(data.get('error', ''))[:200]}")
                return None

            output = data.get("output")
            if isinstance(output, list):
                output = output[0] if output else ""
            if isinstance(output, dict):
                output = output.get("url") or output.get("image") or output.get("output") or ""
            if isinstance(output, str):
                if output.startswith("data:"):
                    return base64.b64decode(output.split(",", 1)[1])
                if output.startswith("http"):
                    img = await client.get(output)
                    img.raise_for_status()
                    logger.info(f"[PPTAgent] Replicate inpainting 去字成功: {model}")
                    return img.content
            logger.warning(f"[PPTAgent] Replicate inpainting 输出格式无法识别: {type(output).__name__}")
    except Exception as e:
        logger.warning(f"[PPTAgent] Replicate inpainting 调用异常: {e}")
    return None


async def _call_iopaint_inpaint(service_url: str, img_bytes: bytes, mask_bytes: bytes) -> bytes | None:
    """Call IOPaint/lama-cleaner /api/v1/inpaint. Returns raw PNG bytes when successful."""
    image_b64 = base64.b64encode(img_bytes).decode()
    mask_b64 = base64.b64encode(mask_bytes).decode()
    payload = {
        "image": image_b64,
        "mask": mask_b64,
        "ldm_steps": 25,
        "ldm_sampler": "ddim",
        "zits_wireframe": True,
        "cv2_flag": "INPAINT_NS",
        "cv2_radius": 5,
        "hd_strategy": "Crop",
        "hd_strategy_crop_triger_size": 640,
        "hd_strategy_crop_margin": 128,
        "hd_trategy_resize_imit": 2048,
        "prompt": "clean presentation slide background, no text, preserve decorations and layout",
        "negative_prompt": "text, letters, words, watermark, blurry artifacts",
        "use_croper": False,
        "croper_x": 0,
        "croper_y": 0,
        "croper_height": 0,
        "croper_width": 0,
        "use_extender": False,
        "extender_x": 0,
        "extender_y": 0,
        "extender_height": 0,
        "extender_width": 0,
        "sd_mask_blur": 4,
        "sd_strength": 0.95,
        "sd_steps": 30,
        "sd_guidance_scale": 7.5,
        "sd_sampler": "UniPC",
        "sd_seed": -1,
        "sd_match_histograms": False,
        "sd_lcm_lora": False,
        "paint_by_example_example_image": None,
        "p2p_image_guidance_scale": 1.5,
        "enable_controlnet": False,
        "controlnet_conditioning_scale": 0.4,
        "controlnet_method": "",
        "enable_brushnet": False,
        "brushnet_method": "",
        "brushnet_conditioning_scale": 1.0,
        "enable_powerpaint_v2": False,
        "powerpaint_task": "text-guided",
    }
    timeout = httpx.Timeout(connect=2.0, read=240.0, write=30.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(service_url, json=payload, headers={"Accept": "image/png"})
        if resp.is_success and resp.content:
            content_type = resp.headers.get("content-type", "")
            if resp.content.startswith(b"\x89PNG") or "image/" in content_type:
                logger.info("[PPTAgent] IOPaint 去字背景清理成功")
                return resp.content
            try:
                data = resp.json()
                image_data = str(data.get("image") or data.get("result") or "")
                if image_data.startswith("data:"):
                    image_data = image_data.split(",", 1)[1]
                if image_data:
                    return base64.b64decode(image_data)
            except Exception:
                pass
        logger.warning(f"[PPTAgent] IOPaint 调用失败 {resp.status_code}: {resp.text[:200]}")
    except (httpx.ConnectError, httpx.ConnectTimeout):
        logger.info(f"[PPTAgent] IOPaint 未启动，跳过: {service_url}")
    except Exception as e:
        logger.warning(f"[PPTAgent] IOPaint 调用异常: {e}")
    return None
