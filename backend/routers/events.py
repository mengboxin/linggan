"""
用户事件流（Server-Sent Events）
用于实时推送：
- 支付成功 payment_success
- 任务完成 task_complete
- 任务失败 task_failed
- 任务进度 task_progress
- 余额变化 balance_update
- Agent 计划创建 agent_plan_created
- Agent 步骤更新 agent_step
- Agent 计划完成 agent_plan_done
- PPT 生成进度 ppt_progress
- PPT 单页就绪 ppt_slide_ready
- PPT 单页失败 ppt_slide_error

事件契约（R8.3, R8.4, R6.1, R6.2, R7.3）：
- 所有事件通过 Redis pub/sub 频道 user_event:{uid} 发布
- Worker 在每个阶段结束调用 r.publish() 推送进度
- 推送间隔 <= 2s（R8.3）
- 前端通过 EventSource 订阅 /api/events/stream?token=xxx

前端通过 EventSource 订阅 /api/events/stream?token=xxx
（SSE 不支持自定义 headers，只能用 query 传 token）

使用 FastAPI 自带的 StreamingResponse，无需引入 sse-starlette。
"""
import asyncio
import json
import logging
from collections import defaultdict
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from core.redis import get_redis_pubsub
from core.security import decode_token
import repositories.user_repo as user_repo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/events", tags=["事件流"])

_EVENT_CHANNEL_PATTERN = "user_event:*"
_EVENT_CHANNEL_PREFIX = "user_event:"
_SUBSCRIBER_QUEUE_SIZE = 100


class _UserEventBroker:
    """Fan out one process-wide Redis pattern subscription to local SSE clients."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[tuple[str, dict]]]] = defaultdict(set)
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._pubsub = None

    async def subscribe(self, user_id: str) -> asyncio.Queue[tuple[str, dict]]:
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_SIZE)
        async with self._lock:
            self._subscribers[user_id].add(queue)
            if self._task is None or self._task.done():
                self._ready.clear()
                self._task = asyncio.create_task(self._run(), name="redis-user-event-broker")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            logger.warning("[events] Redis 事件代理尚未就绪，SSE 将依靠轮询兜底")
        return queue

    async def unsubscribe(self, user_id: str, queue: asyncio.Queue[tuple[str, dict]]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(user_id)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(user_id, None)

    async def close(self) -> None:
        async with self._lock:
            task = self._task
            self._task = None
            self._ready.clear()
            self._subscribers.clear()
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _dispatch(self, user_id: str, event_type: str, payload: dict) -> None:
        for queue in tuple(self._subscribers.get(user_id, ())):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait((event_type, payload))
            except asyncio.QueueFull:
                logger.warning("[events] 丢弃过载 SSE 事件: user_id=%s type=%s", user_id, event_type)

    async def _run(self) -> None:
        retry_delay = 1.0
        while True:
            pubsub = None
            try:
                pubsub = get_redis_pubsub().pubsub()
                self._pubsub = pubsub
                await pubsub.psubscribe(_EVENT_CHANNEL_PATTERN)
                self._ready.set()
                retry_delay = 1.0

                while True:
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0,
                    )
                    if not message or message.get("type") not in {"message", "pmessage"}:
                        continue

                    try:
                        channel = message.get("channel", "")
                        if isinstance(channel, bytes):
                            channel = channel.decode(errors="replace")
                        channel = str(channel)
                        if not channel.startswith(_EVENT_CHANNEL_PREFIX):
                            continue
                        user_id = channel[len(_EVENT_CHANNEL_PREFIX):]

                        raw_data = message.get("data")
                        if isinstance(raw_data, bytes):
                            raw_data = raw_data.decode(errors="replace")
                        payload = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
                        if not isinstance(payload, dict):
                            continue
                        self._dispatch(user_id, str(payload.get("type") or "message"), payload)
                    except Exception as exc:
                        logger.warning("[events] 忽略无法解析的 Redis 事件: %s", exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._ready.clear()
                logger.warning("[events] Redis 事件代理异常，%.0f 秒后重连: %s", retry_delay, exc)
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 15.0)
            finally:
                if self._pubsub is pubsub:
                    self._pubsub = None
                if pubsub is not None:
                    try:
                        await pubsub.punsubscribe(_EVENT_CHANNEL_PATTERN)
                        await pubsub.aclose()
                    except Exception:
                        pass


_event_broker = _UserEventBroker()


async def close_event_broker() -> None:
    await _event_broker.close()


async def _authenticate(token: str) -> dict:
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "token 无效")
    user = await user_repo.get_by_id(payload["sub"])
    if not user:
        raise HTTPException(401, "用户不存在")
    from routers.auth import _require_current_legal_acceptance

    await _require_current_legal_acceptance(user, payload)
    return user


def _format_sse(event: str, data: dict | str) -> str:
    """按 SSE 协议格式化"""
    if isinstance(data, dict):
        data_str = json.dumps(data, ensure_ascii=False)
    else:
        data_str = str(data)
    return f"event: {event}\ndata: {data_str}\n\n"


async def _event_generator(user_id: str, request: Request) -> AsyncGenerator[bytes, None]:
    """订阅 Redis pub/sub 频道 user_event:{user_id}"""
    queue = None

    try:
        # 初始连接事件
        yield b"retry: 15000\n\n"
        queue = await _event_broker.subscribe(user_id)
        yield _format_sse("connected", {"user_id": user_id}).encode("utf-8")

        last_ping = asyncio.get_event_loop().time()

        while True:
            # 客户端断开检测
            if await request.is_disconnected():
                break

            try:
                event_type, payload = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                event_type = ""
                payload = {}

            now = asyncio.get_event_loop().time()
            if event_type:
                yield _format_sse(event_type, payload).encode("utf-8")

            # 每 25 秒心跳一次，防止代理断开
            if now - last_ping >= 25:
                yield _format_sse("ping", "{}").encode("utf-8")
                last_ping = now
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.warning(f"[events] 事件流异常: {e}")
    finally:
        if queue is not None:
            await _event_broker.unsubscribe(user_id, queue)


@router.get("/stream")
async def event_stream(request: Request, token: str = Query(...)):
    """订阅当前用户的实时事件流"""
    user = await _authenticate(token)
    return StreamingResponse(
        _event_generator(user["id"], request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Nginx 禁用缓冲
            "Connection": "keep-alive",
        },
    )
