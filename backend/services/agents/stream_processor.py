"""
Stream Processor — Agent 流式事件处理器

@ported-from https://github.com/11cafe/jaaz (server/services/langgraph_service/StreamProcessor.py)
@original-license MIT
@modifications
  - R7.3: 替换 websocket send_to_websocket 为 Redis pubsub user_event:{uid}
  - 简化为纯事件发布器（不再管理 LangGraph stream）

Requirements: R7.3, R13.1, R13.2
"""

import json
import logging
import time
from typing import Any

from core.redis import get_redis

logger = logging.getLogger(__name__)


class StreamProcessor:
    """
    Agent 流式事件处理器。

    将 Agent 执行过程中的事件发布到 Redis pubsub，
    前端通过 SSE 订阅 user_event:{uid} 频道接收。
    """

    def __init__(self, user_id: str):
        self.user_id = user_id
        self.channel = f"user_event:{user_id}"

    async def publish(self, event_type: str, data: dict[str, Any]) -> None:
        """发布事件到用户频道"""
        try:
            r = get_redis()
            event = {
                "type": event_type,
                "timestamp": time.time(),
                **data,
            }
            await r.publish(self.channel, json.dumps(event))
        except Exception as e:
            logger.warning(f"[stream_processor] 发布事件失败: {e}")

    async def on_plan_created(self, plan_id: str, sub_tasks: list[dict]) -> None:
        """计划创建事件"""
        await self.publish("agent_plan_created", {
            "plan_id": plan_id,
            "sub_tasks": sub_tasks,
            "status": "awaiting_confirm",
        })

    async def on_step_start(self, plan_id: str, sequence: int, operation: str) -> None:
        """子任务开始事件"""
        await self.publish("agent_step", {
            "plan_id": plan_id,
            "sequence": sequence,
            "operation": operation,
            "status": "running",
        })

    async def on_step_complete(self, plan_id: str, sequence: int, result: Any) -> None:
        """子任务完成事件"""
        await self.publish("agent_step", {
            "plan_id": plan_id,
            "sequence": sequence,
            "status": "completed",
            "result": result,
        })

    async def on_step_failed(self, plan_id: str, sequence: int, error: str) -> None:
        """子任务失败事件"""
        await self.publish("agent_step", {
            "plan_id": plan_id,
            "sequence": sequence,
            "status": "failed",
            "error": error,
        })

    async def on_plan_done(self, plan_id: str, status: str) -> None:
        """计划完成事件"""
        await self.publish("agent_plan_done", {
            "plan_id": plan_id,
            "status": status,
        })

    async def on_error(self, error: str) -> None:
        """错误事件"""
        await self.publish("agent_error", {
            "error": error,
        })
