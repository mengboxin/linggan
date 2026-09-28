"""Persist workspace documents as object-storage blobs.

List/index queries stay on lightweight session columns. Opening a workflow
hydrates the current document from object storage instead of toasted JSONB.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from core.pool import acquire
from services import asset_storage

logger = logging.getLogger(__name__)

_has_snapshot_key_col: bool | None = None

SNAPSHOT_CATEGORY = "workspace-snapshot"
SNAPSHOT_FILENAME = "snapshot.json"
SNAPSHOT_DOCUMENT_KEYS = (
    "layers",
    "canvas_image",
    "preview_base64",
    "workflow_snapshot",
    "gen_cards",
    "workspace_state",
    "saved_at",
)
SNAPSHOT_POINTER_KEYS = (
    "snapshot_key",
    "previous_snapshot_key",
    "snapshot_file_asset_id",
    "snapshot_sha256",
    "snapshot_size_bytes",
)
INDEX_META_KEYS = ("workflow_kind", "creation_key")


def snapshot_document_from_meta(meta: dict[str, Any] | None) -> dict[str, Any]:
    source = meta if isinstance(meta, dict) else {}
    return {key: source[key] for key in SNAPSHOT_DOCUMENT_KEYS if key in source}


def index_meta_from_session(meta: dict[str, Any] | None) -> dict[str, Any]:
    source = meta if isinstance(meta, dict) else {}
    return {key: source[key] for key in INDEX_META_KEYS if source.get(key) not in (None, "")}


def snapshot_pointer_from_stored(stored: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(stored, dict):
        return {}
    key = str(stored.get("key") or stored.get("snapshot_key") or "").strip()
    if not key:
        return {}
    pointer = {
        "snapshot_key": key,
        "snapshot_file_asset_id": str(stored.get("id") or stored.get("snapshot_file_asset_id") or ""),
        "snapshot_sha256": str(stored.get("sha256") or stored.get("snapshot_sha256") or ""),
        "snapshot_size_bytes": int(stored.get("size_bytes") or stored.get("snapshot_size_bytes") or 0),
    }
    return {name: value for name, value in pointer.items() if value not in ("", 0)}


async def has_snapshot_key_column() -> bool:
    global _has_snapshot_key_col
    if _has_snapshot_key_col is None:
        async with acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'sessions'
                      AND column_name = 'snapshot_key'
                ) AS exists
                """
            )
            _has_snapshot_key_col = bool(row and row["exists"])
    return _has_snapshot_key_col


async def persist_workspace_snapshot_document(
    *,
    user_id: str,
    task_id: str,
    document: dict[str, Any],
    previous_key: str = "",
    stale_key: str = "",
) -> dict[str, Any] | None:
    """Upload the compacted workspace document. Returns a pointer, or None to keep inline JSON.

    Keep one previous object so a failed current read can fall back. The
    version before that is queued for deletion after the new upload succeeds.
    """
    if not asset_storage.is_asset_storage_enabled():
        return None
    payload = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stored = await asset_storage.store_file_bytes(
        data=payload,
        user_id=user_id,
        category=SNAPSHOT_CATEGORY,
        task_id=task_id,
        filename=SNAPSHOT_FILENAME,
        content_type="application/json",
        retention_class="web_history",
        source_client="web",
        replace_task_asset=False,
    )
    pointer = snapshot_pointer_from_stored(stored)
    if not pointer:
        logger.warning("workspace snapshot upload returned no pointer task_id=%s", task_id)
        return None
    current_key = str(pointer.get("snapshot_key") or "")
    previous = str(previous_key or "").strip()
    if previous and previous != current_key:
        pointer["previous_snapshot_key"] = previous
    stale = str(stale_key or "").strip()
    if stale and stale not in {current_key, previous}:
        try:
            await asset_storage.delete_asset_keys(
                [stale],
                user_id=user_id,
                reason="workspace-snapshot-rotate",
            )
        except Exception as exc:
            logger.warning("failed to rotate stale workspace snapshot key=%s error=%s", stale, exc)
    return pointer


async def load_workspace_snapshot_document(
    meta: dict[str, Any] | None,
    snapshot_key: str = "",
) -> dict[str, Any]:
    source = meta if isinstance(meta, dict) else {}
    inline = snapshot_document_from_meta(source)
    keys: list[str] = []
    for candidate in (
        snapshot_key,
        source.get("snapshot_key"),
        source.get("previous_snapshot_key"),
    ):
        key = str(candidate or "").strip()
        if key and key not in keys:
            keys.append(key)
    for key in keys:
        try:
            raw = await asset_storage.fetch_asset_key_bytes(key)
            parsed = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            logger.warning("workspace snapshot read failed key=%s error=%s", key, exc)
            continue
        if isinstance(parsed, dict):
            return parsed
    return inline
