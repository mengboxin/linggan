"""Execution ledger for image generation tasks.

This module owns the production invariants around one generated image task:
submission idempotency, pending-submit recovery, and the one-time upstream
execution claim. Route and worker modules should call this interface instead
of each carrying their own Redis key protocol.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException

from core.redis import get_redis
from core.task_errors import NonRetryableTaskError

logger = logging.getLogger(__name__)

SUBMIT_IDEMPOTENCY_TTL_SECONDS = 15 * 60
SUBMIT_IDEMPOTENCY_PENDING_TTL_SECONDS = 30
SUBMIT_IDEMPOTENCY_PENDING = "__pending__"
EXECUTION_CLAIM_TTL_SECONDS = 86_400


@dataclass(frozen=True)
class GenerateSubmitIdentity:
    user_id: str
    client_request_id: str
    model_id: str
    prompt: str
    size: str
    n: int
    llm_model_id: str
    vision_model_id: str
    conversation_id: str
    source: str
    image_hashes: list[str]
    operation_id: str = ""
    output_resolution: str = "1k"
    image_quality: str = "auto"
    make_public: bool = False


def _normalize_prompt_for_key(prompt: str) -> str:
    return " ".join((prompt or "").split())


def _digest(material: dict) -> str:
    return hashlib.sha256(json.dumps(material, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def module_submit_idempotency_key(*, module: str, user_id: str, client_request_id: str) -> str:
    """Return a stable, user-scoped idempotency key for a module start request."""
    request_id = (client_request_id or "").strip()
    if not request_id:
        return ""
    normalized_module = "".join(ch for ch in (module or "").lower() if ch.isalnum() or ch in {"_", "-"})
    if not normalized_module:
        raise ValueError("module idempotency key requires a module name")
    material = {
        "module": normalized_module,
        "user_id": str(user_id),
        "client_request_id": request_id[:160],
    }
    return f"submit:{normalized_module}:client:{_digest(material)}"


def generate_submit_idempotency_keys(identity: GenerateSubmitIdentity) -> list[str]:
    """Return the submit keys that identify one user-visible generation submit."""
    keys: list[str] = []
    client_key = (identity.client_request_id or "").strip()
    if client_key:
        material = {"user_id": identity.user_id, "client_request_id": client_key[:160]}
        keys.append(f"submit:generate:client:{identity.user_id}:{_digest(material)}")

    fingerprint_material = {
        "user_id": identity.user_id,
        "model_id": identity.model_id,
        "prompt": _normalize_prompt_for_key(identity.prompt),
        "size": identity.size,
        "output_resolution": identity.output_resolution,
        "image_quality": identity.image_quality,
        "n": identity.n,
        "llm_model_id": identity.llm_model_id,
        "vision_model_id": identity.vision_model_id,
        "conversation_id": identity.conversation_id,
        "source": identity.source,
        "image_hashes": identity.image_hashes,
        "make_public": identity.make_public,
    }
    operation_id = (identity.operation_id or "").strip()
    if operation_id:
        fingerprint_material["operation_id"] = operation_id[:160]
    keys.append(f"submit:generate:fingerprint:{identity.user_id}:{_digest(fingerprint_material)}")
    return keys


async def read_submit_record(key: str) -> Optional[dict]:
    try:
        raw = await get_redis().get(key)
        if not raw or raw == SUBMIT_IDEMPOTENCY_PENDING:
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


async def claim_submit_key(key: str) -> Optional[dict]:
    """Claim one submit key, returning an existing task record for duplicates."""
    try:
        redis = get_redis()
        claimed = await redis.set(
            key,
            SUBMIT_IDEMPOTENCY_PENDING,
            ex=SUBMIT_IDEMPOTENCY_PENDING_TTL_SECONDS,
            nx=True,
        )
        if claimed:
            return None

        for _ in range(10):
            existing = await read_submit_record(key)
            if existing and (existing.get("taskId") or existing.get("job_id")):
                existing["duplicate"] = True
                return existing
            await asyncio.sleep(0.2)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("failed to claim generate submit idempotency key: %s", exc)
        raise HTTPException(503, "提交保护暂不可用，请稍后再试") from exc

    raise HTTPException(409, "任务正在提交中，请不要重复点击")


async def forget_submit_key(key: str) -> None:
    try:
        await get_redis().delete(key)
    except Exception:
        pass


async def forget_submit_keys(keys: list[str]) -> None:
    for key in keys:
        await forget_submit_key(key)


async def claim_submit_keys(keys: list[str]) -> Optional[dict]:
    """Claim all submit keys as one ledger operation.

    If any key resolves to an existing submit record, previously claimed keys
    are released so the duplicate path does not leave stale pending entries.
    """
    claimed: list[str] = []
    try:
        for key in keys:
            duplicate = await claim_submit_key(key)
            if duplicate:
                for claimed_key in claimed:
                    await forget_submit_key(claimed_key)
                return duplicate
            claimed.append(key)
        return None
    except Exception:
        for claimed_key in claimed:
            await forget_submit_key(claimed_key)
        raise


async def remember_submit_key(key: str, record: dict) -> None:
    try:
        await get_redis().set(key, json.dumps(record, ensure_ascii=False), ex=SUBMIT_IDEMPOTENCY_TTL_SECONDS)
    except Exception:
        pass


async def remember_submit_keys(keys: list[str], record: dict) -> None:
    for key in keys:
        await remember_submit_key(key, record)


async def claim_generate_execution_once(task_id: str) -> bool:
    """Allow one worker to enter the upstream-calling generate pipeline."""
    try:
        redis = get_redis()
        return bool(await redis.set(f"task:{task_id}:generate_started", "1", ex=EXECUTION_CLAIM_TTL_SECONDS, nx=True))
    except Exception as exc:
        logger.error("[worker] generate execution lock unavailable: task_id=%s error=%s", task_id, exc)
        raise NonRetryableTaskError("生图执行保护暂不可用，已停止任务以避免重复扣费") from exc
