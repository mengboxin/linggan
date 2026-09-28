"""Queued Grok video generation."""
from __future__ import annotations

import logging

import repositories.task_repo as task_repo
from core.task_errors import NonRetryableTaskError
from services import asset_storage, queue_assets
from services.ai_client import call_video
from services.grok_output import grok_video_duration

logger = logging.getLogger(__name__)


def _reference_image_url(payload: dict, user_id: str) -> str:
    """Return the one externally fetchable image URL accepted by Grok video."""
    references = payload.get("image_assets")
    if not isinstance(references, list):
        return ""

    expected_prefix = asset_storage.user_asset_prefix(user_id).rstrip("/") + "/"
    for reference in references:
        if not isinstance(reference, dict) or str(reference.get("role") or "") != "reference":
            continue
        key = str(reference.get("key") or "").strip().lstrip("/")
        if key and key.startswith(expected_prefix):
            return asset_storage.asset_delivery_url(key)
    return ""


async def run_video_generation(task_id: str, payload: dict) -> None:
    await task_repo.set_processing(task_id, progress=8)
    model_id = str(payload.get("model_id") or "")
    prompt = str(payload.get("prompt") or "").strip()
    params = payload.get("params") or {}
    if not model_id or not prompt:
        raise RuntimeError("视频生成缺少模型或提示词")

    user_id = str(params.get("user_id") or payload.get("_queue_user_id") or "")
    reference_image_url = _reference_image_url(payload, user_id)
    if not reference_image_url:
        raise RuntimeError("视频参考图无法生成供模型读取的公网链接，请重新提交一张图片")

    await task_repo.set_progress(task_id, 20)
    task_state = await task_repo.get(task_id) or {}
    provider_request_id = str(task_state.get("_provider_request_id") or "").strip()

    async def persist_provider_request_id(request_id: str) -> bool:
        try:
            persisted = await task_repo.set_provider_request_id(task_id, request_id)
        except Exception as exc:
            raise NonRetryableTaskError(
                "视频上游任务编号保存失败，为避免重复扣费已停止自动重试"
            ) from exc
        if not persisted:
            raise NonRetryableTaskError(
                "视频上游任务编号保存失败，为避免重复扣费已停止自动重试"
            )
        return True

    video_bytes = await call_video(
        model_id,
        prompt,
        duration=grok_video_duration(params.get("duration")),
        reference_image_url=reference_image_url,
        provider_request_id=provider_request_id,
        on_provider_request_id=persist_provider_request_id,
    )
    await task_repo.set_progress(task_id, 85)
    stored = await asset_storage.store_file_bytes(
        data=video_bytes,
        user_id=user_id,
        category="generate-video",
        task_id=task_id,
        filename=f"{task_id}.mp4",
        content_type="video/mp4",
        source_client=str(params.get("source") or "web"),
        replace_task_asset=True,
    )
    result = {
        "videoUrl": (stored or {}).get("url") or "",
        "assetId": (stored or {}).get("id") or "",
        "mimeType": "video/mp4",
        "duration": grok_video_duration(params.get("duration")),
    }
    if not result["videoUrl"]:
        import base64
        result["videoBase64"] = base64.b64encode(video_bytes).decode("ascii")
    await task_repo.set_completed(task_id, result)
