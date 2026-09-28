"""
Redis Streams 消息队列
支持：
  - 多种任务类型（segmentation / generate / layer-edit / inpainting）
  - 优先级队列（high / normal / low）
  - 消费者组（Consumer Group），支持多实例部署
  - 消息确认（ACK）与死信队列（DLQ）
  - 任务重试（最多 3 次）
"""
import json
import os
import time
import uuid
import logging
from typing import Any, Optional

from core.redis import get_redis
from core.config import settings
from core.user_context import get_current_billing_mode

logger = logging.getLogger(__name__)


def _positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default

# ─── 常量 ──────────────────────────────────────────────────────────────────────

STREAM_HIGH   = "queue:high"    # 高优先级流
STREAM_NORMAL = "queue:normal"  # 普通优先级流
STREAM_LOW    = "queue:low"     # 低优先级流
STREAM_DLQ    = "queue:dlq"     # 死信队列

CONSUMER_GROUP = "workers"      # 消费者组名称
MAX_RETRIES    = 3              # 最大重试次数
CLAIM_IDLE_MS  = 300_000        # 300 秒（5分钟）未 ACK 则重新分配
QUEUE_GLOBAL_MAX_ENTRIES = _positive_int_env("QUEUE_GLOBAL_MAX_ENTRIES", 10_000)
TASK_ACTIVE_SLOT_TTL_SECONDS = max(3600, int(settings.TASK_STATE_TTL_SECONDS))
NO_RECLAIM_TASK_TYPES = {"generate", "generate-video"}
LOCKED_RECLAIM_TASK_TYPES = {"poster", "poster-refine", "sci-fig", "sci-fig-refine", "paper-plan", "paper-write"}

_ACK_DELETE_STREAM_MESSAGE_SCRIPT = """
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if tonumber(acknowledged) == 0 then
    return 0
end
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
"""

_MOVE_STREAM_MESSAGE_SCRIPT = """
local destination_id = redis.call('XADD', KEYS[2], '*', unpack(ARGV, 3))
local acknowledged = redis.pcall('XACK', KEYS[1], ARGV[1], ARGV[2])
if type(acknowledged) == 'table' and acknowledged.err then
    redis.call('XDEL', KEYS[2], destination_id)
    return redis.error_reply(acknowledged.err)
end
if tonumber(acknowledged) == 0 then
    redis.call('XDEL', KEYS[2], destination_id)
    return {0, ''}
end
redis.call('XDEL', KEYS[1], ARGV[2])
return {1, destination_id}
"""

_ENQUEUE_WITH_CAPACITY_SCRIPT = """
local total = 0
for _, stream in ipairs(KEYS) do
    total = total + redis.call('XLEN', stream)
end
if total >= tonumber(ARGV[1]) then
    return {0, tostring(total)}
end
local message_id = redis.call('XADD', ARGV[2], '*', unpack(ARGV, 3))
return {1, message_id}
"""

_CAPACITY_STREAMS = (STREAM_HIGH, STREAM_NORMAL, STREAM_LOW, "queue:image2", "queue:image-heavy")

PRIORITY_MAP = {
    "high":   STREAM_HIGH,
    "normal": STREAM_NORMAL,
    "low":    STREAM_LOW,
}

# 任务类型 → 默认优先级
TASK_PRIORITY = {
    "segmentation": "normal",
    "segmentation-partial": "normal",
    "generate":     "normal",
    "generate-video": "normal",
    "poster":       "normal",
    "poster-refine": "normal",
    "sci-fig":      "normal",
    "sci-fig-refine": "normal",
    "layer-edit":   "normal",
    "touch-replace": "normal",
    "touch-recolor": "normal",
    "touch-remove": "normal",
    "icon-alternatives": "normal",
    "ppt-start": "normal",
    "ppt-confirm-outline-direct": "normal",
    "ppt-confirm-outline-images": "normal",
    "ppt-post-checkpoint": "normal",
    "ppt-slide-render": "normal",
    "ppt-direct-slide-render": "normal",
    "paper-plan": "normal",
    "paper-write": "normal",
    "batch":        "low",
}


def _locked_job_keys(task_type: str, job_id: str) -> tuple[str, str]:
    if task_type.startswith("sci-fig"):
        state_key = f"sci_fig_job:{job_id}"
    elif task_type.startswith("paper"):
        state_key = f"paper_job:{job_id}"
    else:
        state_key = f"poster_job:{job_id}"
    return state_key, f"{state_key}:running"


# ─── 初始化消费者组 ────────────────────────────────────────────────────────────

async def ensure_consumer_groups():
    """确保所有流的消费者组存在（应用启动时调用）"""
    r = get_redis()
    for stream in [STREAM_HIGH, STREAM_NORMAL, STREAM_LOW, STREAM_DLQ]:
        try:
            # MKSTREAM 自动创建流
            await r.xgroup_create(stream, CONSUMER_GROUP, id="0", mkstream=True)
            logger.info(f"[queue] 消费者组已创建: {stream}/{CONSUMER_GROUP}")
        except Exception as e:
            if "BUSYGROUP" in str(e):
                pass  # 已存在，忽略
            else:
                logger.warning(f"[queue] 创建消费者组失败 {stream}: {e}")


async def cleanup_idle_consumer(consumer_name: str) -> None:
    """Remove this worker's consumer metadata only when it owns no pending work."""
    r = get_redis()
    for stream in [STREAM_HIGH, STREAM_NORMAL, STREAM_LOW]:
        try:
            pending = await r.xpending_range(
                stream,
                CONSUMER_GROUP,
                min="-",
                max="+",
                count=1,
                consumername=consumer_name,
            )
            if pending:
                logger.warning(
                    "[queue] 保留仍有 pending 的消费者: stream=%s consumer=%s",
                    stream,
                    consumer_name,
                )
                continue
            await r.xgroup_delconsumer(stream, CONSUMER_GROUP, consumer_name)
        except Exception as e:
            logger.warning(
                "[queue] 清理消费者失败: stream=%s consumer=%s error=%s",
                stream,
                consumer_name,
                e,
            )


# ─── 用户级并发限制（R8.1, R8.2）─────────────────────────────────────────────

MAX_USER_ACTIVE_TASKS = 10  # 每用户最多 10 个活跃任务


class UserConcurrencyExceeded(Exception):
    """用户活跃任务数超过上限"""
    def __init__(self, user_id: str, current: int, limit: int):
        self.user_id = user_id
        self.current = current
        self.limit = limit
        super().__init__(
            f"User {user_id} has {current} active tasks (limit={limit})"
        )


class QueueCapacityExceeded(Exception):
    def __init__(self, current: int, limit: int):
        self.current = current
        self.limit = limit
        super().__init__(f"Global task queue has {current} active entries (limit={limit})")


async def _prune_user_active_slots(user_id: str) -> int:
    """Drop finished, missing, or malformed task ids before counting active work."""
    r = get_redis()
    key = f"task:user:{user_id}:active"
    task_ids = await r.smembers(key)
    if not task_ids:
        return 0

    stale_ids: list[str] = []
    active_count = 0
    for task_id in task_ids:
        try:
            raw = await r.get(f"task:{task_id}")
            if not raw:
                if await r.exists(f"task:active_slot:{task_id}"):
                    active_count += 1
                else:
                    stale_ids.append(task_id)
                continue
            task = json.loads(raw)
            if task.get("status") in {"pending", "processing"}:
                active_count += 1
            else:
                stale_ids.append(task_id)
        except Exception:
            stale_ids.append(task_id)

    if stale_ids:
        await r.srem(key, *stale_ids)
    return active_count


async def reserve_user_slot(user_id: str, task_id: str) -> None:
    """
    检查并预留用户活跃任务槽位。

    如果用户活跃任务数 >= MAX_USER_ACTIVE_TASKS，抛出 UserConcurrencyExceeded。
    否则将 task_id 加入用户活跃集合。

    Redis key: task:user:{uid}:active (SET)
    """
    r = get_redis()
    key = f"task:user:{user_id}:active"

    current_count = await _prune_user_active_slots(user_id)
    if current_count >= MAX_USER_ACTIVE_TASKS:
        raise UserConcurrencyExceeded(user_id, current_count, MAX_USER_ACTIVE_TASKS)

    await r.sadd(key, task_id)
    await r.set(f"task:active_slot:{task_id}", user_id, ex=TASK_ACTIVE_SLOT_TTL_SECONDS)
    # The slot must remain aligned with its task state while it waits in queue.
    await r.expire(key, TASK_ACTIVE_SLOT_TTL_SECONDS)
    logger.debug(f"[queue] reserve_user_slot: user={user_id} task={task_id} active={current_count + 1}")


async def release_user_slot(user_id: str, task_id: str) -> None:
    """
    释放用户活跃任务槽位（任务完成/失败/取消时调用）。

    从 task:user:{uid}:active 集合中移除 task_id。
    """
    r = get_redis()
    key = f"task:user:{user_id}:active"
    await r.srem(key, task_id)
    await r.delete(f"task:active_slot:{task_id}")
    logger.debug(f"[queue] release_user_slot: user={user_id} task={task_id}")


async def get_user_active_count(user_id: str) -> int:
    """获取用户当前活跃任务数"""
    return await _prune_user_active_slots(user_id)


async def _enqueue_with_capacity(r, stream: str, message: dict) -> str:
    result = await r.eval(
        _ENQUEUE_WITH_CAPACITY_SCRIPT,
        len(_CAPACITY_STREAMS),
        *_CAPACITY_STREAMS,
        QUEUE_GLOBAL_MAX_ENTRIES,
        stream,
        *_message_values(message),
    )
    accepted = bool(result and int(result[0] or 0) > 0)
    if not accepted:
        current = int(result[1] or 0) if result and len(result) > 1 else QUEUE_GLOBAL_MAX_ENTRIES
        raise QueueCapacityExceeded(current, QUEUE_GLOBAL_MAX_ENTRIES)
    return str(result[1])


# ─── 入队 ──────────────────────────────────────────────────────────────────────

async def enqueue(
    task_type: str,
    task_id: str,
    payload: dict[str, Any],
    priority: Optional[str] = None,
    user_id: Optional[str] = None,
) -> str:
    """
    将任务推入消息队列。
    如果提供了 user_id，会先检查并发限制（R8.1）。
    返回 Redis Stream 消息 ID。
    """
    r = get_redis()

    # 用户并发限制检查（R8.1）
    slot_reserved = False
    if user_id:
        await reserve_user_slot(user_id, task_id)
        slot_reserved = True

    p = priority or TASK_PRIORITY.get(task_type, "normal")
    stream = PRIORITY_MAP.get(p, STREAM_NORMAL)

    message = {
        "task_id":   task_id,
        "task_type": task_type,
        "payload":   json.dumps(payload, ensure_ascii=False),
        "enqueue_at": str(time.time()),
        "retries":   "0",
    }
    if user_id:
        message["user_id"] = user_id
    billing_mode = get_current_billing_mode()
    if billing_mode:
        message["billing_mode"] = billing_mode

    execution_target = ""
    if _should_use_go_image_heavy_worker(task_type, payload):
        execution_target = "go-image-heavy"
    elif _should_use_go_image2_worker(task_type, payload):
        execution_target = "go-image2"
    try:
        if execution_target or _should_use_go_control_plane(task_type):
            msg_id = await _enqueue_via_go_control_plane(
                task_id=task_id,
                task_type=task_type,
                user_id=user_id or "",
                priority=p,
                payload=payload,
                billing_mode=billing_mode or "",
                execution_target=execution_target,
            )
        else:
            msg_id = await _enqueue_with_capacity(r, stream, message)
    except Exception:
        if slot_reserved and user_id:
            await release_user_slot(user_id, task_id)
        raise
    logger.info(f"[queue] 入队: task_id={task_id} type={task_type} priority={p} msg_id={msg_id}")
    return msg_id


def _should_use_go_control_plane(task_type: str) -> bool:
    enabled_types = {
        value.strip()
        for value in settings.GO_CONTROL_PLANE_TASK_TYPES.split(",")
        if value.strip()
    }
    return bool(settings.GO_CONTROL_PLANE_URL and task_type in enabled_types)


def _should_use_go_image2_worker(task_type: str, payload: dict[str, Any]) -> bool:
    """Route only the first safe image2 slice to Go's dedicated stream.

    This is deliberately stricter than the generic control-plane switch. The
    Python and Go consumers must never share a stream for upstream image calls,
    and the Go processor currently owns one direct image2 call only.
    """
    if not (
        settings.GO_IMAGE2_WORKER_ENABLED
        and settings.GO_CONTROL_PLANE_URL
        and settings.GO_CONTROL_PLANE_SHARED_SECRET
        and task_type == "generate"
        and isinstance(payload, dict)
    ):
        return False

    params = payload.get("params")
    if not isinstance(params, dict):
        return False
    source = str(params.get("source") or "").strip()
    if not source.endswith("image2_shortcut"):
        return False
    try:
        output_count = int(params.get("n") or 1)
    except (TypeError, ValueError):
        return False
    if output_count != 1:
        return False
    if payload.get("llm_model_id") or payload.get("vision_model_id"):
        return False
    visual_review = params.get("enable_visual_review")
    if visual_review is True or str(visual_review).strip().lower() == "true":
        return False

    # A non-empty legacy field means the request still contains raw input data
    # and must stay with Python until the storage migration is complete.
    legacy_inputs = payload.get("images_bytes_b64")
    if legacy_inputs or payload.get("image_bytes") or payload.get("image_base64") or payload.get("image_b64"):
        return False
    references = payload.get("image_assets")
    return references is None or isinstance(references, list)


def _should_use_go_image_heavy_worker(task_type: str, payload: dict[str, Any]) -> bool:
    """Route only asset-backed Flux Fill edits to the isolated Go worker.

    Remove stays on Python because its LaMa -> SDXL fallback is provider
    specific. Icon alternatives also fan out four calls and keep their
    palette-analysis contract in Python.
    """
    if not (
        settings.GO_IMAGE_HEAVY_WORKER_ENABLED
        and settings.GO_CONTROL_PLANE_URL
        and settings.GO_CONTROL_PLANE_SHARED_SECRET
        and task_type in {"touch-replace", "touch-recolor"}
        and isinstance(payload, dict)
    ):
        return False
    if payload.get("image_bytes") or payload.get("mask_bytes"):
        return False
    image_asset = payload.get("image_asset")
    mask_asset = payload.get("mask_asset")
    if not isinstance(image_asset, dict) or not isinstance(mask_asset, dict):
        return False
    image_key = str(image_asset.get("key") or "").strip()
    mask_key = str(mask_asset.get("key") or "").strip()
    if not image_key or not mask_key or "://" in image_key or "://" in mask_key:
        return False
    return True


async def _enqueue_via_go_control_plane(
    *,
    task_id: str,
    task_type: str,
    user_id: str,
    priority: str,
    payload: dict[str, Any],
    billing_mode: str,
    execution_target: str = "",
) -> str:
    """Send a compact, asset-reference-only job through the Go control plane."""
    if not settings.GO_CONTROL_PLANE_SHARED_SECRET:
        raise RuntimeError("GO_CONTROL_PLANE_SHARED_SECRET is required when GO_CONTROL_PLANE_URL is set")
    import httpx

    request_payload = {
        "task_id": task_id,
        "task_type": task_type,
        "user_id": user_id,
        "priority": priority,
        "billing_mode": billing_mode,
        "payload": payload,
    }
    if execution_target:
        request_payload["execution_target"] = execution_target
    timeout = httpx.Timeout(10.0, connect=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{settings.GO_CONTROL_PLANE_URL}/internal/v1/jobs",
            headers={"X-Control-Plane-Secret": settings.GO_CONTROL_PLANE_SHARED_SECRET},
            json=request_payload,
        )
    if response.status_code == 503:
        try:
            error_code = str((response.json() or {}).get("error") or "").strip().lower()
        except Exception:
            error_code = ""
        if error_code == "queue is temporarily full":
            raise QueueCapacityExceeded(
                QUEUE_GLOBAL_MAX_ENTRIES,
                QUEUE_GLOBAL_MAX_ENTRIES,
            )
    if response.status_code != 202:
        raise RuntimeError(f"Go control plane rejected job: status={response.status_code}")
    body = response.json()
    message_id = str(body.get("message_id") or "")
    if not message_id:
        raise RuntimeError("Go control plane did not return a Redis message id")
    return message_id


# ─── 读取待处理消息 ────────────────────────────────────────────────────────────

async def read_messages(
    consumer_name: str,
    count: int = 5,
    block_ms: int = 2000,
) -> list[tuple[str, str, dict]]:
    """
    从高→普通→低优先级依次读取消息。
    返回 [(stream, msg_id, fields), ...]
    """
    r = get_redis()
    results = []

    # 按优先级顺序读取
    for stream in [STREAM_HIGH, STREAM_NORMAL, STREAM_LOW]:
        try:
            entries = await r.xreadgroup(
                groupname=CONSUMER_GROUP,
                consumername=consumer_name,
                streams={stream: ">"},  # ">" 表示只读取未分配的新消息
                count=count,
                block=block_ms if not results else 0,  # 有消息时不阻塞
            )
            if entries:
                for stream_name, messages in entries:
                    for msg_id, fields in messages:
                        results.append((stream_name, msg_id, fields))
                if results:
                    break  # 高优先级有消息就不读低优先级
        except Exception as e:
            logger.error(f"[queue] 读取消息失败 {stream}: {e}")

    return results


# ─── 确认消息 ──────────────────────────────────────────────────────────────────

async def ack_message(stream: str, msg_id: str) -> bool:
    """Acknowledge and then remove one terminal stream entry."""
    r = get_redis()
    try:
        acknowledged = int(await r.eval(
            _ACK_DELETE_STREAM_MESSAGE_SCRIPT,
            1,
            stream,
            CONSUMER_GROUP,
            msg_id,
        ) or 0)
        if acknowledged <= 0:
            logger.warning(f"[queue] ACK did not own pending entry: stream={stream} msg_id={msg_id}")
            return False
        logger.debug(f"[queue] ACK: stream={stream} msg_id={msg_id}")
        return True
    except Exception as e:
        logger.error(f"[queue] ACK 失败: {e}")
        return False


def _message_values(message: dict) -> list[str]:
    values: list[str] = []
    for key, value in message.items():
        values.extend((str(key), "" if value is None else str(value)))
    return values


async def _move_message(r, source_stream: str, destination_stream: str, msg_id: str, message: dict) -> bool:
    result = await r.eval(
        _MOVE_STREAM_MESSAGE_SCRIPT,
        2,
        source_stream,
        destination_stream,
        CONSUMER_GROUP,
        msg_id,
        *_message_values(message),
    )
    return bool(result and int(result[0] or 0) > 0)


# ─── 重试或移入死信队列 ────────────────────────────────────────────────────────

async def nack_message(stream: str, msg_id: str, fields: dict, error: str) -> bool:
    """
    处理失败的消息：
    - 重试次数 < MAX_RETRIES：重新入队（降低优先级）
    - 超过重试次数：移入死信队列 + 标记任务失败
    """
    r = get_redis()
    retries = int(fields.get("retries", "0")) + 1

    if retries <= MAX_RETRIES:
        # 重新入队，降低优先级
        new_stream = STREAM_LOW  # 重试任务放低优先级
        message = {
            **fields,
            "retries": str(retries),
            "last_error": error[:500],
            "retry_at": str(time.time()),
        }
        if not await _move_message(r, stream, new_stream, msg_id, message):
            logger.warning(f"[queue] retry move lost PEL ownership: stream={stream} msg_id={msg_id}")
            return False
        logger.warning(
            f"[queue] 重试 {retries}/{MAX_RETRIES}: "
            f"task_id={fields.get('task_id')} error={error[:100]}"
        )
    else:
        # 移入死信队列
        dlq_message = {
            **fields,
            "retries": str(retries),
            "final_error": error[:500],
            "failed_at": str(time.time()),
            "original_stream": stream,
        }
        if not await _move_message(r, stream, STREAM_DLQ, msg_id, dlq_message):
            logger.warning(f"[queue] DLQ move lost PEL ownership: stream={stream} msg_id={msg_id}")
            return False

        # 关键：标记任务为失败状态（释放积分预留 + 通知用户）
        task_id = fields.get("task_id")
        if task_id:
            try:
                import repositories.task_repo as task_repo
                await task_repo.set_failed(
                    task_id,
                    f"任务重试 {MAX_RETRIES} 次后仍失败：{error[:200]}",
                )
            except Exception as e:
                logger.error(f"[queue] DLQ 标记任务失败异常: task_id={task_id} {e}")

        user_id = fields.get("user_id")
        if task_id and user_id:
            try:
                await release_user_slot(str(user_id), task_id)
            except Exception as e:
                logger.error(f"[queue] DLQ release user slot failed: task_id={task_id} user={user_id} {e}")

        if user_id:
            try:
                payload = json.loads(fields.get("payload") or "{}")
                if isinstance(payload, dict):
                    from services import queue_assets

                    await queue_assets.release_consumed_queue_inputs(
                        user_id=str(user_id),
                        payload=payload,
                    )
            except Exception as e:
                logger.warning(
                    "[queue] DLQ queue input cleanup scheduling failed task_id=%s error=%s",
                    task_id,
                    e,
                )

        logger.error(
            f"[queue] 死信队列: task_id={fields.get('task_id')} "
            f"retries={retries} error={error[:100]}"
        )
    return True


# ─── 认领超时消息（防止消息卡死）─────────────────────────────────────────────

async def reclaim_idle_messages(consumer_name: str, count: int = 10):
    """
    认领超过 CLAIM_IDLE_MS 未处理的消息（其他 Worker 崩溃时恢复）
    """
    r = get_redis()
    reclaimed = []

    for stream in [STREAM_HIGH, STREAM_NORMAL, STREAM_LOW]:
        try:
            # 查询 PEL（待确认消息列表）中超时的消息
            pending = await r.xpending_range(
                stream, CONSUMER_GROUP,
                min="-", max="+",
                count=count,
            )
            for entry in pending:
                msg_id = entry["message_id"]
                idle_ms = entry.get("time_since_delivered", 0)
                delivery_count = entry.get("times_delivered", 0)

                if idle_ms >= CLAIM_IDLE_MS:
                    try:
                        current = await r.xrange(stream, min=msg_id, max=msg_id, count=1)
                        current_fields = current[0][1] if current else {}
                        task_type = current_fields.get("task_type")
                        if task_type in LOCKED_RECLAIM_TASK_TYPES:
                            task_id = current_fields.get("task_id")
                            try:
                                payload = json.loads(current_fields.get("payload") or "{}")
                            except Exception:
                                payload = {}
                            job_id = payload.get("job_id") or (task_id or "").split(":refine:", 1)[0]
                            state_key, running_key = _locked_job_keys(task_type or "", job_id) if job_id else ("", "")
                            if job_id:
                                raw_state = await r.get(state_key)
                                if raw_state:
                                    try:
                                        job_state = json.loads(raw_state)
                                    except Exception:
                                        job_state = {}
                                    if job_state.get("status") in {"preview", "done", "failed"}:
                                        await ack_message(stream, msg_id)
                                        logger.info(
                                            f"[queue] 清理已结束的长任务 pending 消息: stream={stream} "
                                            f"msg_id={msg_id} task_id={task_id} type={task_type} status={job_state.get('status')}"
                                        )
                                        continue
                            if job_id and await r.exists(running_key):
                                logger.warning(
                                    f"[queue] 跳过仍在运行的长任务认领: stream={stream} "
                                    f"msg_id={msg_id} idle={idle_ms}ms task_id={task_id} type={task_type}"
                                )
                                continue
                            logger.warning(
                                f"[queue] 长任务运行锁已过期，准备重新认领: stream={stream} "
                                f"msg_id={msg_id} idle={idle_ms}ms task_id={task_id} type={task_type}"
                            )

                        if task_type in NO_RECLAIM_TASK_TYPES:
                            task_id = current_fields.get("task_id")
                            task_status = ""
                            if task_id:
                                raw_task = await r.get(f"task:{task_id}")
                                if raw_task:
                                    task_status = (json.loads(raw_task).get("status") or "")
                            if task_status in {"completed", "failed"}:
                                await ack_message(stream, msg_id)
                                logger.info(
                                    f"[queue] 清理已结束的生图 pending 消息: stream={stream} "
                                    f"msg_id={msg_id} task_id={task_id} status={task_status}"
                                )
                            else:
                                logger.warning(
                                    f"[queue] 跳过生图超时认领，避免重复调用上游: stream={stream} "
                                    f"msg_id={msg_id} idle={idle_ms}ms task_id={task_id}"
                                )
                            continue
                    except Exception as e:
                        logger.error(f"[queue] 检查 pending 生图消息失败 {stream}/{msg_id}: {e}")
                        continue

                    # 认领该消息
                    claimed = await r.xclaim(
                        stream, CONSUMER_GROUP, consumer_name,
                        min_idle_time=CLAIM_IDLE_MS,
                        message_ids=[msg_id],
                    )
                    if claimed:
                        for c_id, c_fields in claimed:
                            reclaimed.append((stream, c_id, c_fields))
                            logger.warning(
                                f"[queue] 认领超时消息: stream={stream} "
                                f"msg_id={c_id} idle={idle_ms}ms"
                            )
        except Exception as e:
            logger.error(f"[queue] 认领超时消息失败 {stream}: {e}")

    return reclaimed


# ─── 队列统计 ──────────────────────────────────────────────────────────────────

async def get_queue_stats() -> dict:
    """获取队列统计信息"""
    r = get_redis()
    stats = {}

    for name, stream in [("high", STREAM_HIGH), ("normal", STREAM_NORMAL),
                          ("low", STREAM_LOW), ("dlq", STREAM_DLQ)]:
        try:
            info = await r.xinfo_stream(stream)
            pending_info = await r.xpending(stream, CONSUMER_GROUP)
            stats[name] = {
                "length":  info.get("length", 0),
                "pending": pending_info.get("pending", 0) if isinstance(pending_info, dict) else 0,
            }
        except Exception:
            stats[name] = {"length": 0, "pending": 0}

    return stats
