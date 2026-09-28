"""
全局 asyncpg 连接池
- 应用启动时调用 init_pool()，关闭时调用 close_pool()
- 路由/repo 通过 Depends(get_db) 获取连接，用完自动归还
- 支持事务：async with pool.acquire() as conn: async with conn.transaction(): ...
"""
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg

from core.config import settings

_pool: asyncpg.Pool | None = None


class DatabasePoolBusy(RuntimeError):
    """Raised when the shared pool cannot serve a request promptly."""


def _dsn() -> str:
    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


async def init_pool() -> asyncpg.Pool:
    """应用启动时调用一次"""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            _dsn(),
            min_size=settings.DB_POOL_MIN_SIZE,
            max_size=settings.DB_POOL_MAX_SIZE,
            max_inactive_connection_lifetime=settings.DB_POOL_MAX_INACTIVE_SECONDS,
            command_timeout=settings.DB_COMMAND_TIMEOUT_SECONDS,
        )
    return _pool


async def close_pool():
    """应用关闭时调用一次"""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """直接获取连接池对象（同步，pool 必须已初始化）"""
    if _pool is None:
        raise RuntimeError("连接池未初始化，请先调用 init_pool()")
    return _pool


def pool_stats() -> dict[str, int | bool]:
    """Current occupancy of the shared asyncpg pool."""
    if _pool is None:
        return {"ready": False, "size": 0, "idle": 0, "used": 0, "max": 0}
    size = int(_pool.get_size())
    idle = int(_pool.get_idle_size())
    return {
        "ready": True,
        "size": size,
        "idle": idle,
        "used": max(0, size - idle),
        "max": int(_pool.get_max_size()),
    }


@asynccontextmanager
async def acquire():
    """手动获取连接的上下文管理器（用于 repo 层）"""
    pool = get_pool()
    try:
        conn = await pool.acquire(timeout=max(0.1, settings.DB_POOL_ACQUIRE_TIMEOUT_SECONDS))
    except TimeoutError as exc:
        raise DatabasePoolBusy("database connection pool is saturated") from exc
    try:
        yield conn
    finally:
        await pool.release(conn)


async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    """
    FastAPI Depends 依赖注入用。
    用法：conn: asyncpg.Connection = Depends(get_db)
    """
    async with acquire() as conn:
        yield conn
