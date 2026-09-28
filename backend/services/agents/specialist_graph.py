"""LangGraph execution shell shared by durable specialist creative agents.

Specialists retain ownership of domain work such as poster planning, scientific
render repair, or editable-PPT assembly.  This graph gives every queued run a
common execution boundary and makes pause, repair, and delivery outcomes
explicit without serializing artifact bytes into graph state.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph


StateLoader = Callable[[], Awaitable[dict[str, Any] | None]]
StateExecutor = Callable[[], Awaitable[None]]


class SpecialistGraphState(TypedDict, total=False):
    module: str
    job_id: str
    load_state: StateLoader
    execute: StateExecutor
    repair: StateExecutor
    force_execute: bool
    snapshot: dict[str, Any]
    outcome: Literal["execute", "repair", "deliver", "pause", "failed"]
    error: str


def _snapshot(state: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(state, dict):
        return {}
    intervention = state.get("intervention")
    return {
        "status": str(state.get("status") or ""),
        "progress": int(state.get("progress") or 0),
        "message": str(state.get("message") or ""),
        "error": str(state.get("error") or ""),
        "intervention": intervention if isinstance(intervention, dict) else {},
    }


def _outcome(snapshot: dict[str, Any], *, repair_available: bool) -> str:
    status = str(snapshot.get("status") or "")
    intervention = snapshot.get("intervention")
    if isinstance(intervention, dict) and intervention.get("kind"):
        return "pause"
    if status in {"failed", "cancelled"}:
        return "failed"
    if status in {
        "done", "completed", "preview", "outline_done", "checkpoint",
        "awaiting_clarification", "awaiting_confirmation",
        "paused_budget", "paused_provider", "paused_asset",
    }:
        return "deliver"
    if status == "repairing" and repair_available:
        return "repair"
    return "execute"


async def _load_node(state: SpecialistGraphState) -> dict[str, Any]:
    snapshot = _snapshot(await state["load_state"]())
    if state.get("force_execute"):
        return {"snapshot": snapshot, "outcome": "execute", "force_execute": False}
    return {
        "snapshot": snapshot,
        "outcome": _outcome(snapshot, repair_available=bool(state.get("repair"))),
    }


def _after_load(state: SpecialistGraphState) -> str:
    return str(state.get("outcome") or "failed")


async def _execute_node(state: SpecialistGraphState) -> dict[str, Any]:
    try:
        await state["execute"]()
        return {}
    except Exception as exc:
        return {"error": str(exc), "outcome": "failed"}


async def _repair_node(state: SpecialistGraphState) -> dict[str, Any]:
    repair = state.get("repair")
    if not repair:
        return {"outcome": "failed", "error": "repair callback is unavailable"}
    try:
        await repair()
        return {}
    except Exception as exc:
        return {"error": str(exc), "outcome": "failed"}


async def _evaluate_node(state: SpecialistGraphState) -> dict[str, Any]:
    if state.get("outcome") == "failed" and state.get("error"):
        return {"snapshot": {"status": "failed", "error": state["error"]}, "outcome": "failed"}
    snapshot = _snapshot(await state["load_state"]())
    return {
        "snapshot": snapshot,
        "outcome": _outcome(snapshot, repair_available=bool(state.get("repair"))),
    }


def _after_evaluate(state: SpecialistGraphState) -> str:
    return str(state.get("outcome") or "failed")


def _build_graph():
    graph = StateGraph(SpecialistGraphState)
    graph.add_node("load", _load_node)
    graph.add_node("execute", _execute_node)
    graph.add_node("repair", _repair_node)
    graph.add_node("evaluate", _evaluate_node)
    graph.add_node("deliver", lambda _: {})
    graph.add_node("pause", lambda _: {})
    graph.add_node("failed", lambda _: {})
    graph.add_edge(START, "load")
    graph.add_conditional_edges(
        "load",
        _after_load,
        {"execute": "execute", "repair": "repair", "deliver": "deliver", "pause": "pause", "failed": "failed"},
    )
    graph.add_edge("execute", "evaluate")
    graph.add_edge("repair", "evaluate")
    graph.add_conditional_edges(
        "evaluate",
        _after_evaluate,
        {"execute": "execute", "repair": "repair", "deliver": "deliver", "pause": "pause", "failed": "failed"},
    )
    graph.add_edge("deliver", END)
    graph.add_edge("pause", END)
    graph.add_edge("failed", END)
    return graph.compile()


_SPECIALIST_GRAPH = _build_graph()


async def run_specialist_graph(
    *,
    module: str,
    job_id: str,
    load_state: StateLoader,
    execute: StateExecutor,
    repair: StateExecutor | None = None,
    force_execute: bool = False,
) -> dict[str, Any]:
    """Run one specialist through the shared LangGraph execution lifecycle."""
    return await _SPECIALIST_GRAPH.ainvoke({
        "module": module,
        "job_id": job_id,
        "load_state": load_state,
        "execute": execute,
        "repair": repair,
        "force_execute": force_execute,
    })
