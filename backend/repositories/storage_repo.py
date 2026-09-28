from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from uuid import UUID

from core import cache as ui_cache
from core.config import settings
from core.pool import acquire
from repositories import file_asset_repo


STORAGE_SUMMARY_CACHE_TTL_SECONDS = 20
ADMIN_STORAGE_CACHE_TTL_SECONDS = 30
STORAGE_ITEM_KINDS = {
    "all",
    "image",
    "text_image",
    "workspace",
    "sci_fig",
    "poster",
    "ppt",
    "ppt_file",
    "ppt_slide",
    "presentation_upload",
}
_ENSURED_STORAGE_SCHEMA = False
_REQUIRED_IMAGE_ASSET_COLUMNS = {
    "id",
    "user_id",
    "conversation_id",
    "message_id",
    "task_id",
    "prompt",
    "model_id",
    "mime_type",
    "width",
    "height",
    "size_bytes",
    "sha256",
    "original_key",
    "original_url",
    "preview_key",
    "preview_url",
    "thumb_key",
    "thumb_url",
    "asset_scope",
    "retention_class",
    "source_client",
    "expires_at",
    "expires_notice_sent_at",
    "storage_provider",
    "object_count",
    "is_pinned",
    "created_at",
    "updated_at",
}
_REQUIRED_PPT_UPLOAD_COLUMNS = {
    "id",
    "user_id",
    "title",
    "filename",
    "source_key",
    "source_url",
    "source_mime",
    "source_size",
    "source_sha256",
    "slide_count",
    "slides",
    "expires_at",
    "expires_notice_sent_at",
    "source_client",
    "storage_provider",
    "created_at",
    "updated_at",
}
_REQUIRED_FILE_ASSET_COLUMNS = {
    "id",
    "user_id",
    "task_id",
    "category",
    "filename",
    "mime_type",
    "size_bytes",
    "sha256",
    "storage_key",
    "storage_url",
    "retention_class",
    "source_client",
    "expires_at",
    "expires_notice_sent_at",
    "storage_provider",
    "created_at",
    "updated_at",
}
_REQUIRED_CLEANUP_RUN_COLUMNS = {
    "id",
    "mode",
    "user_id",
    "candidate_count",
    "object_count",
    "object_deleted",
    "bytes_estimated",
    "status",
    "details",
    "created_at",
}
_REQUIRED_ASSET_DELETION_QUEUE_COLUMNS = {
    "object_key",
    "user_id",
    "reason",
    "status",
    "attempts",
    "last_error",
    "next_attempt_at",
    "created_at",
    "updated_at",
}
_REQUIRED_ASSET_MIRROR_QUEUE_COLUMNS = {
    "target_provider",
    "target_endpoint",
    "target_bucket",
    "target_region",
    "object_key",
    "operation",
    "revision",
    "status",
    "attempts",
    "last_error",
    "next_attempt_at",
    "created_at",
    "updated_at",
}
_REQUIRED_ADMIN_NOTIFICATION_COLUMNS = {"kind", "last_sent_at", "payload"}


def _row_dict(row) -> dict[str, Any]:
    data = dict(row)
    for key in ("created_at", "updated_at", "expires_at", "expires_notice_sent_at"):
        if data.get(key) is not None:
            data[key] = str(data[key])
    return data


async def _require_columns(conn, table_name: str, required_columns: set[str]) -> None:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        """,
        table_name,
    )
    existing = {str(row["column_name"]) for row in rows}
    if not existing:
        raise RuntimeError(
            f"{table_name} table is missing; run python backend/scripts/run_migrate.py"
        )
    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            f"{table_name} is missing columns: {', '.join(missing)}; "
            "run python backend/scripts/run_migrate.py"
        )


def _slide_keys_and_size(slides: Any) -> tuple[list[str], int]:
    if isinstance(slides, str):
        try:
            slides = json.loads(slides)
        except Exception:
            slides = []
    keys: list[str] = []
    seen_keys: set[str] = set()
    total = 0
    if not isinstance(slides, list):
        return keys, total

    prefix = (settings.ASSET_STORAGE_PREFIX.strip("/ ") or "assets") + "/"
    known_key_fields = {
        "storage_key",
        "source_key",
        "file_key",
        "key",
        "object_key",
        "asset_key",
        "image_key",
        "preview_key",
        "thumb_key",
        "thumbnail_key",
        "original_key",
        "rendered_key",
    }

    def add_key(value: Any) -> None:
        key = str(value or "").strip().lstrip("/")
        if not key or key in seen_keys:
            return
        if key.startswith(("http://", "https://", "data:", "blob:", "file:", "api/assets/", "api/")):
            return
        if key.startswith(prefix):
            seen_keys.add(key)
            keys.append(key)

    def collect_keys(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                collect_keys(item)
            return
        if not isinstance(value, dict):
            return
        for field, item in value.items():
            normalized_field = str(field or "").strip().lower()
            if normalized_field in known_key_fields or normalized_field.endswith("_key"):
                add_key(item)
            elif isinstance(item, (dict, list)):
                collect_keys(item)

    for slide in slides:
        if not isinstance(slide, dict):
            continue
        collect_keys(slide)
        try:
            total += int(slide.get("size_bytes") or 0)
        except Exception:
            pass
    return keys, total


def _slide_preview_url(slides: Any) -> str:
    if isinstance(slides, str):
        try:
            slides = json.loads(slides)
        except Exception:
            slides = []
    if not isinstance(slides, list):
        return ""
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        src = str(slide.get("src") or slide.get("url") or slide.get("preview_url") or "").strip()
        if src:
            return src
    return ""


def _uuid_values(values: list[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        try:
            result.append(str(UUID(text)))
        except Exception:
            continue
    return result


def _split_virtual_item_ids(item_ids: list[str]) -> tuple[list[str], list[str], list[str]]:
    raw_uuid_ids: list[str] = []
    ppt_file_upload_ids: list[str] = []
    ppt_slide_upload_ids: list[str] = []
    for item_id in item_ids:
        text = str(item_id or "").strip()
        if text.startswith("workspace:"):
            continue
        if text.startswith("ppt-file:"):
            ppt_file_upload_ids.extend(_uuid_values([text.split(":", 1)[1]]))
        elif text.startswith("ppt-slides:"):
            ppt_slide_upload_ids.extend(_uuid_values([text.split(":", 1)[1]]))
        else:
            raw_uuid_ids.extend(_uuid_values([text]))
    return raw_uuid_ids, ppt_file_upload_ids, ppt_slide_upload_ids


def workspace_task_ids(item_ids: list[str]) -> list[str]:
    values = [
        str(item_id or "").strip().split(":", 1)[1]
        for item_id in item_ids
        if str(item_id or "").strip().startswith("workspace:")
    ]
    return sorted(set(_uuid_values(values)))


def _workspace_item_from_group_row(row: Any) -> dict[str, Any]:
    data = _row_dict(row)
    task_id = str(data.get("task_id") or "").strip()
    return {
        **data,
        "id": f"workspace:{task_id}",
        "task_id": task_id,
        "kind": "image",
        "source_type": "workspace",
        "title": str(data.get("title") or "").strip() or "未命名工作流",
        "size_bytes": int(data.get("size_bytes") or 0),
        "asset_count": int(data.get("asset_count") or 0),
        "preview_url": str(data.get("preview_url") or ""),
        "object_keys": list(data.get("object_keys") or []),
    }


def _image_kind(asset_scope: str | None) -> str:
    return "ppt_slide" if (asset_scope or "").strip().lower() == "ppt" else "image"


def _image_source_type(asset_scope: str | None) -> str:
    scope = (asset_scope or "").strip().lower()
    if scope in {"workspace", "image_edit", "edit"}:
        return "workspace"
    if scope in {"sci-fig", "sci_fig", "science", "research"}:
        return "sci_fig"
    if scope == "poster":
        return "poster"
    if scope == "ppt":
        return "ppt_image"
    return "text_image"


def _file_source_type(category: str | None) -> str:
    normalized = (category or "").strip().lower()
    if normalized == "presentation_uploads":
        return "presentation_upload"
    if normalized == "ppt":
        return "ppt_file"
    return "file"


def _image_scope_clause(kind: str) -> str:
    if kind == "image":
        return " AND COALESCE(asset_scope, '') != 'ppt'"
    if kind == "text_image":
        return " AND COALESCE(asset_scope, '') NOT IN ('ppt', 'workspace', 'sci-fig', 'sci_fig', 'poster')"
    if kind == "workspace":
        return " AND COALESCE(asset_scope, '') = 'workspace'"
    if kind == "sci_fig":
        return " AND COALESCE(asset_scope, '') IN ('sci-fig', 'sci_fig')"
    if kind == "poster":
        return " AND COALESCE(asset_scope, '') = 'poster'"
    if kind in {"ppt", "ppt_slide"}:
        return " AND COALESCE(asset_scope, '') = 'ppt'"
    return ""


def _ppt_file_item_id(upload_id: str) -> str:
    return f"ppt-file:{upload_id}"


def _ppt_slides_item_id(upload_id: str) -> str:
    return f"ppt-slides:{upload_id}"


def _image_variant_url(asset_id: str, variant: str) -> str:
    return f"/api/assets/{asset_id}/{variant}"


def _file_item_from_row(row: dict[str, Any], *, user_email: str = "") -> dict[str, Any]:
    data = _row_dict(row)
    category = str(data.get("category") or "")
    data["kind"] = "ppt_file"
    data["source_type"] = _file_source_type(category)
    data["title"] = data.get("filename") or ("用户上传 PPT" if category == "presentation_uploads" else "PPT 文件")
    data["object_keys"] = [data.get("storage_key")] if data.get("storage_key") else []
    if user_email:
        data["user_email"] = user_email
    return data


def _ppt_upload_file_item(row: dict[str, Any]) -> dict[str, Any] | None:
    source_size = int(row.get("source_size") or row.get("size_bytes") or 0)
    source_key = str(row.get("source_key") or "").strip().lstrip("/")
    if not source_size and not source_key:
        return None
    upload_id = str(row.get("id") or "")
    data = _row_dict(row)
    return {
        **data,
        "id": _ppt_file_item_id(upload_id),
        "kind": "ppt_file",
        "source_type": "presentation_upload",
        "title": f"{data.get('title') or data.get('filename') or 'PPT'} · 源文件",
        "size_bytes": source_size,
        "mime_type": data.get("source_mime") or data.get("mime_type") or "",
        "object_keys": [source_key] if source_key else [],
        "source_upload_id": upload_id,
    }


def _ppt_upload_slide_item(row: dict[str, Any]) -> dict[str, Any] | None:
    slide_keys, slide_bytes = _slide_keys_and_size(row.get("slides"))
    if not slide_bytes and not slide_keys:
        return None
    upload_id = str(row.get("id") or "")
    data = _row_dict(row)
    slide_count = int(data.get("slide_count") or len(slide_keys) or 0)
    return {
        **data,
        "id": _ppt_slides_item_id(upload_id),
        "kind": "ppt_slide",
        "source_type": "presentation_upload_preview",
        "title": f"{data.get('title') or data.get('filename') or 'PPT'} · 页面预览图",
        "size_bytes": slide_bytes,
        "mime_type": "image/*",
        "object_keys": slide_keys,
        "preview_url": _slide_preview_url(data.get("slides")),
        "source_upload_id": upload_id,
        "slide_count": slide_count,
    }


async def ensure_storage_tables() -> None:
    global _ENSURED_STORAGE_SCHEMA
    if _ENSURED_STORAGE_SCHEMA:
        return
    await file_asset_repo.ensure_table()
    async with acquire() as conn:
        await _require_columns(conn, "image_assets", _REQUIRED_IMAGE_ASSET_COLUMNS)
        await _require_columns(conn, "ppt_presentation_uploads", _REQUIRED_PPT_UPLOAD_COLUMNS)
        await _require_columns(conn, "file_assets", _REQUIRED_FILE_ASSET_COLUMNS)
        await _require_columns(conn, "storage_cleanup_runs", _REQUIRED_CLEANUP_RUN_COLUMNS)
        await _require_columns(conn, "asset_object_deletion_queue", _REQUIRED_ASSET_DELETION_QUEUE_COLUMNS)
        await _require_columns(conn, "asset_object_mirror_queue", _REQUIRED_ASSET_MIRROR_QUEUE_COLUMNS)
        await _require_columns(conn, "storage_admin_notifications", _REQUIRED_ADMIN_NOTIFICATION_COLUMNS)
    _ENSURED_STORAGE_SCHEMA = True


async def invalidate_user_storage_cache(user_id: str) -> None:
    await ui_cache.bump_user_cache_version(user_id, "storage")


async def invalidate_user_storage_and_history_cache(user_id: str) -> None:
    await ui_cache.bump_user_cache_version(user_id, "storage", "history")


async def storage_summary(user_id: str, *, use_cache: bool = True) -> dict[str, Any]:
    if use_cache:
        version = await ui_cache.get_user_cache_version(user_id, "storage")
        cache_key = ui_cache.user_cache_key(user_id, "storage-summary-unlimited", version)
        cached = await ui_cache.get_json(cache_key)
        if isinstance(cached, dict):
            return cached

    summary = await _storage_summary_uncached(user_id)
    if use_cache:
        await ui_cache.set_json(cache_key, summary, STORAGE_SUMMARY_CACHE_TTL_SECONDS)
    return summary


async def _storage_summary_uncached(user_id: str) -> dict[str, Any]:
    await ensure_storage_tables()
    async with acquire() as conn:
        image_source_rows = await conn.fetch(
            """
            SELECT
                COALESCE(asset_scope, '') AS asset_scope,
                COALESCE(SUM(size_bytes), 0)::bigint AS bytes,
                COUNT(*)::int AS asset_count,
                COUNT(*) FILTER (
                    WHERE expires_at IS NOT NULL
                      AND expires_at <= NOW() + ($2::int * INTERVAL '1 day')
                )::int AS asset_expiring_count,
                CASE
                    WHEN COALESCE(asset_scope, '') = 'workspace'
                    THEN COUNT(DISTINCT COALESCE(NULLIF(task_id, ''), id::text))::int
                    ELSE COUNT(*)::int
                END AS count,
                CASE
                    WHEN COALESCE(asset_scope, '') = 'workspace'
                    THEN COUNT(DISTINCT COALESCE(NULLIF(task_id, ''), id::text)) FILTER (
                        WHERE expires_at IS NOT NULL
                          AND expires_at <= NOW() + ($2::int * INTERVAL '1 day')
                    )::int
                    ELSE COUNT(*) FILTER (
                        WHERE expires_at IS NOT NULL
                          AND expires_at <= NOW() + ($2::int * INTERVAL '1 day')
                    )::int
                END AS expiring_count
            FROM image_assets
            WHERE user_id = $1::uuid
              AND COALESCE(source_client, 'web') = 'web'
            GROUP BY COALESCE(asset_scope, '')
            """,
            user_id,
            settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS,
        )
        file_assets = await conn.fetch(
            """
            SELECT
                category,
                COALESCE(SUM(size_bytes), 0)::bigint AS bytes,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW() + ($2::int * INTERVAL '1 day'))::int AS expiring_count
            FROM file_assets
            WHERE user_id = $1::uuid
              AND COALESCE(source_client, 'web') = 'web'
            GROUP BY category
            """,
            user_id,
            settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS,
        )
        ppt_rows = await conn.fetch(
            """
            SELECT
                source_size, slides, expires_at
            FROM ppt_presentation_uploads
            WHERE user_id = $1::uuid
              AND COALESCE(source_client, 'web') = 'web'
            """,
            user_id,
        )
    image_bytes = 0
    image_count = 0
    image_expiring_count = 0
    ppt_image_bytes = 0
    ppt_image_count = 0
    ppt_image_expiring_count = 0
    source_breakdown: dict[str, dict[str, int]] = {}
    for row in image_source_rows:
        asset_scope = str(row["asset_scope"] or "")
        asset_bytes = int(row["bytes"] or 0)
        asset_count = int(row["asset_count"] or 0)
        asset_expiring_count = int(row["asset_expiring_count"] or 0)
        if asset_scope == "ppt":
            ppt_image_bytes += asset_bytes
            ppt_image_count += asset_count
            ppt_image_expiring_count += asset_expiring_count
        else:
            image_bytes += asset_bytes
            image_count += asset_count
            image_expiring_count += asset_expiring_count

        source_type = _image_source_type(asset_scope)
        bucket = source_breakdown.setdefault(source_type, {"bytes": 0, "count": 0, "expiring_count": 0})
        bucket["bytes"] += asset_bytes
        bucket["count"] += int(row["count"] or 0)
        bucket["expiring_count"] += int(row["expiring_count"] or 0)

    upload_source_bytes = 0
    upload_source_count = 0
    upload_source_expiring_count = 0
    upload_slide_bytes = 0
    upload_slide_count = 0
    upload_slide_expiring_count = 0
    for row in ppt_rows:
        slide_keys, slide_bytes = _slide_keys_and_size(row["slides"])
        source_size = int(row["source_size"] or 0)
        upload_source_bytes += source_size
        upload_slide_bytes += slide_bytes
        if source_size:
            upload_source_count += 1
        if slide_keys:
            upload_slide_count += 1
        expires_at = row["expires_at"]
        if expires_at is not None:
            try:
                delta_days = (expires_at - datetime.now(expires_at.tzinfo)).total_seconds() / 86400
                if delta_days <= settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS:
                    if source_size:
                        upload_source_expiring_count += 1
                    if slide_keys:
                        upload_slide_expiring_count += 1
            except Exception:
                pass
    file_assets_by_category: dict[str, dict[str, int]] = {}
    for row in file_assets:
        category = str(row["category"] or "")
        file_assets_by_category[category] = {
            "bytes": int(row["bytes"] or 0),
            "count": int(row["count"] or 0),
            "expiring_count": int(row["expiring_count"] or 0),
        }
    ppt_file_assets = file_assets_by_category.get("ppt", {"bytes": 0, "count": 0, "expiring_count": 0})
    ppt_slide_bytes = ppt_image_bytes + upload_slide_bytes
    ppt_file_bytes = int(ppt_file_assets["bytes"] or 0) + upload_source_bytes
    used = image_bytes + ppt_slide_bytes + ppt_file_bytes
    source_breakdown.setdefault("text_image", {"bytes": 0, "count": 0, "expiring_count": 0})
    source_breakdown.setdefault("workspace", {"bytes": 0, "count": 0, "expiring_count": 0})
    source_breakdown.setdefault("sci_fig", {"bytes": 0, "count": 0, "expiring_count": 0})
    source_breakdown.setdefault("poster", {"bytes": 0, "count": 0, "expiring_count": 0})
    source_breakdown.setdefault("ppt_image", {"bytes": 0, "count": 0, "expiring_count": 0})
    source_breakdown["ppt_file"] = {
        "bytes": int(ppt_file_assets["bytes"] or 0),
        "count": int(ppt_file_assets["count"] or 0),
        "expiring_count": int(ppt_file_assets["expiring_count"] or 0),
    }
    source_breakdown["presentation_upload"] = {
        "bytes": upload_source_bytes + upload_slide_bytes,
        "count": upload_source_count + upload_slide_count,
        "expiring_count": upload_source_expiring_count + upload_slide_expiring_count,
    }
    return {
        "unlimited": True,
        "used_bytes": used,
        "large_asset_warning_bytes": settings.LARGE_ASSET_WARNING_BYTES,
        "retention": {
            "web_history_days": settings.WEB_HISTORY_RETENTION_DAYS,
            "expiry_notice_days": settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS,
            "export_days": settings.EXPORTED_FILE_RETENTION_DAYS,
            "temporary_days": settings.TEMP_ASSET_RETENTION_DAYS,
        },
        "breakdown": {
            "images": {
                "bytes": image_bytes,
                "count": image_count,
                "expiring_count": image_expiring_count,
            },
            "ppt_slides": {
                "bytes": ppt_slide_bytes,
                "count": ppt_image_count + upload_slide_count,
                "expiring_count": ppt_image_expiring_count + upload_slide_expiring_count,
            },
            "ppt_files": {
                "bytes": ppt_file_bytes,
                "count": int(ppt_file_assets["count"] or 0) + upload_source_count,
                "expiring_count": int(ppt_file_assets["expiring_count"] or 0) + upload_source_expiring_count,
            },
            "ppt_uploads": {
                "bytes": upload_source_bytes + upload_slide_bytes,
                "count": upload_source_count + upload_slide_count,
                "expiring_count": upload_source_expiring_count + upload_slide_expiring_count,
            },
            "sources": source_breakdown,
        },
    }


async def _list_workspace_cleanup_items(
    conn,
    user_id: str,
    *,
    limit: int,
    offset: int,
    sort: str,
    older_than_days: int | None,
    expiring_within_days: int | None,
) -> list[dict[str, Any]]:
    order = {
        "size_asc": "size_bytes ASC NULLS LAST",
        "time_asc": "created_at ASC",
        "time_desc": "created_at DESC",
        "expires_asc": "expires_at ASC NULLS LAST",
    }.get(sort, "size_bytes DESC NULLS LAST")
    params: list[Any] = [user_id]
    having: list[str] = []
    if older_than_days is not None:
        params.append(int(older_than_days))
        having.append(
            f"COALESCE(s.created_at, MIN(ia.created_at)) <= NOW() - (${len(params)}::int * INTERVAL '1 day')"
        )
    if expiring_within_days is not None:
        params.append(int(expiring_within_days))
        having.append(
            f"MIN(ia.expires_at) IS NOT NULL AND MIN(ia.expires_at) <= NOW() + (${len(params)}::int * INTERVAL '1 day')"
        )
    having_sql = f"HAVING {' AND '.join(having)}" if having else ""
    limit_pos = len(params) + 1
    offset_pos = len(params) + 2
    rows = await conn.fetch(
        f"""
        SELECT ia.task_id,
               COALESCE(NULLIF(s.name, ''), NULLIF(MAX(ia.prompt), ''), '未命名工作流') AS title,
               COALESCE(SUM(ia.size_bytes), 0)::bigint AS size_bytes,
               COUNT(*)::int AS asset_count,
               (
                   ARRAY_AGG(
                       COALESCE(NULLIF(ia.thumb_url, ''), NULLIF(ia.preview_url, ''), NULLIF(ia.original_url, ''))
                       ORDER BY ia.updated_at DESC
                   ) FILTER (
                       WHERE COALESCE(NULLIF(ia.thumb_url, ''), NULLIF(ia.preview_url, ''), NULLIF(ia.original_url, '')) IS NOT NULL
                   )
               )[1] AS preview_url,
               COALESCE(s.created_at, MIN(ia.created_at)) AS created_at,
               COALESCE(s.updated_at, MAX(ia.updated_at)) AS updated_at,
               MIN(ia.expires_at) AS expires_at
        FROM image_assets ia
        LEFT JOIN sessions s
          ON s.id::text = ia.task_id
         AND s.user_id = ia.user_id
        WHERE ia.user_id = $1::uuid
          AND COALESCE(ia.source_client, 'web') = 'web'
          AND ia.asset_scope = 'workspace'
          AND NULLIF(ia.task_id, '') IS NOT NULL
        GROUP BY ia.task_id, s.name, s.created_at, s.updated_at
        {having_sql}
        ORDER BY {order}
        LIMIT ${limit_pos} OFFSET ${offset_pos}
        """,
        *params,
        limit,
        offset,
    )
    return [_workspace_item_from_group_row(row) for row in rows]


async def list_cleanup_items(
    user_id: str,
    *,
    limit: int = 100,
    offset: int = 0,
    sort: str = "size_desc",
    kind: str = "all",
    older_than_days: int | None = None,
    expiring_within_days: int | None = None,
) -> list[dict[str, Any]]:
    if kind not in STORAGE_ITEM_KINDS:
        kind = "all"
    order = {
        "size_asc": "size_bytes ASC NULLS LAST",
        "time_asc": "created_at ASC",
        "time_desc": "created_at DESC",
        "expires_asc": "expires_at ASC NULLS LAST",
    }.get(sort, "size_bytes DESC NULLS LAST")
    filters = ["user_id = $1::uuid", "COALESCE(source_client, 'web') = 'web'"]
    params: list[Any] = [user_id]
    if older_than_days is not None:
        params.append(int(older_than_days))
        filters.append(f"created_at <= NOW() - (${len(params)}::int * INTERVAL '1 day')")
    if expiring_within_days is not None:
        params.append(int(expiring_within_days))
        filters.append(f"expires_at IS NOT NULL AND expires_at <= NOW() + (${len(params)}::int * INTERVAL '1 day')")
    where = " AND ".join(filters)
    combined_kind = kind in {"all", "image", "ppt", "ppt_file", "ppt_slide", "presentation_upload"}
    fetch_limit = limit + offset if combined_kind else limit
    fetch_offset = 0 if combined_kind else offset

    items: list[dict[str, Any]] = []
    async with acquire() as conn:
        if kind in {"all", "image", "text_image", "sci_fig", "poster", "ppt", "ppt_slide"}:
            image_scope_clause = _image_scope_clause(kind)
            if kind in {"all", "image"}:
                image_scope_clause += " AND COALESCE(asset_scope, '') != 'workspace'"
            image_rows = await conn.fetch(
                f"""
                SELECT id::text, prompt AS title, model_id, mime_type,
                       width, height, size_bytes, original_key, preview_key, thumb_key,
                       original_url, preview_url, thumb_url, asset_scope, retention_class, is_pinned,
                       created_at, updated_at, expires_at, expires_notice_sent_at
                FROM image_assets
                WHERE {where}{image_scope_clause}
                ORDER BY {order}
                LIMIT $%d OFFSET $%d
                """ % (len(params) + 1, len(params) + 2),
                *params,
                fetch_limit,
                fetch_offset,
            )
            for row in image_rows:
                data = _row_dict(row)
                data["kind"] = _image_kind(data.get("asset_scope"))
                data["source_type"] = _image_source_type(data.get("asset_scope"))
                data["object_keys"] = [key for key in (data.get("original_key"), data.get("preview_key"), data.get("thumb_key")) if key]
                data["preview_url"] = (
                    data.get("thumb_url")
                    or data.get("preview_url")
                    or data.get("original_url")
                    or (_image_variant_url(data["id"], "thumb") if data.get("thumb_key") else "")
                    or (_image_variant_url(data["id"], "preview") if data.get("preview_key") else "")
                    or (_image_variant_url(data["id"], "original") if data.get("original_key") else "")
                )
                items.append(data)
        if kind in {"all", "image", "workspace"}:
            items.extend(await _list_workspace_cleanup_items(
                conn,
                user_id,
                limit=fetch_limit,
                offset=fetch_offset,
                sort=sort,
                older_than_days=older_than_days,
                expiring_within_days=expiring_within_days,
            ))
        if kind in {"all", "ppt", "ppt_file"}:
            file_rows = await conn.fetch(
                f"""
                SELECT id::text, user_id::text, task_id, category, filename, mime_type,
                       size_bytes, sha256, storage_key, storage_url, retention_class,
                       source_client, expires_at, expires_notice_sent_at,
                       storage_provider, created_at, updated_at
                FROM file_assets
                WHERE {where}
                  AND category = 'ppt'
                ORDER BY {order}
                LIMIT $%d OFFSET $%d
                """ % (len(params) + 1, len(params) + 2),
                *params,
                fetch_limit,
                fetch_offset,
            )
            for row in file_rows:
                items.append(_file_item_from_row(dict(row)))
        if kind in {"all", "ppt", "ppt_file", "ppt_slide", "presentation_upload"}:
            ppt_filters = where.replace("size_bytes", "source_size")
            ppt_order = order.replace("size_bytes", "source_size")
            ppt_rows = await conn.fetch(
                f"""
                SELECT id::text, title, filename, source_mime,
                       source_size, source_key, source_url,
                       slide_count, slides, created_at, updated_at, expires_at, expires_notice_sent_at
                FROM ppt_presentation_uploads
                WHERE {ppt_filters}
                ORDER BY {ppt_order}
                LIMIT $%d OFFSET $%d
                """ % (len(params) + 1, len(params) + 2),
                *params,
                fetch_limit,
                fetch_offset,
            )
            for row in ppt_rows:
                data = _row_dict(row)
                if kind in {"all", "ppt", "ppt_file", "presentation_upload"}:
                    file_item = _ppt_upload_file_item(data)
                    if file_item:
                        file_item.pop("slides", None)
                        items.append(file_item)
                if kind in {"all", "ppt", "ppt_slide", "presentation_upload"}:
                    slide_item = _ppt_upload_slide_item(data)
                    if slide_item:
                        slide_item.pop("slides", None)
                        items.append(slide_item)
    reverse = sort not in {"size_asc", "time_asc"}
    if sort.startswith("size"):
        items.sort(key=lambda item: int(item.get("size_bytes") or 0), reverse=reverse)
    elif sort.startswith("time"):
        items.sort(key=lambda item: item.get("created_at") or "", reverse=reverse)
    elif sort.startswith("expires"):
        items.sort(key=lambda item: item.get("expires_at") or "9999", reverse=False)
    if combined_kind:
        return items[offset:offset + limit]
    return items[:limit]


async def count_cleanup_items(
    user_id: str,
    *,
    kind: str = "all",
    older_than_days: int | None = None,
    expiring_within_days: int | None = None,
) -> int:
    if kind not in STORAGE_ITEM_KINDS:
        kind = "all"
    filters = ["user_id = $1::uuid", "COALESCE(source_client, 'web') = 'web'"]
    params: list[Any] = [user_id]
    if older_than_days is not None:
        params.append(int(older_than_days))
        filters.append(f"created_at <= NOW() - (${len(params)}::int * INTERVAL '1 day')")
    if expiring_within_days is not None:
        params.append(int(expiring_within_days))
        filters.append(f"expires_at IS NOT NULL AND expires_at <= NOW() + (${len(params)}::int * INTERVAL '1 day')")
    where = " AND ".join(filters)

    total = 0
    async with acquire() as conn:
        if kind in {"text_image", "sci_fig", "poster"}:
            total += int(await conn.fetchval(f"SELECT COUNT(*)::int FROM image_assets WHERE {where}{_image_scope_clause(kind)}", *params) or 0)
        if kind == "image":
            total += int(await conn.fetchval(
                f"SELECT COUNT(*)::int FROM image_assets WHERE {where}{_image_scope_clause(kind)} AND COALESCE(asset_scope, '') != 'workspace'",
                *params,
            ) or 0)
        if kind in {"ppt", "ppt_slide"}:
            total += int(await conn.fetchval(f"SELECT COUNT(*)::int FROM image_assets WHERE {where}{_image_scope_clause('ppt_slide')}", *params) or 0)
        if kind == "all":
            total += int(await conn.fetchval(
                f"SELECT COUNT(*)::int FROM image_assets WHERE {where} AND COALESCE(asset_scope, '') != 'workspace'",
                *params,
            ) or 0)
        if kind in {"all", "image", "workspace"}:
            workspace_filters = [
                "ia.user_id = $1::uuid",
                "COALESCE(ia.source_client, 'web') = 'web'",
                "ia.asset_scope = 'workspace'",
                "NULLIF(ia.task_id, '') IS NOT NULL",
            ]
            workspace_params: list[Any] = [user_id]
            workspace_having: list[str] = []
            if older_than_days is not None:
                workspace_params.append(int(older_than_days))
                workspace_having.append(
                    f"COALESCE(s.created_at, MIN(ia.created_at)) <= NOW() - (${len(workspace_params)}::int * INTERVAL '1 day')"
                )
            if expiring_within_days is not None:
                workspace_params.append(int(expiring_within_days))
                workspace_having.append(
                    f"MIN(ia.expires_at) IS NOT NULL AND MIN(ia.expires_at) <= NOW() + (${len(workspace_params)}::int * INTERVAL '1 day')"
                )
            workspace_having_sql = f"HAVING {' AND '.join(workspace_having)}" if workspace_having else ""
            total += int(await conn.fetchval(
                f"""
                SELECT COUNT(*)::int
                FROM (
                    SELECT ia.task_id
                    FROM image_assets ia
                    LEFT JOIN sessions s
                      ON s.id::text = ia.task_id
                     AND s.user_id = ia.user_id
                    WHERE {' AND '.join(workspace_filters)}
                    GROUP BY ia.task_id, s.created_at
                    {workspace_having_sql}
                ) workspace_groups
                """,
                *workspace_params,
            ) or 0)
        if kind in {"all", "ppt", "ppt_file"}:
            total += int(await conn.fetchval(f"SELECT COUNT(*)::int FROM file_assets WHERE {where} AND category = 'ppt'", *params) or 0)
        if kind in {"all", "ppt", "ppt_file", "presentation_upload"}:
            total += int(await conn.fetchval(f"SELECT COUNT(*)::int FROM ppt_presentation_uploads WHERE {where.replace('size_bytes', 'source_size')} AND (source_size > 0 OR source_key <> '')", *params) or 0)
        if kind in {"all", "ppt", "ppt_slide", "presentation_upload"}:
            rows = await conn.fetch(f"SELECT slides FROM ppt_presentation_uploads WHERE {where.replace('size_bytes', 'source_size')}", *params)
            total += sum(1 for row in rows if _slide_keys_and_size(row["slides"])[0])
    return total


async def get_cleanup_items_by_ids(user_id: str, item_ids: list[str]) -> list[dict[str, Any]]:
    if not item_ids:
        return []
    workspace_ids = workspace_task_ids(item_ids)
    uuid_item_ids, ppt_file_upload_ids, ppt_slide_upload_ids = _split_virtual_item_ids(item_ids)
    all_items: list[dict[str, Any]] = []
    async with acquire() as conn:
        if workspace_ids:
            workspace_rows = await conn.fetch(
                """
                SELECT ia.task_id,
                       COALESCE(NULLIF(s.name, ''), NULLIF(MAX(ia.prompt), ''), '未命名工作流') AS title,
                       COALESCE(SUM(ia.size_bytes), 0)::bigint AS size_bytes,
                       COUNT(*)::int AS asset_count,
                       (
                           ARRAY_AGG(
                               COALESCE(NULLIF(ia.thumb_url, ''), NULLIF(ia.preview_url, ''), NULLIF(ia.original_url, ''))
                               ORDER BY ia.updated_at DESC
                           ) FILTER (
                               WHERE COALESCE(NULLIF(ia.thumb_url, ''), NULLIF(ia.preview_url, ''), NULLIF(ia.original_url, '')) IS NOT NULL
                           )
                       )[1] AS preview_url,
                       ARRAY_REMOVE(
                           ARRAY_AGG(ia.original_key)
                           || ARRAY_AGG(ia.preview_key)
                           || ARRAY_AGG(ia.thumb_key),
                           NULL
                       ) AS object_keys,
                       COALESCE(s.created_at, MIN(ia.created_at)) AS created_at,
                       COALESCE(s.updated_at, MAX(ia.updated_at)) AS updated_at,
                       MIN(ia.expires_at) AS expires_at
                FROM image_assets ia
                LEFT JOIN sessions s
                  ON s.id::text = ia.task_id
                 AND s.user_id = ia.user_id
                WHERE ia.user_id = $1::uuid
                  AND ia.task_id = ANY($2::text[])
                  AND ia.asset_scope = 'workspace'
                GROUP BY ia.task_id, s.name, s.created_at, s.updated_at
                """,
                user_id,
                workspace_ids,
            )
            all_items.extend(_workspace_item_from_group_row(row) for row in workspace_rows)
        image_rows = await conn.fetch(
            """
            SELECT id::text, prompt AS title, size_bytes, asset_scope,
                   original_key, preview_key, thumb_key, created_at, expires_at
            FROM image_assets
            WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
            """,
            user_id,
            uuid_item_ids,
        )
        for row in image_rows:
            data = _row_dict(row)
            data["kind"] = _image_kind(data.get("asset_scope"))
            data["object_keys"] = [key for key in (data.get("original_key"), data.get("preview_key"), data.get("thumb_key")) if key]
            all_items.append(data)
        file_rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, task_id, category, filename, mime_type,
                   size_bytes, sha256, storage_key, storage_url, retention_class,
                   source_client, expires_at, expires_notice_sent_at,
                   storage_provider, created_at, updated_at
            FROM file_assets
            WHERE user_id = $1::uuid
              AND id = ANY($2::uuid[])
              AND category IN ('ppt', 'presentation_uploads')
            """,
            user_id,
            uuid_item_ids,
        )
        for row in file_rows:
            all_items.append(_file_item_from_row(dict(row)))
        upload_ids = sorted(set(ppt_file_upload_ids + ppt_slide_upload_ids + uuid_item_ids))
        ppt_rows = await conn.fetch(
            """
            SELECT id::text, title, filename, source_mime,
                   source_size, source_key, slides, created_at, expires_at
            FROM ppt_presentation_uploads
            WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
            """,
            user_id,
            upload_ids,
        )
        for row in ppt_rows:
            data = _row_dict(row)
            upload_id = str(data.get("id") or "")
            include_file = upload_id in ppt_file_upload_ids or upload_id in uuid_item_ids
            include_slides = upload_id in ppt_slide_upload_ids or upload_id in uuid_item_ids
            if include_file:
                file_item = _ppt_upload_file_item(data)
                if file_item:
                    file_item.pop("slides", None)
                    all_items.append(file_item)
            if include_slides:
                slide_item = _ppt_upload_slide_item(data)
                if slide_item:
                    slide_item.pop("slides", None)
                    all_items.append(slide_item)
    return all_items


async def _delete_item_records(
    user_id: str,
    items: list[dict[str, Any]],
    *,
    check_image_references: bool,
) -> dict[str, int]:
    image_ids = [item["id"] for item in items if item.get("kind") in {"image", "ppt_slide"} and not str(item.get("id") or "").startswith("ppt-slides:")]
    file_ids = [item["id"] for item in items if item.get("kind") == "ppt_file" and not str(item.get("id") or "").startswith("ppt-file:")]
    ppt_file_upload_ids = [str(item.get("source_upload_id") or "").strip() for item in items if item.get("kind") == "ppt_file" and str(item.get("id") or "").startswith("ppt-file:")]
    ppt_slide_upload_ids = [str(item.get("source_upload_id") or "").strip() for item in items if item.get("kind") == "ppt_slide" and str(item.get("id") or "").startswith("ppt-slides:")]
    async with acquire() as conn:
        image_count = 0
        file_count = 0
        ppt_file_count = 0
        ppt_slide_count = 0
        if image_ids:
            if not check_image_references:
                rows = await conn.fetch(
                    """
                    DELETE FROM image_assets ia
                    WHERE ia.user_id = $1::uuid
                      AND ia.id = ANY($2::uuid[])
                    RETURNING ia.id::text
                    """,
                    user_id,
                    image_ids,
                )
            else:
                rows = await conn.fetch(
                    """
                    DELETE FROM image_assets ia
                    WHERE ia.user_id = $1::uuid
                      AND ia.id = ANY($2::uuid[])
                      AND NOT EXISTS (
                        SELECT 1
                        FROM conversation_messages m
                        JOIN conversations c ON c.id = m.conversation_id
                        WHERE c.user_id = $1::uuid
                          AND (
                            m.id = ia.message_id
                            OR m.conversation_id = ia.conversation_id
                            OR COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || ia.id::text || '%'
                            OR (NULLIF(ia.original_key, '') IS NOT NULL AND COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || ia.original_key || '%')
                            OR (NULLIF(ia.preview_key, '') IS NOT NULL AND COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || ia.preview_key || '%')
                            OR (NULLIF(ia.thumb_key, '') IS NOT NULL AND COALESCE(m.meta, '{}'::jsonb)::text LIKE '%' || ia.thumb_key || '%')
                          )
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM sessions s
                        WHERE s.user_id = $1::uuid
                          AND COALESCE(s.status, 'active') != 'deleted'
                          AND (
                            s.id::text = COALESCE(ia.task_id, '')
                            OR COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || ia.id::text || '%'
                            OR (NULLIF(ia.original_key, '') IS NOT NULL AND COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || ia.original_key || '%')
                            OR (NULLIF(ia.preview_key, '') IS NOT NULL AND COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || ia.preview_key || '%')
                            OR (NULLIF(ia.thumb_key, '') IS NOT NULL AND COALESCE(s.meta, '{}'::jsonb)::text LIKE '%' || ia.thumb_key || '%')
                          )
                      )
                    RETURNING ia.id::text
                    """,
                    user_id,
                    image_ids,
                )
            deleted_image_ids = [row["id"] for row in rows]
            image_count = len(deleted_image_ids)
        else:
            deleted_image_ids = []
        if ppt_file_upload_ids:
            rows = await conn.fetch(
                """
                UPDATE ppt_presentation_uploads
                SET source_key = '',
                    source_url = '',
                    source_mime = '',
                    source_size = 0,
                    source_sha256 = '',
                    updated_at = NOW()
                WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
                  AND (source_key <> '' OR source_size > 0)
                RETURNING id::text
                """,
                user_id,
                ppt_file_upload_ids,
            )
            deleted_ppt_file_upload_ids = [row["id"] for row in rows]
            ppt_file_count = len(deleted_ppt_file_upload_ids)
        else:
            deleted_ppt_file_upload_ids = []
        if ppt_slide_upload_ids:
            rows = await conn.fetch(
                """
                UPDATE ppt_presentation_uploads
                SET slides = '[]'::jsonb,
                    slide_count = 0,
                    updated_at = NOW()
                WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
                  AND jsonb_array_length(COALESCE(slides, '[]'::jsonb)) > 0
                RETURNING id::text
                """,
                user_id,
                ppt_slide_upload_ids,
            )
            deleted_ppt_slide_upload_ids = [row["id"] for row in rows]
            ppt_slide_count = len(deleted_ppt_slide_upload_ids)
        else:
            deleted_ppt_slide_upload_ids = []
    deleted_file_ids = await file_asset_repo.delete_file_assets_by_ids(file_ids, user_id)
    deleted_file_key_ids = await file_asset_repo.delete_file_assets_by_keys(
        [key for item in items for key in (item.get("object_keys") or []) if item.get("kind") in {"ppt_file", "ppt_slide"}],
        user_id,
    )
    file_count = len(set(deleted_file_ids + deleted_file_key_ids))
    if image_count or file_count or ppt_file_count or ppt_slide_count:
        await invalidate_user_storage_and_history_cache(user_id)
    return {
        "image_records_deleted": image_count,
        "image_record_ids_deleted": deleted_image_ids,
        "image_records_skipped": max(0, len(image_ids) - image_count),
        "file_records_deleted": file_count,
        "file_record_ids_deleted": sorted(set(deleted_file_ids + deleted_file_key_ids)),
        "ppt_file_records_deleted": ppt_file_count,
        "ppt_file_record_ids_deleted": deleted_ppt_file_upload_ids,
        "ppt_slide_records_deleted": ppt_slide_count,
        "ppt_slide_record_ids_deleted": deleted_ppt_slide_upload_ids,
        "ppt_records_deleted": ppt_file_count + ppt_slide_count,
        "ppt_record_ids_deleted": sorted(set(deleted_ppt_file_upload_ids + deleted_ppt_slide_upload_ids)),
    }


async def delete_item_records(user_id: str, items: list[dict[str, Any]]) -> dict[str, int]:
    return await _delete_item_records(
        user_id,
        items,
        check_image_references=True,
    )


async def delete_expired_item_records(user_id: str, items: list[dict[str, Any]]) -> dict[str, int]:
    return await _delete_item_records(
        user_id,
        items,
        check_image_references=True,
    )


def object_keys_for_deleted_records(items: list[dict[str, Any]], deleted_records: dict[str, int]) -> set[str]:
    keys: set[str] = set()
    deleted_image_ids = {str(item_id) for item_id in deleted_records.get("image_record_ids_deleted", []) or []}
    deleted_file_ids = {str(item_id) for item_id in deleted_records.get("file_record_ids_deleted", []) or []}
    deleted_ppt_file_ids = {str(item_id) for item_id in deleted_records.get("ppt_file_record_ids_deleted", []) or []}
    deleted_ppt_slide_ids = {str(item_id) for item_id in deleted_records.get("ppt_slide_record_ids_deleted", []) or []}
    for item in items:
        kind = item.get("kind")
        item_id = str(item.get("id") or "")
        source_upload_id = str(item.get("source_upload_id") or "")
        if kind in {"image", "ppt_slide"} and not item_id.startswith("ppt-slides:") and item_id not in deleted_image_ids:
            continue
        if kind == "ppt_file" and not item_id.startswith("ppt-file:") and item_id not in deleted_file_ids:
            continue
        if item_id.startswith("ppt-file:") and source_upload_id not in deleted_ppt_file_ids:
            continue
        if item_id.startswith("ppt-slides:") and source_upload_id not in deleted_ppt_slide_ids:
            continue
        if kind not in {"image", "ppt_slide", "ppt_file"}:
            continue
        keys.update(str(key).strip().lstrip("/") for key in item.get("object_keys") or [] if str(key).strip())
    return keys


def _normalize_object_keys(keys: list[str] | set[str]) -> list[str]:
    return sorted({
        str(key).strip().lstrip("/")
        for key in keys or []
        if str(key).strip()
    })


async def enqueue_asset_object_deletions(
    keys: list[str] | set[str],
    *,
    user_id: str | None = None,
    reason: str = "",
    error: str = "",
) -> int:
    normalized_keys = _normalize_object_keys(keys)
    if not normalized_keys:
        return 0
    await ensure_storage_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            INSERT INTO asset_object_deletion_queue (
                object_key, user_id, reason, status, last_error, next_attempt_at, updated_at
            )
            SELECT
                key,
                NULLIF($2, '')::uuid,
                $3,
                'pending',
                $4,
                NOW(),
                NOW()
            FROM unnest($1::text[]) AS key
            ON CONFLICT (object_key) DO UPDATE
            SET user_id = COALESCE(EXCLUDED.user_id, asset_object_deletion_queue.user_id),
                reason = COALESCE(NULLIF(EXCLUDED.reason, ''), asset_object_deletion_queue.reason),
                status = 'pending',
                last_error = COALESCE(NULLIF(EXCLUDED.last_error, ''), asset_object_deletion_queue.last_error),
                next_attempt_at = LEAST(asset_object_deletion_queue.next_attempt_at, NOW()),
                updated_at = NOW()
            RETURNING object_key
            """,
            normalized_keys,
            user_id or "",
            reason[:200],
            error[:1000],
        )
    return len(rows)


async def pending_asset_object_deletions(limit: int = 1000) -> list[str]:
    await ensure_storage_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT q.object_key
            FROM asset_object_deletion_queue q
            WHERE q.status = 'pending'
              AND q.next_attempt_at <= NOW()
              AND NOT EXISTS (
                  SELECT 1
                  FROM image_assets ia
                  WHERE q.object_key IN (ia.original_key, ia.preview_key, ia.thumb_key)
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM file_assets fa
                  WHERE q.object_key = fa.storage_key
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM ppt_presentation_uploads p
                  WHERE q.object_key = p.source_key
                     OR COALESCE(p.slides, '[]'::jsonb)::text LIKE '%' || q.object_key || '%'
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM sessions s
                  WHERE COALESCE(s.status, 'active') != 'deleted'
                    AND q.object_key = COALESCE(s.preview_key, '')
              )
            ORDER BY q.updated_at ASC
            LIMIT $1
            """,
            max(1, min(int(limit or 1000), 5000)),
        )
    return [str(row["object_key"]) for row in rows]


async def mark_asset_object_deletions_deleted(keys: list[str] | set[str]) -> int:
    normalized_keys = _normalize_object_keys(keys)
    if not normalized_keys:
        return 0
    await ensure_storage_tables()
    async with acquire() as conn:
        result = await conn.execute(
            """
            DELETE FROM asset_object_deletion_queue
            WHERE object_key = ANY($1::text[])
            """,
            normalized_keys,
        )
    try:
        return int(str(result).split()[-1])
    except (TypeError, ValueError, IndexError):
        return 0


async def mark_asset_object_deletions_failed(failures: list[dict[str, Any]]) -> int:
    keyed_failures = [
        {
            "key": str(item.get("key") or "").strip().lstrip("/"),
            "error": str(item.get("error") or "delete failed")[:1000],
        }
        for item in failures or []
        if str(item.get("key") or "").strip()
    ]
    if not keyed_failures:
        return 0
    keys = [item["key"] for item in keyed_failures]
    errors = [item["error"] for item in keyed_failures]
    await ensure_storage_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            UPDATE asset_object_deletion_queue q
            SET attempts = q.attempts + 1,
                last_error = failed.error,
                next_attempt_at = NOW()
                    + (LEAST(86400, 60 * POWER(2, LEAST(q.attempts, 10))) * INTERVAL '1 second'),
                updated_at = NOW()
            FROM (
                SELECT key, error
                FROM unnest($1::text[], $2::text[]) AS item(key, error)
            ) AS failed
            WHERE q.object_key = failed.key
            RETURNING q.object_key
            """,
            keys,
            errors,
        )
    return len(rows)


async def bucket_usage_estimate() -> dict[str, Any]:
    version = await ui_cache.get_global_cache_version("storage")
    cache_key = ui_cache.global_cache_key("bucket-usage", version)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached

    await ensure_storage_tables()
    async with acquire() as conn:
        image_bytes = await conn.fetchval("SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM image_assets")
        # Presentation uploads are represented by both a file_assets row and
        # their presentation record, so count that object only from the latter.
        # All other file categories, including temporary queue inputs, consume
        # real bucket space and must be visible to administrators.
        file_bytes = await conn.fetchval(
            """
            SELECT COALESCE(SUM(size_bytes), 0)::bigint
            FROM file_assets
            WHERE COALESCE(category, '') <> 'presentation_uploads'
            """
        )
        ppt_rows = await conn.fetch("SELECT source_size, slides FROM ppt_presentation_uploads")
        user_count = await conn.fetchval(
            """
            SELECT COUNT(DISTINCT user_id)::int FROM (
                SELECT user_id FROM image_assets
                UNION
                SELECT user_id FROM file_assets
                UNION
                SELECT user_id FROM ppt_presentation_uploads
            ) users_with_assets
            """
        )
    ppt_bytes = 0
    for row in ppt_rows:
        _, slide_bytes = _slide_keys_and_size(row["slides"])
        ppt_bytes += int(row["source_size"] or 0) + slide_bytes
    total = int(image_bytes or 0) + int(file_bytes or 0) + int(ppt_bytes or 0)
    payload = {
        "used_bytes": total,
        "image_bytes": int(image_bytes or 0),
        "file_bytes": int(file_bytes or 0),
        "presentation_bytes": int(ppt_bytes or 0),
        "quota_bytes": settings.CLOUD_STORAGE_BUCKET_QUOTA_BYTES,
        "warn_bytes": settings.CLOUD_STORAGE_BUCKET_WARN_BYTES,
        "warning": total >= settings.CLOUD_STORAGE_BUCKET_WARN_BYTES,
        "user_count": int(user_count or 0),
    }
    await ui_cache.set_json(cache_key, payload, ADMIN_STORAGE_CACHE_TTL_SECONDS)
    return payload


async def admin_retention_summary(expiring_days: int | None = None) -> dict[str, Any]:
    days = int(expiring_days or settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS)
    version = await ui_cache.get_global_cache_version("storage")
    cache_key = ui_cache.global_cache_key("retention-summary", version, days)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached

    await ensure_storage_tables()
    async with acquire() as conn:
        image = await conn.fetchrow(
            """
            SELECT
                COUNT(*)::int AS total_count,
                COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes,
                COUNT(*) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at <= NOW()
                )::int AS expired_count,
                COALESCE(SUM(size_bytes) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at <= NOW()
                ), 0)::bigint AS expired_bytes,
                COALESCE(SUM(object_count) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at <= NOW()
                ), 0)::int AS expired_objects,
                COUNT(*) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at > NOW()
                      AND expires_at <= NOW() + ($1::int * INTERVAL '1 day')
                )::int AS expiring_count,
                COALESCE(SUM(size_bytes) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at > NOW()
                      AND expires_at <= NOW() + ($1::int * INTERVAL '1 day')
                ), 0)::bigint AS expiring_bytes,
                COALESCE(SUM(object_count) FILTER (
                    WHERE COALESCE(is_pinned, FALSE) = FALSE
                      AND expires_at IS NOT NULL
                      AND expires_at > NOW()
                      AND expires_at <= NOW() + ($1::int * INTERVAL '1 day')
                ), 0)::int AS expiring_objects
            FROM image_assets
            WHERE COALESCE(source_client, 'web') = 'web'
            """,
            days,
        )
        ppt_rows = await conn.fetch(
            """
            SELECT source_size, source_key, slides, expires_at
            FROM ppt_presentation_uploads
            WHERE COALESCE(source_client, 'web') = 'web'
            """
        )
        ppt_file_assets = await conn.fetchrow(
            """
            SELECT
                COUNT(*)::int AS total_count,
                COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes,
                COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired_count,
                COALESCE(SUM(size_bytes) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW()), 0)::bigint AS expired_bytes,
                COUNT(*) FILTER (
                    WHERE expires_at IS NOT NULL
                      AND expires_at > NOW()
                      AND expires_at <= NOW() + ($1::int * INTERVAL '1 day')
                )::int AS expiring_count,
                COALESCE(SUM(size_bytes) FILTER (
                    WHERE expires_at IS NOT NULL
                      AND expires_at > NOW()
                      AND expires_at <= NOW() + ($1::int * INTERVAL '1 day')
                ), 0)::bigint AS expiring_bytes
            FROM file_assets
            WHERE COALESCE(source_client, 'web') = 'web'
              AND category = 'ppt'
            """,
            days,
        )

    now = datetime.now()
    ppt_total_count = len(ppt_rows)
    ppt_upload_file_count = 0
    ppt_slide_count = 0
    ppt_file_bytes = int(ppt_file_assets["total_bytes"] or 0)
    ppt_file_count = int(ppt_file_assets["total_count"] or 0)
    ppt_file_expired_count = int(ppt_file_assets["expired_count"] or 0)
    ppt_file_expired_bytes = int(ppt_file_assets["expired_bytes"] or 0)
    ppt_file_expiring_count = int(ppt_file_assets["expiring_count"] or 0)
    ppt_file_expiring_bytes = int(ppt_file_assets["expiring_bytes"] or 0)
    ppt_total_bytes = 0
    ppt_expired_count = 0
    ppt_expired_bytes = 0
    ppt_expired_objects = 0
    ppt_expiring_count = 0
    ppt_expiring_bytes = 0
    ppt_expiring_objects = 0
    for row in ppt_rows:
        slide_keys, slide_bytes = _slide_keys_and_size(row["slides"])
        source_size = int(row["source_size"] or 0)
        if source_size:
            ppt_upload_file_count += 1
            ppt_file_count += 1
            ppt_file_bytes += source_size
        if slide_keys:
            ppt_slide_count += 1
        size = source_size + slide_bytes
        object_count = (1 if row["source_key"] else 0) + len(slide_keys)
        ppt_total_bytes += size
        expires_at = row["expires_at"]
        if expires_at is None:
            continue
        current = now
        if getattr(expires_at, "tzinfo", None) is not None:
            current = datetime.now(expires_at.tzinfo)
        if expires_at <= current:
            ppt_expired_count += 1
            ppt_expired_bytes += size
            ppt_expired_objects += object_count
            if source_size:
                ppt_file_expired_count += 1
                ppt_file_expired_bytes += source_size
        else:
            delta_days = (expires_at - current).total_seconds() / 86400
            if delta_days <= days:
                ppt_expiring_count += 1
                ppt_expiring_bytes += size
                ppt_expiring_objects += object_count
                if source_size:
                    ppt_file_expiring_count += 1
                    ppt_file_expiring_bytes += source_size

    image_total_count = int(image["total_count"] or 0)
    image_total_bytes = int(image["total_bytes"] or 0)
    payload = {
        "retention_days": {
            "web_history": settings.WEB_HISTORY_RETENTION_DAYS,
            "expiry_notice": days,
            "export": settings.EXPORTED_FILE_RETENTION_DAYS,
            "temporary": settings.TEMP_ASSET_RETENTION_DAYS,
        },
        "records": {
            "images": {"count": image_total_count, "bytes": image_total_bytes},
            "ppt_uploads": {"count": ppt_total_count, "bytes": ppt_total_bytes + int(ppt_file_assets["total_bytes"] or 0)},
            "ppt_files": {"count": ppt_file_count, "bytes": ppt_file_bytes},
            "ppt_slides": {"count": ppt_slide_count, "bytes": max(0, ppt_total_bytes - sum(int(row["source_size"] or 0) for row in ppt_rows))},
        },
        "expired": {
            "items": int(image["expired_count"] or 0) + ppt_expired_count + int(ppt_file_assets["expired_count"] or 0),
            "bytes": int(image["expired_bytes"] or 0) + ppt_expired_bytes + int(ppt_file_assets["expired_bytes"] or 0),
            "objects": int(image["expired_objects"] or 0) + ppt_expired_objects + int(ppt_file_assets["expired_count"] or 0),
            "ppt_files": {"count": ppt_file_expired_count, "bytes": ppt_file_expired_bytes},
        },
        "expiring": {
            "items": int(image["expiring_count"] or 0) + ppt_expiring_count + int(ppt_file_assets["expiring_count"] or 0),
            "bytes": int(image["expiring_bytes"] or 0) + ppt_expiring_bytes + int(ppt_file_assets["expiring_bytes"] or 0),
            "objects": int(image["expiring_objects"] or 0) + ppt_expiring_objects + int(ppt_file_assets["expiring_count"] or 0),
            "within_days": days,
            "ppt_files": {"count": ppt_file_expiring_count, "bytes": ppt_file_expiring_bytes},
        },
    }
    await ui_cache.set_json(cache_key, payload, ADMIN_STORAGE_CACHE_TTL_SECONDS)
    return payload


async def recent_cleanup_runs(limit: int = 20) -> list[dict[str, Any]]:
    await ensure_storage_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.id::text, r.mode, r.user_id::text, u.email AS user_email,
                   r.candidate_count, r.object_count, r.object_deleted,
                   r.bytes_estimated, r.status, r.details, r.created_at::text
            FROM storage_cleanup_runs r
            LEFT JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
            LIMIT $1
            """,
            limit,
        )
    result = []
    for row in rows:
        data = dict(row)
        details = data.get("details")
        if isinstance(details, str):
            try:
                data["details"] = json.loads(details)
            except Exception:
                data["details"] = {}
        elif details is None:
            data["details"] = {}
        result.append(data)
    return result


async def top_storage_users(limit: int = 20) -> list[dict[str, Any]]:
    requested_limit = max(1, min(limit, 200))
    version = await ui_cache.get_global_cache_version("storage")
    cache_key = ui_cache.global_cache_key("top-storage-users-v2", version, requested_limit)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, list):
        return cached

    await ensure_storage_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT u.id::text AS user_id, u.email, u.display_name, u.role,
                   COALESCE(i.bytes, 0)::bigint AS image_bytes,
                   COALESCE(i.count, 0)::int AS image_count,
                   COALESCE(f.bytes, 0)::bigint AS file_bytes,
                   COALESCE(f.count, 0)::int AS file_count,
                   COALESCE(f.ppt_bytes, 0)::bigint AS ppt_file_bytes,
                   COALESCE(f.ppt_count, 0)::int AS ppt_file_count,
                   COALESCE(p.source_bytes, 0)::bigint AS ppt_source_bytes,
                   COALESCE(p.count, 0)::int AS ppt_count
            FROM users u
            LEFT JOIN (
                SELECT user_id, COALESCE(SUM(size_bytes), 0)::bigint AS bytes, COUNT(*)::int AS count
                FROM image_assets
                GROUP BY user_id
            ) i ON i.user_id = u.id
            LEFT JOIN (
                SELECT user_id,
                       COALESCE(SUM(size_bytes), 0)::bigint AS bytes,
                       COUNT(*)::int AS count,
                       COALESCE(SUM(size_bytes) FILTER (WHERE category = 'ppt'), 0)::bigint AS ppt_bytes,
                       COUNT(*) FILTER (WHERE category = 'ppt')::int AS ppt_count
                FROM file_assets
                WHERE COALESCE(category, '') <> 'presentation_uploads'
                GROUP BY user_id
            ) f ON f.user_id = u.id
            LEFT JOIN (
                SELECT user_id, COALESCE(SUM(source_size), 0)::bigint AS source_bytes, COUNT(*)::int AS count
                FROM ppt_presentation_uploads
                GROUP BY user_id
            ) p ON p.user_id = u.id
            WHERE COALESCE(i.count, 0) > 0 OR COALESCE(f.count, 0) > 0 OR COALESCE(p.count, 0) > 0
            ORDER BY (COALESCE(i.bytes, 0) + COALESCE(f.bytes, 0) + COALESCE(p.source_bytes, 0)) DESC
            LIMIT $1
            """,
            max(1, min(requested_limit * 3, 200)),
        )
        candidate_user_ids = sorted({str(row["user_id"]) for row in rows if row["user_id"]})
        ppt_slide_rows = (
            await conn.fetch(
                """
                SELECT user_id::text, slides
                FROM ppt_presentation_uploads
                WHERE user_id = ANY($1::uuid[])
                """,
                candidate_user_ids,
            )
            if candidate_user_ids
            else []
        )
    slide_bytes_by_user: dict[str, int] = {}
    for row in ppt_slide_rows:
        _, slide_bytes = _slide_keys_and_size(row["slides"])
        if slide_bytes:
            user_id = row["user_id"]
            slide_bytes_by_user[user_id] = slide_bytes_by_user.get(user_id, 0) + slide_bytes

    users = []
    for row in rows:
        data = dict(row)
        slide_bytes = slide_bytes_by_user.get(data["user_id"], 0)
        image_bytes = int(data.get("image_bytes") or 0)
        file_bytes = int(data.get("file_bytes") or 0)
        file_count = int(data.get("file_count") or 0)
        ppt_file_bytes = int(data.get("ppt_file_bytes") or 0)
        ppt_file_count = int(data.get("ppt_file_count") or 0)
        ppt_upload_bytes = int(data.get("ppt_source_bytes") or 0) + slide_bytes
        total = image_bytes + file_bytes + ppt_upload_bytes
        users.append({
            "user_id": data["user_id"],
            "email": data.get("email") or "",
            "display_name": data.get("display_name") or "",
            "role": data.get("role") or "user",
            "used_bytes": total,
            "breakdown": {
                "images": {"count": int(data.get("image_count") or 0), "bytes": image_bytes},
                "files": {"count": file_count, "bytes": file_bytes},
                "ppt_files": {"count": ppt_file_count, "bytes": ppt_file_bytes},
                "ppt_uploads": {"count": int(data.get("ppt_count") or 0), "bytes": ppt_upload_bytes},
            },
        })
    users.sort(key=lambda item: item["used_bytes"], reverse=True)
    payload = users[:requested_limit]
    await ui_cache.set_json(cache_key, payload, ADMIN_STORAGE_CACHE_TTL_SECONDS)
    return payload


async def admin_list_storage_items(
    *,
    status: str = "expired",
    kind: str = "all",
    sort: str = "expires_asc",
    expiring_days: int | None = None,
    large_threshold_bytes: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    if kind not in STORAGE_ITEM_KINDS:
        kind = "all"
    days = int(expiring_days or settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS)
    threshold = int(large_threshold_bytes or settings.LARGE_ASSET_WARNING_BYTES)
    fetch_limit = min(max(limit + offset, limit), 500)

    image_filters = ["COALESCE(ia.source_client, 'web') = 'web'"]
    file_filters = ["COALESCE(fa.source_client, 'web') = 'web'"]
    file_filters.append("fa.category = 'ppt'")
    ppt_filters = ["COALESCE(pu.source_client, 'web') = 'web'"]
    image_params: list[Any] = []
    file_params: list[Any] = []
    ppt_params: list[Any] = []
    if status == "expired":
        image_filters.append("COALESCE(ia.is_pinned, FALSE) = FALSE")
        image_filters.append("ia.expires_at IS NOT NULL AND ia.expires_at <= NOW()")
        file_filters.append("fa.expires_at IS NOT NULL AND fa.expires_at <= NOW()")
        ppt_filters.append("pu.expires_at IS NOT NULL AND pu.expires_at <= NOW()")
    elif status == "expiring":
        image_params.append(days)
        file_params.append(days)
        ppt_params.append(days)
        image_filters.append("COALESCE(ia.is_pinned, FALSE) = FALSE")
        image_filters.append("ia.expires_at IS NOT NULL AND ia.expires_at > NOW() AND ia.expires_at <= NOW() + ($1::int * INTERVAL '1 day')")
        file_filters.append("fa.expires_at IS NOT NULL AND fa.expires_at > NOW() AND fa.expires_at <= NOW() + ($1::int * INTERVAL '1 day')")
        ppt_filters.append("pu.expires_at IS NOT NULL AND pu.expires_at > NOW() AND pu.expires_at <= NOW() + ($1::int * INTERVAL '1 day')")
    elif status == "large":
        image_params.append(threshold)
        file_params.append(threshold)
        image_filters.append("ia.size_bytes >= $1")
        file_filters.append("fa.size_bytes >= $1")
    elif status != "all":
        raise ValueError("status must be all, expired, expiring, or large")

    image_where = " AND ".join(image_filters)
    file_where = " AND ".join(file_filters)
    ppt_where = " AND ".join(ppt_filters)
    image_limit_arg = len(image_params) + 1
    file_limit_arg = len(file_params) + 1
    ppt_limit_arg = len(ppt_params) + 1

    items: list[dict[str, Any]] = []
    async with acquire() as conn:
        if kind in {"all", "image", "text_image", "workspace", "sci_fig", "poster", "ppt", "ppt_slide"}:
            image_scope_clause = _image_scope_clause(kind).replace("asset_scope", "ia.asset_scope")
            image_rows = await conn.fetch(
                f"""
                SELECT ia.id::text, ia.user_id::text, u.email AS user_email,
                       COALESCE(NULLIF(ia.prompt, ''), '图片记录') AS title, ia.model_id,
                       ia.mime_type, ia.width, ia.height, ia.size_bytes,
                       ia.original_key, ia.preview_key, ia.thumb_key,
                       ia.original_url, ia.preview_url, ia.thumb_url,
                       ia.asset_scope, ia.retention_class, ia.is_pinned,
                       ia.created_at, ia.updated_at, ia.expires_at, ia.expires_notice_sent_at
                FROM image_assets ia
                LEFT JOIN users u ON u.id = ia.user_id
                WHERE {image_where}{image_scope_clause}
                ORDER BY ia.expires_at ASC NULLS LAST, ia.created_at DESC
                LIMIT ${image_limit_arg}
                """,
                *image_params,
                fetch_limit,
            )
            for row in image_rows:
                data = _row_dict(row)
                data["kind"] = _image_kind(data.get("asset_scope"))
                data["source_type"] = _image_source_type(data.get("asset_scope"))
                data["object_keys"] = [key for key in (data.get("original_key"), data.get("preview_key"), data.get("thumb_key")) if key]
                data["preview_url"] = (
                    data.get("thumb_url")
                    or data.get("preview_url")
                    or data.get("original_url")
                    or (_image_variant_url(data["id"], "thumb") if data.get("thumb_key") else "")
                    or (_image_variant_url(data["id"], "preview") if data.get("preview_key") else "")
                    or (_image_variant_url(data["id"], "original") if data.get("original_key") else "")
                )
                items.append(data)
        if kind in {"all", "ppt", "ppt_file"}:
            file_rows = await conn.fetch(
                f"""
                SELECT fa.id::text, fa.user_id::text, u.email AS user_email,
                       fa.task_id, fa.category, fa.filename, fa.mime_type,
                       fa.size_bytes, fa.sha256, fa.storage_key, fa.storage_url,
                       fa.retention_class, fa.source_client, fa.expires_at,
                       fa.expires_notice_sent_at, fa.storage_provider,
                       fa.created_at, fa.updated_at
                FROM file_assets fa
                LEFT JOIN users u ON u.id = fa.user_id
                WHERE {file_where}
                ORDER BY fa.expires_at ASC NULLS LAST, fa.created_at DESC
                LIMIT ${file_limit_arg}
                """,
                *file_params,
                fetch_limit,
            )
            for row in file_rows:
                items.append(_file_item_from_row(dict(row), user_email=row.get("user_email") or ""))
        if kind in {"all", "ppt", "ppt_file", "ppt_slide", "presentation_upload"}:
            ppt_rows = await conn.fetch(
                f"""
                SELECT pu.id::text, pu.user_id::text, u.email AS user_email,
                       pu.title, pu.filename, pu.source_mime,
                       pu.source_size, pu.source_key, pu.source_url,
                       pu.slide_count, pu.slides, pu.created_at, pu.updated_at,
                       pu.expires_at, pu.expires_notice_sent_at
                FROM ppt_presentation_uploads pu
                LEFT JOIN users u ON u.id = pu.user_id
                WHERE {ppt_where}
                ORDER BY pu.expires_at ASC NULLS LAST, pu.created_at DESC
                LIMIT ${ppt_limit_arg}
                """,
                *ppt_params,
                fetch_limit,
            )
            for row in ppt_rows:
                data = _row_dict(row)
                if kind in {"all", "ppt", "ppt_file", "presentation_upload"}:
                    file_item = _ppt_upload_file_item(data)
                    if file_item and (status != "large" or int(file_item.get("size_bytes") or 0) >= threshold):
                        file_item.pop("slides", None)
                        items.append(file_item)
                if kind in {"all", "ppt", "ppt_slide", "presentation_upload"}:
                    slide_item = _ppt_upload_slide_item(data)
                    if slide_item and (status != "large" or int(slide_item.get("size_bytes") or 0) >= threshold):
                        slide_item.pop("slides", None)
                        items.append(slide_item)

    reverse = sort not in {"size_asc", "time_asc", "expires_asc"}
    if sort.startswith("size"):
        items.sort(key=lambda item: int(item.get("size_bytes") or 0), reverse=reverse)
    elif sort.startswith("time"):
        items.sort(key=lambda item: item.get("created_at") or "", reverse=reverse)
    else:
        items.sort(key=lambda item: item.get("expires_at") or "9999", reverse=False)
    return items[offset:offset + limit]


async def get_admin_cleanup_items_by_ids(item_ids: list[str]) -> list[dict[str, Any]]:
    if not item_ids:
        return []
    uuid_item_ids, ppt_file_upload_ids, ppt_slide_upload_ids = _split_virtual_item_ids(item_ids)
    all_items: list[dict[str, Any]] = []
    async with acquire() as conn:
        image_rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, prompt AS title, size_bytes, asset_scope,
                   original_key, preview_key, thumb_key, created_at, expires_at
            FROM image_assets
            WHERE id = ANY($1::uuid[])
              AND COALESCE(source_client, 'web') = 'web'
            """,
            uuid_item_ids,
        )
        for row in image_rows:
            data = _row_dict(row)
            data["kind"] = _image_kind(data.get("asset_scope"))
            data["object_keys"] = [key for key in (data.get("original_key"), data.get("preview_key"), data.get("thumb_key")) if key]
            all_items.append(data)
        file_rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, task_id, category, filename, mime_type,
                   size_bytes, sha256, storage_key, storage_url, retention_class,
                   source_client, expires_at, expires_notice_sent_at,
                   storage_provider, created_at, updated_at
            FROM file_assets
            WHERE id = ANY($1::uuid[])
              AND COALESCE(source_client, 'web') = 'web'
              AND category IN ('ppt', 'presentation_uploads')
            """,
            uuid_item_ids,
        )
        for row in file_rows:
            all_items.append(_file_item_from_row(dict(row)))
        upload_ids = sorted(set(ppt_file_upload_ids + ppt_slide_upload_ids + uuid_item_ids))
        ppt_rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, title, filename, source_mime,
                   source_size, source_key, slides, created_at, expires_at
            FROM ppt_presentation_uploads
            WHERE id = ANY($1::uuid[])
              AND COALESCE(source_client, 'web') = 'web'
            """,
            upload_ids,
        )
        for row in ppt_rows:
            data = _row_dict(row)
            upload_id = str(data.get("id") or "")
            include_file = upload_id in ppt_file_upload_ids or upload_id in uuid_item_ids
            include_slides = upload_id in ppt_slide_upload_ids or upload_id in uuid_item_ids
            if include_file:
                file_item = _ppt_upload_file_item(data)
                if file_item:
                    file_item.pop("slides", None)
                    all_items.append(file_item)
            if include_slides:
                slide_item = _ppt_upload_slide_item(data)
                if slide_item:
                    slide_item.pop("slides", None)
                    all_items.append(slide_item)
    return all_items


async def log_cleanup_run(
    *,
    mode: str,
    user_id: str | None,
    items: list[dict[str, Any]],
    cleanup: dict[str, Any],
    status: str = "completed",
) -> None:
    await ensure_storage_tables()
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO storage_cleanup_runs (
                mode, user_id, candidate_count, object_count, object_deleted, bytes_estimated, status, details
            )
            VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5, $6, $7, $8::jsonb)
            """,
            mode,
            user_id or "",
            len(items),
            sum(len(item.get("object_keys") or []) for item in items),
            int(cleanup.get("deleted", 0) or cleanup.get("object_keys_deleted", 0) or 0),
            sum(int(item.get("size_bytes") or 0) for item in items),
            status,
            json.dumps(cleanup, ensure_ascii=False),
        )


async def mark_expiry_notices_sent(item_ids: list[str]) -> None:
    if not item_ids:
        return
    uuid_ids = _uuid_values(item_ids)
    async with acquire() as conn:
        await conn.execute(
            "UPDATE image_assets SET expires_notice_sent_at = NOW() WHERE id = ANY($1::uuid[])",
            uuid_ids,
        )
        await conn.execute(
            "UPDATE ppt_presentation_uploads SET expires_notice_sent_at = NOW() WHERE id = ANY($1::uuid[])",
            uuid_ids,
        )
    await file_asset_repo.mark_expiry_notices_sent(uuid_ids)


async def should_send_admin_notification(kind: str, min_hours: int = 20) -> bool:
    await ensure_storage_tables()
    async with acquire() as conn:
        recent = await conn.fetchval(
            """
            SELECT last_sent_at > NOW() - ($2::int * INTERVAL '1 hour')
            FROM storage_admin_notifications
            WHERE kind = $1
            """,
            kind,
            min_hours,
        )
    return not bool(recent)


async def mark_admin_notification_sent(kind: str, payload: dict[str, Any] | None = None) -> None:
    await ensure_storage_tables()
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO storage_admin_notifications (kind, last_sent_at, payload)
            VALUES ($1, NOW(), $2::jsonb)
            ON CONFLICT (kind) DO UPDATE
            SET last_sent_at = EXCLUDED.last_sent_at,
                payload = EXCLUDED.payload
            """,
            kind,
            json.dumps(payload or {}, ensure_ascii=False),
        )
