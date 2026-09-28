"""
队列监控路由（管理员）
GET  /api/queue/stats     队列统计
GET  /api/queue/health    队列健康状态
POST /api/queue/retry-dlq 重试死信队列中的消息
"""
import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Query

from core.queue import get_queue_stats, STREAM_DLQ, CONSUMER_GROUP, enqueue
from core.redis import get_redis
from routers.admin import require_admin
from routers.auth import get_current_user
import repositories.task_repo as task_repo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/queue", tags=["队列监控"])


@router.get("/stats")
async def queue_stats(_: bool = Depends(require_admin)):
    """获取各优先级队列的消息数量和待确认数量"""
    stats = await get_queue_stats()
    return {"ok": True, "queues": stats}


@router.get("/health")
async def queue_health(user: dict = Depends(get_current_user)):
    """队列健康检查（所有用户可访问）"""
    r = get_redis()
    try:
        await r.ping()
        stats = await get_queue_stats()
        total_pending = sum(q.get("pending", 0) for q in stats.values())
        return {
            "ok": True,
            "redis": True,
            "total_pending": total_pending,
            "dlq_length": stats.get("dlq", {}).get("length", 0),
        }
    except Exception as e:
        return {"ok": False, "redis": False, "error": str(e)}


@router.post("/retry-dlq")
async def retry_dlq(
    limit: int = 10,
    _: bool = Depends(require_admin),
):
    """将死信队列中的消息重新入队（最多 limit 条）"""
    r = get_redis()
    retried = 0
    errors = []

    try:
        # 读取死信队列中的消息
        messages = await r.xrange(STREAM_DLQ, count=limit)
        for msg_id, fields in messages:
            task_id   = fields.get("task_id", "")
            task_type = fields.get("task_type", "")
            payload_str = fields.get("payload", "{}")

            try:
                payload = json.loads(payload_str)
                # 重置重试次数，重新入队
                await enqueue(
                    task_type=task_type,
                    task_id=task_id,
                    payload=payload,
                    priority="low",
                )
                # 从死信队列删除
                await r.xdel(STREAM_DLQ, msg_id)
                retried += 1
            except Exception as e:
                errors.append(f"task_id={task_id}: {e}")

    except Exception as e:
        raise HTTPException(500, f"重试死信队列失败: {e}")

    return {
        "ok": True,
        "retried": retried,
        "errors": errors,
    }


@router.delete("/dlq/clear")
async def clear_dlq(_: bool = Depends(require_admin)):
    """清空死信队列（谨慎操作）"""
    r = get_redis()
    try:
        # 删除整个流并重建
        await r.delete(STREAM_DLQ)
        await r.xgroup_create(STREAM_DLQ, CONSUMER_GROUP, id="0", mkstream=True)
        return {"ok": True, "message": "死信队列已清空"}
    except Exception as e:
        raise HTTPException(500, f"清空失败: {e}")


@router.post("/admin/cleanup-user/{user_id}")
async def cleanup_user_tasks(
    user_id: str,
    scan_limit: int = Query(default=2000, ge=1, le=10000),
    _: bool = Depends(require_admin),
):
    """
    Mark a user's stuck pending/processing Redis tasks as failed and release held slots/credits.

    This is intentionally scoped to one user and only touches Redis realtime task state.
    Persistent credit refunds for already consumed model calls should still be handled
    through the admin credit adjustment endpoint after reviewing transactions.
    """
    from core.queue import release_user_slot

    r = get_redis()
    active_key = f"task:user:{user_id}:active"
    active_ids = await r.smembers(active_key)
    task_ids = set(active_ids)
    scanned = 0
    async for key in r.scan_iter(match="task:*", count=500):
        if scanned >= scan_limit:
            break
        scanned += 1
        if key.startswith("task:user:"):
            continue
        task_id = key.split("task:", 1)[1]
        if task_id:
            task_ids.add(task_id)

    cleaned: list[dict] = []
    removed_stale: list[str] = []

    for task_id in task_ids:
        task = await task_repo.get(task_id)
        if not task:
            if task_id in active_ids:
                removed_stale.append(task_id)
                await release_user_slot(user_id, task_id)
            continue
        if task.get("_user_id") != user_id:
            continue
        if task.get("type") not in {"compose", "generate"}:
            continue
        status = task.get("status")
        if status not in {"pending", "processing"}:
            if task_id in active_ids:
                removed_stale.append(task_id)
                await release_user_slot(user_id, task_id)
            continue

        await task_repo.set_failed(task_id, "管理员清理卡住的生成任务，已释放预占积分")
        cleaned.append({
            "taskId": task_id,
            "status": status,
            "cost": task.get("_cost", 0),
        })

    return {
        "ok": True,
        "user_id": user_id,
        "cleaned": cleaned,
        "removed_stale": removed_stale,
        "cleaned_count": len(cleaned),
        "removed_stale_count": len(removed_stale),
        "scanned": scanned,
    }


# ─── 任务取消（R8.6, R8.7）────────────────────────────────────────────────────


@router.post("/cancel/{task_id}")
async def cancel_task(task_id: str, user: dict = Depends(get_current_user)):
    """
    取消任务（R8.6, R8.7）

    - pending 状态：直接标记 cancelled
    - processing 状态：设置 cancel 标记，worker 检测后中止
    - 释放用户活跃槽位 + 释放预占信用值
    """
    task = await task_repo.get(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")

    # 权限检查：只能取消自己的任务
    task_user_id = task.get("_user_id") or task.get("user_id")
    if task_user_id and task_user_id != user["id"]:
        raise HTTPException(403, "无权取消此任务")

    status = task.get("status", "")
    if status in ("completed", "failed", "cancelled"):
        raise HTTPException(400, f"任务已终结，无法取消（当前状态: {status}）")

    r = get_redis()

    # The repository owns the state transition, active-slot release, and
    # task-scoped reservation settlement.  Do not release aggregate credits
    # here: a worker callback can race this endpoint.
    if status == "processing":
        await r.setex(f"cancel:{task_id}", 60, "1")
    transition = await task_repo.cancel(task_id)
    return {
        "ok": True,
        "task_id": task_id,
        "previous_status": status,
        "status": transition.status or "cancelled",
    }

# ─── 任务列表（R8.5）─────────────────────────────────────────────────────────


@router.get("/tasks")
async def list_tasks(
    since: str = "2h",
    user: dict = Depends(get_current_user),
):
    """
    获取用户最近的任务列表（R8.5）

    参数:
        since: 时间范围，如 "2h"（默认）、"24h"、"7d"
    """
    import re
    from datetime import datetime, timedelta

    # 解析 since 参数
    match = re.match(r"^(\d+)(h|d|m)$", since)
    if not match:
        raise HTTPException(422, "since 格式无效，示例: 2h, 24h, 7d")

    value, unit = int(match.group(1)), match.group(2)
    if unit == "h":
        delta = timedelta(hours=value)
    elif unit == "d":
        delta = timedelta(days=value)
    else:
        delta = timedelta(minutes=value)

    cutoff = datetime.utcnow() - delta

    # 从 task_repo 获取用户任务（Redis 存储）
    # 简化实现：扫描用户活跃集合 + 最近完成的任务
    r = get_redis()
    user_id = user["id"]

    # 获取活跃任务
    active_key = f"task:user:{user_id}:active"
    active_ids = await r.smembers(active_key)

    tasks = []
    for tid in active_ids:
        task = await task_repo.get(tid)
        if task:
            tasks.append({
                "taskId": tid,
                "type": task.get("type", "unknown"),
                "status": task.get("status", "unknown"),
                "progress": task.get("progress", 0),
                "error": task.get("error"),
                "createdAt": task.get("created_at", ""),
            })

    # 按创建时间倒序
    tasks.sort(key=lambda t: t.get("createdAt", ""), reverse=True)
    return {"tasks": tasks, "total": len(tasks)}
