"""Release bucket-backed assets after their owning records are deleted.

Callers provide the deleted record payload. This module finds linked image and
file metadata, checks every durable user-facing reference, deletes only
unreferenced metadata, and stages object deletion in the same transaction.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID

from core.pool import acquire
from repositories import storage_repo
from services import asset_storage

logger = logging.getLogger(__name__)

_INTENT_STALE_AFTER_MINUTES = 10

_IMAGE_ID_FIELDS = {
    "asset_id",
    "assetId",
    "rendered_asset_id",
    "renderedAssetId",
    "source_asset_id",
    "sourceAssetId",
    "reference_asset_id",
    "referenceAssetId",
}
_IMAGE_ID_COLLECTION_FIELDS = {"asset_ids", "assetIds", "image_asset_ids", "imageAssetIds"}
_FILE_ID_FIELDS = {
    "file_asset_id",
    "fileAssetId",
    "pptx_file_asset_id",
    "pptxFileAssetId",
}
_FILE_ID_COLLECTION_FIELDS = {"file_asset_ids", "fileAssetIds"}
_TASK_ID_FIELDS = {"task_id", "taskId", "job_id", "jobId"}
_TASK_ID_COLLECTION_FIELDS = {"task_ids", "taskIds", "job_ids", "jobIds"}
_OBJECT_KEY_FIELDS = {
    "asset_original_key",
    "asset_preview_key",
    "asset_thumb_key",
    "original_key",
    "preview_key",
    "thumb_key",
    "thumbnail_key",
    "storage_key",
    "source_key",
    "pptx_key",
    "file_key",
    "object_key",
    "snapshot_key",
    "previous_snapshot_key",
}
_OBJECT_KEY_COLLECTION_FIELDS = {"keys", "object_keys", "storage_keys", "asset_keys"}


@dataclass
class AssetReferences:
    image_asset_ids: set[str] = field(default_factory=set)
    file_asset_ids: set[str] = field(default_factory=set)
    task_ids: set[str] = field(default_factory=set)
    object_keys: set[str] = field(default_factory=set)


def _add_strings(target: set[str], value: Any, *, strip_slash: bool = False) -> None:
    values = value if isinstance(value, (list, tuple, set, frozenset)) else [value]
    for item in values:
        if not isinstance(item, str) or not item.strip():
            continue
        normalized = item.strip()
        if strip_slash:
            normalized = normalized.lstrip("/")
        if normalized:
            target.add(normalized)


def _collect_string_reference(value: str, refs: AssetReferences) -> None:
    raw = value.strip()
    if not raw:
        return
    parsed = urlsplit(raw)
    if parsed.scheme == "asset":
        asset_id = (parsed.netloc or parsed.path).strip("/")
        if asset_id:
            refs.image_asset_ids.add(asset_id)
        return
    parts = parsed.path.strip("/").split("/")
    if len(parts) >= 4 and parts[:4] == ["api", "assets", "files", "by-key"]:
        key = unquote((parse_qs(parsed.query).get("key") or [""])[0]).strip().lstrip("/")
        if key:
            refs.object_keys.add(key)
        return
    if len(parts) >= 3 and parts[:2] == ["api", "assets"] and parts[2] != "files":
        refs.image_asset_ids.add(parts[2])


def collect_asset_references(value: Any) -> AssetReferences:
    """Collect asset identifiers from API payloads and persisted JSON records."""
    refs = AssetReferences()

    def collect(item: Any) -> None:
        if isinstance(item, str):
            _collect_string_reference(item, refs)
            return
        if isinstance(item, (list, tuple, set, frozenset)):
            for child in item:
                collect(child)
            return
        if not isinstance(item, dict):
            return
        for key, child in item.items():
            if key in _IMAGE_ID_FIELDS:
                _add_strings(refs.image_asset_ids, child)
            elif key in _IMAGE_ID_COLLECTION_FIELDS:
                _add_strings(refs.image_asset_ids, child)
            elif key in _FILE_ID_FIELDS:
                _add_strings(refs.file_asset_ids, child)
            elif key in _FILE_ID_COLLECTION_FIELDS:
                _add_strings(refs.file_asset_ids, child)
            elif key in _TASK_ID_FIELDS:
                _add_strings(refs.task_ids, child)
            elif key in _TASK_ID_COLLECTION_FIELDS:
                _add_strings(refs.task_ids, child)
            elif key in _OBJECT_KEY_FIELDS:
                _add_strings(refs.object_keys, child, strip_slash=True)
            elif key in _OBJECT_KEY_COLLECTION_FIELDS:
                _add_strings(refs.object_keys, child, strip_slash=True)
            collect(child)

    collect(value)
    return refs


def _uuid_values(values: set[str]) -> list[str]:
    normalized: set[str] = set()
    for value in values:
        try:
            normalized.add(str(UUID(str(value or "").strip())))
        except (TypeError, ValueError, AttributeError):
            continue
    return sorted(normalized)


def _row_keys(row: dict[str, Any], fields: tuple[str, ...]) -> set[str]:
    return {
        str(row.get(field) or "").strip().lstrip("/")
        for field in fields
        if str(row.get(field) or "").strip()
    }


async def _load_candidate_rows(conn, *, user_id: str, refs: AssetReferences) -> tuple[list[dict], list[dict]]:
    image_ids = _uuid_values(refs.image_asset_ids)
    file_ids = _uuid_values(refs.file_asset_ids)
    task_ids = sorted(refs.task_ids)
    object_keys = sorted(refs.object_keys)
    image_rows = [
        dict(row)
        for row in await conn.fetch(
            """
            SELECT id::text, task_id, size_bytes, original_key, preview_key, thumb_key
            FROM image_assets
            WHERE user_id = $1::uuid
              AND (
                id = ANY($2::uuid[])
                OR task_id = ANY($3::text[])
                OR original_key = ANY($4::text[])
                OR preview_key = ANY($4::text[])
                OR thumb_key = ANY($4::text[])
              )
            FOR UPDATE
            """,
            user_id,
            image_ids,
            task_ids,
            object_keys,
        )
    ]
    file_rows = [
        dict(row)
        for row in await conn.fetch(
            """
            SELECT id::text, task_id, size_bytes, storage_key
            FROM file_assets
            WHERE user_id = $1::uuid
              AND (
                id = ANY($2::uuid[])
                OR task_id = ANY($3::text[])
                OR storage_key = ANY($4::text[])
              )
            FOR UPDATE
            """,
            user_id,
            file_ids,
            task_ids,
            object_keys,
        )
    ]
    return image_rows, file_rows


async def _find_surviving_reference_tokens(
    conn,
    *,
    user_id: str,
    tokens: set[str],
    include_asset_rows: bool,
    ignore_conversation_links_for_image_ids: set[str] | None = None,
) -> set[str]:
    normalized = sorted({str(token).strip().lstrip("/") for token in tokens if str(token).strip()})
    if not normalized:
        return set()
    asset_row_checks = """
        OR EXISTS (
            SELECT 1
            FROM image_assets ia
            WHERE ia.user_id = $2::uuid
              AND candidate.token IN (ia.original_key, ia.preview_key, ia.thumb_key)
        )
        OR EXISTS (
            SELECT 1
            FROM file_assets fa
            WHERE fa.user_id = $2::uuid
              AND candidate.token = fa.storage_key
        )
    """ if include_asset_rows else ""
    ignored_image_ids = _uuid_values(ignore_conversation_links_for_image_ids or set())
    rows = await conn.fetch(
        f"""
        WITH candidates(token) AS (
            SELECT token FROM unnest($1::text[]) AS token
        )
        SELECT candidate.token
        FROM candidates candidate
        WHERE EXISTS (
            SELECT 1
            FROM conversation_messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = $2::uuid
              AND strpos(to_jsonb(m)::text, candidate.token) > 0
        )
        OR EXISTS (
            SELECT 1
            FROM image_assets ia
            JOIN conversations c
              ON c.id = ia.conversation_id
             AND c.user_id = ia.user_id
            WHERE ia.user_id = $2::uuid
              AND candidate.token IN (
                  ia.id::text,
                  ia.original_key,
                  ia.preview_key,
                  ia.thumb_key
              )
              AND (
                  EXISTS (
                      SELECT 1
                      FROM conversation_messages linked_message
                      WHERE linked_message.id = ia.message_id
                        AND linked_message.conversation_id = c.id
                  )
                  OR (
                      ia.message_id IS NULL
                      AND NOT (ia.id = ANY($3::uuid[]))
                      AND EXISTS (
                          SELECT 1
                          FROM conversation_messages conversation_message
                          WHERE conversation_message.conversation_id = c.id
                      )
                  )
              )
        )
        OR EXISTS (
            SELECT 1
            FROM sessions s
            WHERE s.user_id = $2::uuid
              AND COALESCE(s.status, 'active') != 'deleted'
              AND (
                candidate.token = COALESCE(s.preview_key, '')
                OR strpos(COALESCE(s.meta, '{{}}'::jsonb)::text, candidate.token) > 0
              )
        )
        OR EXISTS (
            SELECT 1
            FROM project_tasks pt
            JOIN projects p ON p.id = pt.project_id
            WHERE p.user_id = $2::uuid
              AND strpos(COALESCE(pt.snapshot, '{{}}'::jsonb)::text, candidate.token) > 0
        )
        OR EXISTS (
            SELECT 1
            FROM projects p
            WHERE p.user_id = $2::uuid
              AND strpos(COALESCE(p.thumbnail, ''), candidate.token) > 0
        )
        OR EXISTS (
            SELECT 1
            FROM ppt_presentation_uploads pu
            WHERE pu.user_id = $2::uuid
              AND (
                candidate.token = COALESCE(pu.source_key, '')
                OR strpos(COALESCE(pu.slides, '[]'::jsonb)::text, candidate.token) > 0
              )
        )
        OR EXISTS (
            SELECT 1
            FROM ppt_generations pg
            WHERE pg.user_id = $2::uuid
              AND (
                strpos(COALESCE(pg.images, '[]'::jsonb)::text, candidate.token) > 0
                OR strpos(COALESCE(pg.pptx_url, ''), candidate.token) > 0
              )
        )
        OR EXISTS (
            SELECT 1
            FROM ppt_canvas_slides pcs
            WHERE strpos(COALESCE(pcs.elements_json, '[]'::jsonb)::text, candidate.token) > 0
               OR strpos(COALESCE(pcs.background, '{{}}'::jsonb)::text, candidate.token) > 0
        )
        OR EXISTS (
            SELECT 1
            FROM public_generations pg
            WHERE pg.asset_id = candidate.token
               OR strpos(COALESCE(pg.image_url, ''), candidate.token) > 0
               OR strpos(COALESCE(pg.preview_url, ''), candidate.token) > 0
               OR strpos(COALESCE(pg.thumbnail_url, ''), candidate.token) > 0
               OR strpos(COALESCE(pg.meta, '{{}}'::jsonb)::text, candidate.token) > 0
        )
        {asset_row_checks}
        """,
        normalized,
        user_id,
        ignored_image_ids,
    )
    return {str(row["token"]) for row in rows}


def _row_reference_tokens(row: dict[str, Any], *, image: bool) -> set[str]:
    tokens = {str(row.get("id") or "").strip()}
    fields = ("original_key", "preview_key", "thumb_key") if image else ("storage_key",)
    tokens.update(_row_keys(row, fields))
    return {token for token in tokens if token}


async def _stage_object_deletions(conn, *, user_id: str, keys: set[str], reason: str) -> None:
    if not keys:
        return
    await conn.execute(
        """
        INSERT INTO asset_object_deletion_queue (
            object_key, user_id, reason, status, attempts, last_error,
            next_attempt_at, updated_at
        )
        SELECT key, $2::uuid, $3, 'pending', 0, '', NOW(), NOW()
        FROM unnest($1::text[]) AS key
        ON CONFLICT (object_key) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            reason = EXCLUDED.reason,
            status = 'pending',
            next_attempt_at = LEAST(asset_object_deletion_queue.next_attempt_at, NOW()),
            updated_at = NOW()
        """,
        sorted(keys),
        user_id,
        reason[:200],
    )


def _empty_result() -> dict[str, Any]:
    return {
        "asset_rows_deleted": 0,
        "image_records_deleted": 0,
        "image_record_ids_deleted": [],
        "image_records_preserved": 0,
        "file_records_deleted": 0,
        "file_record_ids_deleted": [],
        "file_records_preserved": 0,
        "object_keys_requested": 0,
        "object_keys_deleted": 0,
        "object_keys_preserved": 0,
        "object_delete_failed": [],
        "bytes_estimated": 0,
    }


def _intent_json_default(value: Any) -> Any:
    if isinstance(value, (set, frozenset, tuple)):
        return sorted(value)
    if isinstance(value, UUID):
        return str(value)
    raise TypeError(f"unsupported cleanup intent value: {type(value).__name__}")


async def stage_record_cleanup_intent(
    conn,
    *,
    user_id: str,
    records: Any,
    reason: str,
) -> str:
    """Persist cleanup work in the same transaction that removes its owner."""
    payload = json.dumps(records, ensure_ascii=False, default=_intent_json_default)
    return str(await conn.fetchval(
        """
        INSERT INTO asset_record_cleanup_intents (
            user_id, reason, records, status, attempts, last_error,
            next_attempt_at, updated_at
        )
        VALUES ($1::uuid, $2, $3::jsonb, 'pending', 0, '', NOW(), NOW())
        RETURNING id::text
        """,
        user_id,
        reason[:200],
        payload,
    ))


async def create_record_cleanup_intent(
    *,
    user_id: str,
    records: Any,
    reason: str,
) -> str:
    """Persist an intent when the owning record is outside PostgreSQL."""
    async with acquire() as conn:
        async with conn.transaction():
            return await stage_record_cleanup_intent(
                conn,
                user_id=user_id,
                records=records,
                reason=reason,
            )


async def _mark_cleanup_intent_failed(intent_id: str, error: Exception) -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE asset_record_cleanup_intents
            SET status = 'pending',
                attempts = attempts + 1,
                last_error = $2,
                next_attempt_at = NOW()
                    + (LEAST(86400, 60 * POWER(2, LEAST(attempts, 10))) * INTERVAL '1 second'),
                updated_at = NOW()
            WHERE id = $1::uuid
            """,
            intent_id,
            str(error)[:1000],
        )


async def process_record_cleanup_intent(intent_id: str) -> dict[str, Any]:
    """Claim and process one durable cleanup intent without failing the delete API."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"""
            UPDATE asset_record_cleanup_intents
            SET status = 'processing', updated_at = NOW()
            WHERE id = $1::uuid
              AND (
                (status = 'pending' AND next_attempt_at <= NOW())
                OR (
                    status = 'processing'
                    AND updated_at <= NOW() - INTERVAL '{_INTENT_STALE_AFTER_MINUTES} minutes'
                )
              )
            RETURNING id::text, user_id::text, reason, records
            """,
            intent_id,
        )
    if not row:
        return {**_empty_result(), "cleanup_intent_id": intent_id, "deferred": True}

    records = row["records"]
    if isinstance(records, str):
        records = json.loads(records)
    try:
        if str(row["reason"] or "") == "generation-task-delete" and isinstance(records, dict):
            from repositories import task_repo

            task_id = str(records.get("task_id") or records.get("taskId") or "").strip()
            if task_id and await task_repo.get(task_id):
                await _mark_cleanup_intent_failed(
                    intent_id,
                    RuntimeError("generation task still exists"),
                )
                return {
                    **_empty_result(),
                    "cleanup_intent_id": intent_id,
                    "deferred": True,
                }
        result = await release_record_assets(
            user_id=str(row["user_id"]),
            records=records,
            reason=str(row["reason"] or "record-delete"),
            ignore_conversation_links_for_image_ids=(
                set(records.get("direct_message_asset_ids") or [])
                if isinstance(records, dict)
                else set()
            ),
        )
    except Exception as exc:
        logger.exception("record cleanup intent failed intent_id=%s", intent_id)
        await _mark_cleanup_intent_failed(intent_id, exc)
        return {
            **_empty_result(),
            "cleanup_intent_id": intent_id,
            "deferred": True,
            "cleanup_error": str(exc),
        }

    async with acquire() as conn:
        await conn.execute(
            "DELETE FROM asset_record_cleanup_intents WHERE id = $1::uuid",
            intent_id,
        )
    return {**result, "cleanup_intent_id": intent_id, "deferred": False}


async def retry_pending_record_cleanup_intents(limit: int = 100) -> dict[str, int]:
    """Retry intents left behind by a crash or a transient storage failure."""
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id::text
            FROM asset_record_cleanup_intents
            WHERE (status = 'pending' AND next_attempt_at <= NOW())
               OR (
                    status = 'processing'
                    AND updated_at <= NOW() - INTERVAL '{_INTENT_STALE_AFTER_MINUTES} minutes'
               )
            ORDER BY created_at ASC
            LIMIT $1
            """,
            max(1, min(int(limit or 100), 1000)),
        )
    processed = 0
    deferred = 0
    for row in rows:
        result = await process_record_cleanup_intent(str(row["id"]))
        if result.get("deferred"):
            deferred += 1
        else:
            processed += 1
    return {"requested": len(rows), "processed": processed, "deferred": deferred}


async def release_record_assets(
    *,
    user_id: str,
    records: Any,
    reason: str,
    ignore_conversation_links_for_image_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Release assets mentioned by records that have already been deleted.

    The operation is conservative: any surviving durable reference preserves
    the complete asset row and all of its variants.
    """
    refs = collect_asset_references(records)
    if not (refs.image_asset_ids or refs.file_asset_ids or refs.task_ids or refs.object_keys):
        return _empty_result()

    deleted_image_ids: list[str] = []
    deleted_file_ids: list[str] = []
    image_rows: list[dict] = []
    file_rows: list[dict] = []
    releasable_keys: set[str] = set()
    preserved_keys: set[str] = set()

    async with acquire() as conn:
        async with conn.transaction():
            image_rows, file_rows = await _load_candidate_rows(conn, user_id=user_id, refs=refs)
            row_tokens: set[str] = set()
            for row in image_rows:
                row_tokens.update(_row_reference_tokens(row, image=True))
            for row in file_rows:
                row_tokens.update(_row_reference_tokens(row, image=False))
            surviving_tokens = await _find_surviving_reference_tokens(
                conn,
                user_id=user_id,
                tokens=row_tokens,
                include_asset_rows=False,
                ignore_conversation_links_for_image_ids=ignore_conversation_links_for_image_ids,
            )
            deletable_image_ids = [
                str(row["id"])
                for row in image_rows
                if not (_row_reference_tokens(row, image=True) & surviving_tokens)
            ]
            deletable_file_ids = [
                str(row["id"])
                for row in file_rows
                if not (_row_reference_tokens(row, image=False) & surviving_tokens)
            ]
            if deletable_image_ids:
                deleted_image_ids = [
                    str(row["id"])
                    for row in await conn.fetch(
                        """
                        DELETE FROM image_assets
                        WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
                        RETURNING id::text
                        """,
                        user_id,
                        deletable_image_ids,
                    )
                ]
            if deletable_file_ids:
                deleted_file_ids = [
                    str(row["id"])
                    for row in await conn.fetch(
                        """
                        DELETE FROM file_assets
                        WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
                        RETURNING id::text
                        """,
                        user_id,
                        deletable_file_ids,
                    )
                ]

            owned_prefix = asset_storage.user_asset_prefix(user_id).rstrip("/") + "/"
            candidate_keys = {
                key for key in refs.object_keys if key.startswith(owned_prefix)
            }
            for row in image_rows:
                candidate_keys.update(_row_keys(row, ("original_key", "preview_key", "thumb_key")))
            for row in file_rows:
                candidate_keys.update(_row_keys(row, ("storage_key",)))
            surviving_keys = await _find_surviving_reference_tokens(
                conn,
                user_id=user_id,
                tokens=candidate_keys,
                include_asset_rows=True,
                ignore_conversation_links_for_image_ids=ignore_conversation_links_for_image_ids,
            )
            releasable_keys = candidate_keys - surviving_keys
            preserved_keys = candidate_keys & surviving_keys
            await _stage_object_deletions(
                conn,
                user_id=user_id,
                keys=releasable_keys,
                reason=reason,
            )

    storage_result = {"requested": 0, "deleted": 0, "failed": []}
    if releasable_keys:
        try:
            storage_result = await asset_storage.delete_asset_keys(
                sorted(releasable_keys),
                user_id=user_id,
                reason=reason,
                enqueue_failed=False,
            )
        except Exception as exc:
            logger.warning("asset lifecycle object deletion failed reason=%s error=%s", reason, exc)
            storage_result = {
                "requested": len(releasable_keys),
                "deleted": 0,
                "failed": [{"key": key, "error": str(exc)} for key in sorted(releasable_keys)],
            }
        failed = list(storage_result.get("failed") or [])
        failed_keys = {
            str(item.get("key") or "").strip().lstrip("/")
            for item in failed
            if str(item.get("key") or "").strip()
        }
        await storage_repo.mark_asset_object_deletions_deleted(releasable_keys - failed_keys)
        await storage_repo.mark_asset_object_deletions_failed(failed)

    deleted_image_id_set = set(deleted_image_ids)
    deleted_file_id_set = set(deleted_file_ids)
    bytes_estimated = sum(
        int(row.get("size_bytes") or 0)
        for row in image_rows
        if str(row.get("id") or "") in deleted_image_id_set
    ) + sum(
        int(row.get("size_bytes") or 0)
        for row in file_rows
        if str(row.get("id") or "") in deleted_file_id_set
    )
    if deleted_image_ids or deleted_file_ids or releasable_keys:
        await storage_repo.invalidate_user_storage_and_history_cache(user_id)
    result = {
        "asset_rows_deleted": len(deleted_image_ids) + len(deleted_file_ids),
        "image_records_deleted": len(deleted_image_ids),
        "image_record_ids_deleted": sorted(deleted_image_ids),
        "image_records_preserved": max(0, len(image_rows) - len(deleted_image_ids)),
        "file_records_deleted": len(deleted_file_ids),
        "file_record_ids_deleted": sorted(deleted_file_ids),
        "file_records_preserved": max(0, len(file_rows) - len(deleted_file_ids)),
        "object_keys_requested": len(releasable_keys | preserved_keys),
        "object_keys_deleted": int(storage_result.get("deleted") or 0),
        "object_keys_preserved": len(preserved_keys),
        "object_delete_failed": list(storage_result.get("failed") or []),
        "bytes_estimated": bytes_estimated,
    }
    if result["object_delete_failed"]:
        logger.warning("asset lifecycle retained failed object deletions: %s", result["object_delete_failed"])
    return result
