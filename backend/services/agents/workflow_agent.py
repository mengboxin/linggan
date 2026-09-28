"""Shared lightweight agent primitives for generation workflows.

This module intentionally avoids a heavy framework dependency. It provides the
same core shape we need from ReAct/LangGraph-style flows: visible steps,
bounded retries, validation, and repair hints.
"""
from __future__ import annotations

import inspect
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Awaitable, Callable, Optional


AgentState = dict[str, Any]


@dataclass
class AgentStep:
    id: str
    name: str
    status: str
    message: str
    progress: int
    attempt: int = 1
    started_at: float = 0.0
    completed_at: Optional[float] = None
    result: Optional[dict[str, Any]] = None
    error: str = ""


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def ensure_agent_steps(state: AgentState) -> list[dict[str, Any]]:
    steps = state.setdefault("agent_steps", [])
    return steps if isinstance(steps, list) else []


async def set_agent_step(
    state: AgentState,
    save_state: Callable[[AgentState], Awaitable[None] | None],
    *,
    name: str,
    status: str,
    message: str,
    progress: int,
    attempt: int = 1,
    result: Optional[dict[str, Any]] = None,
    error: str = "",
) -> dict[str, Any]:
    """Append/update a visible agent step and persist the owning state."""
    steps = ensure_agent_steps(state)
    now = time.time()
    existing = next(
        (
            step
            for step in reversed(steps)
            if step.get("name") == name
            and step.get("attempt", 1) == attempt
        ),
        None,
    )
    if existing is None:
        existing = asdict(
            AgentStep(
                id=str(uuid.uuid4()),
                name=name,
                status=status,
                message=message,
                progress=progress,
                attempt=attempt,
                started_at=now,
                result=result,
                error=error,
            )
        )
        steps.append(existing)
    else:
        existing.update({
            "status": status,
            "message": message,
            "progress": progress,
            "result": result,
            "error": error,
        })
    if status in {"completed", "failed", "skipped"}:
        existing["completed_at"] = now
    state["message"] = message
    state["progress"] = max(0, min(100, int(progress)))
    await maybe_await(save_state(state))
    return existing


async def run_with_retries(
    *,
    state: AgentState,
    save_state: Callable[[AgentState], Awaitable[None] | None],
    step_name: str,
    start_progress: int,
    end_progress: int,
    max_attempts: int,
    action: Callable[[int, Optional[str]], Awaitable[Any]],
    repair: Optional[Callable[[int, str], Awaitable[None]]] = None,
    running_message: Callable[[int], str] | str = "智能体正在执行...",
    success_message: str = "智能体步骤完成",
    failure_message: str = "智能体步骤失败",
) -> Any:
    """Run an action with visible retry and optional repair callback."""
    last_error: Optional[str] = None
    for attempt in range(1, max(1, max_attempts) + 1):
        progress = start_progress + int((attempt - 1) / max(max_attempts, 1) * max(end_progress - start_progress, 0))
        msg = running_message(attempt) if callable(running_message) else running_message
        await set_agent_step(
            state,
            save_state,
            name=step_name,
            status="running",
            message=msg,
            progress=progress,
            attempt=attempt,
        )
        try:
            result = await action(attempt, last_error)
            await set_agent_step(
                state,
                save_state,
                name=step_name,
                status="completed",
                message=success_message,
                progress=end_progress,
                attempt=attempt,
            )
            return result
        except Exception as exc:
            last_error = str(exc) or repr(exc)
            await set_agent_step(
                state,
                save_state,
                name=step_name,
                status="failed" if attempt >= max_attempts else "running",
                message=(
                    f"{failure_message}：{last_error}"
                    if attempt >= max_attempts
                    else f"{failure_message}，正在自我修复后重试（{attempt}/{max_attempts}）"
                ),
                progress=min(end_progress, progress + 1),
                attempt=attempt,
                error=last_error,
            )
            if attempt < max_attempts and repair:
                await repair(attempt, last_error)
    raise RuntimeError(last_error or failure_message)


def compact_steps(steps: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    """Return a UI-friendly tail of agent steps."""
    return steps[-limit:] if len(steps) > limit else steps
