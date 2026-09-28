import asyncio
from contextlib import asynccontextmanager
import sys
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from core.config import settings
from core.error_handlers import (
    database_pool_busy_handler,
    queue_capacity_exceeded_handler,
)
from core.logging_filters import install_sensitive_query_filters
from core.pool import DatabasePoolBusy, acquire, pool_stats
from core.queue import QueueCapacityExceeded
from core.redis import close_redis_clients, get_redis
from routers import (
    segmentation, layer_edit, admin, auth, models, mask, nlp,
    nlp_enhanced, batch_enhanced, project_version, credits, collaboration, generate, generate_video,
    workspace, prompt, safety, layer_edit_agent, ppt, conversation_router, pet, system, downloads,
    payment, events, sci_fig, poster, paper, feature_flags, ppt_canvas, agent, attachments, assets, storage,
    public_gallery, notifications, go_image2, go_image_heavy, creative_styles,
    admin_backups, admin_subscriptions, image_prompt, legal, canvas_flow
)
from routers import queue_monitor


install_sensitive_query_filters()


async def _asset_cleanup_retry_loop() -> None:
    from services import asset_lifecycle, asset_storage

    while True:
        await asyncio.sleep(60)
        try:
            await asset_lifecycle.retry_pending_record_cleanup_intents(limit=200)
            await asset_storage.retry_pending_asset_deletions(limit=1000)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"\n[WARN] Asset cleanup retry failed: {exc}\n")


async def _asset_mirror_retry_loop() -> None:
    from services import asset_storage

    while True:
        await asyncio.sleep(15)
        try:
            await asset_storage.retry_pending_asset_mirror_operations(limit=20)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"\n[WARN] Asset mirror retry failed: {exc}\n")


def _check_required_env():
    """启动前校验必填环境变量"""
    import os
    missing = []
    if not settings.ADMIN_PASSWORD:
        missing.append("ADMIN_PASSWORD")
    if not settings.SECRET_KEY:
        missing.append("SECRET_KEY")
    if not os.getenv("DATABASE_URL") and not os.getenv("DB_PASSWORD"):
        missing.append("DB_PASSWORD 或 DATABASE_URL")
    if settings.QUEUE_REQUIRE_ASSET_REFERENCES:
        from services.asset_storage import is_asset_storage_enabled

        if not is_asset_storage_enabled():
            missing.append("S3/R2 object storage for queue asset references")
    if missing:
        print(f"\n[ERROR] 缺少必填环境变量: {', '.join(missing)}")
        print("   请在 .env 文件中配置后重新启动\n")
        sys.exit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _check_required_env()

    # 1. 初始化 asyncpg 连接池
    from core.pool import init_pool, close_pool
    try:
        await init_pool()
        print(
            "\n[DB] 数据库连接池已就绪"
            f"（min={settings.DB_POOL_MIN_SIZE}, max={settings.DB_POOL_MAX_SIZE}）"
        )
    except Exception as e:
        print(f"\n[WARN] 数据库连接池初始化失败: {e}\n")

    # 2. 检查 Redis
    try:
        from services import asset_lifecycle

        recovery = await asset_lifecycle.retry_pending_record_cleanup_intents(limit=25)
        if recovery["requested"]:
            print(
                "[STORAGE] Recovered record cleanup intents: "
                f"processed={recovery['processed']} deferred={recovery['deferred']}"
            )
    except Exception as e:
        print(f"\n[WARN] Pending record cleanup recovery failed: {e}\n")

    try:
        r = get_redis()
        await r.ping()
        print("[API] 灵感后端已启动")
        print(f"   Redis:     {settings.REDIS_URL}")
        print(f"   API 文档:  http://localhost:{settings.PORT}/docs\n")
    except Exception as e:
        print(f"\n[WARN] Redis 连接失败: {e}")
        print("   任务状态将无法持久化，请检查 Redis 服务\n")

    # 3. 启动消息队列 Worker
    worker_started = False
    if settings.START_EMBEDDED_WORKER:
        from core.worker import start_worker
        worker_concurrency = int(getattr(settings, "WORKER_CONCURRENCY", 4))
        try:
            await start_worker(concurrency=worker_concurrency)
            worker_started = True
            print(f"   消息队列 Worker 已启动（并发数: {worker_concurrency}）\n")
        except Exception as e:
            print(f"\n[WARN] Worker 启动失败: {e}\n")
    else:
        print("   消息队列 Worker 未在 API 进程内启动（START_EMBEDDED_WORKER=false）\n")

    terminal_effect_worker_started = False
    if settings.TASK_TERMINAL_EFFECT_WORKER_ENABLED:
        try:
            from repositories.task_repo import start_terminal_effect_worker

            await start_terminal_effect_worker()
            terminal_effect_worker_started = True
        except Exception as e:
            print(f"\n[WARN] Terminal task effect worker failed to start: {e}\n")

    model_billing_worker_started = False
    try:
        from services.model_billing_reconciler import start_model_call_settlement_worker

        await start_model_call_settlement_worker()
        model_billing_worker_started = True
    except Exception as e:
        print(f"\n[WARN] Model-call settlement worker failed to start: {e}\n")

    try:
        from services.backup_service import start_backup_scheduler

        await start_backup_scheduler()
    except Exception as e:
        print(f"\nWarning: database backup scheduler failed to start: {e}\n")

    asset_cleanup_task = asyncio.create_task(_asset_cleanup_retry_loop())
    asset_mirror_task = asyncio.create_task(_asset_mirror_retry_loop())

    yield

    asset_cleanup_task.cancel()
    asset_mirror_task.cancel()
    await asyncio.gather(asset_cleanup_task, asset_mirror_task, return_exceptions=True)

    # 关闭时优雅停止 Worker
    if model_billing_worker_started:
        try:
            from services.model_billing_reconciler import stop_model_call_settlement_worker

            await stop_model_call_settlement_worker()
        except Exception as e:
            print(f"\n[WARN] Model-call settlement worker shutdown failed: {e}")

    if terminal_effect_worker_started:
        try:
            from repositories.task_repo import stop_terminal_effect_worker

            await stop_terminal_effect_worker()
        except Exception as e:
            print(f"\n[WARN] Terminal task effect worker shutdown failed: {e}")

    if worker_started:
        try:
            from core.worker import stop_worker
            await stop_worker()
            print("\n[WORKER] Worker 已优雅关闭")
        except Exception as e:
            print(f"\n[WARN] Worker 关闭异常: {e}")

    # 关闭连接池
    try:
        from services.backup_service import stop_backup_scheduler

        await stop_backup_scheduler()
    except Exception as e:
        print(f"\nWarning: database backup scheduler shutdown failed: {e}")

    try:
        await close_pool()
        print("[DB] 数据库连接池已关闭")
    except Exception as e:
        print(f"\n[WARN] 连接池关闭异常: {e}")

    # 先停止共享 Pub/Sub 监听，再关闭 Redis 连接。
    await events.close_event_broker()
    await close_redis_clients()


app = FastAPI(title="灵感 API", version="3.0.0", lifespan=lifespan)
app.add_exception_handler(DatabasePoolBusy, database_pool_busy_handler)
app.add_exception_handler(QueueCapacityExceeded, queue_capacity_exceeded_handler)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── 错误报警中间件 ────────────────────────────────────────────────────────────
class ErrorAlertMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if response.status_code >= 500:
            try:
                from services.error_alert import record_error
                await record_error(
                    path=request.url.path,
                    status_code=response.status_code,
                    detail=f"{request.method} {request.url.path}",
                )
            except Exception:
                pass
        return response

app.add_middleware(ErrorAlertMiddleware)

app.include_router(auth.router)
app.include_router(segmentation.router)
app.include_router(layer_edit.router)
app.include_router(admin.router)
app.include_router(models.router)
app.include_router(mask.router)
app.include_router(nlp.router)
app.include_router(nlp_enhanced.router)
app.include_router(batch_enhanced.router)
app.include_router(project_version.router)
app.include_router(credits.router)
app.include_router(collaboration.router)
app.include_router(generate.router)
app.include_router(generate_video.router)
app.include_router(workspace.router)
app.include_router(canvas_flow.router)
app.include_router(prompt.router)
app.include_router(safety.router)
app.include_router(layer_edit_agent.router)
app.include_router(queue_monitor.router)
app.include_router(ppt.router)
app.include_router(sci_fig.router)
app.include_router(poster.router)
app.include_router(paper.router)
app.include_router(attachments.router)
app.include_router(conversation_router.router)
app.include_router(pet.router)
app.include_router(system.router)
app.include_router(downloads.router)
app.include_router(payment.router)
app.include_router(events.router)
app.include_router(feature_flags.router)
app.include_router(ppt_canvas.router)
app.include_router(agent.router)
app.include_router(assets.router)
app.include_router(storage.router)
app.include_router(public_gallery.router)
app.include_router(creative_styles.router)
app.include_router(image_prompt.router)
app.include_router(notifications.router)
app.include_router(go_image2.router)
app.include_router(go_image_heavy.router)
app.include_router(admin_backups.router)
app.include_router(admin_subscriptions.router)
app.include_router(legal.router)


@app.get("/api/health")
async def health():
    r = get_redis()
    redis_ok = False
    database_ok = False
    try:
        await r.ping()
        redis_ok = True
    except Exception:
        pass
    try:
        async with acquire() as conn:
            await conn.fetchval("SELECT 1")
        database_ok = True
    except Exception:
        pass
    return {
        "ok": redis_ok and database_ok,
        "redis": redis_ok,
        "database": database_ok,
        "db_pool": pool_stats(),
    }
