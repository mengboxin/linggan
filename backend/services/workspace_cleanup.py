from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from core.pool import acquire
from repositories import storage_repo
from services import asset_lifecycle, workspace_snapshot


def _uuid_task_ids(task_ids: list[str] | set[str]) -> list[str]:
    normalized: set[str] = set()
    for task_id in task_ids:
        try:
            normalized.add(str(UUID(str(task_id or "").strip())))
        except (TypeError, ValueError):
            continue
    return sorted(normalized)


def _parse_session_meta(value: Any) -> Any:
    """Normalize JSONB values when asyncpg returns its text representation."""
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}


async def delete_workspace_tasks(
    *,
    user_id: str,
    task_ids: list[str] | set[str],
    process_assets: bool = True,
) -> dict[str, Any]:
    normalized_task_ids = _uuid_task_ids(task_ids)
    empty_result: dict[str, Any] = {
        "requested_task_ids": normalized_task_ids,
        "deleted_task_ids": [],
        "workspace_records_deleted": 0,
        "image_records_deleted": 0,
        "image_record_ids_deleted": [],
        "file_records_deleted": 0,
        "file_record_ids_deleted": [],
        "edit_history_records_deleted": 0,
        "object_keys_requested": 0,
        "object_keys_deleted": 0,
        "object_delete_failed": [],
        "bytes_estimated": 0,
    }
    if not normalized_task_ids:
        return empty_result

    cleanup_intent_id = ""
    has_snapshot_key = await workspace_snapshot.has_snapshot_key_column()
    snapshot_select = "snapshot_key" if has_snapshot_key else "NULL::text AS snapshot_key"
    snapshot_clear = "snapshot_key = NULL," if has_snapshot_key else ""
    async with acquire() as conn:
        async with conn.transaction():
            raw_session_rows = await conn.fetch(
                f"""
                SELECT id::text AS task_id, preview_key, {snapshot_select}, meta
                FROM sessions
                WHERE user_id = $1::uuid
                  AND id = ANY($2::uuid[])
                FOR UPDATE
                """,
                user_id,
                normalized_task_ids,
            )
            session_rows = []
            for row in raw_session_rows:
                session = dict(row)
                session["meta"] = _parse_session_meta(session.get("meta"))
                session_rows.append(session)
            matched_task_ids = sorted({str(row.get("task_id") or "") for row in session_rows})
            if not matched_task_ids:
                return empty_result
            references = asset_lifecycle.collect_asset_references({
                "task_ids": matched_task_ids,
                "sessions": session_rows,
            })

            history_result = await conn.execute(
                """
                DELETE FROM edit_history
                WHERE user_id = $1::uuid
                  AND session_id = ANY($2::uuid[])
                """,
                user_id,
                matched_task_ids,
            )
            await conn.execute(
                f"""
                UPDATE sessions
                SET status = 'deleted',
                    meta = '{{}}'::jsonb,
                    preview_key = NULL,
                    {snapshot_clear}
                    source_width = NULL,
                    source_height = NULL,
                    updated_at = NOW()
                WHERE user_id = $1::uuid
                  AND id = ANY($2::uuid[])
                """,
                user_id,
                matched_task_ids,
            )
            cleanup_intent_id = await asset_lifecycle.stage_record_cleanup_intent(
                conn,
                user_id=user_id,
                records={
                    "task_ids": matched_task_ids,
                    "image_asset_ids": sorted(references.image_asset_ids),
                    "file_asset_ids": sorted(references.file_asset_ids),
                    "object_keys": sorted(references.object_keys),
                },
                reason="workspace-delete",
            )

    lifecycle_result = (
        await asset_lifecycle.process_record_cleanup_intent(cleanup_intent_id)
        if process_assets
        else {"cleanup_intent_id": cleanup_intent_id, "deferred": True}
    )
    try:
        history_count = int(str(history_result).split()[-1])
    except (TypeError, ValueError, IndexError):
        history_count = 0
    result = {
        "requested_task_ids": normalized_task_ids,
        "deleted_task_ids": matched_task_ids,
        "workspace_records_deleted": len(session_rows),
        "image_records_deleted": int(lifecycle_result.get("image_records_deleted") or 0),
        "image_record_ids_deleted": list(lifecycle_result.get("image_record_ids_deleted") or []),
        "image_records_preserved": int(lifecycle_result.get("image_records_preserved") or 0),
        "file_records_deleted": int(lifecycle_result.get("file_records_deleted") or 0),
        "file_record_ids_deleted": list(lifecycle_result.get("file_record_ids_deleted") or []),
        "file_records_preserved": int(lifecycle_result.get("file_records_preserved") or 0),
        "edit_history_records_deleted": history_count,
        "object_keys_requested": int(lifecycle_result.get("object_keys_requested") or 0),
        "object_keys_deleted": int(lifecycle_result.get("object_keys_deleted") or 0),
        "object_keys_preserved": int(lifecycle_result.get("object_keys_preserved") or 0),
        "object_delete_failed": list(lifecycle_result.get("object_delete_failed") or []),
        "bytes_estimated": int(lifecycle_result.get("bytes_estimated") or 0),
        "cleanup_intent_id": cleanup_intent_id,
        "cleanup_deferred": bool(lifecycle_result.get("deferred")),
    }
    await storage_repo.invalidate_user_storage_and_history_cache(user_id)
    return result
