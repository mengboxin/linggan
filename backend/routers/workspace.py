"""
工作区路由 —— 项目（文件夹）+ 任务（图片编辑记录）管理
使用全局 asyncpg 连接池，高并发下连接复用。
"""
import asyncio
import json
import base64
import binascii
import re
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.pool import acquire, get_db
from routers.auth import get_current_user
from services import asset_lifecycle, asset_storage, workspace_cleanup, workspace_snapshot

import asyncpg

router = APIRouter(prefix="/api/workspace", tags=["工作区"])


# ══════════════════════════════════════════════════════════════
# 请求/响应模型
# ══════════════════════════════════════════════════════════════

class CreateProjectBody(BaseModel):
    name: str = "未命名项目"
    description: Optional[str] = None

class UpdateProjectBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_archived: Optional[bool] = None

class CreateTaskBody(BaseModel):
    name: str = "未命名任务"
    source_width: Optional[int] = None
    source_height: Optional[int] = None
    workflow_kind: Literal["image_edit", "canvas_flow"] = "image_edit"
    creation_key: Optional[str] = None

class UpdateTaskBody(BaseModel):
    name: Optional[str] = None

class SaveSnapshotBody(BaseModel):
    layers: list
    canvas_image: Optional[str] = None
    preview_base64: Optional[str] = None
    workflow_snapshot: Optional[dict] = None
    gen_cards: Optional[list] = None
    workspace_state: Optional[dict] = None


SNAPSHOT_IMAGE_KEYS = {
    "imageBase64",
    "thumbnailBase64",
    "maskData",
    "canvasImageSnapshot",
    "canvas_image",
    "preview_base64",
}
SNAPSHOT_META_KEYS = {
    "layers",
    "canvas_image",
    "preview_base64",
    "workflow_snapshot",
    "gen_cards",
    "workspace_state",
    "saved_at",
}


def _is_inline_snapshot_image(value: object) -> bool:
    if not isinstance(value, str):
        return False
    raw = value.strip()
    if not raw:
        return False
    if (
        raw.startswith("__idb__:")
        or raw.startswith("blob:")
        or raw.startswith("/api/assets/")
        or raw.startswith("http://")
        or raw.startswith("https://")
        or raw.startswith("file:")
    ):
        return False
    return raw.startswith("data:image/") or len(raw) > 256


def _asset_value(meta: dict, preferred: str = "original") -> str:
    if preferred == "thumb":
        return (
            meta.get("thumbnail_url")
            or meta.get("thumb_url")
            or meta.get("preview_url")
            or meta.get("image_url")
            or ""
        )
    if preferred == "preview":
        return meta.get("preview_url") or meta.get("thumbnail_url") or meta.get("thumb_url") or meta.get("image_url") or ""
    return meta.get("image_url") or meta.get("preview_url") or meta.get("thumbnail_url") or meta.get("thumb_url") or ""


def _asset_url(asset_id: object, variant: str = "original") -> str:
    if not isinstance(asset_id, str) or not asset_id.strip():
        return ""
    return f"/api/assets/{asset_id.strip()}/{variant}"


def _external_image_ref(value: object) -> str:
    if not isinstance(value, str):
        return ""
    raw = value.strip()
    if (
        raw.startswith("/api/assets/")
        or raw.startswith("http://")
        or raw.startswith("https://")
        or raw.startswith("file:")
        or raw.startswith("blob:")
        or raw.startswith("__idb__:")
    ):
        return raw
    return ""


WORKFLOW_TASK_NAME_EXISTS_MESSAGE = "工作流名称已存在，请换一个名称"


def _normalize_task_name(value: Optional[str]) -> str:
    return " ".join((value or "").strip().split()) or "未命名工作流"


def _normalize_creation_key(value: Optional[str]) -> str:
    key = (value or "").strip()
    if not key:
        return ""
    if len(key) > 128 or not re.fullmatch(r"[A-Za-z0-9:_-]+", key):
        raise HTTPException(422, "创建请求标识无效")
    return key


async def _find_task_by_creation_key(
    conn: asyncpg.Connection,
    *,
    user_id: str,
    creation_key: str,
):
    if not creation_key:
        return None
    return await conn.fetchrow(
        """
        SELECT id, name, source_width, source_height,
               workflow_kind,
               status, created_at::text, updated_at::text
        FROM sessions
        WHERE user_id = $1::uuid
          AND status != 'deleted'
          AND meta->>'creation_key' = $2
        LIMIT 1
        """,
        user_id,
        creation_key,
    )


async def _ensure_unique_task_name(
    conn: asyncpg.Connection,
    *,
    user_id: str,
    name: str,
    exclude_task_id: Optional[str] = None,
) -> None:
    exists = await conn.fetchval(
        """
        SELECT 1
        FROM sessions
        WHERE user_id = $1::uuid
          AND status != 'deleted'
          AND lower(btrim(name)) = lower(btrim($2))
          AND ($3::uuid IS NULL OR id != $3::uuid)
        LIMIT 1
        """,
        user_id,
        name,
        exclude_task_id,
    )
    if exists:
        raise HTTPException(409, WORKFLOW_TASK_NAME_EXISTS_MESSAGE)


async def _store_snapshot_image(
    *,
    image: str,
    user_id: str,
    task_id: str,
    item_id: str,
    prompt: str = "",
    model_id: str = "",
    cache: dict[str, dict],
) -> dict:
    cached = cache.get(image)
    if cached:
        return cached
    stored = await asset_storage.store_generated_image(
        image_base64=image,
        user_id=user_id,
        conversation_id=None,
        task_id=task_id or "workspace",
        prompt=prompt[:2000],
        model_id=model_id,
        category="workspace",
        item_id=item_id,
    )
    if not stored:
        raise HTTPException(503, "图片资产存储未配置或上传失败，已拒绝把大图直接写入数据库")
    meta = stored.to_meta()
    cache[image] = meta
    return meta


def _safe_item_id(path: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in path)
    cleaned = cleaned.strip("._")
    return (cleaned or "snapshot-image")[:120]


async def _compact_snapshot_value(
    value: object,
    *,
    user_id: str,
    task_id: str,
    path: str,
    key: str = "",
    parent_key: str = "",
    prompt: str = "",
    model_id: str = "",
    cache: dict[str, dict],
) -> object:
    if isinstance(value, str):
        should_store = (key in SNAPSHOT_IMAGE_KEYS or parent_key == "refImages") and _is_inline_snapshot_image(value)
        if not should_store:
            return value
        meta = await _store_snapshot_image(
            image=value,
            user_id=user_id,
            task_id=task_id,
            item_id=_safe_item_id(path),
            prompt=prompt,
            model_id=model_id,
            cache=cache,
        )
        preferred = "thumb" if key in {"thumbnailBase64", "preview_base64"} else "original"
        return _asset_value(meta, preferred)

    if isinstance(value, list):
        return [
            await _compact_snapshot_value(
                item,
                user_id=user_id,
                task_id=task_id,
                path=f"{path}.{idx}",
                key=str(idx),
                parent_key=key,
                prompt=prompt,
                model_id=model_id,
                cache=cache,
            )
            for idx, item in enumerate(value)
        ]

    if not isinstance(value, dict):
        return value

    source = value
    result: dict = {}
    object_prompt = source.get("prompt") if isinstance(source.get("prompt"), str) else prompt
    object_model = source.get("modelId") if isinstance(source.get("modelId"), str) else model_id
    main_image = source.get("imageBase64")
    main_meta: Optional[dict] = None
    source_asset_id = source.get("assetId") or source.get("asset_id")
    existing_image_url = (
        _asset_url(source_asset_id, "original")
        or _external_image_ref(source.get("imageUrl"))
        or _external_image_ref(source.get("image_url"))
    )
    existing_preview_url = (
        _asset_url(source_asset_id, "preview")
        or _external_image_ref(source.get("previewUrl"))
        or _external_image_ref(source.get("preview_url"))
    )
    existing_thumb_url = (
        _asset_url(source_asset_id, "thumb")
        or _external_image_ref(source.get("thumbnailUrl"))
        or _external_image_ref(source.get("thumbnail_url"))
        or _external_image_ref(source.get("thumb_url"))
    )
    has_existing_asset_ref = bool(existing_image_url or existing_preview_url or existing_thumb_url)
    if has_existing_asset_ref:
        result["imageBase64"] = existing_image_url or existing_preview_url or existing_thumb_url
        if isinstance(source_asset_id, str) and source_asset_id.strip():
            result["assetId"] = source_asset_id.strip()
        if existing_image_url:
            result["imageUrl"] = existing_image_url
        if existing_preview_url:
            result["previewUrl"] = existing_preview_url
        if existing_thumb_url:
            result["thumbnailUrl"] = existing_thumb_url
    elif _is_inline_snapshot_image(main_image):
        main_meta = await _store_snapshot_image(
            image=main_image,  # type: ignore[arg-type]
            user_id=user_id,
            task_id=task_id,
            item_id=_safe_item_id(f"{path}.imageBase64"),
            prompt=object_prompt,
            model_id=object_model,
            cache=cache,
        )
        result["imageBase64"] = _asset_value(main_meta, "original")
        if main_meta.get("asset_id"):
            result["assetId"] = main_meta["asset_id"]
        if main_meta.get("image_url"):
            result["imageUrl"] = main_meta["image_url"]
        if main_meta.get("preview_url"):
            result["previewUrl"] = main_meta["preview_url"]
        thumb = main_meta.get("thumbnail_url") or main_meta.get("thumb_url")
        if thumb:
            result["thumbnailUrl"] = thumb

    for child_key, child_value in source.items():
        if child_key == "imageBase64" and (main_meta or has_existing_asset_ref):
            continue
        if child_key == "thumbnailBase64" and main_meta:
            result[child_key] = _asset_value(main_meta, "thumb")
            continue
        if child_key == "thumbnailBase64" and has_existing_asset_ref:
            result[child_key] = existing_thumb_url or existing_preview_url or existing_image_url
            continue
        if child_key in {"assetId", "imageUrl", "previewUrl", "thumbnailUrl"} and child_key in result:
            continue
        result[child_key] = await _compact_snapshot_value(
            child_value,
            user_id=user_id,
            task_id=task_id,
            path=f"{path}.{child_key}",
            key=child_key,
            parent_key=key,
            prompt=object_prompt,
            model_id=object_model,
            cache=cache,
        )
    return result


def _usable_preview_image(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    img = value.strip()
    if not img or img.startswith("__idb__:") or img.startswith("blob:"):
        return None
    return img


def _first_image_value(*values: object) -> Optional[str]:
    for value in values:
        img = _usable_preview_image(value)
        if img:
            return img
    return None


def _build_preview_base64(meta: dict) -> Optional[str]:
    root_preview = _first_image_value(
        meta.get("thumbnail_url"),
        meta.get("thumb_url"),
        meta.get("thumbnailUrl"),
        meta.get("preview_url"),
        meta.get("previewUrl"),
    )
    if root_preview:
        return root_preview.split(",", 1)[-1]

    workflow = meta.get("workflow_snapshot") or {}
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if isinstance(nodes, list) and nodes:
        for node in reversed(nodes):
            if not isinstance(node, dict):
                continue
            for key in ("thumbnailUrl", "previewUrl"):
                img = _usable_preview_image(node.get(key))
                if img:
                    return img.split(",", 1)[-1]

    cards = meta.get("gen_cards") or []
    if isinstance(cards, list) and cards:
        for card in reversed(cards):
            if not isinstance(card, dict):
                continue
            for key in ("thumbnailUrl", "thumbnailBase64", "previewUrl"):
                img = _usable_preview_image(card.get(key))
                if img:
                    return img.split(",", 1)[-1]
    return None


def _preview_thumb(raw: Optional[str], max_chars: int = 96000) -> Optional[str]:
    if not isinstance(raw, str) or not raw:
        return None
    value = raw.strip()
    if value.startswith("/api/assets/") or value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("file:"):
        return value
    if value.startswith("blob:") or value.startswith("__idb__:"):
        return None
    if value.startswith("data:image/") and len(value) <= max_chars:
        return value
    if value.startswith("data:"):
        return value if len(value) <= max_chars else None
    if len(value) > max_chars:
        return None
    payload = value.split(",", 1)[-1]
    try:
        image_bytes = base64.b64decode(payload, validate=False)
        stripped = image_bytes.lstrip()
        mime = "image/png"
        if stripped.startswith(b"<svg"):
            mime = "image/svg+xml"
        elif image_bytes.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
            mime = "image/webp"
        elif image_bytes.startswith(b"GIF8"):
            mime = "image/gif"
        return f"data:{mime};base64,{payload}"
    except (binascii.Error, OSError, ValueError):
        if value.startswith("<svg") and len(value) <= max_chars:
            encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
            return "data:image/svg+xml;base64," + encoded
        return None


def _preview_key_url(raw: Optional[str]) -> Optional[str]:
    """Resolve a persisted preview reference without treating object keys as Base64."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    value = raw.strip()
    if value.startswith(("/api/assets/", "http://", "https://", "file:")):
        return value
    if value.startswith(("data:", "blob:", "__idb__:")):
        return _preview_thumb(value)
    return asset_storage.asset_delivery_url(value) or None


def _task_rows_with_preview(rows: list[asyncpg.Record]) -> list[dict]:
    tasks: list[dict] = []
    for r in rows:
        d = dict(r)
        raw_preview = d.pop("preview_base64", None)
        raw_preview_fallback = d.pop("preview_base64_fallback", None)
        card_thumbnail_base64 = d.pop("card_thumbnail_base64", None)
        saved_at = d.pop("saved_at", None)
        has_snapshot = bool(d.pop("has_snapshot", False))
        root_thumbnail_url = d.pop("root_thumbnail_url", None)
        root_preview_url = d.pop("root_preview_url", None)
        node_thumbnail_url = d.pop("node_thumbnail_url", None)
        node_preview_url = d.pop("node_preview_url", None)
        card_thumbnail_url = d.pop("card_thumbnail_url", None)
        card_preview_url = d.pop("card_preview_url", None)
        root_thumbnail_fallback_url = d.pop("root_thumbnail_fallback_url", None)
        root_preview_fallback_url = d.pop("root_preview_fallback_url", None)
        node_thumbnail_fallback_url = d.pop("node_thumbnail_fallback_url", None)
        node_preview_fallback_url = d.pop("node_preview_fallback_url", None)
        card_thumbnail_fallback_url = d.pop("card_thumbnail_fallback_url", None)
        card_preview_fallback_url = d.pop("card_preview_fallback_url", None)
        preview = _preview_thumb(raw_preview) or _preview_thumb(card_thumbnail_base64)
        thumbnail_url = _preview_thumb(
            _first_image_value(root_thumbnail_url, node_thumbnail_url, card_thumbnail_url)
        )
        preview_url = _preview_thumb(
            _first_image_value(root_preview_url, node_preview_url, card_preview_url)
        )
        preview_key_url = _preview_key_url(d.get("preview_key"))
        thumbnail_url = thumbnail_url or preview_key_url
        preview_url = preview_url or preview_key_url
        d["meta"] = {
            "preview_base64": preview,
            "thumbnail_url": thumbnail_url,
            "preview_url": preview_url,
            "thumbnail_fallback_url": _preview_thumb(_first_image_value(
                root_thumbnail_fallback_url,
                node_thumbnail_fallback_url,
                card_thumbnail_fallback_url,
                raw_preview_fallback,
            )),
            "preview_fallback_url": _preview_thumb(_first_image_value(
                root_preview_fallback_url,
                node_preview_fallback_url,
                card_preview_fallback_url,
                raw_preview_fallback,
            )),
            "saved_at": saved_at,
            "has_snapshot": has_snapshot,
            "has_large_preview": bool(raw_preview or card_thumbnail_base64) and not preview,
        }
        tasks.append(d)
    return tasks


# ══════════════════════════════════════════════════════════════
# 项目（文件夹）
# ══════════════════════════════════════════════════════════════

@router.get("/projects")
async def list_projects(
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    rows = await conn.fetch(
        """
        SELECT p.id, p.name, p.description, p.is_archived,
               p.created_at::text, p.updated_at::text,
               COUNT(s.id) FILTER (WHERE s.status != 'deleted')::int AS task_count
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id AND s.user_id = p.user_id
        WHERE p.user_id = $1::uuid
          AND p.type = 'image'
          AND btrim(p.name) NOT LIKE '移动端%'
        GROUP BY p.id
        ORDER BY p.updated_at DESC
        """,
        user["id"],
    )
    return {"projects": [dict(r) for r in rows]}


@router.post("/projects")
async def create_project(
    body: CreateProjectBody,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    name = body.name.strip() or "未命名项目"
    exists = await conn.fetchval(
        """
        SELECT 1
        FROM projects
        WHERE user_id = $1::uuid AND type = 'image' AND lower(trim(name)) = lower(trim($2))
        LIMIT 1
        """,
        user["id"], name,
    )
    if exists:
        raise HTTPException(409, "项目名称已存在，请换一个名称")

    try:
        row = await conn.fetchrow(
            """
            INSERT INTO projects (user_id, name, description)
            VALUES ($1::uuid, $2, $3)
            RETURNING id, name, description, is_archived,
                      created_at::text, updated_at::text
            """,
            user["id"], name, body.description,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "项目名称已存在，请换一个名称")
    return dict(row)


@router.patch("/projects/{project_id}")
async def update_project(
    project_id: str,
    body: UpdateProjectBody,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    row = await conn.fetchrow(
        "SELECT id FROM projects WHERE id = $1::uuid AND user_id = $2::uuid",
        project_id, user["id"],
    )
    if not row:
        raise HTTPException(404, "项目不存在")

    updates, args = [], [project_id]
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "项目名称不能为空")
        exists = await conn.fetchval(
            """
            SELECT 1
            FROM projects
            WHERE user_id = $1::uuid
              AND type = 'image'
              AND id != $2::uuid
              AND lower(trim(name)) = lower(trim($3))
            LIMIT 1
            """,
            user["id"], project_id, name,
        )
        if exists:
            raise HTTPException(409, "项目名称已存在，请换一个名称")
        args.append(name); updates.append(f"name = ${len(args)}")
    if body.description is not None:
        args.append(body.description); updates.append(f"description = ${len(args)}")
    if body.is_archived is not None:
        args.append(body.is_archived); updates.append(f"is_archived = ${len(args)}")

    if updates:
        updates.append("updated_at = NOW()")
        try:
            await conn.execute(
                f"UPDATE projects SET {', '.join(updates)} WHERE id = $1::uuid", *args,
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, "项目名称已存在，请换一个名称")
    return {"ok": True}


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM projects WHERE id = $1::uuid AND user_id = $2::uuid",
            project_id, user["id"],
        )
        if not row:
            raise HTTPException(404, "项目不存在")
        task_rows = await conn.fetch(
            "SELECT id::text FROM sessions WHERE project_id = $1::uuid AND user_id = $2::uuid",
            project_id, user["id"],
        )
    cleanup = await workspace_cleanup.delete_workspace_tasks(
        user_id=user["id"],
        task_ids=[str(task_row["id"]) for task_row in task_rows],
    )
    async with acquire() as conn:
        async with conn.transaction():
            current = await conn.fetchrow(
                "SELECT id, thumbnail FROM projects WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE",
                project_id,
                user["id"],
            )
            if not current:
                raise HTTPException(404, "项目不存在")
            project_records = {"project_id": project_id, "thumbnail": current["thumbnail"] or ""}
            await conn.execute(
                "UPDATE projects SET thumbnail = NULL WHERE id = $1::uuid AND user_id = $2::uuid",
                project_id,
                user["id"],
            )
            delete_result = await conn.execute(
                "DELETE FROM projects WHERE id = $1::uuid AND user_id = $2::uuid",
                project_id,
                user["id"],
            )
            if delete_result != "DELETE 1":
                raise HTTPException(404, "项目不存在")
            cleanup_intent_id = await asset_lifecycle.stage_record_cleanup_intent(
                conn,
                user_id=user["id"],
                records=project_records,
                reason="workspace-project-delete",
            )
    project_asset_cleanup = await asset_lifecycle.process_record_cleanup_intent(
        cleanup_intent_id,
    )
    return {
        "ok": True,
        "cleanup": cleanup,
        "project_asset_cleanup": project_asset_cleanup,
    }


# ══════════════════════════════════════════════════════════════
# 任务（图片编辑记录）
# ══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/tasks")
async def list_tasks(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    has_snapshot_key = await workspace_snapshot.has_snapshot_key_column()
    snapshot_ready = (
        "OR NULLIF(snapshot_key, '') IS NOT NULL"
        if has_snapshot_key
        else ""
    )
    async with acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id FROM projects WHERE id = $1::uuid AND user_id = $2::uuid",
            project_id, user["id"],
        )
        if not proj:
            raise HTTPException(404, "项目不存在")

        rows = await conn.fetch(
            f"""
            SELECT id, name, source_width, source_height, preview_key,
                   workflow_kind,
                   status, created_at::text, updated_at::text,
                   NULL::text AS preview_base64,
                   updated_at::text AS saved_at,
                   (
                       NULLIF(preview_key, '') IS NOT NULL
                       {snapshot_ready}
                   ) AS has_snapshot
            FROM sessions
            WHERE project_id = $1::uuid AND status != 'deleted'
            ORDER BY updated_at DESC
            """,
            project_id,
        )
    prepared_rows = await asset_storage.prepare_image_asset_payload([dict(row) for row in rows], user["id"])
    return {"tasks": _task_rows_with_preview(prepared_rows)}


@router.get("/tasks")
async def list_all_tasks(
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    workflow_kind: Optional[Literal["image_edit", "canvas_flow"]] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    requested_limit = max(1, min(limit, 500))
    requested_offset = max(0, offset)
    has_snapshot_key = await workspace_snapshot.has_snapshot_key_column()
    snapshot_ready = (
        "OR NULLIF(s.snapshot_key, '') IS NOT NULL"
        if has_snapshot_key
        else ""
    )
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT s.id, s.project_id, s.name, s.source_width, s.source_height, s.preview_key,
                   s.workflow_kind,
                   s.status, s.created_at::text, s.updated_at::text,
                   NULL::text AS preview_base64,
                   s.updated_at::text AS saved_at,
                   (
                       NULLIF(s.preview_key, '') IS NOT NULL
                       {snapshot_ready}
                   ) AS has_snapshot
            FROM sessions s
            JOIN projects p ON p.id = s.project_id AND p.user_id = s.user_id
            WHERE s.user_id = $1::uuid
              AND s.status != 'deleted'
              AND p.type = 'image'
              AND btrim(p.name) NOT LIKE '移动端%'
              AND ($4::text IS NULL OR s.workflow_kind = $4)
            ORDER BY s.updated_at DESC
            LIMIT $2 OFFSET $3
            """,
            user["id"],
            requested_limit,
            requested_offset,
            workflow_kind,
        )
    prepared_rows = await asset_storage.prepare_image_asset_payload([dict(row) for row in rows], user["id"])
    return {"tasks": _task_rows_with_preview(prepared_rows)}


@router.post("/projects/{project_id}/tasks")
async def create_task(
    project_id: str,
    body: CreateTaskBody,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    proj = await conn.fetchrow(
        "SELECT id FROM projects WHERE id = $1::uuid AND user_id = $2::uuid",
        project_id, user["id"],
    )
    if not proj:
        raise HTTPException(404, "项目不存在")

    creation_key = _normalize_creation_key(body.creation_key)
    existing = await _find_task_by_creation_key(
        conn,
        user_id=user["id"],
        creation_key=creation_key,
    )
    if existing:
        return dict(existing)

    name = _normalize_task_name(body.name)
    await _ensure_unique_task_name(conn, user_id=user["id"], name=name)
    try:
        row = await conn.fetchrow(
            """
            INSERT INTO sessions (user_id, project_id, name, source_width, source_height, workflow_kind, meta)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
            RETURNING id, name, source_width, source_height,
                      workflow_kind,
                      status, created_at::text, updated_at::text
            """,
            user["id"], project_id, name, body.source_width, body.source_height, body.workflow_kind,
            json.dumps({
                "workflow_kind": body.workflow_kind,
                **({"creation_key": creation_key} if creation_key else {}),
            }),
        )
    except asyncpg.UniqueViolationError:
        existing = await _find_task_by_creation_key(
            conn,
            user_id=user["id"],
            creation_key=creation_key,
        )
        if existing:
            return dict(existing)
        raise HTTPException(409, WORKFLOW_TASK_NAME_EXISTS_MESSAGE)
    return dict(row)


@router.patch("/tasks/{task_id}")
async def update_task(
    task_id: str,
    body: UpdateTaskBody,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    row = await conn.fetchrow(
        "SELECT id, project_id FROM sessions WHERE id = $1::uuid AND user_id = $2::uuid",
        task_id, user["id"],
    )
    if not row:
        raise HTTPException(404, "任务不存在")

    if body.name:
        name = _normalize_task_name(body.name)
        await _ensure_unique_task_name(
            conn,
            user_id=user["id"],
            name=name,
            exclude_task_id=task_id,
        )
        try:
            await conn.execute(
                "UPDATE sessions SET name = $2, updated_at = NOW() WHERE id = $1::uuid",
                task_id, name,
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, WORKFLOW_TASK_NAME_EXISTS_MESSAGE)
    return {"ok": True}


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    user: dict = Depends(get_current_user),
):
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM sessions WHERE id = $1::uuid AND user_id = $2::uuid",
            task_id, user["id"],
        )
    if not row:
        return {"ok": True, "already_deleted": True}

    cleanup = await workspace_cleanup.delete_workspace_tasks(
        user_id=user["id"],
        task_ids=[task_id],
        process_assets=False,
    )
    cleanup_intent_id = str(cleanup.get("cleanup_intent_id") or "").strip()
    if cleanup_intent_id:
        asyncio.create_task(asset_lifecycle.process_record_cleanup_intent(cleanup_intent_id))
    return {"ok": True, "cleanup": cleanup}


# ══════════════════════════════════════════════════════════════
# 快照（图层数据持久化）
# ══════════════════════════════════════════════════════════════

@router.get("/tasks/{task_id}/snapshot")
async def get_snapshot(
    task_id: str,
    user: dict = Depends(get_current_user),
):
    has_snapshot_key = await workspace_snapshot.has_snapshot_key_column()
    snapshot_select = "snapshot_key" if has_snapshot_key else "NULL::text AS snapshot_key"
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"""
            SELECT id, project_id, workflow_kind, {snapshot_select}, meta
            FROM sessions
            WHERE id = $1::uuid AND user_id = $2::uuid AND status != 'deleted'
            """,
            task_id, user["id"],
        )
    if not row:
        raise HTTPException(404, "任务不存在")

    meta = row["meta"] or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    document = await workspace_snapshot.load_workspace_snapshot_document(
        meta,
        snapshot_key=str(row.get("snapshot_key") or ""),
    )

    payload = {
        "task_id": task_id,
        "project_id": str(row["project_id"]),
        "workflow_kind": row.get("workflow_kind") or meta.get("workflow_kind", "image_edit"),
        "layers": document.get("layers", []),
        "canvas_image": document.get("canvas_image"),
        "workflow_snapshot": document.get("workflow_snapshot"),
        "gen_cards": document.get("gen_cards", []),
        "workspace_state": document.get("workspace_state"),
        "saved_at": document.get("saved_at"),
    }
    return await asset_storage.prepare_image_asset_payload(payload, user["id"])


@router.post("/tasks/{task_id}/snapshot")
async def save_snapshot(
    task_id: str,
    body: SaveSnapshotBody,
    user: dict = Depends(get_current_user),
):
    has_snapshot_key = await workspace_snapshot.has_snapshot_key_column()
    snapshot_select = "snapshot_key" if has_snapshot_key else "NULL::text AS snapshot_key"
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"""
            SELECT id, workflow_kind, {snapshot_select}, meta
            FROM sessions
            WHERE id = $1::uuid AND user_id = $2::uuid AND status != 'deleted'
            """,
            task_id, user["id"],
        )
    if not row:
        raise HTTPException(404, "任务不存在")

    old_meta = row["meta"] or {}
    if isinstance(old_meta, str):
        old_meta = json.loads(old_meta)

    compact_cache: dict[str, dict] = {}
    incoming_meta = {
        "layers": body.layers,
        "canvas_image": body.canvas_image,
        "preview_base64": body.preview_base64,
        "workflow_snapshot": body.workflow_snapshot,
        "gen_cards": body.gen_cards,
        "workspace_state": body.workspace_state,
    }
    compacted = await _compact_snapshot_value(
        incoming_meta,
        user_id=user["id"],
        task_id=task_id,
        path="workspace",
        cache=compact_cache,
    )
    if not isinstance(compacted, dict):
        raise HTTPException(500, "快照压缩失败")

    document = {
        "layers": compacted.get("layers") or [],
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    if compacted.get("canvas_image"):
        document["canvas_image"] = compacted["canvas_image"]
    if compacted.get("preview_base64"):
        document["preview_base64"] = compacted["preview_base64"]
    if compacted.get("workflow_snapshot") is not None:
        document["workflow_snapshot"] = compacted["workflow_snapshot"]
    if compacted.get("gen_cards") is not None:
        document["gen_cards"] = compacted["gen_cards"]
    if compacted.get("workspace_state") is not None:
        document["workspace_state"] = compacted["workspace_state"]
    document["preview_base64"] = compacted.get("preview_base64") or _build_preview_base64(document)

    previous_key = str(row.get("snapshot_key") or old_meta.get("snapshot_key") or "")
    pointer = await workspace_snapshot.persist_workspace_snapshot_document(
        user_id=user["id"],
        task_id=task_id,
        document=document,
        previous_key=previous_key,
        stale_key=str(old_meta.get("previous_snapshot_key") or ""),
    )
    index_meta = workspace_snapshot.index_meta_from_session(old_meta)
    if row.get("workflow_kind"):
        index_meta["workflow_kind"] = row["workflow_kind"]
    persisted_meta = {**index_meta, **(pointer or document)}

    preview_reference = ""
    if isinstance(body.preview_base64, str):
        preview_asset = compact_cache.get(body.preview_base64)
        if preview_asset:
            preview_reference = str(
                preview_asset.get("asset_thumb_key")
                or preview_asset.get("asset_preview_key")
                or preview_asset.get("thumbnail_url")
                or preview_asset.get("preview_url")
                or ""
            )
    preview_reference = preview_reference or str(document.get("preview_base64") or "")
    if preview_reference.startswith(("data:", "blob:", "__idb__:")):
        preview_reference = ""

    snapshot_key = str((pointer or {}).get("snapshot_key") or row.get("snapshot_key") or "")
    async with acquire() as conn:
        if has_snapshot_key:
            updated_task_id = await conn.fetchval(
                """
                UPDATE sessions
                SET meta = $2::jsonb,
                    preview_key = NULLIF($4, ''),
                    snapshot_key = NULLIF($5, ''),
                    updated_at = NOW()
                WHERE id = $1::uuid
                  AND user_id = $3::uuid
                  AND status != 'deleted'
                RETURNING id::text
                """,
                task_id,
                json.dumps(persisted_meta),
                user["id"],
                preview_reference,
                snapshot_key,
            )
        else:
            updated_task_id = await conn.fetchval(
                """
                UPDATE sessions
                SET meta = $2::jsonb,
                    preview_key = NULLIF($4, ''),
                    updated_at = NOW()
                WHERE id = $1::uuid
                  AND user_id = $3::uuid
                  AND status != 'deleted'
                RETURNING id::text
                """,
                task_id,
                json.dumps(persisted_meta),
                user["id"],
                preview_reference,
            )
    if not updated_task_id:
        await workspace_cleanup.delete_workspace_tasks(user_id=user["id"], task_ids=[task_id])
        raise HTTPException(409, "工作流已删除，本次自动保存未写入并已清理上传资源")
    return {
        "ok": True,
        "saved_at": document["saved_at"],
        "workflow_snapshot": document.get("workflow_snapshot"),
    }


# ══════════════════════════════════════════════════════════════
# 编辑历史
# ══════════════════════════════════════════════════════════════

@router.get("/tasks/{task_id}/history")
async def get_task_history(
    task_id: str,
    limit: int = 30,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    row = await conn.fetchrow(
        "SELECT id FROM sessions WHERE id = $1::uuid AND user_id = $2::uuid",
        task_id, user["id"],
    )
    if not row:
        raise HTTPException(404, "任务不存在")

    rows = await conn.fetch(
        """
        SELECT id, action, description, is_undoable, created_at::text
        FROM edit_history
        WHERE session_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2
        """,
        task_id, limit,
    )
    return {"history": [dict(r) for r in rows]}


@router.post("/tasks/{task_id}/history")
async def add_history_entry(
    task_id: str,
    action: str,
    description: str = "",
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    row = await conn.fetchrow(
        "SELECT id FROM sessions WHERE id = $1::uuid AND user_id = $2::uuid",
        task_id, user["id"],
    )
    if not row:
        raise HTTPException(404, "任务不存在")

    valid_actions = {
        'upload', 'segment', 'layer_edit', 'layer_reorder',
        'layer_opacity', 'layer_visibility', 'layer_delete',
        'layer_add', 'compose', 'brush_stroke', 'crop', 'undo', 'redo'
    }
    if action not in valid_actions:
        action = 'layer_edit'

    await conn.execute(
        """
        INSERT INTO edit_history (session_id, user_id, action, description)
        VALUES ($1::uuid, $2::uuid, $3, $4)
        """,
        task_id, user["id"], action, description,
    )
    return {"ok": True}
