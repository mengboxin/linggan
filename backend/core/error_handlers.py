"""Reusable HTTP mappings for transient infrastructure saturation."""
from fastapi import Request
from fastapi.responses import JSONResponse

from core.pool import DatabasePoolBusy
from core.queue import QueueCapacityExceeded


async def database_pool_busy_handler(_request: Request, _exc: DatabasePoolBusy):
    return JSONResponse(
        status_code=503,
        content={"detail": "服务繁忙，请稍后重试"},
        headers={"Retry-After": "2"},
    )


async def queue_capacity_exceeded_handler(
    _request: Request,
    _exc: QueueCapacityExceeded,
):
    return JSONResponse(
        status_code=503,
        content={"detail": "任务队列已满，请稍后重试"},
        headers={"Retry-After": "5"},
    )
