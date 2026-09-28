"""
并发 Worker 消费者
- 启动时创建 N 个 asyncio Task，并发消费消息队列
- 每个 Worker 独立处理任务，互不干扰
- 支持优雅关闭（SIGTERM/SIGINT）
- 支持任务超时控制
- 定期认领超时消息（防止消息卡死）
"""
import asyncio
import json
import logging
import os
import signal
import time
import uuid
from typing import Callable, Awaitable

from core.queue import (
    read_messages, ack_message, nack_message,
    reclaim_idle_messages, ensure_consumer_groups, cleanup_idle_consumer,
    release_user_slot,
)
from core import generation_execution
from core.user_context import bind_user_context
import repositories.task_repo as task_repo
from core.task_errors import NonRetryableTaskError
from services import foxapi_credentials
from services.compute_billing import ALL_BILLING_MODES
from services import queue_assets

logger = logging.getLogger(__name__)


def _worker_drain_grace_seconds() -> float:
    try:
        return max(1.0, float(os.getenv("WORKER_DRAIN_GRACE_SECONDS", "900")))
    except (TypeError, ValueError):
        return 900.0


def _worker_log(message: str, *args) -> None:
    logger.info(message, *args)

# ─── 任务超时配置（秒）────────────────────────────────────────────────────────

TASK_TIMEOUT = {
    "segmentation-partial": 300,
    "sci-fig":         1800,
    "sci-fig-refine":  900,
    "segmentation":    300,   # 分割最多 5 分钟
    "generate":        600,   # 图像生成智能体：规划 + 生成 + 质检 + 重试
    "generate-video":  720,   # Grok 生视频：提交 + 轮询 + 下载
    "poster":          1800,  # poster series: planning + multiple image generations
    "poster-refine":   900,   # single poster edit can still call image2
    "layer-edit":      180,   # 图层编辑最多 3 分钟
    "touch-replace":   30,    # 触摸替换 30s（R2.7）
    "touch-recolor":   30,    # 触摸重着色 30s（R2.7）
    "touch-remove":    30,    # 触摸移除 30s（R2.7）
    "icon-alternatives": 180,
    "ppt-start":       1800,
    "ppt-confirm-outline-direct": 3600,
    "ppt-confirm-outline-images": 3600,
    "ppt-post-checkpoint": 3600,
    "ppt-slide-render": 900,
    "ppt-direct-slide-render": 900,
    "paper-plan":      900,
    "paper-write":     1800,
    "batch":           600,   # 批处理最多 10 分钟
    "default":         120,   # 默认 2 分钟
}


async def _claim_generate_execution_once(task_id: str) -> bool:
    """Allow a generate task to enter the upstream-calling pipeline once."""
    return await generation_execution.claim_generate_execution_once(task_id)

# ─── 任务处理器注册表 ──────────────────────────────────────────────────────────

_handlers: dict[str, Callable[..., Awaitable[None]]] = {}


def register_handler(task_type: str):
    """装饰器：注册任务处理函数"""
    def decorator(fn: Callable[..., Awaitable[None]]):
        _handlers[task_type] = fn
        _worker_log("[worker] handler registered type=%s handler=%s", task_type, fn.__name__)
        return fn
    return decorator


# ─── Worker 类 ────────────────────────────────────────────────────────────────

class Worker:
    def __init__(self, worker_id: str, concurrency: int = 4, drain_grace_seconds: float | None = None):
        self.worker_id = worker_id
        self.concurrency = concurrency
        self.drain_grace_seconds = (
            _worker_drain_grace_seconds() if drain_grace_seconds is None else max(0.0, drain_grace_seconds)
        )
        self._running = False
        self._tasks: list[asyncio.Task] = []
        self._semaphore: asyncio.Semaphore | None = None
        self._processing: set[asyncio.Task] = set()
        self._protected_generate_tasks: set[asyncio.Task] = set()

    async def start(self):
        """启动 Worker"""
        self._running = True
        # Semaphore 控制同时执行的任务上限，消费循环本身只有 1 个
        self._semaphore = asyncio.Semaphore(self.concurrency)
        # 追踪正在执行的处理任务，用于优雅关闭
        self._processing.clear()
        self._protected_generate_tasks.clear()

        # 只需 1 个消费循环负责拉取消息，处理任务通过 create_task 并发执行
        _worker_log(
            "[worker] started id=%s concurrency=%s handlers=%s",
            self.worker_id,
            self.concurrency,
            ",".join(sorted(_handlers)),
        )
        consume_task = asyncio.create_task(
            self._consume_loop(f"{self.worker_id}-consumer")
        )
        reclaim_task = asyncio.create_task(self._reclaim_loop())

        self._tasks = [consume_task, reclaim_task]

    async def stop(self):
        """Stop intake first, then drain active work without cancelling claimed generations."""
        self._running = False

        _worker_log("[worker] stopping intake id=%s active=%s", self.worker_id, len(self._processing))
        intake_tasks = list(self._tasks)
        for task in intake_tasks:
            task.cancel()
        if intake_tasks:
            await asyncio.gather(*intake_tasks, return_exceptions=True)
        self._tasks.clear()

        active = set(self._processing)
        if active:
            logger.info(
                "[worker] draining %s active tasks for up to %ss",
                len(active),
                self.drain_grace_seconds,
            )
            _, pending = await asyncio.wait(active, timeout=self.drain_grace_seconds)
            protected = pending & self._protected_generate_tasks
            cancellable = pending - protected
            for task in cancellable:
                task.cancel()
            if cancellable:
                await asyncio.gather(*cancellable, return_exceptions=True)
            if protected:
                logger.warning(
                    "[worker] drain grace elapsed; waiting for %s claimed generate tasks",
                    len(protected),
                )
                await asyncio.gather(*protected, return_exceptions=True)

        await cleanup_idle_consumer(f"{self.worker_id}-consumer")
        await cleanup_idle_consumer(f"{self.worker_id}-reclaim")

        _worker_log("[worker] stopped id=%s", self.worker_id)

    async def _consume_loop(self, consumer_name: str):
        """
        消费循环：持续从队列拉取消息，每条消息 create_task 异步处理。
        Semaphore 保证同时执行的任务数不超过 concurrency。

        优化：
        - 批量读取（一次最多拉 concurrency 条，减少 Redis 往返）
        - 用 semaphore.acquire() 阻塞等待空位，不轮询
        """
        _worker_log("[worker] consumer started name=%s", consumer_name)
        while self._running:
            try:
                # 等待有空位再拉取（阻塞式，不浪费 CPU）
                await self._semaphore.acquire()

                # 拉取消息（有空位才拉，最多拉 1 条以保证公平调度）
                messages = await read_messages(consumer_name, count=1, block_ms=2000)

                if not messages:
                    # 没消息，释放刚获取的 semaphore slot
                    self._semaphore.release()
                    continue

                for stream, msg_id, fields in messages:
                    _worker_log(
                        "[worker] message received stream=%s msg_id=%s task_id=%s type=%s",
                        stream,
                        msg_id,
                        fields.get("task_id", "unknown"),
                        fields.get("task_type", "unknown"),
                    )
                    task = asyncio.create_task(
                        self._run_and_release(stream, msg_id, fields)
                    )
                    self._processing.add(task)
                    task.add_done_callback(self._processing.discard)

                # 如果拉到多条（未来扩展），为后续消息也获取 slot
                # 当前 count=1 所以这里只处理 1 条

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[worker] 消费循环异常: {e}")
                # 异常时释放可能已获取的 slot
                try:
                    self._semaphore.release()
                except ValueError:
                    pass
                await asyncio.sleep(1)

        logger.info(f"[worker] 消费者停止: {consumer_name}")

    async def _run_and_release(self, stream: str, msg_id: str, fields: dict):
        """执行任务，完成后释放 semaphore slot"""
        try:
            await self._process_message(stream, msg_id, fields)
        finally:
            current = asyncio.current_task()
            if current is not None:
                self._protected_generate_tasks.discard(current)
            self._semaphore.release()

    async def _release_acknowledged_queue_inputs(self, *, acknowledged: bool, user_id: str, payload: dict) -> None:
        if acknowledged:
            await queue_assets.release_consumed_queue_inputs(
                user_id=user_id,
                payload=payload,
            )

    async def _video_can_resume(self, task_id: str) -> bool:
        try:
            state = await task_repo.get(task_id)
        except Exception as exc:
            logger.warning(
                "[worker] unable to read video resume state; fail without resubmitting: task_id=%s error=%s",
                task_id,
                exc,
            )
            return False
        return bool(state and str(state.get("_provider_request_id") or "").strip())

    async def _fail_and_ack(self, *, task_id: str, stream: str, msg_id: str, error: str, user_id: str, payload: dict) -> None:
        await task_repo.set_failed(task_id, error)
        acknowledged = await ack_message(stream, msg_id)
        await self._release_acknowledged_queue_inputs(
            acknowledged=acknowledged,
            user_id=user_id,
            payload=payload,
        )
        if user_id:
            await release_user_slot(user_id, task_id)

    async def _process_message(self, stream: str, msg_id: str, fields: dict):
        """处理单条消息"""
        task_id   = fields.get("task_id", "unknown")
        task_type = fields.get("task_type", "unknown")
        retries   = int(fields.get("retries", "0"))
        queued_user_id = str(fields.get("user_id") or "")

        t0 = time.time()
        _worker_log("[worker] task started task_id=%s type=%s retries=%s", task_id, task_type, retries)
        handler = _handlers.get(task_type)
        if not handler:
            _worker_log("[worker] task failed task_id=%s type=%s reason=no_handler", task_id, task_type)
            if queued_user_id:
                await release_user_slot(queued_user_id, task_id)
            logger.error(f"[worker] 未找到处理器: {task_type}")
            acknowledged = await ack_message(stream, msg_id)
            if acknowledged and queued_user_id:
                try:
                    payload = json.loads(fields.get("payload") or "{}")
                    if isinstance(payload, dict):
                        await self._release_acknowledged_queue_inputs(
                            acknowledged=True,
                            user_id=queued_user_id,
                            payload=payload,
                        )
                except Exception as exc:
                    logger.warning("[worker] unknown-handler queue input cleanup failed task_id=%s error=%s", task_id, exc)
            await task_repo.set_failed(task_id, f"未知任务类型: {task_type}")
            return

        # 解析 payload
        try:
            payload = json.loads(fields.get("payload", "{}"))
        except json.JSONDecodeError as e:
            if queued_user_id:
                await release_user_slot(queued_user_id, task_id)
            logger.error(f"[worker] payload 解析失败: {e}")
            await ack_message(stream, msg_id)
            await task_repo.set_failed(task_id, f"payload 格式错误: {e}")
            return

        payload_user_id = str(
            payload.get("user_id")
            or (payload.get("params") or {}).get("user_id")
            or ""
        ) if isinstance(payload, dict) else ""
        runtime_user_id = queued_user_id or payload_user_id
        payload["_queue_user_id"] = runtime_user_id
        task_state = await task_repo.get(task_id)
        frozen_billing_mode = str(
            (task_state or {}).get("_billing_mode") or ""
        ).strip()
        queued_billing_mode = str(fields.get("billing_mode") or "").strip()
        billing_mode = frozen_billing_mode if frozen_billing_mode in ALL_BILLING_MODES else (
            queued_billing_mode if queued_billing_mode in ALL_BILLING_MODES else None
        )
        if runtime_user_id and billing_mode is None:
            billing_mode = await foxapi_credentials.get_billing_mode(runtime_user_id)

        if task_type == "generate":
            current = asyncio.current_task()
            if current is not None:
                self._protected_generate_tasks.add(current)
                current.add_done_callback(self._protected_generate_tasks.discard)
            acquired = await _claim_generate_execution_once(task_id)
            if not acquired:
                if current is not None:
                    self._protected_generate_tasks.discard(current)
                logger.warning(
                    "[worker] 跳过重复生图消息，避免重复调用上游: task_id=%s stream=%s msg_id=%s",
                    task_id,
                    stream,
                    msg_id,
                )
                await ack_message(stream, msg_id)
                return

        # 执行处理器（带超时）
        timeout = TASK_TIMEOUT.get(task_type, TASK_TIMEOUT["default"])
        try:
            with bind_user_context(runtime_user_id or None, billing_mode):
                await asyncio.wait_for(
                    handler(task_id, payload),
                    timeout=timeout,
                )
            acknowledged = await ack_message(stream, msg_id)
            await self._release_acknowledged_queue_inputs(
                acknowledged=acknowledged,
                user_id=runtime_user_id,
                payload=payload,
            )
            if queued_user_id:
                await release_user_slot(queued_user_id, task_id)
            elapsed = round(time.time() - t0, 2)
            _worker_log("[worker] task completed task_id=%s type=%s elapsed=%ss", task_id, task_type, elapsed)

        except asyncio.TimeoutError:
            error = f"任务超时（>{timeout}s）"
            logger.error(f"[worker] 超时: task_id={task_id} timeout={timeout}s")
            _worker_log("[worker] task timeout task_id=%s type=%s timeout=%ss", task_id, task_type, timeout)
            if task_type == "generate" or (task_type == "generate-video" and not await self._video_can_resume(task_id)):
                await self._fail_and_ack(
                    task_id=task_id,
                    stream=stream,
                    msg_id=msg_id,
                    error=error,
                    user_id=runtime_user_id,
                    payload=payload,
                )
                return
            # 不在这里 set_failed，让 nack_message 决定是否重试
            # 只有超过 MAX_RETRIES 进入 DLQ 时才标记 failed
            await nack_message(stream, msg_id, fields, error)

        except NonRetryableTaskError as e:
            error = str(e) or repr(e)
            logger.error(f"[worker] 不可重试失败: task_id={task_id} error={error}")
            _worker_log("[worker] task non_retryable_failed task_id=%s type=%s error=%s", task_id, task_type, error[:300])
            await task_repo.set_failed(task_id, error)
            acknowledged = await ack_message(stream, msg_id)
            await self._release_acknowledged_queue_inputs(
                acknowledged=acknowledged,
                user_id=runtime_user_id,
                payload=payload,
            )
            if queued_user_id:
                await release_user_slot(queued_user_id, task_id)

        except Exception as e:
            error = str(e) or repr(e)
            logger.error(f"[worker] 处理失败: task_id={task_id} error={error}")
            _worker_log("[worker] task failed task_id=%s type=%s error=%s", task_id, task_type, error[:300])
            if task_type == "generate" or (task_type == "generate-video" and not await self._video_can_resume(task_id)):
                await self._fail_and_ack(
                    task_id=task_id,
                    stream=stream,
                    msg_id=msg_id,
                    error=error,
                    user_id=runtime_user_id,
                    payload=payload,
                )
                return
            # handler 内部可能已经 set_failed（如 segmentation 等），
            # 但如果没有，nack 后进 DLQ 时会自动 set_failed
            await nack_message(stream, msg_id, fields, error)

    async def _reclaim_loop(self):
        """定期认领超时消息（每 60 秒一次，快速恢复崩溃任务）"""
        while self._running:
            try:
                await asyncio.sleep(60)
                reclaimed = await reclaim_idle_messages(
                    f"{self.worker_id}-reclaim", count=20
                )
                if reclaimed:
                    logger.info(f"[worker] 认领了 {len(reclaimed)} 条超时消息")
                    for stream, msg_id, fields in reclaimed:
                        # 同样用 create_task 并发处理，不阻塞认领循环
                        await self._semaphore.acquire()
                        task = asyncio.create_task(
                            self._run_and_release(stream, msg_id, fields)
                        )
                        self._processing.add(task)
                        task.add_done_callback(self._processing.discard)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[worker] 认领循环异常: {e}")


# ─── 全局 Worker 实例 ──────────────────────────────────────────────────────────

_worker: Worker | None = None


async def start_worker(concurrency: int = 4):
    """启动全局 Worker（在 FastAPI lifespan 中调用）"""
    global _worker

    # 确保消费者组存在
    await ensure_consumer_groups()

    # 注册所有任务处理器
    _register_all_handlers()

    worker_id = f"worker-{uuid.uuid4().hex[:8]}"
    _worker = Worker(worker_id=worker_id, concurrency=concurrency)
    await _worker.start()

    _worker_log("[worker] global worker ready id=%s", worker_id)
    return _worker


async def stop_worker():
    """停止全局 Worker（在 FastAPI lifespan 关闭时调用）"""
    global _worker
    if _worker:
        await _worker.stop()
        _worker = None


# ─── 注册所有任务处理器 ────────────────────────────────────────────────────────

def _register_all_handlers():
    """注册所有任务类型的处理器"""

    @register_handler("segmentation")
    async def handle_segmentation(task_id: str, payload: dict):
        image_bytes = await _payload_bytes(payload, "image")
        params = payload.get("params", {})
        provider = params.get("provider", "qwen")
        if provider == "openai":
            from services.openai_layering import run_openai_layering
            await run_openai_layering(
                task_id,
                image_bytes,
                params,
                user_id=str(payload.get("_queue_user_id") or ""),
                billing_model_id=str(params.get("billing_model_id") or ""),
            )
        elif provider == "replicate":
            from services.segmentation import run_replicate_layering
            await run_replicate_layering(
                task_id,
                image_bytes,
                params,
                user_id=str(payload.get("_queue_user_id") or ""),
                billing_model_id=str(params.get("billing_model_id") or ""),
            )
        else:
            from services.segmentation import run_segmentation
            await run_segmentation(task_id, image_bytes, params)

    @register_handler("generate")
    async def handle_generate(task_id: str, payload: dict):
        from services.agents.image_generation_agent import run_image_generation_agent
        import base64
        model_id     = payload.get("model_id", "")
        prompt       = payload.get("prompt", "")
        params       = payload.get("params", {})
        image_bytes = await _payload_bytes(payload, "image")
        images_bytes = await _payload_image_list(payload)
        all_images = images_bytes or ([image_bytes] if image_bytes else [])
        await run_image_generation_agent(
            task_id=task_id,
            model_id=model_id,
            prompt=prompt,
            ref_images=all_images,
            params=params,
            llm_model_id=payload.get("llm_model_id") or None,
            vision_model_id=payload.get("vision_model_id") or None,
        )

    @register_handler("generate-video")
    async def handle_generate_video(task_id: str, payload: dict):
        from services.video_generation import run_video_generation

        await run_video_generation(task_id, payload)

    @register_handler("segmentation-partial")
    async def handle_segmentation_partial(task_id: str, payload: dict):
        from services.segmentation import run_sam2_segmentation

        image_bytes = await _payload_bytes(payload, "image")
        params = payload.get("params", {})
        if "region" in payload:
            params = {**params, "region": payload.get("region")}
        await run_sam2_segmentation(
            task_id,
            image_bytes,
            params,
            user_id=str(payload.get("_queue_user_id") or ""),
            billing_model_id=str(payload.get("billing_model_id") or ""),
        )

    @register_handler("poster")
    async def handle_poster(task_id: str, payload: dict):
        from routers.poster import run_poster_job_from_queue

        await run_poster_job_from_queue(payload.get("job_id") or task_id)

    @register_handler("poster-refine")
    async def handle_poster_refine(task_id: str, payload: dict):
        from routers.poster import run_poster_refine_from_queue

        await run_poster_refine_from_queue(
            job_id=payload.get("job_id") or task_id,
            poster_index=int(payload.get("poster_index") or 0),
            feedback=str(payload.get("feedback") or ""),
            image_model_id=payload.get("image_model_id") or None,
        )

    @register_handler("sci-fig")
    async def handle_sci_fig(task_id: str, payload: dict):
        from routers.sci_fig import run_sci_fig_from_queue

        await run_sci_fig_from_queue(payload.get("job_id") or task_id)

    @register_handler("sci-fig-refine")
    async def handle_sci_fig_refine(task_id: str, payload: dict):
        from routers.sci_fig import run_sci_fig_refine_from_queue

        await run_sci_fig_refine_from_queue(
            job_id=payload.get("job_id") or task_id,
            mode=str(payload.get("mode") or "generate"),
            feedback=str(payload.get("feedback") or ""),
            image_model_id=payload.get("image_model_id") or None,
        )

    @register_handler("paper-plan")
    async def handle_paper_plan(task_id: str, payload: dict):
        from routers.paper import run_paper_plan_from_queue

        await run_paper_plan_from_queue(payload.get("job_id") or task_id)

    @register_handler("paper-write")
    async def handle_paper_write(task_id: str, payload: dict):
        from routers.paper import run_paper_write_from_queue

        await run_paper_write_from_queue(payload.get("job_id") or task_id)

    @register_handler("layer-edit")
    async def handle_layer_edit(task_id: str, payload: dict):
        from services.layer_edit import run_layer_edit
        image_bytes = await _payload_bytes(payload, "image")
        params = payload.get("params", {})
        await run_layer_edit(
            task_id,
            image_bytes,
            params,
            user_id=str(payload.get("_queue_user_id") or ""),
        )

    @register_handler("touch-replace")
    async def handle_touch_replace(task_id: str, payload: dict):
        """触摸编辑 - 替换（R2.2）"""
        from services.touch_edit import run_touch_inpaint
        image_bytes = await _payload_bytes(payload, "image")
        mask_bytes = await _payload_bytes(payload, "mask")
        prompt = payload.get("prompt", "")
        element_id = payload.get("element_id", "")
        mode = payload.get("mode", "replace")
        await run_touch_inpaint(
            task_id, image_bytes, mask_bytes, prompt, mode,
            element_id=element_id,
            user_id=str(payload.get("_queue_user_id") or ""),
            billing_model_id=str(payload.get("billing_model_id") or ""),
        )

    @register_handler("touch-recolor")
    async def handle_touch_recolor(task_id: str, payload: dict):
        """触摸编辑 - 重新着色（R2.3）"""
        from services.touch_edit import run_touch_inpaint
        image_bytes = await _payload_bytes(payload, "image")
        mask_bytes = await _payload_bytes(payload, "mask")
        target_color = payload.get("target_color", "")
        element_id = payload.get("element_id", "")
        mode = payload.get("mode", "recolor")
        await run_touch_inpaint(
            task_id, image_bytes, mask_bytes, "", mode,
            target_color=target_color,
            element_id=element_id,
            user_id=str(payload.get("_queue_user_id") or ""),
            billing_model_id=str(payload.get("billing_model_id") or ""),
        )

    @register_handler("touch-remove")
    async def handle_touch_remove(task_id: str, payload: dict):
        """触摸编辑 - 移除（R2.4）"""
        from services.touch_edit import run_touch_inpaint
        image_bytes = await _payload_bytes(payload, "image")
        mask_bytes = await _payload_bytes(payload, "mask")
        element_id = payload.get("element_id", "")
        mode = payload.get("mode", "remove")
        await run_touch_inpaint(
            task_id, image_bytes, mask_bytes, "", mode,
            element_id=element_id,
            user_id=str(payload.get("_queue_user_id") or ""),
            billing_model_id=str(payload.get("billing_model_id") or ""),
        )

    @register_handler("icon-alternatives")
    async def handle_icon_alternatives(task_id: str, payload: dict):
        from services.touch_edit import run_icon_alternatives

        await run_icon_alternatives(
            task_id=task_id,
            image_bytes=await _payload_bytes(payload, "image"),
            mask_bytes=await _payload_bytes(payload, "mask"),
            element_id=str(payload.get("element_id") or ""),
            prompt=str(payload.get("prompt") or ""),
            user_id=str(payload.get("_queue_user_id") or ""),
            billing_model_id=str(payload.get("billing_model_id") or ""),
        )

    @register_handler("ppt-start")
    async def handle_ppt_start(task_id: str, payload: dict):
        from routers.ppt import run_ppt_start_from_queue

        await run_ppt_start_from_queue(payload.get("job_id") or task_id)

    @register_handler("ppt-confirm-outline-direct")
    async def handle_ppt_confirm_outline_direct(task_id: str, payload: dict):
        from routers.ppt import run_ppt_confirm_outline_direct_from_queue

        await run_ppt_confirm_outline_direct_from_queue(payload.get("job_id") or task_id)

    @register_handler("ppt-confirm-outline-images")
    async def handle_ppt_confirm_outline_images(task_id: str, payload: dict):
        from routers.ppt import run_ppt_confirm_outline_images_from_queue

        await run_ppt_confirm_outline_images_from_queue(payload.get("job_id") or task_id)

    @register_handler("ppt-post-checkpoint")
    async def handle_ppt_post_checkpoint(task_id: str, payload: dict):
        from routers.ppt import run_ppt_post_checkpoint_from_queue

        await run_ppt_post_checkpoint_from_queue(payload.get("job_id") or task_id)

    @register_handler("ppt-slide-render")
    async def handle_ppt_slide_render(task_id: str, payload: dict):
        from routers.ppt import run_ppt_slide_render_from_queue

        await run_ppt_slide_render_from_queue(
            payload.get("job_id") or task_id,
            payload.get("slide_payload") or {},
            str(payload.get("user_id") or ""),
        )

    @register_handler("ppt-direct-slide-render")
    async def handle_ppt_direct_slide_render(task_id: str, payload: dict):
        from routers.ppt import run_ppt_direct_slide_render_from_queue

        await run_ppt_direct_slide_render_from_queue(
            payload.get("job_id") or task_id,
            payload.get("slide_payload") or {},
        )


def _decode_bytes(b64_str: str) -> bytes:
    """Base64 字符串 → bytes"""
    import base64
    if not b64_str:
        return b""
    try:
        return base64.b64decode(b64_str)
    except Exception:
        return b""


async def _payload_bytes(payload: dict, field: str) -> bytes:
    """Read a new object reference, or a legacy Base64 field during migration."""
    reference = payload.get(f"{field}_asset")
    if reference:
        return await queue_assets.load_queue_input(reference, str(payload.get("_queue_user_id") or ""))
    return _decode_bytes(str(payload.get(f"{field}_bytes") or ""))


async def _payload_image_list(payload: dict) -> list[bytes]:
    references = payload.get("image_assets")
    if isinstance(references, list) and references:
        user_id = str(payload.get("_queue_user_id") or "")
        # Sequential fetches cap retained input data while each job waits on its
        # upstream model call; jobs themselves remain globally semaphore-bound.
        return [await queue_assets.load_queue_input(reference, user_id) for reference in references]
    import base64
    return [base64.b64decode(value) for value in payload.get("images_bytes_b64", [])]
