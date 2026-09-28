"""Durable history artifact helpers.

History records are persisted as conversation message metadata. This module is
the small interface that turns those durable meta blobs into listable artifacts
for web and mobile clients.
"""

from __future__ import annotations

import base64
import binascii
import copy
import json
from io import BytesIO
from typing import Any

from PIL import Image
from services import asset_storage

TEXT_TO_IMAGE_SOURCES = {
    "web",
    "web-bottom",
    "desktop",
    "mobile",
    "conversation-canvas",
    "mobile_retouch_image2_shortcut",
}

IMAGE_EDIT_HISTORY_SOURCES = {
    "image2_shortcut",
    "desktop_image2_shortcut",
    "workflow_edit",
    "web_workflow_edit",
    "desktop_workflow_edit",
    "mobile_workflow_edit",
    "workflow_text",
    "desktop_workflow_text",
}


def normalize_meta_value(value: Any) -> dict:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return value if isinstance(value, dict) else {}


def _summary_text(meta: dict, *keys: str) -> str:
    for key in keys:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _is_inline_image_data(value: Any) -> bool:
    return isinstance(value, str) and value.lstrip().lower().startswith("data:image/")


def _poster_history_projection(posters: Any) -> list[dict]:
    """Keep the poster editor's version graph without shipping inline image bytes."""
    if not isinstance(posters, list):
        return []

    compact: list[dict] = []
    poster_keys = (
        "id", "poster_index", "number", "title", "selected_version_index",
        "generation_status", "generation_progress", "generation_message", "generation_error",
        "refine_status", "refine_progress", "refine_message", "refine_error",
    )
    for poster in posters[:5]:
        if not isinstance(poster, dict):
            continue
        item = {}
        for key in poster_keys:
            value = poster.get(key)
            if value in (None, ""):
                continue
            item[key] = value[:320] if isinstance(value, str) else value
        versions: list[dict] = []
        for version in poster.get("versions", [])[:8]:
            if not isinstance(version, dict):
                continue
            compact_version = {}
            for key in ("id", "posterIndex", "number", "title", "createdAt"):
                value = version.get(key)
                if value not in (None, ""):
                    compact_version[key] = value[:320] if isinstance(value, str) else value
            asset_id = version.get("assetId") or version.get("asset_id")
            if isinstance(asset_id, str) and asset_id:
                compact_version["assetId"] = asset_id
            else:
                for key in ("previewUrl", "preview_url", "imageUrl", "image_url", "renderedUrl", "thumbnailUrl", "thumbnail_url"):
                    value = version.get(key)
                    if isinstance(value, str) and value and not _is_inline_image_data(value):
                        compact_version["previewUrl"] = value[:2048]
                        break
            has_asset_reference = bool(asset_id or compact_version.get("previewUrl"))
            if any(version.get(key) for key in ("renderedB64", "rendered_b64", "imageBase64", "image_b64")) and not has_asset_reference:
                compact_version["legacy_inline_artifact"] = True
            if compact_version:
                versions.append(compact_version)
        if versions:
            item["versions"] = versions
        compact.append(item)
    return compact


def message_history_summary(meta: dict | None) -> dict:
    """Small list-card projection. History indexes must not read toasted message meta."""
    source = meta if isinstance(meta, dict) else {}
    summary = {
        "type": _summary_text(source, "type"),
        "source": _summary_text(source, "source"),
        "status": _summary_text(source, "status"),
        "error": _summary_text(source, "error"),
        "job_id": _summary_text(source, "job_id", "task_id"),
        "task_id": _summary_text(source, "task_id"),
        "asset_id": _summary_text(source, "asset_id"),
        "image_url": _summary_text(source, "image_url"),
        "preview_url": _summary_text(source, "preview_url"),
        "thumbnail_url": _summary_text(source, "thumbnail_url", "thumb_url"),
        "local_file_path": _summary_text(source, "local_file_path"),
        "local_image_url": _summary_text(source, "local_image_url"),
        "gen_mode": _summary_text(source, "gen_mode"),
        "category": _summary_text(source, "category"),
        "style_preset": _summary_text(source, "style_preset"),
        "output_format": _summary_text(source, "output_format"),
    }
    posters = source.get("posters")
    if isinstance(posters, list) and posters:
        summary["poster_count"] = len(posters)
        summary["has_artifact"] = True
        summary["posters"] = _poster_history_projection(posters)
        summary["poster_projection_version"] = 2
    elif source.get("poster_count") not in (None, "", 0, "0"):
        try:
            summary["poster_count"] = int(source.get("poster_count") or 0)
        except (TypeError, ValueError):
            pass
    poster_asset = poster_history_asset(source)
    if poster_asset.get("asset_id") or poster_asset.get("image_url") or poster_asset.get("preview_url") or poster_asset.get("thumbnail_url"):
        summary["has_artifact"] = True
        summary["asset_id"] = summary["asset_id"] or poster_asset.get("asset_id") or ""
        summary["image_url"] = summary["image_url"] or poster_asset.get("image_url") or ""
        summary["preview_url"] = summary["preview_url"] or poster_asset.get("preview_url") or ""
        summary["thumbnail_url"] = summary["thumbnail_url"] or poster_asset.get("thumbnail_url") or ""
    if isinstance(posters, list):
        # Inline bytes are recoverable only after an explicit detail-open request.
        for key in ("image_url", "preview_url", "thumbnail_url"):
            if _is_inline_image_data(summary.get(key)):
                summary.pop(key, None)
    sci_asset = sci_fig_history_asset(source)
    if sci_asset.get("asset_id") or sci_asset.get("image_url") or sci_asset.get("preview_url") or sci_asset.get("thumbnail_url"):
        summary["has_artifact"] = True
        summary["asset_id"] = summary["asset_id"] or sci_asset.get("asset_id") or ""
        summary["image_url"] = summary["image_url"] or sci_asset.get("image_url") or ""
        summary["preview_url"] = summary["preview_url"] or sci_asset.get("preview_url") or ""
        summary["thumbnail_url"] = summary["thumbnail_url"] or sci_asset.get("thumbnail_url") or ""
    if source.get("has_artifact"):
        summary["has_artifact"] = True
    return {key: value for key, value in summary.items() if value not in ("", None, False, 0)}


def lightweight_meta(meta: dict) -> dict:
    if not isinstance(meta, dict):
        return {}
    light = copy.deepcopy(meta)

    def trim_item(item):
        if not isinstance(item, dict):
            return item
        trimmed = dict(item)
        for key in (
            "preview_b64",
            "preview_b64_list",
            "image_b64",
            "image_b64s",
            "images",
            "svg_b64",
            "versions",
            "slide_decks",
            "direct_slide_decks",
            "slides",
        ):
            if key in trimmed:
                value = trimmed.pop(key)
                if isinstance(value, list):
                    trimmed[f"{key}_count"] = len(value)
                elif isinstance(value, str) and value:
                    trimmed[f"{key}_omitted"] = True
        for key in (
            "asset_id",
            "image_url",
            "preview_url",
            "thumbnail_url",
            "thumb_url",
            "original_url",
            "local_file_path",
            "local_image_url",
        ):
            if key in item:
                trimmed[key] = item[key]
        return trimmed

    light = trim_item(light)
    artifacts = light.get("artifacts")
    if isinstance(artifacts, list):
        light["artifacts"] = [trim_item(item) for item in artifacts]
    light["_light"] = True
    return light


def first_image_from_meta(meta: dict) -> str:
    if not isinstance(meta, dict):
        return ""
    candidates = [
        meta.get("local_image_url"),
        meta.get("image_url"),
        meta.get("image_b64"),
        meta.get("preview_url"),
        meta.get("preview_b64"),
        meta.get("generated_image"),
        meta.get("result_image"),
    ]
    for key in ("images", "image_urls", "image_b64s"):
        value = meta.get(key)
        if isinstance(value, list):
            candidates.extend(value)
    for key in ("result", "output", "data"):
        value = meta.get(key)
        if isinstance(value, dict):
            nested = first_image_from_meta(value)
            if nested:
                candidates.append(nested)
    for image in candidates:
        if isinstance(image, str) and image.strip():
            return image.strip()
    return ""


def asset_urls_from_meta(meta: dict) -> dict:
    if not isinstance(meta, dict):
        return {}
    urls = asset_storage.client_image_asset_urls(meta)
    if not urls.get("image_url") and meta.get("local_image_url"):
        urls["image_url"] = meta.get("local_image_url")
    if not urls.get("preview_url"):
        urls["preview_url"] = urls.get("image_url") or ""
    if not urls.get("thumbnail_url"):
        urls["thumbnail_url"] = urls.get("preview_url") or ""
    return {
        **urls,
        "local_file_path": meta.get("local_file_path") or "",
        "local_image_url": meta.get("local_image_url") or "",
    }


def thumbnail_image(image: str, max_px: int = 180, quality: int = 70) -> str:
    raw = str(image or "").split(",", 1)[-1]
    if not raw:
        return ""
    try:
        image_bytes = base64.b64decode(raw, validate=False)
        with Image.open(BytesIO(image_bytes)) as img:
            img = img.convert("RGB")
            img.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
            out = BytesIO()
            img.save(out, format="WEBP", quality=quality, method=4)
        return "data:image/webp;base64," + base64.b64encode(out.getvalue()).decode("ascii")
    except (binascii.Error, OSError, ValueError):
        if len(raw) <= 24000:
            return image
        return ""


def _is_image_edit_history(source: str, request_source: str, prompt: str) -> bool:
    if source in IMAGE_EDIT_HISTORY_SOURCES or request_source in IMAGE_EDIT_HISTORY_SOURCES:
        return True
    text = str(prompt or "")
    return text.startswith("REFERENCE IMAGE CONTRACT") or "User edit request:" in text


def image_history_item(row: dict) -> dict | None:
    meta = normalize_meta_value(row.get("meta"))
    request_meta = normalize_meta_value(row.get("request_meta"))
    source = str(meta.get("source") or "")
    request_source = str(request_meta.get("source") or "")
    request_type = str(request_meta.get("type") or "")
    result_type = str(meta.get("type") or "")
    prompt = str(row.get("prompt") or row.get("conversation_title") or "")
    if _is_image_edit_history(source, request_source, prompt):
        return None
    is_text_to_image = (
        source in TEXT_TO_IMAGE_SOURCES
        or (
            request_source in TEXT_TO_IMAGE_SOURCES
            and request_type in {"image_request", "text_to_image", ""}
            and result_type in {"image_result", ""}
        )
    )
    if not is_text_to_image:
        return None
    urls = asset_urls_from_meta(meta)
    image = first_image_from_meta(meta)
    thumbnail = urls.get("thumbnail_url") or thumbnail_image(image)
    is_failed = meta.get("status") == "failed"
    has_asset_image = bool(urls.get("asset_id") or urls.get("image_url") or urls.get("preview_url"))
    if not image and not has_asset_image and not is_failed:
        return None
    return {
        "conversation_id": row.get("conversation_id"),
        "conversation_title": row.get("conversation_title", ""),
        "message_id": row.get("message_id"),
        # Failed assistant rows from older workers may not carry task_id in
        # their own metadata. Reuse the paired request identity so the client
        # can merge the task into one history record instead of rendering a
        # second error card.
        "job_id": meta.get("job_id") or meta.get("task_id") or request_meta.get("job_id") or request_meta.get("task_id") or "",
        "prompt": row.get("prompt", "") or row.get("conversation_title", ""),
        "image": urls.get("preview_url") or "",
        "thumbnail": thumbnail,
        "has_image": bool(image or has_asset_image),
        "asset_id": urls.get("asset_id") or "",
        "image_url": urls.get("image_url") or "",
        "preview_url": urls.get("preview_url") or "",
        "thumbnail_url": urls.get("thumbnail_url") or "",
        "image_fallback_url": urls.get("image_fallback_url") or "",
        "preview_fallback_url": urls.get("preview_fallback_url") or "",
        "thumbnail_fallback_url": urls.get("thumbnail_fallback_url") or "",
        "local_file_path": urls.get("local_file_path") or "",
        "local_image_url": urls.get("local_image_url") or "",
        "source": source,
        "created_at": row.get("created_at", ""),
        "status": "failed" if is_failed else "completed",
        "error": meta.get("error", "") if is_failed else "",
    }


def poster_history_asset(meta: dict) -> dict:
    empty_asset = {
        "asset_id": "",
        "thumbnail_url": "",
        "preview_url": "",
        "image_url": "",
    }
    posters = meta.get("posters") if isinstance(meta, dict) else None
    if not isinstance(posters, list):
        return empty_asset
    for poster in posters:
        if not isinstance(poster, dict):
            continue
        versions = poster.get("versions")
        if not isinstance(versions, list) or not versions:
            continue
        try:
            selected_index = int(poster.get("selected_version_index"))
        except (TypeError, ValueError):
            selected_index = len(versions) - 1
        selected_index = min(max(selected_index, 0), len(versions) - 1)
        version = versions[selected_index] if isinstance(versions[selected_index], dict) else {}
        asset_urls = asset_urls_from_meta(version)
        asset_id = str(asset_urls.get("asset_id") or "").strip()
        thumbnail_url = asset_urls.get("thumbnail_url", "")
        preview_url = asset_urls.get("preview_url", "")
        image_url = asset_urls.get("image_url", "")
        if _is_inline_image_data(image_url):
            image_url = ""
        if _is_inline_image_data(preview_url):
            preview_url = ""
        if _is_inline_image_data(thumbnail_url):
            thumbnail_url = ""
        if not image_url:
            image_url = preview_url
        if not thumbnail_url:
            thumbnail_url = preview_url or image_url
        if not preview_url:
            preview_url = image_url
        return {
            "asset_id": asset_id,
            "thumbnail_url": thumbnail_url,
            "preview_url": preview_url,
            "image_url": image_url,
            "image_fallback_url": asset_urls.get("image_fallback_url", ""),
            "preview_fallback_url": asset_urls.get("preview_fallback_url", ""),
            "thumbnail_fallback_url": asset_urls.get("thumbnail_fallback_url", ""),
        }
    return empty_asset


def poster_history_thumbnail(meta: dict) -> str:
    return poster_history_asset(meta)["thumbnail_url"]


def poster_history_item(row: dict) -> dict:
    meta = normalize_meta_value(row.get("meta"))
    request_meta = normalize_meta_value(row.get("request_meta"))
    posters = meta.get("posters")
    job_id = (meta.get("job_id") or request_meta.get("job_id") or "")
    requested_count = request_meta.get("poster_count") or meta.get("poster_count") or 0
    asset = poster_history_asset(meta)
    if not (
        asset.get("asset_id")
        or asset.get("image_url")
        or asset.get("preview_url")
        or asset.get("thumbnail_url")
    ):
        asset = {**asset, **asset_urls_from_meta(meta)}
    has_artifact = (
        (isinstance(posters, list) and bool(posters))
        or bool(meta.get("has_artifact"))
        or bool(asset.get("asset_id") or asset.get("image_url") or asset.get("preview_url"))
    )
    poster_count = len(posters) if isinstance(posters, list) else int(requested_count or 0)
    return {
        "id": row.get("id"),
        "conversation_id": row.get("id"),
        "title": row.get("title") or "海报生成",
        "type": "poster",
        "message_count": row.get("message_count", 0),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "artifact_message_id": row.get("message_id") or "",
        "artifact_created_at": row.get("artifact_created_at") or "",
        "job_id": job_id,
        "status": "preview" if has_artifact else ("generating" if job_id else "saved"),
        "poster_count": poster_count,
        "has_artifact": has_artifact,
        "thumbnail_url": asset["thumbnail_url"],
        "preview_url": asset["preview_url"],
        "image_url": asset["image_url"],
        "asset_id": asset["asset_id"],
        "image_fallback_url": asset.get("image_fallback_url", ""),
        "preview_fallback_url": asset.get("preview_fallback_url", ""),
        "thumbnail_fallback_url": asset.get("thumbnail_fallback_url", ""),
    }


def sci_fig_history_asset(meta: dict) -> dict:
    empty_asset = {
        "asset_id": "",
        "thumbnail_url": "",
        "preview_url": "",
        "image_url": "",
        "image_fallback_url": "",
        "preview_fallback_url": "",
        "thumbnail_fallback_url": "",
    }
    if not isinstance(meta, dict):
        return empty_asset
    rendered_asset = meta.get("rendered_asset")
    if isinstance(rendered_asset, dict):
        asset = asset_urls_from_meta(rendered_asset)
        if asset.get("thumbnail_url") or asset.get("preview_url") or asset.get("image_url"):
            return {**empty_asset, **asset}
    versions = meta.get("artifact_versions")
    if not isinstance(versions, list):
        return empty_asset
    try:
        selected_index = int(meta.get("selected_version_index"))
    except (TypeError, ValueError):
        selected_index = len(versions) - 1
    selected_index = min(max(selected_index, 0), len(versions) - 1) if versions else -1
    ordered = []
    if selected_index >= 0:
        ordered.append(versions[selected_index])
    ordered.extend(version for index, version in enumerate(versions) if index != selected_index)
    for version in ordered:
        if not isinstance(version, dict):
            continue
        asset = asset_urls_from_meta(version)
        if asset.get("thumbnail_url") or asset.get("preview_url") or asset.get("image_url"):
            return {**empty_asset, **asset}
        rendered = version.get("renderedB64") or version.get("rendered_b64")
        if isinstance(rendered, str) and rendered:
            return {**empty_asset, "thumbnail_url": rendered, "preview_url": rendered, "image_url": rendered}
    return empty_asset


def sci_fig_history_thumbnail(meta: dict) -> str:
    return sci_fig_history_asset(meta)["thumbnail_url"]


def sci_fig_history_item(row: dict) -> dict:
    meta = normalize_meta_value(row.get("meta"))
    request_meta = normalize_meta_value(row.get("request_meta"))
    job_id = meta.get("job_id") or request_meta.get("job_id") or ""
    artifact_versions = meta.get("artifact_versions")
    rendered_asset = meta.get("rendered_asset")
    asset = sci_fig_history_asset(meta)
    if not (
        asset.get("asset_id")
        or asset.get("image_url")
        or asset.get("preview_url")
        or asset.get("thumbnail_url")
    ):
        asset = {**asset, **asset_urls_from_meta(meta)}
    has_artifact = bool(
        (isinstance(artifact_versions, list) and artifact_versions)
        or (
            isinstance(rendered_asset, dict)
            and (rendered_asset.get("asset_id") or rendered_asset.get("preview_url") or rendered_asset.get("image_url"))
        )
        or meta.get("rendered_b64")
        or meta.get("has_artifact")
        or asset.get("asset_id")
        or asset.get("image_url")
        or asset.get("preview_url")
    )
    status = meta.get("status") or ("generating" if job_id and not has_artifact else "saved")
    if has_artifact and status not in {"done", "failed"}:
        status = "preview"
    return {
        "id": row.get("id"),
        "conversation_id": row.get("id"),
        "title": row.get("title") or "科研绘图",
        "description": row.get("title") or "科研绘图",
        "type": "sci-fig",
        "message_count": row.get("message_count", 0),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "artifact_message_id": row.get("message_id") or "",
        "artifact_created_at": row.get("artifact_created_at") or "",
        "job_id": job_id,
        "status": status,
        "gen_mode": meta.get("gen_mode") or request_meta.get("gen_mode") or "image2",
        "category": request_meta.get("category") or "data_chart",
        "style_preset": request_meta.get("style_preset") or "custom",
        "output_format": request_meta.get("output_format") or "png",
        "has_artifact": has_artifact,
        "thumbnail_url": asset["thumbnail_url"],
        "preview_url": asset["preview_url"],
        "image_url": asset["image_url"],
        "asset_id": asset["asset_id"],
        "image_fallback_url": asset["image_fallback_url"],
        "preview_fallback_url": asset["preview_fallback_url"],
        "thumbnail_fallback_url": asset["thumbnail_fallback_url"],
    }
