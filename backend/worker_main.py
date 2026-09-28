import asyncio
import logging
import signal
import sys

from core.config import settings
from core.pool import close_pool, init_pool
from core.redis import close_redis_clients, get_redis
from core.worker import start_worker, stop_worker


class _MaxLogLevelFilter(logging.Filter):
    """Keep normal worker activity out of the process error stream."""

    def __init__(self, maximum: int) -> None:
        super().__init__()
        self.maximum = maximum

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno <= self.maximum


def _configure_worker_logging() -> None:
    """Split stdout runtime logs from stderr warnings and errors.

    Hosting panels commonly expose these streams as separate "run" and
    "error" tabs. The default Python handler writes every severity to stderr,
    which makes a healthy worker look broken.
    """
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    runtime_handler = logging.StreamHandler(sys.stdout)
    runtime_handler.setLevel(logging.DEBUG)
    runtime_handler.addFilter(_MaxLogLevelFilter(logging.INFO))
    runtime_handler.setFormatter(formatter)

    error_handler = logging.StreamHandler(sys.stderr)
    error_handler.setLevel(logging.WARNING)
    error_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.INFO)
    root.addHandler(runtime_handler)
    root.addHandler(error_handler)


_configure_worker_logging()
logger = logging.getLogger(__name__)


async def main():
    stop_event = asyncio.Event()

    def request_stop(*_args):
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_stop)
        except NotImplementedError:
            signal.signal(sig, lambda *_args: request_stop())

    await init_pool()
    await get_redis().ping()
    await start_worker(concurrency=settings.WORKER_CONCURRENCY)
    terminal_effect_worker_started = False
    if settings.TASK_TERMINAL_EFFECT_WORKER_ENABLED:
        from repositories.task_repo import start_terminal_effect_worker

        await start_terminal_effect_worker()
        terminal_effect_worker_started = True
    from services.model_billing_reconciler import start_model_call_settlement_worker

    await start_model_call_settlement_worker()
    model_billing_worker_started = True
    logger.info("PixelScribe queue worker started, concurrency=%s", settings.WORKER_CONCURRENCY)

    try:
        await stop_event.wait()
    finally:
        if model_billing_worker_started:
            from services.model_billing_reconciler import stop_model_call_settlement_worker

            await stop_model_call_settlement_worker()
        if terminal_effect_worker_started:
            from repositories.task_repo import stop_terminal_effect_worker

            await stop_terminal_effect_worker()
        await stop_worker()
        await close_pool()
        await close_redis_clients()
        logger.info("PixelScribe queue worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
