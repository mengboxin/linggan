"""Canonical PPT workspace and artifact helpers.

PPT routes and agents persist several generations of the same shape: image
slide decks, direct SVG decks, artifacts, and compact history snapshots. This
module is the small interface for turning those durable records into one
workspace shape without duplicating versions every time history is restored.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Callable

DEFAULT_CONVERSION_MODE = "ppt_master_direct"
CONVERSION_MODES = {"ppt_master_direct", "image_only", "editable_overlay", "native_svg"}


def normalize_conversion_mode(mode: str | None) -> str:
    value = (mode or DEFAULT_CONVERSION_MODE).strip()
    return value if value in CONVERSION_MODES else DEFAULT_CONVERSION_MODE


def strip_data_url(raw: object) -> str:
    value = str(raw or "").strip()
    if value.startswith("data:") and "," in value:
        value = value.split(",", 1)[1]
    return value


def _clamp_index(value: object, max_index: int, default: int = 0) -> int:
    try:
        idx = int(value)
    except Exception:
        idx = default
    return min(max(idx, 0), max(max_index, 0))


def _outline_slides(outline: dict) -> list:
    return outline.get("slides", []) if isinstance(outline, dict) else []


def _slide_title(idx: int) -> str:
    return f"Page {idx + 1}"


def serialize_direct_slide(deck: dict, idx: int) -> dict:
    versions = [strip_data_url(v) for v in (deck.get("versions") or [])]
    versions = [v for v in versions if v]
    selected = _clamp_index(
        deck.get("selected_version_index", deck.get("selectedVersionIndex", 0)),
        len(versions) - 1,
    )
    slide_info = dict(deck.get("slide") or {})
    title = str(deck.get("title") or slide_info.get("title") or _slide_title(idx))
    slide_info["page"] = idx + 1
    slide_info["title"] = title
    return {
        "id": deck.get("id") or f"direct-slide-{idx + 1}",
        "title": title,
        "prompt": deck.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "",
        "kind": "svg",
        "versions": versions,
        "selectedVersionIndex": selected,
        "slide": slide_info,
        "slide_index": idx,
        "svg_b64": versions[selected] if versions else "",
    }


def serialize_direct_slide_manifest(deck: dict, idx: int) -> dict:
    """Return direct-slide editor metadata without serializing its SVG bytes.

    Direct decks can embed high-resolution visual material inside an SVG.  A
    history open only needs the page identity, title and selected version; the
    SVG itself is fetched page-by-page after the workspace is visible.
    """
    raw_versions = deck.get("versions") or []
    version_count = len(raw_versions) if isinstance(raw_versions, list) else 0
    if not version_count and deck.get("svg_b64"):
        version_count = 1
    selected = _clamp_index(
        deck.get("selected_version_index", deck.get("selectedVersionIndex", 0)),
        version_count - 1,
    )
    slide_info = dict(deck.get("slide") or {})
    title = str(deck.get("title") or slide_info.get("title") or _slide_title(idx))
    slide_info["page"] = idx + 1
    slide_info["title"] = title
    return {
        "id": deck.get("id") or f"direct-slide-{idx + 1}",
        "title": title,
        "prompt": deck.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "",
        "kind": "svg",
        "selectedVersionIndex": selected,
        "slide": slide_info,
        "slide_index": idx,
        "version_count": version_count,
        "deferred": True,
    }


def _compact_workspace_artifacts(artifacts: object) -> list[dict]:
    """Keep history metadata useful while never echoing embedded slide bytes."""
    if not isinstance(artifacts, list):
        return []
    omitted_keys = {
        "preview_b64", "preview_b64_list", "image_b64", "image_b64s",
        "images", "svg_b64", "versions", "slide_decks", "direct_slide_decks", "slides",
    }
    compact: list[dict] = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        item = {key: value for key, value in artifact.items() if key not in omitted_keys}
        for key in omitted_keys:
            value = artifact.get(key)
            if isinstance(value, list):
                item[f"{key}_count"] = len(value)
        compact.append(item)
    return compact


def selected_images_from_decks(decks: list[dict]) -> list[str]:
    selected_images: list[str] = []
    for deck in decks:
        versions = [strip_data_url(v) for v in (deck.get("versions") or [])]
        versions = [v for v in versions if v]
        if not versions:
            continue
        selected_idx = _clamp_index(
            deck.get("selectedVersionIndex", deck.get("selected_version_index", 0)),
            len(versions) - 1,
        )
        selected_images.append(versions[selected_idx])
    return selected_images


def image_decks_to_outline(state: dict, decks: list[dict]) -> dict:
    outline = dict(state.get("outline") or {})
    outline.setdefault("title", state.get("topic") or "PPT")
    outline.setdefault("style", state.get("style_hint") or "")
    outline.setdefault("color_scheme", "")
    slides: list[dict] = []
    for idx, deck in enumerate(decks):
        slide_info = dict(deck.get("slide") or {})
        title = str(deck.get("title") or slide_info.get("title") or _slide_title(idx))
        prompt = str(deck.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        slide_info.setdefault("type", "cover" if idx == 0 else "content")
        slide_info.setdefault("points", [prompt] if prompt else [])
        if prompt:
            slide_info["prompt"] = prompt
            slide_info.setdefault("layout_hint", prompt)
        slides.append(slide_info)
    outline["slides"] = slides
    return outline


def pptx_versions_from_artifacts(state: dict, job_id: str, default_slide_count: int) -> list[dict]:
    versions: list[dict] = []
    for artifact in state.get("artifacts", []) or []:
        if not isinstance(artifact, dict) or artifact.get("type") != "pptx_done":
            continue
        versions.append({
            "version": len(versions) + 1,
            "slide_count": int(artifact.get("slide_count") or default_slide_count or 0),
            "created_at": str(artifact.get("created_at") or ""),
            "job_id": str(artifact.get("job_id") or job_id),
            "pptx_filename": str(artifact.get("pptx_filename") or state.get("pptx_filename") or ""),
        })
    return versions[-1:] if versions else []


def slide_decks_from_meta(meta: dict) -> list[dict]:
    decks = meta.get("slide_decks") or meta.get("direct_slide_decks") or meta.get("slides")
    if isinstance(decks, list) and all(isinstance(item, dict) for item in decks):
        return decks
    versions = meta.get("versions")
    if isinstance(versions, list) and versions:
        return [{
            "id": str(meta.get("id") or "slide-1"),
            "title": str(meta.get("title") or _slide_title(0)),
            "prompt": str(meta.get("prompt") or ""),
            "kind": "svg" if meta.get("svg_b64") else "image",
            "versions": versions,
            "selectedVersionIndex": int(meta.get("selectedVersionIndex") or meta.get("selected_version_index") or 0),
            "slide": meta.get("slide") if isinstance(meta.get("slide"), dict) else {},
        }]
    return []


def _merge_version(versions: list[str], candidate: str) -> tuple[list[str], int]:
    clean_versions = [strip_data_url(v) for v in versions]
    clean_versions = [v for v in clean_versions if v]
    candidate = strip_data_url(candidate)
    if not candidate:
        return clean_versions, _clamp_index(0, len(clean_versions) - 1)
    if candidate not in clean_versions:
        clean_versions.append(candidate)
    return clean_versions, clean_versions.index(candidate)


def apply_direct_artifacts_to_decks(decks: list[dict], artifacts: list[dict], outline: dict) -> list[dict]:
    merged = [dict(deck) for deck in decks if isinstance(deck, dict)]
    outline_slides = _outline_slides(outline)
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        artifact_type = str(artifact.get("type") or "")
        if artifact_type not in ("direct_slide_version", "direct_slide_added"):
            continue
        svg = strip_data_url(artifact.get("svg_b64") or artifact.get("image_b64") or artifact.get("preview_b64"))
        if not svg:
            continue
        slide_index = _clamp_index(artifact.get("slide_index", len(merged)), len(merged), len(merged))
        prompt = str(artifact.get("prompt") or "")
        if artifact_type == "direct_slide_version" and 0 <= slide_index < len(merged):
            versions, selected = _merge_version(list(merged[slide_index].get("versions") or []), svg)
            merged[slide_index] = {
                **merged[slide_index],
                "prompt": prompt or str(merged[slide_index].get("prompt") or ""),
                "versions": versions,
                "selected_version_index": selected,
                "selectedVersionIndex": selected,
            }
        elif artifact_type == "direct_slide_added":
            if any(svg in [strip_data_url(v) for v in (deck.get("versions") or [])] for deck in merged):
                continue
            insert_at = min(max(slide_index, 0), len(merged))
            slide_info = (
                dict(outline_slides[insert_at])
                if insert_at < len(outline_slides) and isinstance(outline_slides[insert_at], dict)
                else {}
            )
            title = str(artifact.get("title") or slide_info.get("title") or f"New slide {insert_at + 1}")
            merged.insert(insert_at, {
                "id": str(artifact.get("id") or f"direct-slide-added-{insert_at + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "svg",
                "versions": [svg],
                "selected_version_index": 0,
                "selectedVersionIndex": 0,
                "slide": {
                    **slide_info,
                    "page": insert_at + 1,
                    "title": title,
                    "prompt": prompt or slide_info.get("prompt") or slide_info.get("layout_hint") or "",
                },
            })

    for idx, deck in enumerate(merged):
        slide_info = dict(deck.get("slide") or {})
        title = str(deck.get("title") or slide_info.get("title") or _slide_title(idx))
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        merged[idx] = {**deck, "title": title, "kind": "svg", "slide": slide_info}
    return merged


def image_decks_from_images(images: list[str], outline: dict) -> list[dict]:
    outline_slides = _outline_slides(outline)
    decks: list[dict] = []
    for idx, image in enumerate(images):
        raw = strip_data_url(image)
        if not raw:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        title = str(slide_info.get("title") or _slide_title(idx))
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        decks.append({
            "id": f"slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "image",
            "versions": [raw],
            "selectedVersionIndex": 0,
            "slide": {**slide_info, "page": idx + 1, "title": title},
        })
    return decks


def direct_decks_from_artifacts(artifacts: list[dict], outline: dict) -> list[dict]:
    latest = next(
        (
            artifact for artifact in reversed(artifacts)
            if isinstance(artifact, dict)
            and artifact.get("conversion_mode") == "ppt_master_direct"
            and isinstance(artifact.get("project_dir"), str)
        ),
        None,
    )
    if not latest:
        return []
    svg_dir = Path(str(latest.get("project_dir") or "")) / "svg_output"
    if not svg_dir.exists():
        return []
    outline_slides = _outline_slides(outline)
    decks: list[dict] = []
    for idx, svg_path in enumerate(sorted(svg_dir.glob("*.svg"))):
        try:
            svg_b64 = base64.b64encode(svg_path.read_bytes()).decode("ascii")
        except Exception:
            continue
        slide_info = dict(outline_slides[idx]) if idx < len(outline_slides) and isinstance(outline_slides[idx], dict) else {}
        title = str(slide_info.get("title") or _slide_title(idx))
        prompt = str(slide_info.get("prompt") or slide_info.get("layout_hint") or "")
        slide_info["page"] = idx + 1
        slide_info["title"] = title
        decks.append({
            "id": f"direct-slide-{idx + 1}",
            "title": title,
            "prompt": prompt,
            "kind": "svg",
            "versions": [svg_b64],
            "selected_version_index": 0,
            "selectedVersionIndex": 0,
            "slide": slide_info,
        })
    return decks


def serialize_image_slide_decks(state: dict) -> list[dict]:
    outline = state.get("outline") or {}
    outline_slides = _outline_slides(outline)
    raw_decks = state.get("image_slide_decks")
    decks: list[dict] = []

    if isinstance(raw_decks, list) and raw_decks:
        for idx, item in enumerate(raw_decks):
            if not isinstance(item, dict):
                continue
            versions = [strip_data_url(v) for v in (item.get("versions") or [])]
            versions = [v for v in versions if v]
            if not versions:
                continue
            slide_info = item.get("slide") if isinstance(item.get("slide"), dict) else {}
            if not slide_info and idx < len(outline_slides) and isinstance(outline_slides[idx], dict):
                slide_info = dict(outline_slides[idx])
            selected_idx = _clamp_index(
                item.get("selectedVersionIndex", item.get("selected_version_index", 0)),
                len(versions) - 1,
            )
            title = str(item.get("title") or slide_info.get("title") or _slide_title(idx))
            prompt = str(item.get("prompt") or slide_info.get("prompt") or slide_info.get("layout_hint") or "")
            decks.append({
                "id": str(item.get("id") or f"slide-{idx + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "image",
                "versions": versions,
                "selectedVersionIndex": selected_idx,
                "slide": {**dict(slide_info), "page": idx + 1, "title": title},
            })

    if not decks:
        decks = image_decks_from_images(state.get("slide_images_b64", []) or [], outline)

    for artifact in state.get("artifacts", []) or []:
        if not isinstance(artifact, dict):
            continue
        artifact_type = artifact.get("type")
        if artifact_type not in ("slide_version", "slide_added"):
            continue
        img = strip_data_url(artifact.get("image_b64") or artifact.get("preview_b64"))
        if not img:
            continue
        slide_index = _clamp_index(artifact.get("slide_index", len(decks)), len(decks), len(decks))
        if artifact_type == "slide_version" and 0 <= slide_index < len(decks):
            versions, selected = _merge_version(list(decks[slide_index].get("versions") or []), img)
            decks[slide_index] = {
                **decks[slide_index],
                "prompt": str(artifact.get("prompt") or decks[slide_index].get("prompt") or ""),
                "versions": versions,
                "selectedVersionIndex": selected,
            }
        elif artifact_type == "slide_added":
            if any(img in (deck.get("versions") or []) for deck in decks):
                continue
            insert_at = min(max(slide_index, 0), len(decks))
            title = str(artifact.get("title") or f"New slide {insert_at + 1}")
            prompt = str(artifact.get("prompt") or "")
            decks.insert(insert_at, {
                "id": str(artifact.get("id") or f"slide-added-{insert_at + 1}"),
                "title": title,
                "prompt": prompt,
                "kind": "image",
                "versions": [img],
                "selectedVersionIndex": 0,
                "slide": {
                    "page": insert_at + 1,
                    "type": "content",
                    "title": title,
                    "points": [prompt] if prompt else [],
                    "layout_hint": prompt,
                    "prompt": prompt,
                },
            })

    for idx, deck in enumerate(decks):
        slide_info = dict(deck.get("slide") or {})
        slide_info["page"] = idx + 1
        decks[idx] = {**deck, "slide": slide_info}
    return decks


def extract_job_id_from_meta(meta: dict) -> str:
    if not isinstance(meta, dict):
        return ""
    job_id = meta.get("job_id")
    if isinstance(job_id, str) and job_id:
        return job_id
    artifacts = meta.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in reversed(artifacts):
            if isinstance(artifact, dict) and isinstance(artifact.get("job_id"), str) and artifact.get("job_id"):
                return artifact["job_id"]
    return ""


def workspace_state_from_messages(messages: list[dict], conversation_id: str) -> dict | None:
    job_id = ""
    outline: dict = {}
    conversion_mode = DEFAULT_CONVERSION_MODE
    status = "checkpoint"
    progress = 50
    message = "Loaded PPT workspace from history."
    artifacts: list[dict] = []
    image_decks: list[dict] = []
    direct_decks: list[dict] = []
    slide_images: list[str] = []
    pptx_path = ""
    pptx_url = ""
    pptx_key = ""
    latest_slide_count = 0
    template_id = ""
    is_light_history = False

    for msg in messages:
        meta = msg.get("meta") or {}
        if not isinstance(meta, dict):
            continue
        is_light_history = is_light_history or bool(meta.get("_light"))
        job_id = extract_job_id_from_meta(meta) or job_id
        if isinstance(meta.get("outline"), dict):
            outline = meta["outline"]
        template_id = str(meta.get("template_id") or template_id or "").strip()
        conversion_mode = normalize_conversion_mode(str(meta.get("conversion_mode") or conversion_mode or DEFAULT_CONVERSION_MODE))

        nested_artifacts = meta.get("artifacts")
        if isinstance(nested_artifacts, list):
            artifacts.extend([item for item in nested_artifacts if isinstance(item, dict)])
        if meta.get("type"):
            artifacts.append(meta)

        meta_type = str(meta.get("type") or "")
        if meta_type == "outline":
            status = "outline_done"
            progress = 20
            message = "已从历史记录恢复 PPT 大纲，请确认后继续生成。"
        decks = slide_decks_from_meta(meta)
        if decks:
            is_direct = (
                conversion_mode == "ppt_master_direct"
                or meta_type.startswith("direct_")
                or any(deck.get("kind") == "svg" for deck in decks)
            )
            is_full_snapshot = (
                meta_type in {"slides_preview", "selected_slides", "slides_sync", "direct_slides_sync", "pptx_done", "ppt_master_direct"}
                or bool(meta.get("slide_decks") or meta.get("direct_slide_decks") or meta.get("slides"))
                or len(decks) > 1
            )
            if is_direct:
                if is_full_snapshot and (not direct_decks or len(decks) >= len(direct_decks)):
                    direct_decks = decks
                conversion_mode = "ppt_master_direct"
            elif is_full_snapshot and (not image_decks or len(decks) >= len(image_decks)):
                image_decks = decks

        images = meta.get("preview_b64_list")
        if isinstance(images, list) and images:
            candidate_images = [strip_data_url(item) for item in images if str(item or "").strip()]
            if meta_type == "selected_slides" or not slide_images or len(candidate_images) >= len(slide_images):
                slide_images = candidate_images
        elif isinstance(meta.get("preview_b64"), str) and meta.get("preview_b64") and not slide_images:
            slide_images = [strip_data_url(meta["preview_b64"])]
        try:
            latest_slide_count = max(latest_slide_count, int(meta.get("slide_count") or 0))
        except Exception:
            pass
        if meta_type == "pptx_done":
            status = "done"
            progress = 100
            message = "PPTX generation completed."
            pptx_path = str(meta.get("pptx_path") or pptx_path or "")
            pptx_url = str(meta.get("pptx_url") or pptx_url or "")
            pptx_key = str(meta.get("pptx_key") or pptx_key or "")

    if not job_id:
        return None
    if not direct_decks and conversion_mode == "ppt_master_direct" and not is_light_history:
        direct_decks = direct_decks_from_artifacts(artifacts, outline)
    if direct_decks:
        direct_decks = apply_direct_artifacts_to_decks(direct_decks, artifacts, outline)
        if status == "checkpoint":
            # Direct-slide workspaces have already completed page production;
            # export is an optional packaging action, not the remaining 50%.
            progress = 100
            message = "全部可编辑页面已完成，可继续编辑或导出 PPT。"
    if not image_decks and slide_images:
        image_decks = image_decks_from_images(slide_images, outline)
    if image_decks:
        image_decks = serialize_image_slide_decks({**dict(outline=outline), "image_slide_decks": image_decks, "artifacts": artifacts})
    has_workspace = bool(outline or direct_decks or image_decks or slide_images or latest_slide_count or pptx_path or pptx_url or pptx_key)
    if not has_workspace:
        return None
    return {
        "job_id": job_id,
        "conversation_id": conversation_id,
        "status": status,
        "progress": progress,
        "message": message,
        "outline": outline,
        "template_id": template_id or str((outline.get("template") or {}).get("id") or "") if isinstance(outline, dict) else template_id,
        "conversion_mode": "ppt_master_direct" if direct_decks else conversion_mode,
        "direct_slide_decks": direct_decks,
        "image_slide_decks": image_decks,
        "slide_images_b64": slide_images,
        "artifacts": artifacts,
        "pptx_path": pptx_path,
        "pptx_url": pptx_url,
        "pptx_key": pptx_key,
    }


def pptx_ready_from_state(state: dict) -> bool:
    pptx_path = str(state.get("pptx_path") or "").strip()
    return bool(
        (Path(pptx_path).exists() if pptx_path else False)
        or state.get("pptx_key")
        or state.get("pptx_url")
    )


def workspace_payload_from_state(
    state: dict,
    job_id: str,
    messages: list[dict] | None = None,
    *,
    clean_agent_steps: Callable[[list], list] | None = None,
    workspace_phase: Callable[[str], str] | None = None,
    chat_messages_from_history: Callable[[list[dict]], list[dict]] | None = None,
    include_direct_slide_content: bool = True,
) -> dict:
    raw_mode = str(state.get("conversion_mode") or "").strip()
    mode = normalize_conversion_mode(raw_mode)
    # Historical image workspaces predate the explicit conversion-mode field.
    # Do not reinterpret their saved image decks as empty direct-SVG decks just
    # because the current product default is the editable presentation mode.
    if not raw_mode and not state.get("direct_slide_decks") and (
        state.get("image_slide_decks") or state.get("slide_images_b64")
    ):
        mode = "image_only"
    defer_direct_slide_content = mode == "ppt_master_direct" and not include_direct_slide_content
    if mode == "ppt_master_direct":
        serializer = serialize_direct_slide if include_direct_slide_content else serialize_direct_slide_manifest
        slide_decks = [serializer(deck, idx) for idx, deck in enumerate(state.get("direct_slide_decks") or [])]
        selected_images: list[str] = []
    else:
        slide_decks = serialize_image_slide_decks(state)
        selected_images = selected_images_from_decks(slide_decks)
    slide_count = len(slide_decks) if mode == "ppt_master_direct" else len(selected_images)
    outline = state.get("outline") or {}
    outline_slides = _outline_slides(outline)
    pptx_ready = pptx_ready_from_state(state)
    steps = state.get("agent_steps", [])
    if clean_agent_steps:
        steps = clean_agent_steps(steps)
    chat_messages = chat_messages_from_history(messages or []) if chat_messages_from_history else []
    status = state.get("status") or ("done" if pptx_ready else "checkpoint")
    progress = state.get("progress", 100 if pptx_ready else 50)
    if mode == "ppt_master_direct" and slide_count and status == "checkpoint" and not state.get("pending_slide_task"):
        # Backfill workspaces saved before direct-page completion used a hard
        # coded 50/82 percent checkpoint.
        progress = 100
    return {
        "job_id": job_id,
        "conversation_id": state.get("conversation_id"),
        "status": status,
        "phase": workspace_phase(str(status)) if workspace_phase else str(status),
        "progress": progress,
        "message": state.get("message") or "Loaded PPT workspace.",
        "error": state.get("error", ""),
        "outline": outline or None,
        "template_id": state.get("template_id") or str((outline.get("template") or {}).get("id") or ""),
        "conversion_mode": mode,
        "slide_decks": slide_decks,
        "direct_slide_decks": slide_decks if mode == "ppt_master_direct" else [],
        "slide_images": selected_images,
        "slide_count": slide_count,
        "slide_total": len(outline_slides or []) or slide_count,
        "agent_steps": steps,
        "artifacts": _compact_workspace_artifacts(state.get("artifacts", [])) if defer_direct_slide_content else state.get("artifacts", []),
        "slide_content_deferred": defer_direct_slide_content,
        "pptx_ready": pptx_ready,
        "pptx_path": state.get("pptx_path", "") if pptx_ready else "",
        "pptx_url": state.get("pptx_url", "") if pptx_ready else "",
        "pptx_filename": state.get("pptx_filename", "") if pptx_ready else "",
        "pptx_versions": pptx_versions_from_artifacts(state, job_id, slide_count),
        "messages": messages or [],
        "chat_messages": chat_messages,
    }


def workspace_payload_has_renderable_slides(payload: dict | None) -> bool:
    if not isinstance(payload, dict):
        return False
    return bool(
        payload.get("slide_decks")
        or payload.get("direct_slide_decks")
        or payload.get("slide_images")
    )
