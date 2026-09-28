"""Durable object references for binary queue inputs.

Redis Streams are a control plane.  Image data belongs in object storage, not
in stream fields where Base64 and JSON create several simultaneous copies.
"""
from __future__ import annotations

import logging
from typing import Any

from core.config import settings
from core.task_errors import NonRetryableTaskError
from services import asset_storage


logger = logging.getLogger(__name__)


async def persist_queue_inputs(
    *,
    user_id: str,
    task_id: str,
    inputs: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    """Store binary task inputs and return small Redis-safe references.

    ``None`` retains compatibility with local installations that do not have
    S3/R2 configured yet. Production deployments must configure object
    storage, in which case every returned reference is a few hundred bytes.
    """
    if not inputs:
        return []
    if not asset_storage.is_asset_storage_enabled():
        if settings.QUEUE_REQUIRE_ASSET_REFERENCES:
            raise RuntimeError("object storage is required for binary queue inputs")
        logger.warning(
            "queue asset storage is disabled; falling back to legacy binary payload task_id=%s",
            task_id,
        )
        return None

    references: list[dict[str, Any]] = []
    try:
        for index, item in enumerate(inputs):
            role = str(item.get("role") or "input")
            data = item.get("data") or b""
            original_name = str(item.get("filename") or "input.bin")
            # A task can include several uploads named image.png. The storage key
            # includes this filename, so make every role/index distinct.
            filename = f"{index:02d}-{role}-{original_name}"
            content_type = str(item.get("content_type") or "application/octet-stream")
            if not isinstance(data, bytes) or not data:
                raise ValueError(f"queue input {role} is empty")

            stored = await asset_storage.store_file_bytes(
                data=data,
                user_id=user_id,
                category="queue-inputs",
                task_id=task_id,
                filename=filename,
                content_type=content_type,
                retention_class="temporary",
                source_client="web",
            )
            if not stored or not stored.get("key"):
                raise RuntimeError(f"failed to store queue input {role}")
            references.append({
                "role": role,
                "file_asset_id": str(stored.get("id") or ""),
                "key": str(stored["key"]),
                "content_type": str(stored.get("mime_type") or content_type),
                "size_bytes": int(stored.get("size_bytes") or len(data)),
            })
    except Exception:
        if references:
            # Persist a cleanup intent before propagating the submission error.
            await release_consumed_queue_inputs(
                user_id=user_id,
                payload={"queue_input_assets": references},
            )
        raise
    return references


def _reference_key(reference: Any, user_id: str) -> str:
    if not isinstance(reference, dict):
        raise NonRetryableTaskError("queue asset reference is invalid")
    key = str(reference.get("key") or "").strip().lstrip("/")
    expected_prefix = asset_storage.user_asset_prefix(user_id).rstrip("/") + "/"
    if not key or not user_id or not key.startswith(expected_prefix):
        raise NonRetryableTaskError("queue asset reference is outside the task owner scope")
    return key


async def load_queue_input(reference: Any, user_id: str) -> bytes:
    """Load one referenced input after a worker has acquired an execution slot."""
    return await asset_storage.fetch_asset_key_bytes(_reference_key(reference, user_id))


def _payload_queue_input_references(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only object-store references created for the queued request."""
    references: list[dict[str, Any]] = []
    for key, value in payload.items():
        if key.endswith("_asset") and isinstance(value, dict):
            references.append(value)
        elif key.endswith("_assets") and isinstance(value, list):
            references.extend(item for item in value if isinstance(item, dict))
    return [
        {
            "file_asset_id": str(reference.get("file_asset_id") or ""),
            "storage_key": str(reference.get("key") or ""),
        }
        for reference in references
        if reference.get("file_asset_id") or reference.get("key")
    ]


async def release_consumed_queue_inputs(*, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Delete request binaries after their stream entry has been acknowledged.

    Inputs are intentionally separate from generated output assets. A durable
    cleanup intent makes a transient storage failure retryable without keeping
    the successful task message in Redis.
    """
    references = _payload_queue_input_references(payload)
    if not user_id or not references:
        return {"released": 0, "deferred": False}
    try:
        from services import asset_lifecycle

        intent_id = await asset_lifecycle.create_record_cleanup_intent(
            user_id=user_id,
            records={"queue_inputs": references},
            reason="queue-input-consumed",
        )
        return await asset_lifecycle.process_record_cleanup_intent(intent_id)
    except Exception as exc:
        logger.warning(
            "queue input cleanup scheduling failed user_id=%s refs=%s error=%s",
            user_id,
            len(references),
            exc,
        )
        return {"released": 0, "deferred": True, "cleanup_error": str(exc)}
