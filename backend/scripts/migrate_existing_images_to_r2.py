"""Migrate legacy base64 image fields in Postgres metadata into private R2 assets.

Run on the server after R2 env vars are configured:
    python scripts/migrate_existing_images_to_r2.py

Use --dry-run to count planned work without writing.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import os
import sys
from copy import deepcopy
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.pool import acquire, close_pool, init_pool
from services import asset_storage


IMAGE_KEYS = {
    "image_b64",
    "preview_b64",
    "generated_image",
    "result_image",
    "imageBase64",
    "thumbnailBase64",
    "canvasImageSnapshot",
    "canvas_image",
    "preview_base64",
    "thumbnail",
    "source_image_b64",
    "ref_image_b64",
}

URL_KEYS = {"image_url", "preview_url", "thumbnail_url", "thumb_url", "original_url", "local_image_url"}
LIST_KEYS = {
    "images",
    "image_b64s",
    "image_urls",
    "preview_b64_list",
    "slide_images_b64",
    "selected_slide_images",
    "slides",
    "versions",
}


def _legacy_file_metadata(value: str) -> tuple[bytes, str, str] | None:
    """Return a browser-safe fallback for legacy images Pillow cannot decode."""
    try:
        raw = base64.b64decode(_strip_data_url(value.strip()))
    except (binascii.Error, ValueError):
        return None
    if raw.lstrip().startswith(b"<svg"):
        return raw, "image/svg+xml", "svg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return raw, "image/webp", "webp"
    return None


def _is_existing_reference(value: str) -> bool:
    raw = value.strip()
    return (
        not raw
        or raw.startswith("/api/assets/")
        or raw.startswith("http://")
        or raw.startswith("https://")
        or raw.startswith("file:")
        or raw.startswith("blob:")
        or raw.startswith("__idb__:")
    )


def _strip_data_url(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def _looks_like_base64_image(value: Any) -> bool:
    if not isinstance(value, str) or _is_existing_reference(value):
        return False
    raw = _strip_data_url(value.strip())
    if len(raw) < 80:
        return False
    try:
        sample = raw[: min(len(raw), 4096)]
        sample += "=" * (-len(sample) % 4)
        head = base64.b64decode(sample, validate=False)
    except (binascii.Error, ValueError):
        return False
    return head.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF", b"<svg"))


def _asset_values(stored: asset_storage.StoredImageAsset | dict[str, object]) -> dict[str, str]:
    if isinstance(stored, dict):
        url = str(stored.get("url") or "")
        return {
            "file_asset_id": str(stored.get("id") or ""),
            "image_url": url,
            "preview_url": url,
            "thumbnail_url": url,
            "asset_original_key": str(stored.get("key") or ""),
        }
    return {
        "asset_id": stored.id,
        "image_url": stored.original_url,
        "preview_url": stored.preview_url,
        "thumbnail_url": stored.thumb_url,
    }


def _asset_url(stored: asset_storage.StoredImageAsset | dict[str, object], variant: str) -> str:
    if isinstance(stored, dict):
        return str(stored.get("url") or "")
    if variant == "thumb":
        return stored.thumb_url
    if variant == "original":
        return stored.original_url
    return stored.preview_url


def _apply_asset_values(target: dict[str, Any], stored: asset_storage.StoredImageAsset | dict[str, object]) -> None:
    values = _asset_values(stored)
    target.update(values)
    file_asset_id = values.get("file_asset_id")
    if not file_asset_id:
        return
    ids = [str(item) for item in target.get("file_asset_ids") or [] if str(item)]
    if file_asset_id not in ids:
        ids.append(file_asset_id)
    target["file_asset_ids"] = ids


def _session_preview_reference(meta: dict[str, Any]) -> str:
    def usable(value: Any) -> str:
        if not isinstance(value, str):
            return ""
        value = value.strip()
        if value.startswith(("/api/assets/", "http://", "https://")):
            return value
        return ""

    for key in ("thumbnail_url", "thumb_url", "thumbnailUrl", "thumbUrl", "preview_url", "previewUrl", "preview_base64"):
        if preview := usable(meta.get(key)):
            return preview
    workflow = meta.get("workflow_snapshot")
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else []
    for node in reversed(nodes if isinstance(nodes, list) else []):
        if not isinstance(node, dict):
            continue
        for key in ("thumbnailUrl", "previewUrl", "imageUrl", "imageBase64"):
            if preview := usable(node.get(key)):
                return preview
    cards = meta.get("gen_cards")
    for card in reversed(cards if isinstance(cards, list) else []):
        if not isinstance(card, dict):
            continue
        for key in ("thumbnailUrl", "previewUrl", "imageUrl", "thumbnailBase64", "imageBase64"):
            if preview := usable(card.get(key)):
                return preview
    return ""


async def _store_image(
    value: str,
    *,
    user_id: str,
    conversation_id: str | None,
    message_id: str | None,
    task_id: str,
    prompt: str,
    model_id: str,
    category: str,
    item_id: str,
) -> asset_storage.StoredImageAsset | dict[str, object] | None:
    fallback = _legacy_file_metadata(value)
    if fallback:
        raw, mime_type, extension = fallback
        return await asset_storage.store_file_bytes(
            data=raw,
            user_id=user_id,
            category="legacy-inline-images",
            task_id=task_id,
            filename=f"{item_id or 'legacy-image'}.{extension}",
            content_type=mime_type,
            retention_class="web_history",
            source_client="web",
        )

    stored = await asset_storage.store_generated_image(
        image_base64=value,
        user_id=user_id,
        conversation_id=conversation_id,
        task_id=task_id,
        prompt=prompt,
        model_id=model_id,
        category=category,
        item_id=item_id,
    )
    if stored and message_id:
        await asset_storage.attach_message(stored.id, message_id)
    if stored:
        return stored
    return None


async def _migrate_meta_images(
    obj: Any,
    *,
    user_id: str,
    conversation_id: str | None,
    message_id: str | None,
    task_id: str,
    prompt: str,
    model_id: str,
    category: str,
    path: str,
    dry_run: bool,
    max_uploads: int | None,
    stats: dict[str, int],
) -> Any:
    if max_uploads is not None and stats["uploaded"] >= max_uploads:
        return obj

    if isinstance(obj, list):
        next_items = []
        for index, item in enumerate(obj):
            next_items.append(await _migrate_meta_images(
                item,
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
                task_id=task_id,
                prompt=prompt,
                model_id=model_id,
                category=category,
                path=f"{path}.{index}",
                dry_run=dry_run,
                max_uploads=max_uploads,
                stats=stats,
            ))
        return next_items

    if not isinstance(obj, dict):
        return obj

    next_obj = dict(obj)
    for key, value in list(obj.items()):
        child_path = f"{path}.{key}"
        if key in URL_KEYS and isinstance(value, str) and value.startswith("/api/assets/"):
            continue

        if key in IMAGE_KEYS and _looks_like_base64_image(value):
            stats["found"] += 1
            if dry_run:
                continue
            stored = await _store_image(
                value,
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
                task_id=task_id,
                prompt=prompt,
                model_id=model_id,
                category=category,
                item_id=child_path.replace(".", "-"),
            )
            if stored:
                stats["uploaded"] += 1
                if key in {"preview_base64", "thumbnailBase64", "preview_b64", "thumbnail"}:
                    next_obj[key] = _asset_url(stored, "thumb")
                elif key == "canvas_image":
                    next_obj[key] = _asset_url(stored, "preview")
                else:
                    next_obj[key] = _asset_url(stored, "preview")
                _apply_asset_values(next_obj, stored)
            continue

        if key in LIST_KEYS and isinstance(value, list):
            migrated_list = []
            changed_any = False
            for index, item in enumerate(value):
                if _looks_like_base64_image(item):
                    stats["found"] += 1
                    if dry_run:
                        migrated_list.append(item)
                        continue
                    stored = await _store_image(
                        item,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        message_id=message_id,
                        task_id=task_id,
                        prompt=prompt,
                        model_id=model_id,
                        category=category,
                        item_id=f"{child_path}-{index}".replace(".", "-"),
                    )
                    if stored:
                        stats["uploaded"] += 1
                        migrated_list.append(_asset_url(stored, "preview"))
                        _apply_asset_values(next_obj, stored)
                        changed_any = True
                    else:
                        migrated_list.append(item)
                else:
                    migrated_list.append(item)
            if changed_any:
                next_obj[key] = migrated_list
                if key == "preview_b64_list" and migrated_list:
                    next_obj["preview_b64"] = migrated_list[0]
                if key == "slide_images_b64":
                    next_obj["slide_image_urls"] = migrated_list
            continue

        if isinstance(value, (dict, list)):
            next_obj[key] = await _migrate_meta_images(
                value,
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
                task_id=task_id,
                prompt=prompt,
                model_id=model_id,
                category=category,
                path=child_path,
                dry_run=dry_run,
                max_uploads=max_uploads,
                stats=stats,
            )
    return next_obj


async def migrate_conversation_messages(
    dry_run: bool,
    limit: int | None,
    max_uploads: int | None,
    batch_size: int,
) -> dict[str, int]:
    stats = {"rows": 0, "changed": 0, "found": 0, "uploaded": 0}
    async with acquire() as conn:
        offset = 0
        while limit is None or stats["rows"] < limit:
            remaining = batch_size if limit is None else min(batch_size, limit - stats["rows"])
            rows = await conn.fetch(
                """
                SELECT m.id::text AS message_id, m.conversation_id::text, c.user_id::text,
                       c.title, m.content, m.meta, m.created_at::text
                FROM conversation_messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE m.meta IS NOT NULL
                ORDER BY m.created_at ASC, m.id ASC
                LIMIT $1 OFFSET $2
                """,
                remaining,
                offset,
            )
            if not rows:
                break
            offset += len(rows)
            for row in rows:
                stats["rows"] += 1
                meta = row["meta"] or {}
                if isinstance(meta, str):
                    meta = json.loads(meta)
                original = deepcopy(meta)
                prompt = str(meta.get("prompt") or row["content"] or row["title"] or "")[:2000]
                model_id = str(meta.get("model_id") or meta.get("model") or "legacy")
                task_id = str(meta.get("task_id") or row["message_id"])
                migrated = await _migrate_meta_images(
                    meta,
                    user_id=row["user_id"],
                    conversation_id=row["conversation_id"],
                    message_id=row["message_id"],
                    task_id=task_id,
                    prompt=prompt,
                    model_id=model_id,
                    category="history",
                    path=f"message-{row['message_id']}",
                    dry_run=dry_run,
                    max_uploads=max_uploads,
                    stats=stats,
                )
                if migrated != original:
                    stats["changed"] += 1
                    if not dry_run:
                        await conn.execute(
                            "UPDATE conversation_messages SET meta = $2::jsonb WHERE id = $1::uuid",
                            row["message_id"],
                            json.dumps(migrated, ensure_ascii=False),
                        )
    return stats


async def migrate_sessions(dry_run: bool, limit: int | None, max_uploads: int | None) -> dict[str, int]:
    stats = {"rows": 0, "changed": 0, "found": 0, "uploaded": 0}
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id::text AS session_id, user_id::text, name, preview_key, meta, updated_at::text
            FROM sessions
            WHERE meta IS NOT NULL AND meta <> '{{}}'::jsonb
            ORDER BY updated_at ASC
            {f"LIMIT {int(limit)}" if limit else ""}
            """
        )
        for row in rows:
            stats["rows"] += 1
            meta = row["meta"] or {}
            if isinstance(meta, str):
                meta = json.loads(meta)
            original = deepcopy(meta)
            migrated = await _migrate_meta_images(
                meta,
                user_id=row["user_id"],
                conversation_id=None,
                message_id=None,
                task_id=row["session_id"],
                prompt=str(row["name"] or "workspace")[:2000],
                model_id="legacy-workspace",
                category="workspace",
                path=f"session-{row['session_id']}",
                dry_run=dry_run,
                max_uploads=max_uploads,
                stats=stats,
            )
            preview_reference = _session_preview_reference(migrated if isinstance(migrated, dict) else {})
            should_backfill_preview = not str(row["preview_key"] or "").strip() and bool(preview_reference)
            if migrated != original or should_backfill_preview:
                stats["changed"] += 1
                if not dry_run:
                    await conn.execute(
                        """
                        UPDATE sessions
                        SET meta = $2::jsonb,
                            preview_key = COALESCE(NULLIF(preview_key, ''), NULLIF($3, '')),
                            updated_at = NOW()
                        WHERE id = $1::uuid
                        """,
                        row["session_id"],
                        json.dumps(migrated, ensure_ascii=False),
                        preview_reference,
                    )
    return stats


async def migrate_ppt_job_states(dry_run: bool, limit: int | None, max_uploads: int | None) -> dict[str, int]:
    stats = {"rows": 0, "changed": 0, "found": 0, "uploaded": 0}
    keys: list[str] = []
    try:
        from core.redis import get_redis

        redis = get_redis()
        cursor = 0
        while True:
            cursor, batch = await redis.scan(cursor=cursor, match="ppt_job:*", count=100)
            keys.extend([key.decode() if isinstance(key, bytes) else str(key) for key in batch])
            if cursor == 0:
                break
            if limit and len(keys) >= limit:
                break
        if limit:
            keys = keys[:limit]
        for key in keys:
            raw = await redis.get(key)
            if not raw:
                continue
            stats["rows"] += 1
            state = json.loads(raw)
            original = deepcopy(state)
            job_id = key.split("ppt_job:", 1)[-1]
            migrated = await _migrate_meta_images(
                state,
                user_id=str(state.get("user_id") or ""),
                conversation_id=str(state.get("conversation_id") or "") or None,
                message_id=None,
                task_id=job_id,
                prompt=str(state.get("topic") or state.get("message") or "ppt")[:2000],
                model_id=str(state.get("image_model_id") or "legacy-ppt"),
                category="ppt",
                path=f"ppt-job-{job_id}",
                dry_run=dry_run,
                max_uploads=max_uploads,
                stats=stats,
            )
            if migrated != original:
                stats["changed"] += 1
                if not dry_run:
                    await redis.set(key, json.dumps(migrated, ensure_ascii=False), ex=3600 * 24)
    except Exception as exc:
        print(f"[WARN] skip redis ppt job migration: {exc}")
    return stats


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="count only, do not upload or update rows")
    parser.add_argument("--limit", type=int, default=None, help="limit rows per table")
    parser.add_argument("--max-uploads", type=int, default=None, help="stop after this many image uploads per table")
    parser.add_argument("--batch-size", type=int, default=25, help="rows fetched at once while migrating conversation history")
    args = parser.parse_args()

    if not asset_storage.is_asset_storage_enabled():
        raise SystemExit("R2 is not configured. Please set R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET.")

    await init_pool()
    try:
        conv_stats = await migrate_conversation_messages(
            args.dry_run,
            args.limit,
            args.max_uploads,
            max(1, min(args.batch_size, 100)),
        )
        session_stats = await migrate_sessions(args.dry_run, args.limit, args.max_uploads)
        ppt_stats = await migrate_ppt_job_states(args.dry_run, args.limit, args.max_uploads)
        mode = "DRY RUN" if args.dry_run else "MIGRATED"
        print(f"[{mode}] conversation_messages: {conv_stats}")
        print(f"[{mode}] sessions: {session_stats}")
        print(f"[{mode}] ppt_job_states: {ppt_stats}")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
