from __future__ import annotations

import argparse
import asyncio
import logging
from collections import defaultdict
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.pool import close_pool, init_pool
from core.config import settings
from core.pool import acquire
from repositories import conversation_repo, storage_repo
from services import asset_lifecycle, asset_storage
from services.emailer import send_html_email, storage_notice_email_html

logger = logging.getLogger(__name__)


def fmt_mb(value: int) -> str:
    return f"{value / 1024 / 1024:.1f} MB"


async def _expiring_items(days: int) -> list[dict]:
    async with acquire() as conn:
        image_rows = await conn.fetch(
            """
            SELECT ia.id::text, ia.user_id::text, u.email, 'image' AS kind,
                   COALESCE(NULLIF(ia.prompt, ''), '图片记录') AS title,
                   ia.size_bytes, ia.expires_at::text
            FROM image_assets ia
            JOIN users u ON u.id = ia.user_id
            WHERE COALESCE(ia.source_client, 'web') = 'web'
              AND COALESCE(ia.is_pinned, FALSE) = FALSE
              AND ia.expires_at IS NOT NULL
              AND ia.expires_notice_sent_at IS NULL
              AND ia.expires_at > NOW()
              AND ia.expires_at <= NOW() + ($1::int * INTERVAL '1 day')
            ORDER BY ia.expires_at ASC
            """,
            days,
        )
        ppt_rows = await conn.fetch(
            """
            SELECT pu.id::text, pu.user_id::text, u.email,
                   pu.title, pu.source_size, pu.source_key, pu.slides, pu.expires_at::text
            FROM ppt_presentation_uploads pu
            JOIN users u ON u.id = pu.user_id
            WHERE COALESCE(pu.source_client, 'web') = 'web'
              AND pu.expires_at IS NOT NULL
              AND pu.expires_notice_sent_at IS NULL
              AND pu.expires_at > NOW()
              AND pu.expires_at <= NOW() + ($1::int * INTERVAL '1 day')
            ORDER BY pu.expires_at ASC
            """,
            days,
        )
        file_rows = await conn.fetch(
            """
            SELECT fa.id::text, fa.user_id::text, u.email, 'ppt_file' AS kind,
                   COALESCE(NULLIF(fa.filename, ''), 'PPT 文件') AS title,
                   fa.size_bytes, fa.expires_at::text
            FROM file_assets fa
            JOIN users u ON u.id = fa.user_id
            WHERE COALESCE(fa.source_client, 'web') = 'web'
              AND fa.category = 'ppt'
              AND fa.expires_at IS NOT NULL
              AND fa.expires_notice_sent_at IS NULL
              AND fa.expires_at > NOW()
              AND fa.expires_at <= NOW() + ($1::int * INTERVAL '1 day')
            ORDER BY fa.expires_at ASC
            """,
            days,
        )
    rows = [dict(row) for row in image_rows]
    rows.extend(dict(row) for row in file_rows)
    for row in ppt_rows:
        data = dict(row)
        if int(data.get("source_size") or 0) or data.get("source_key"):
            rows.append({
                **data,
                "id": f"ppt-file:{data['id']}",
                "kind": "ppt_file",
                "title": f"{data.get('title') or 'PPT'} · 文件",
                "size_bytes": int(data.get("source_size") or 0),
            })
        slide_keys, slide_bytes = storage_repo._slide_keys_and_size(data.get("slides"))
        if slide_keys:
            rows.append({
                **data,
                "id": f"ppt-slides:{data['id']}",
                "kind": "ppt_slide",
                "title": f"{data.get('title') or 'PPT'} · 页面图片",
                "size_bytes": slide_bytes,
            })
    return rows


async def send_expiry_notices(base_url: str, dry_run: bool = False) -> dict:
    rows = await _expiring_items(settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS)
    by_user: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_user[row["user_id"]].append(row)

    sent_ids: list[str] = []
    for user_id, items in by_user.items():
        email = items[0].get("email", "")
        total = sum(int(item.get("size_bytes") or 0) for item in items)
        preview = "".join(
            f"<li>{item.get('title') or item.get('kind')} · {fmt_mb(int(item.get('size_bytes') or 0))} · 到期 {item.get('expires_at')}</li>"
            for item in items[:12]
        )
        if len(items) > 12:
            preview += f"<li>还有 {len(items) - 12} 项...</li>"
        body = f"""
        <p>你有 {len(items)} 项网页端云端记录将在 {settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS} 天内到期，预计释放 {fmt_mb(total)}。</p>
        <ul>{preview}</ul>
        <p>需要长期保存的内容，建议先下载或使用桌面端保存到本地。</p>
        """
        if dry_run:
            print(f"[dry-run] expiry notice to={email} items={len(items)} bytes={total}")
        else:
            await send_html_email(
                email,
                "灵感云端记录即将到期，请及时保存",
                storage_notice_email_html(
                    title="云端记录即将到期",
                    body=body,
                    action_url=f"{base_url.rstrip('/')}/storage-cleanup",
                ),
            )
            sent_ids.extend(item["id"] for item in items if not str(item.get("id") or "").startswith("ppt-"))
    if sent_ids and not dry_run:
        await storage_repo.mark_expiry_notices_sent(sent_ids)
    return {"users": len(by_user), "items": len(rows), "notified": len(sent_ids)}


def _summarize_items(items: list[dict]) -> dict:
    total = sum(int(item.get("size_bytes") or 0) for item in items)
    users = {str(item.get("user_id") or "") for item in items if item.get("user_id")}
    objects = sum(len(item.get("object_keys") or []) for item in items)
    return {"users": len(users), "items": len(items), "objects": objects, "bytes_estimated": total}


async def expired_items(limit: int = 2000) -> list[dict]:
    image_items: list[dict] = []
    file_items: list[dict] = []
    ppt_items: list[dict] = []
    async with acquire() as conn:
        image_rows = await conn.fetch(
            """
            SELECT 'image' AS kind, id::text, user_id::text, size_bytes, expires_at,
                   original_key, preview_key, thumb_key
            FROM image_assets
            WHERE COALESCE(source_client, 'web') = 'web'
              AND COALESCE(is_pinned, FALSE) = FALSE
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
            """,
            limit,
        )
        for row in image_rows:
            data = dict(row)
            data["object_keys"] = [key for key in (data.get("original_key"), data.get("preview_key"), data.get("thumb_key")) if key]
            image_items.append(data)
        file_rows = await conn.fetch(
            """
            SELECT 'ppt_file' AS kind, id::text, user_id::text, size_bytes, expires_at,
                   storage_key
            FROM file_assets
            WHERE COALESCE(source_client, 'web') = 'web'
              AND category = 'ppt'
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
            """,
            limit,
        )
        for row in file_rows:
            data = dict(row)
            data["object_keys"] = [data.get("storage_key")] if data.get("storage_key") else []
            file_items.append(data)
        ppt_rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, source_size, expires_at,
                   source_key, slides
            FROM ppt_presentation_uploads
            WHERE COALESCE(source_client, 'web') = 'web'
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
            """,
            limit,
        )
        for row in ppt_rows:
            data = dict(row)
            slide_keys, slide_bytes = storage_repo._slide_keys_and_size(data.get("slides"))
            if int(data.get("source_size") or 0) or data.get("source_key"):
                ppt_items.append({
                    **data,
                    "id": f"ppt-file:{data['id']}",
                    "kind": "ppt_file",
                    "source_upload_id": data["id"],
                    "object_keys": [data.get("source_key")] if data.get("source_key") else [],
                    "size_bytes": int(data.get("source_size") or 0),
                })
            if slide_keys:
                ppt_items.append({
                    **data,
                    "id": f"ppt-slides:{data['id']}",
                    "kind": "ppt_slide",
                    "source_upload_id": data["id"],
                    "object_keys": slide_keys,
                    "size_bytes": slide_bytes,
                })
    for group in (image_items, file_items, ppt_items):
        group.sort(key=lambda item: str(item.get("expires_at") or ""))

    items: list[dict] = []
    groups = [image_items, file_items, ppt_items]
    while len(items) < limit and any(groups):
        for group in groups:
            if group and len(items) < limit:
                items.append(group.pop(0))
    return items


async def retry_pending_cleanup(dry_run: bool = False, limit: int = 2000) -> dict:
    retry_cleanup = {"requested": 0, "deleted": 0, "failed": []}
    record_cleanup = {"requested": 0, "processed": 0, "deferred": 0}
    if not dry_run:
        record_cleanup = await asset_lifecycle.retry_pending_record_cleanup_intents(limit=min(limit, 1000))
        retry_cleanup = await asset_storage.retry_pending_asset_deletions(limit=limit)
    return {
        "objects_deleted": int(retry_cleanup.get("deleted") or 0),
        "queued_retried": int(retry_cleanup.get("requested") or 0),
        "queued_failed": len(retry_cleanup.get("failed") or []),
        "record_cleanup_processed": int(record_cleanup.get("processed") or 0),
        "record_cleanup_deferred": int(record_cleanup.get("deferred") or 0),
    }


async def cleanup_expired(dry_run: bool = False, limit: int = 2000) -> dict:
    retry_summary = await retry_pending_cleanup(dry_run, limit)
    items = await expired_items(limit)
    grouped: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        grouped[item["user_id"]].append(item)
    summary = {
        "users": len(grouped),
        "items": len(items),
        **retry_summary,
        "errors": 0,
    }
    for user_id, user_items in grouped.items():
        if dry_run:
            keys = {key for item in user_items for key in item.get("object_keys", [])}
            print(f"[dry-run] cleanup user={user_id} items={len(user_items)} keys={len(keys)}")
            continue
        try:
            candidate_keys = {key for item in user_items for key in item.get("object_keys", [])}
            await storage_repo.enqueue_asset_object_deletions(
                candidate_keys,
                user_id=user_id,
                reason="scheduled-expired-cleanup",
            )
            deleted_records = await storage_repo.delete_expired_item_records(user_id, user_items)
            keys = storage_repo.object_keys_for_deleted_records(user_items, deleted_records)
            if keys:
                cleanup = await asset_storage.delete_asset_keys_with_queue(
                    keys,
                    user_id=user_id,
                    reason="scheduled-expired-cleanup",
                )
                summary["objects_deleted"] += int(cleanup.get("deleted", 0))
                failed = cleanup.get("failed") or []
                if failed:
                    logger.warning(
                        "cleanup S3 delete failed for user=%s count=%s errors=%s",
                        user_id, len(failed), failed[:5],
                    )
            else:
                cleanup = {}
            await storage_repo.log_cleanup_run(
                mode="scheduled", user_id=user_id, items=user_items,
                cleanup={**deleted_records, **cleanup},
            )
        except Exception as exc:
            summary["errors"] += 1
            logger.error("cleanup failed for user=%s error=%s", user_id, exc)
            await storage_repo.log_cleanup_run(
                mode="scheduled", user_id=user_id, items=user_items,
                cleanup={"error": str(exc)},
                status="failed",
            )
    return summary


async def send_admin_cleanup_reminder(base_url: str, dry_run: bool = False, limit: int = 2000) -> dict:
    items = await expired_items(limit)
    summary = _summarize_items(items)
    if summary["items"] <= 0:
        return {"sent": False, "reason": "no_expired_items", **summary}

    if not dry_run and not await storage_repo.should_send_admin_notification("expired_cleanup", min_hours=20):
        return {"sent": False, "reason": "recently_sent", **summary}

    admin_email = (settings.ADMIN_EMAIL or settings.SMTP_USER or "").strip()
    preview = "".join(
        f"<li>{item.get('kind')} · {fmt_mb(int(item.get('size_bytes') or 0))} · 用户 {item.get('user_id')}</li>"
        for item in items[:12]
    )
    if len(items) > 12:
        preview += f"<li>还有 {len(items) - 12} 项...</li>"
    body = f"""
    <p>当前有 {summary['items']} 项云端记录已到期，涉及 {summary['users']} 个用户，预计可释放 {fmt_mb(int(summary['bytes_estimated']))}。</p>
    <ul>{preview}</ul>
    <p>系统定时任务会自动清理超过保留期的网页端云端记录；你也可以进入后台查看明细和清理记录。</p>
    """
    action_url = f"{base_url.rstrip('/')}/storage" if base_url else ""
    if dry_run:
        print(f"[dry-run] admin cleanup reminder to={admin_email}: {summary}")
        return {"sent": False, "dry_run": True, **summary}
    if not admin_email:
        return {"sent": False, "reason": "admin_email_not_configured", **summary}

    await send_html_email(
        admin_email,
        "灵感有到期云端记录待手动清理",
        storage_notice_email_html(
            title="有到期云端记录待手动清理",
            body=body,
            action_url=action_url,
        ),
    )
    await storage_repo.mark_admin_notification_sent("expired_cleanup", summary)
    return {"sent": True, **summary}


async def send_bucket_warning(base_url: str, dry_run: bool = False) -> dict:
    usage = await storage_repo.bucket_usage_estimate()
    if not usage.get("warning"):
        return {"warning": False, **usage}
    admin_email = (settings.ADMIN_EMAIL or settings.SMTP_USER or "").strip()
    body = f"""
    <p>当前对象存储估算用量 {fmt_mb(int(usage['used_bytes']))}，预警阈值 {fmt_mb(int(usage['warn_bytes']))}，桶额度 {fmt_mb(int(usage['quota_bytes']))}。</p>
    <p>请检查空间清理、套餐配额或准备切换新的 S3 兼容对象存储。</p>
    """
    if dry_run:
        print(f"[dry-run] admin bucket warning to={admin_email}: {usage}")
    else:
        await send_html_email(
            admin_email,
            "灵感对象存储容量预警",
            storage_notice_email_html(
                title="对象存储容量接近上限",
                body=body,
                action_url=f"{base_url.rstrip('/')}/storage",
            ),
        )
    return {"warning": True, **usage}


async def main() -> None:
    parser = argparse.ArgumentParser(description="Linggan storage retention and cleanup job")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--skip-notices", action="store_true")
    parser.add_argument("--skip-admin-reminder", action="store_true")
    parser.add_argument("--skip-admin-warning", action="store_true")
    cleanup_mode = parser.add_mutually_exclusive_group()
    cleanup_mode.add_argument(
        "--notice-only",
        action="store_true",
        help="Only send notices and warnings; do not retry pending cleanup work.",
    )
    cleanup_mode.add_argument(
        "--delete-expired",
        "--run-cleanup",
        dest="delete_expired",
        action="store_true",
        help="Destructively delete naturally expired records. --run-cleanup is a compatibility alias.",
    )
    parser.add_argument("--limit", type=int, default=2000)
    args = parser.parse_args()

    await init_pool()
    try:
        if not args.skip_notices:
            print(await send_expiry_notices(args.base_url, args.dry_run))
        if not args.skip_admin_reminder:
            print(await send_admin_cleanup_reminder(args.base_url, args.dry_run, args.limit))
        if args.delete_expired:
            print(await cleanup_expired(args.dry_run, args.limit))
        elif not args.notice_only:
            print(await retry_pending_cleanup(args.dry_run, args.limit))
        if not args.skip_admin_warning:
            print(await send_bucket_warning(args.base_url, args.dry_run))
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
