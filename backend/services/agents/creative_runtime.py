"""Runtime bridge between the shared top-level agent and module sub-agents."""
from __future__ import annotations

from typing import Any

from services.agents.agent_run_store import create_run, get_run, transition_run, update_run
from services.agents.creative_contract import CreativeDeliveryContract, build_delivery_contract


_PPT_STAGE_MAP = {
    "pending": ("queued", "task_queued"),
    "analyzing": ("executing", "execution_started"),
    "generating_images": ("executing", "execution_started"),
    "confirmed": ("executing", "execution_started"),
    "building": ("executing", "execution_started"),
    "checkpoint": ("awaiting_user", "checkpoint"),
    "outline_done": ("awaiting_user", "checkpoint"),
    "done": ("completed", "delivery"),
    "failed": ("failed", "failed"),
}

_SPECIALIST_STAGE_MAP = {
    "pending": ("queued", "task_queued"),
    "planning": ("executing", "execution_started"),
    "generating": ("executing", "execution_started"),
    "processing": ("executing", "execution_started"),
    "running": ("executing", "execution_started"),
    "writing": ("executing", "execution_started"),
    "typesetting": ("executing", "execution_started"),
    "reviewing": ("reviewing", "quality_review"),
    "repairing": ("repairing", "repair_strategy"),
    "preview": ("awaiting_user", "checkpoint"),
    "awaiting_clarification": ("awaiting_user", "clarification"),
    "awaiting_confirmation": ("awaiting_user", "checkpoint"),
    "paused_budget": ("paused_budget", "budget_paused"),
    "paused_provider": ("paused_provider", "provider_paused"),
    "paused_asset": ("paused_asset", "asset_paused"),
    "done": ("completed", "delivery"),
    "completed": ("completed", "delivery"),
    "failed": ("failed", "failed"),
}


async def create_module_run(
    *,
    user_id: str,
    module: str,
    action: str,
    instruction: str,
    context: dict[str, Any] | None = None,
    conversation_id: str = "",
    contract: CreativeDeliveryContract | None = None,
) -> dict[str, Any]:
    """Create a top-level run for a module whose specialist starts immediately."""
    context = context or {}
    contract = contract or build_delivery_contract(
        module=module,
        action=action,
        instruction=instruction,
        context=context,
    )
    run = await create_run(
        user_id=user_id,
        state={
            "module": module,
            "action": action,
            "instruction": instruction,
            "conversation_id": conversation_id,
            "plan": {"summary": contract.summary, "delivery_contract": contract.model_dump()},
            "delivery_contract": contract.model_dump(),
            "execution_context": context,
        },
    )
    run = await transition_run(
        run["run_id"],
        user_id=user_id,
        status="confirmed",
        stage="user_confirmed",
        message="已接收创作需求，正在交给专属智能体处理。",
    ) or run
    return await transition_run(
        run["run_id"],
        user_id=user_id,
        status="queued",
        stage="task_queued",
        message="专属创作智能体已进入执行队列。",
    ) or run


def _ppt_intervention(state: dict[str, Any]) -> dict[str, Any]:
    value = state.get("intervention")
    return value if isinstance(value, dict) else {}


async def sync_ppt_run(state: dict[str, Any]) -> None:
    """Mirror durable PPT state into the common Agent Run without log spam."""
    run_id = str(state.get("agent_run_id") or "").strip()
    user_id = str(state.get("user_id") or "").strip()
    if not run_id or not user_id:
        return
    run = await get_run(run_id, user_id=user_id)
    if not run:
        return
    intervention = _ppt_intervention(state)
    status = str(state.get("status") or "pending")
    mapped_status, stage = _PPT_STAGE_MAP.get(status, ("executing", "execution_started"))
    if intervention.get("kind") == "budget":
        mapped_status, stage = "paused_budget", "budget_paused"
    elif intervention.get("kind") == "provider":
        mapped_status, stage = "paused_provider", "provider_paused"
    elif intervention.get("kind") == "asset":
        mapped_status, stage = "paused_asset", "asset_paused"
    elif intervention.get("kind") == "quality_review":
        mapped_status, stage = "awaiting_user", "quality_review"

    snapshot = {
        "job_id": state.get("job_id", ""),
        "status": status,
        "progress": state.get("progress", 0),
        "message": state.get("message", ""),
        "intervention": intervention,
    }
    previous = run.get("module_sync") if isinstance(run.get("module_sync"), dict) else {}
    if previous.get("status") == mapped_status and previous.get("stage") == stage:
        await update_run(run_id, user_id=user_id, module_state=snapshot, module_sync={"status": mapped_status, "stage": stage})
        return

    await transition_run(
        run_id,
        user_id=user_id,
        status=mapped_status,
        stage=stage,
        message=str(state.get("message") or "PPT specialist updated its state."),
        detail=str(state.get("error") or intervention.get("message") or ""),
        module_state=snapshot,
        module_sync={"status": mapped_status, "stage": stage},
        intervention=intervention or None,
    )


async def sync_specialist_run(state: dict[str, Any], *, module: str) -> None:
    """Mirror a poster or scientific-figure sub-agent into the common run."""
    run_id = str(state.get("agent_run_id") or "").strip()
    user_id = str(state.get("user_id") or "").strip()
    if not run_id or not user_id:
        return
    run = await get_run(run_id, user_id=user_id)
    if not run:
        return
    intervention = state.get("intervention") if isinstance(state.get("intervention"), dict) else {}
    raw_status = str(state.get("status") or "generating")
    mapped_status, stage = _SPECIALIST_STAGE_MAP.get(raw_status, ("executing", "execution_started"))
    if intervention.get("kind") == "budget":
        mapped_status, stage = "paused_budget", "budget_paused"
    elif intervention.get("kind") == "provider":
        mapped_status, stage = "paused_provider", "provider_paused"
    elif intervention.get("kind") == "asset":
        mapped_status, stage = "paused_asset", "asset_paused"
    snapshot = {
        "job_id": state.get("job_id", ""),
        "module": module,
        "status": raw_status,
        "progress": state.get("progress", 0),
        "message": state.get("message", ""),
        "intervention": intervention,
    }
    previous = run.get("module_sync") if isinstance(run.get("module_sync"), dict) else {}
    if previous.get("status") == mapped_status and previous.get("stage") == stage:
        await update_run(run_id, user_id=user_id, module_state=snapshot, module_sync={"status": mapped_status, "stage": stage})
        return
    await transition_run(
        run_id,
        user_id=user_id,
        status=mapped_status,
        stage=stage,
        message=str(state.get("message") or f"{module} specialist updated its state."),
        detail=str(state.get("error") or intervention.get("message") or ""),
        module_state=snapshot,
        module_sync={"status": mapped_status, "stage": stage},
        intervention=intervention or None,
    )
