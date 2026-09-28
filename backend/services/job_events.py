from __future__ import annotations

import json
import logging

from core.task_errors import to_user_error_message

logger = logging.getLogger(__name__)


def compact_image_versions(items: list[dict]) -> list[dict]:
    compact: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        for key in ("renderedB64", "rendered_b64", "imageBase64", "image_b64"):
            next_item.pop(key, None)
        compact.append(next_item)
    return compact


async def publish_task_progress(redis_client, task_id: str, state: dict) -> None:
    user_id = state.get("_user_id")
    if not user_id:
        return
    payload = {
        "type": "task_progress",
        "task_id": task_id,
        "status": state.get("status", "pending"),
        "progress": int(state.get("progress") or 0),
        "message": state.get("message") or "",
    }
    await redis_client.publish(
        f"user_event:{user_id}",
        json.dumps(payload, ensure_ascii=False),
    )


async def publish_job_update(
    state: dict,
    *,
    job_type: str,
    job_id: str | None = None,
) -> None:
    user_id = state.get("user_id")
    if not user_id:
        return
    status = str(state.get("status") or "")
    if not status:
        return

    payload = {
        "type": "job_update",
        "job_type": job_type,
        "job_id": job_id or state.get("job_id") or "",
        "status": status,
        "progress": state.get("progress", 0),
        "message": state.get("message", ""),
        "error": to_user_error_message(state.get("error", "")) if state.get("error") else "",
    }

    try:
        from core.redis import get_redis

        await get_redis().publish(f"user_event:{user_id}", json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.warning("publish job update failed job_type=%s job_id=%s: %s", job_type, payload["job_id"], exc)
