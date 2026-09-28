"""
Agent 编排路由

端点：
- POST /api/agent/plan: 分解用户指令为子任务计划
- POST /api/agent/execute: 确认并执行计划
- POST /api/agent/retry/{sub_id}: 重试失败的子任务
- POST /api/agent/skip/{sub_id}: 跳过子任务
- POST /api/agent/abort: 中止整个计划

Requirements: R7.2, R7.3, R7.4, R7.5
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.rate_limit import rate_limit, RateLimitExceeded
from models.schemas import AgentPlanRequest, AgentPlanResponse, SubTask
from routers.auth import get_current_user
from repositories import conversation_repo
from services.agents.nodes.plan import plan_node
from services.agents.creative_agent import CreativeAgent, DeepPlanRequest, DeepPlanResponse, decode_image_data_urls
from services.agents.creative_contract import propose_creative_command
from services.agents.agent_run_store import (
    AgentRunTransitionError,
    append_run_note,
    confirm_run,
    create_run,
    get_run,
    resume_run,
    transition_run,
)
from services.agents.intent_router import (
    IntentRoute,
    IntentRouteRequest,
    resolve_intent_route,
    route_intent_deterministic,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent", tags=["Agent 编排"])

# ─── 内存中的计划存储（生产环境应使用 Redis）─────────────────────────────────────
_plans: dict[str, dict[str, Any]] = {}


# ─── 请求模型 ─────────────────────────────────────────────────────────────────


class ExecuteRequest(BaseModel):
    plan_id: str = Field(..., description="计划 ID")


class BatchRequest(BaseModel):
    plan_id: str = Field(..., description="计划 ID")
    sub_task_sequence: int = Field(..., description="子任务序号")
    variant_count: int = Field(4, ge=1, le=10, description="变体数量")


class ConfirmDeepRunRequest(BaseModel):
    answers: dict[str, str] = Field(default_factory=dict)
    snapshot_fingerprint: str = Field(default="", max_length=128)


class CreativeRunMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    scope: dict[str, Any] = Field(default_factory=dict)
    persist_to_conversation: bool = True


# ─── 路由端点 ─────────────────────────────────────────────────────────────────


@router.post("/route", response_model=IntentRoute)
async def route_instruction(
    body: IntentRouteRequest,
    user: dict = Depends(get_current_user),
):
    """Route a request to a typed workflow before planning or execution."""
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})
    billed_body = body.model_copy(update={"user_id": str(user["id"])})
    return await resolve_intent_route(billed_body)


@router.post("/deep-plan", response_model=DeepPlanResponse)
async def create_deep_plan(
    body: DeepPlanRequest,
    user: dict = Depends(get_current_user),
):
    """Build a visible, confirmable work plan without exposing private reasoning."""
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)})

    try:
        body = body.model_copy(update={"user_id": str(user["id"])})
        body.image_bytes = decode_image_data_urls(body.image_data_urls)
        if body.image_roles and len(body.image_roles) != len(body.image_data_urls):
            raise HTTPException(422, "图片素材角色与图片数量不一致")
        plan = await CreativeAgent().plan(body)
        run = await create_run(
            user_id=user["id"],
            state={
                "module": plan.module,
                "action": plan.action,
                "instruction": body.instruction,
                "workflow_snapshot": body.workflow_snapshot,
                "snapshot_fingerprint": body.snapshot_fingerprint,
                "plan": plan.model_dump(exclude={"run_id", "status", "timeline"}),
                "delivery_contract": plan.delivery_contract,
                "execution_context": plan.execution_context,
                "questions": [question.model_dump() for question in plan.questions],
            },
        )
        return plan.model_copy(update={
            "run_id": run["run_id"],
            "status": run["status"],
            "timeline": run["timeline"],
            "snapshot_fingerprint": str(run.get("snapshot_fingerprint") or ""),
        })
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:
        logger.exception("deep creative plan failed user_id=%s", user["id"])
        raise HTTPException(502, "深度规划暂时不可用，请切换快速模式后重试") from exc


@router.get("/runs/{run_id}")
async def get_deep_run(run_id: str, user: dict = Depends(get_current_user)):
    """Return the concise, user-visible lifecycle of one deep creative run."""
    run = await get_run(run_id, user_id=user["id"])
    if not run:
        raise HTTPException(404, "创作计划不存在或已过期")
    return {
        key: run.get(key)
        for key in (
            "run_id", "status", "module", "action", "timeline", "task_id",
            "instruction", "error", "recovery", "intervention", "delivery", "delivery_contract",
            "module_state", "conversation_id", "updated_at", "snapshot_fingerprint",
        )
    }


@router.post("/runs/{run_id}/commands")
async def route_run_command(
    run_id: str,
    body: CreativeRunMessageRequest,
    user: dict = Depends(get_current_user),
):
    """Turn a module chat message into a bounded specialist command proposal."""
    run = await get_run(run_id, user_id=user["id"])
    if not run:
        raise HTTPException(404, "创作任务不存在或已过期")
    module = str(run.get("module") or "image_generate")
    proposal = propose_creative_command(module=module, content=body.content, scope=body.scope)
    command = {
        "kind": proposal.kind,
        "content": body.content.strip()[:1000],
        "scope": proposal.scope,
        "requires_confirmation": proposal.requires_confirmation,
    }
    await append_run_note(
        run_id,
        user_id=user["id"],
        stage="chat_command",
        message=proposal.assistant_message,
        detail=f"command={proposal.kind}",
        last_command=command,
    )

    conversation_id = str(run.get("conversation_id") or "").strip()
    if conversation_id and body.persist_to_conversation:
        try:
            await conversation_repo.add_message(
                conversation_id=conversation_id,
                role="user",
                content=body.content.strip(),
                meta={"type": "agent_command", "agent_run_id": run_id, **command},
            )
            await conversation_repo.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content=proposal.assistant_message,
                meta={
                    "type": "agent_command_proposal",
                    "agent_run_id": run_id,
                    "kind": proposal.kind,
                    "requires_confirmation": proposal.requires_confirmation,
                    "scope": proposal.scope,
                },
            )
        except Exception as exc:
            logger.warning("failed to persist agent command conversation run_id=%s error=%s", run_id, exc)

    return {
        "run_id": run_id,
        "status": run.get("status"),
        "module": module,
        "conversation_id": conversation_id,
        "proposal": proposal.model_dump(),
    }


@router.post("/runs/{run_id}/confirm")
async def confirm_deep_run(
    run_id: str,
    body: ConfirmDeepRunRequest,
    user: dict = Depends(get_current_user),
):
    try:
        run = await confirm_run(
            run_id,
            user_id=user["id"],
            answers=body.answers,
            snapshot_fingerprint=body.snapshot_fingerprint,
        )
    except AgentRunTransitionError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "run_id": run["run_id"],
        "status": run["status"],
        "answers": run.get("answers") or {},
        "execution_context": run.get("execution_context") or {},
        "timeline": run.get("timeline") or [],
    }


@router.post("/runs/{run_id}/cancel")
async def cancel_deep_run(run_id: str, user: dict = Depends(get_current_user)):
    try:
        run = await transition_run(
            run_id,
            user_id=user["id"],
            status="cancelled",
            stage="cancelled",
            message="已取消本次深度规划。",
        )
    except AgentRunTransitionError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not run:
        raise HTTPException(404, "创作计划不存在或已过期")
    return {"run_id": run_id, "status": run["status"]}


@router.post("/runs/{run_id}/resume")
async def resume_deep_run(run_id: str, user: dict = Depends(get_current_user)):
    """Record a user-approved continuation before the module queues remaining work."""
    try:
        run = await resume_run(run_id, user_id=user["id"])
    except AgentRunTransitionError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "run_id": run["run_id"],
        "status": run["status"],
        "module": run.get("module"),
        "module_state": run.get("module_state") or {},
    }


@router.post("/plan", response_model=AgentPlanResponse)
async def create_plan(
    body: AgentPlanRequest,
    user: dict = Depends(get_current_user),
):
    """
    分解用户指令为子任务计划（R7.1, R7.2）

    调用 LLM 将自然语言指令分解为可执行的 SubTask 列表。
    返回 plan_id 和 sub_tasks，状态为 awaiting_confirm。
    用户确认后调用 /execute 开始执行。
    """
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    try:
        attachments = body.context.get("attachments") if isinstance(body.context, dict) else []
        route = route_intent_deterministic(IntentRouteRequest(
            instruction=body.instruction,
            context=body.context,
            attachments=attachments if isinstance(attachments, list) else [],
            has_images=bool(body.context.get("has_images")) if isinstance(body.context, dict) else False,
            allow_model_fallback=False,
        ))
        plan_context = {**body.context, "intent_route": route.model_dump()}
        if body.client_request_id:
            plan_context["client_request_id"] = body.client_request_id
        plan_id, sub_tasks = await plan_node(
            instruction=body.instruction,
            context=plan_context,
            user_id=str(user["id"]),
        )
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(502, f"LLM 服务不可用: {str(e)}")

    # 存储计划
    _plans[plan_id] = {
        "plan_id": plan_id,
        "user_id": user["id"],
        "sub_tasks": sub_tasks,
        "status": "awaiting_confirm",
        "instruction": body.instruction,
        "routing": route.model_dump(),
    }

    return AgentPlanResponse(
        plan_id=plan_id,
        sub_tasks=sub_tasks,
        status="awaiting_confirm",
        routing=route.model_dump(),
    )


@router.post("/execute")
async def execute_plan_route(
    body: ExecuteRequest,
    user: dict = Depends(get_current_user),
):
    """
    确认并执行计划（R7.3）

    用户确认计划后调用此端点开始执行。
    执行过程通过 SSE agent_step 事件实时推送进度。
    """
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    plan = _plans.get(body.plan_id)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["user_id"] != user["id"]:
        raise HTTPException(403, "无权执行此计划")
    if plan["status"] != "awaiting_confirm":
        raise HTTPException(400, f"计划状态不允许执行: {plan['status']}")

    plan["status"] = "executing"

    # 异步执行（不阻塞响应）
    from services.agents.orchestrator import execute_plan
    import asyncio

    async def _execute_stub(sub_task: SubTask) -> dict:
        """占位执行函数（实际实现需要调用对应的工具服务）"""
        # TODO: 根据 sub_task.operation 路由到对应服务
        return {"message": f"执行完成: {sub_task.operation}"}

    # 启动后台执行
    asyncio.create_task(
        execute_plan(
            plan_id=body.plan_id,
            sub_tasks=plan["sub_tasks"],
            user_id=user["id"],
            execute_fn=_execute_stub,
        )
    )

    return {"plan_id": body.plan_id, "status": "executing"}


@router.post("/retry/{sub_id}")
async def retry_sub_task_route(
    sub_id: int,
    body: ExecuteRequest,
    user: dict = Depends(get_current_user),
):
    """重试失败的子任务（R7.4）"""
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    plan = _plans.get(body.plan_id)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["user_id"] != user["id"]:
        raise HTTPException(403, "无权操作此计划")

    from services.agents.orchestrator import retry_sub_task

    async def _execute_stub(sub_task: SubTask) -> dict:
        return {"message": f"重试完成: {sub_task.operation}"}

    try:
        result = await retry_sub_task(
            plan_id=body.plan_id,
            sub_tasks=plan["sub_tasks"],
            sub_task_sequence=sub_id,
            user_id=user["id"],
            execute_fn=_execute_stub,
        )
        return result
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/skip/{sub_id}")
async def skip_sub_task_route(
    sub_id: int,
    body: ExecuteRequest,
    user: dict = Depends(get_current_user),
):
    """跳过子任务"""
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    plan = _plans.get(body.plan_id)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["user_id"] != user["id"]:
        raise HTTPException(403, "无权操作此计划")

    from services.agents.orchestrator import skip_sub_task

    try:
        result = await skip_sub_task(
            plan_id=body.plan_id,
            sub_tasks=plan["sub_tasks"],
            sub_task_sequence=sub_id,
            user_id=user["id"],
        )
        return result
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/abort")
async def abort_plan_route(
    body: ExecuteRequest,
    user: dict = Depends(get_current_user),
):
    """中止整个计划"""
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as e:
        raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after)})

    plan = _plans.get(body.plan_id)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["user_id"] != user["id"]:
        raise HTTPException(403, "无权操作此计划")

    from services.agents.orchestrator import abort_plan

    result = await abort_plan(
        plan_id=body.plan_id,
        sub_tasks=plan["sub_tasks"],
        user_id=user["id"],
    )
    plan["status"] = "aborted"
    return result
