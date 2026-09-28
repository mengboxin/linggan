"""Durable, user-scoped state for a creative agent run.

LangGraph owns the transition logic. Redis keeps the resumable user-visible
state available across API and worker processes without storing image bytes.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Optional

from core.redis import get_redis


RUN_TTL_SECONDS = 24 * 60 * 60
_PREFIX = "agent_run:"

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
RUN_STATUSES = frozenset({
    "awaiting_confirmation",
    "confirmed",
    "queued",
    "executing",
    "reviewing",
    "repairing",
    "awaiting_user",
    "paused_budget",
    "paused_provider",
    "paused_asset",
    "completed",
    "failed",
    "cancelled",
})


class AgentRunTransitionError(ValueError):
    """Raised when a user attempts an invalid or stale agent-run transition."""


def _key(run_id: str) -> str:
    return f"{_PREFIX}{run_id}"


async def create_run(*, user_id: str, state: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time() * 1000)
    run = {
        "run_id": str(uuid.uuid4()),
        "user_id": str(user_id),
        "status": "awaiting_confirmation",
        "created_at": now,
        "updated_at": now,
        "timeline": [],
    }
    # The store controls identity and lifecycle fields; callers may only add
    # planning data and a deliberately small workflow snapshot.
    run.update({
        key: value for key, value in state.items()
        if key not in {"run_id", "user_id", "status", "created_at", "updated_at", "timeline"}
    })
    append_timeline(run, stage="workflow_frozen", status="completed", message="已冻结本次工作流快照。")
    append_timeline(run, stage="plan_ready", status="completed", message="已完成需求分析并生成执行方案。")
    await get_redis().set(_key(run["run_id"]), json.dumps(run, ensure_ascii=False), ex=RUN_TTL_SECONDS)
    return run


async def get_run(run_id: str, *, user_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    raw = await get_redis().get(_key(run_id))
    if not raw:
        return None
    try:
        run = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(run, dict):
        return None
    if user_id is not None and str(run.get("user_id")) != str(user_id):
        return None
    return run


async def update_run(run_id: str, *, user_id: Optional[str] = None, **patch: Any) -> Optional[dict[str, Any]]:
    run = await get_run(run_id, user_id=user_id)
    if not run:
        return None
    run.update(patch)
    run["updated_at"] = int(time.time() * 1000)
    await get_redis().set(_key(run_id), json.dumps(run, ensure_ascii=False), ex=RUN_TTL_SECONDS)
    return run


async def append_run_note(
    run_id: str,
    *,
    user_id: Optional[str] = None,
    stage: str,
    message: str,
    detail: str = "",
    **patch: Any,
) -> Optional[dict[str, Any]]:
    """Persist a concise user-visible event without changing lifecycle state."""
    run = await get_run(run_id, user_id=user_id)
    if not run:
        return None
    run.update(patch)
    append_timeline(
        run,
        stage=stage,
        status=str(run.get("status") or "queued"),
        message=message,
        detail=detail,
    )
    run["updated_at"] = int(time.time() * 1000)
    await get_redis().set(_key(run_id), json.dumps(run, ensure_ascii=False), ex=RUN_TTL_SECONDS)
    return run


def append_timeline(
    run: dict[str, Any],
    *,
    stage: str,
    status: str,
    message: str,
    detail: str = "",
) -> None:
    timeline = run.get("timeline")
    if not isinstance(timeline, list):
        timeline = []
        run["timeline"] = timeline
    timeline.append({
        "stage": str(stage)[:80],
        "status": str(status)[:32],
        "message": str(message)[:500],
        "detail": str(detail)[:1200],
        "at": int(time.time() * 1000),
    })
    # A run can retry generation. Keep enough history for a user to understand
    # what happened without allowing an unbounded Redis value.
    del timeline[:-24]


async def transition_run(
    run_id: str,
    *,
    user_id: Optional[str] = None,
    status: str,
    stage: str,
    message: str,
    detail: str = "",
    **patch: Any,
) -> Optional[dict[str, Any]]:
    if status not in RUN_STATUSES:
        raise AgentRunTransitionError(f"unknown agent run status: {status}")
    run = await get_run(run_id, user_id=user_id)
    if not run:
        return None
    current = str(run.get("status") or "")
    if current in TERMINAL_STATUSES and status != current:
        raise AgentRunTransitionError(f"agent run is already {current}")
    run.update(patch)
    run["status"] = status
    append_timeline(run, stage=stage, status=status, message=message, detail=detail)
    run["updated_at"] = int(time.time() * 1000)
    await get_redis().set(_key(run_id), json.dumps(run, ensure_ascii=False), ex=RUN_TTL_SECONDS)
    return run


async def confirm_run(
    run_id: str,
    *,
    user_id: str,
    answers: dict[str, str],
    snapshot_fingerprint: str,
) -> dict[str, Any]:
    run = await get_run(run_id, user_id=user_id)
    if not run:
        raise AgentRunTransitionError("创作计划不存在或已过期")
    if run.get("status") != "awaiting_confirmation":
        raise AgentRunTransitionError("该创作计划当前不能确认")
    expected = str(run.get("snapshot_fingerprint") or "")
    if expected and expected != str(snapshot_fingerprint or ""):
        raise AgentRunTransitionError("工作流已变化，请重新发起深度规划")
    return (await transition_run(
        run_id,
        user_id=user_id,
        status="confirmed",
        stage="user_confirmed",
        message="已确认执行方案，等待创建生成任务。",
        answers={str(key): str(value)[:500] for key, value in answers.items() if str(value).strip()},
    )) or run


async def validate_confirmed_run(
    run_id: str,
    *,
    user_id: str,
    snapshot_fingerprint: str,
) -> dict[str, Any]:
    run = await get_run(run_id, user_id=user_id)
    if not run:
        raise AgentRunTransitionError("创作计划不存在或已过期")
    if run.get("status") != "confirmed":
        raise AgentRunTransitionError("创作计划未确认或已提交")
    expected = str(run.get("snapshot_fingerprint") or "")
    if expected and expected != str(snapshot_fingerprint or ""):
        raise AgentRunTransitionError("工作流已变化，请重新发起深度规划")
    return run


async def resume_run(
    run_id: str,
    *,
    user_id: str,
    message: str = "User requested continuation.",
) -> dict[str, Any]:
    """Move a user-actionable paused run back into the module queue."""
    run = await get_run(run_id, user_id=user_id)
    if not run:
        raise AgentRunTransitionError("创作任务不存在或已过期")
    status = str(run.get("status") or "")
    if status not in {"awaiting_user", "paused_budget", "paused_provider", "paused_asset"}:
        raise AgentRunTransitionError("当前任务不处于可继续状态")
    return (await transition_run(
        run_id,
        user_id=user_id,
        status="queued",
        stage="resume_requested",
        message=message,
        intervention=None,
    )) or run
