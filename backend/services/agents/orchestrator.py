"""
Agent Orchestrator — LangGraph 多步指令编排器

@ported-from https://github.com/11cafe/jaaz (server/services/langgraph_service/agent_service.py)
@original-license MIT
@modifications
  - R7.3: 替换 websocket 为 Redis pubsub SSE（user_event:{uid}）
  - 剔除 jaaz 专属工具（Imagen/Veo），保留状态机逻辑
  - 改造为 PixelScribe 工具集
  - 添加 execute_plan 主循环 + retry/skip/abort（R7.3, R7.4）
  - 添加 batch variants 并行执行（R7.5）
  - 每步发布 SSE agent_step 事件

Requirements: R7.3, R7.4, R7.5, R13.1, R13.2, R13.6
"""

import asyncio
import json
import logging
import time
from typing import Any, Literal, Optional

from core.config import settings
from core.concurrency import gather_limited
from core.redis import get_redis
from models.schemas import SubTask

logger = logging.getLogger(__name__)

# ─── 常量 ─────────────────────────────────────────────────────────────────────

SUBTASK_TIMEOUT = 120  # 单步超时 120s（R7.4）
MAX_RETRIES = 3        # 最大重试次数（R7.4）
MAX_BATCH_VARIANTS = 10  # 最大并行变体数（R7.5）


# ─── SSE 事件发布 ─────────────────────────────────────────────────────────────


async def _publish_event(user_id: str, event: dict[str, Any]) -> None:
    """发布 SSE 事件到用户频道"""
    try:
        r = get_redis()
        await r.publish(
            f"user_event:{user_id}",
            json.dumps(event),
        )
    except Exception as e:
        logger.warning(f"[agent] 发布事件失败: {e}")


async def publish_agent_step(
    user_id: str,
    plan_id: str,
    sub_task: SubTask,
    status: str,
    result: Optional[Any] = None,
    error: Optional[str] = None,
    variant_index: Optional[int] = None,
) -> None:
    """发布 agent_step SSE 事件"""
    await _publish_event(user_id, {
        "type": "agent_step",
        "plan_id": plan_id,
        "sub_task_id": sub_task.sequence,
        "operation": sub_task.operation,
        "target": sub_task.target,
        "status": status,
        "result": result,
        "error": error,
        "variant_index": variant_index,
        "timestamp": time.time(),
    })


# ─── 执行计划主循环 ───────────────────────────────────────────────────────────


async def execute_plan(
    plan_id: str,
    sub_tasks: list[SubTask],
    user_id: str,
    execute_fn: Any,  # async (sub_task: SubTask) -> Any
) -> dict[str, Any]:
    """
    执行计划主循环（R7.3, R7.4）

    遍历 sub_tasks 列表，依次执行每个子任务：
    - 每个 sub_task 包裹 120s 超时
    - 失败 retries < 3 → 标记 pending 重试
    - retries = 3 → 标记 failed + status='paused'
    - 每步发布 SSE agent_step 事件

    参数:
        plan_id: 计划 ID
        sub_tasks: 子任务列表
        user_id: 用户 ID
        execute_fn: 执行单个子任务的异步函数

    返回:
        执行结果摘要
    """
    results: list[dict[str, Any]] = []
    paused = False

    for task in sub_tasks:
        if paused:
            task.status = "skipped"
            results.append({"sequence": task.sequence, "status": "skipped"})
            continue

        # 发布开始事件
        task.status = "running"
        await publish_agent_step(user_id, plan_id, task, "running")

        # 执行（带超时和重试）
        success = False
        while task.retries < MAX_RETRIES and not success:
            try:
                result = await asyncio.wait_for(
                    execute_fn(task),
                    timeout=SUBTASK_TIMEOUT,
                )
                task.status = "completed"
                task.result = result
                success = True

                await publish_agent_step(
                    user_id, plan_id, task, "completed", result=result
                )
                results.append({
                    "sequence": task.sequence,
                    "status": "completed",
                    "result": result,
                })

            except asyncio.TimeoutError:
                task.retries += 1
                error_msg = f"子任务超时（>{SUBTASK_TIMEOUT}s），重试 {task.retries}/{MAX_RETRIES}"
                task.error = error_msg
                logger.warning(f"[agent] {error_msg}: plan_id={plan_id}, seq={task.sequence}")

                if task.retries >= MAX_RETRIES:
                    task.status = "failed"
                    paused = True
                    await publish_agent_step(
                        user_id, plan_id, task, "failed", error=error_msg
                    )
                    results.append({
                        "sequence": task.sequence,
                        "status": "failed",
                        "error": error_msg,
                    })

            except Exception as e:
                task.retries += 1
                error_msg = f"子任务执行失败: {str(e)}"
                task.error = error_msg
                logger.error(f"[agent] {error_msg}: plan_id={plan_id}, seq={task.sequence}")

                if task.retries >= MAX_RETRIES:
                    task.status = "failed"
                    paused = True
                    await publish_agent_step(
                        user_id, plan_id, task, "failed", error=error_msg
                    )
                    results.append({
                        "sequence": task.sequence,
                        "status": "failed",
                        "error": error_msg,
                    })

    overall_status = "paused" if paused else "completed"
    await _publish_event(user_id, {
        "type": "agent_plan_done",
        "plan_id": plan_id,
        "status": overall_status,
        "results": results,
    })

    return {"plan_id": plan_id, "status": overall_status, "results": results}


# ─── Retry / Skip / Abort ────────────────────────────────────────────────────


async def retry_sub_task(
    plan_id: str,
    sub_tasks: list[SubTask],
    sub_task_sequence: int,
    user_id: str,
    execute_fn: Any,
) -> dict[str, Any]:
    """重试指定子任务（R7.4）"""
    task = next((t for t in sub_tasks if t.sequence == sub_task_sequence), None)
    if not task:
        raise ValueError(f"子任务不存在: sequence={sub_task_sequence}")

    if task.status != "failed":
        raise ValueError(f"只能重试失败的子任务，当前状态: {task.status}")

    # 重置重试计数
    task.retries = 0
    task.status = "pending"
    task.error = None

    # 重新执行
    try:
        result = await asyncio.wait_for(execute_fn(task), timeout=SUBTASK_TIMEOUT)
        task.status = "completed"
        task.result = result
        await publish_agent_step(user_id, plan_id, task, "completed", result=result)
        return {"sequence": task.sequence, "status": "completed", "result": result}
    except Exception as e:
        task.status = "failed"
        task.error = str(e)
        task.retries = 1
        await publish_agent_step(user_id, plan_id, task, "failed", error=str(e))
        return {"sequence": task.sequence, "status": "failed", "error": str(e)}


async def skip_sub_task(
    plan_id: str,
    sub_tasks: list[SubTask],
    sub_task_sequence: int,
    user_id: str,
) -> dict[str, Any]:
    """跳过指定子任务"""
    task = next((t for t in sub_tasks if t.sequence == sub_task_sequence), None)
    if not task:
        raise ValueError(f"子任务不存在: sequence={sub_task_sequence}")

    task.status = "skipped"
    await publish_agent_step(user_id, plan_id, task, "skipped")
    return {"sequence": task.sequence, "status": "skipped"}


async def abort_plan(
    plan_id: str,
    sub_tasks: list[SubTask],
    user_id: str,
) -> dict[str, Any]:
    """中止整个计划"""
    for task in sub_tasks:
        if task.status in ("pending", "running"):
            task.status = "aborted"

    await _publish_event(user_id, {
        "type": "agent_plan_done",
        "plan_id": plan_id,
        "status": "aborted",
    })
    return {"plan_id": plan_id, "status": "aborted"}


# ─── Batch Variants 并行执行（R7.5）─────────────────────────────────────────────


async def execute_batch(
    plan_id: str,
    sub_task: SubTask,
    variant_count: int,
    user_id: str,
    execute_fn: Any,
) -> list[dict[str, Any]]:
    """
    并行执行多个变体（R7.5）

    参数:
        plan_id: 计划 ID
        sub_task: 要执行的子任务
        variant_count: 变体数量（1-10）
        user_id: 用户 ID
        execute_fn: 执行函数 async (sub_task, variant_index) -> Any

    返回:
        变体结果列表
    """
    if variant_count < 1 or variant_count > MAX_BATCH_VARIANTS:
        raise ValueError(f"variant_count 必须在 1-{MAX_BATCH_VARIANTS} 之间")

    async def _run_variant(index: int) -> dict[str, Any]:
        try:
            result = await asyncio.wait_for(
                execute_fn(sub_task, index),
                timeout=SUBTASK_TIMEOUT,
            )
            await publish_agent_step(
                user_id, plan_id, sub_task, "completed",
                result=result, variant_index=index,
            )
            return {"variant_index": index, "status": "completed", "result": result}
        except Exception as e:
            await publish_agent_step(
                user_id, plan_id, sub_task, "failed",
                error=str(e), variant_index=index,
            )
            return {"variant_index": index, "status": "failed", "error": str(e)}

    # 并行执行所有变体
    results = await gather_limited(
        range(variant_count),
        settings.TASK_FANOUT_CONCURRENCY,
        _run_variant,
    )

    return list(results)
