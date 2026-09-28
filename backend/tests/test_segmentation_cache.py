"""
分割结果缓存层单元测试

覆盖：
- cache_segmentation_result: 写入 Redis + PG
- get_cached_segmentation: 从 Redis 读取 / 从 PG 读取并回写 Redis
- evict_lru_cache_entries: LRU 淘汰

Requirements: R12.3, R12.4
"""
import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.segmentation import (
    BBox,
    ElementMask,
    SegmentationResult,
    cache_segmentation_result,
    get_cached_segmentation,
    evict_lru_cache_entries,
    SEG_CACHE_TTL,
)


# ---------------------------------------------------------------------------
# 辅助工厂
# ---------------------------------------------------------------------------


def _make_mask(id: str = "mask-1", category: str = "object") -> ElementMask:
    return ElementMask(
        id=id,
        category=category,
        mask_base64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        bbox=BBox(x=10, y=20, w=100, h=80),
        confidence=0.95,
    )


def _make_result(content_hash: str = "a" * 64) -> SegmentationResult:
    return SegmentationResult(
        masks=[_make_mask("mask-1"), _make_mask("mask-2", "text")],
        width=800,
        height=600,
        content_hash=content_hash,
    )


def _mock_acquire(mock_conn):
    """创建一个模拟 acquire 上下文管理器"""
    @asynccontextmanager
    async def _acquire():
        yield mock_conn
    return _acquire


# ---------------------------------------------------------------------------
# cache_segmentation_result 测试
# ---------------------------------------------------------------------------


class TestCacheSegmentationResult:
    """cache_segmentation_result 写入 Redis + PG"""

    def test_writes_to_redis_and_pg(self):
        """成功写入 Redis 和 PG"""
        result = _make_result()
        content_hash = result.content_hash

        mock_redis = AsyncMock()
        mock_conn = AsyncMock()

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    await cache_segmentation_result(content_hash, result, user_id="user-123")

            # 验证 Redis 写入
            mock_redis.setex.assert_called_once()
            call_args = mock_redis.setex.call_args
            assert call_args[0][0] == f"seg:hash:{content_hash}"
            assert call_args[0][1] == SEG_CACHE_TTL
            # 验证写入的 JSON 可解析
            written_json = json.loads(call_args[0][2])
            assert written_json["content_hash"] == content_hash
            assert len(written_json["masks"]) == 2

            # 验证 PG 写入
            mock_conn.execute.assert_called_once()
            pg_args = mock_conn.execute.call_args[0]
            assert "INSERT INTO segmentation_cache" in pg_args[0]
            assert "ON CONFLICT" in pg_args[0]
            assert pg_args[1] == content_hash
            assert pg_args[2] == "user-123"

        asyncio.run(_run())

    def test_redis_failure_does_not_block_pg(self):
        """Redis 写入失败不阻止 PG 写入"""
        result = _make_result()
        content_hash = result.content_hash

        mock_redis = AsyncMock()
        mock_redis.setex.side_effect = Exception("Redis 连接超时")
        mock_conn = AsyncMock()

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    # 不应抛出异常
                    await cache_segmentation_result(content_hash, result)

            # PG 仍然被调用
            mock_conn.execute.assert_called_once()

        asyncio.run(_run())

    def test_pg_failure_does_not_raise(self):
        """PG 写入失败不抛出异常"""
        result = _make_result()
        content_hash = result.content_hash

        mock_redis = AsyncMock()
        mock_conn = AsyncMock()
        mock_conn.execute.side_effect = Exception("PG 连接失败")

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    # 不应抛出异常
                    await cache_segmentation_result(content_hash, result)

            # Redis 仍然被调用
            mock_redis.setex.assert_called_once()

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# get_cached_segmentation 测试
# ---------------------------------------------------------------------------


class TestGetCachedSegmentation:
    """get_cached_segmentation 从 Redis/PG 读取"""

    def test_returns_from_redis_when_cached(self):
        """Redis 命中时直接返回，不查 PG"""
        result = _make_result()
        content_hash = result.content_hash
        cached_json = json.dumps(result.model_dump())

        mock_redis = AsyncMock()
        mock_redis.get.return_value = cached_json

        mock_conn = AsyncMock()

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    got = await get_cached_segmentation(content_hash)

            assert got is not None
            assert got.content_hash == content_hash
            assert len(got.masks) == 2
            assert got.width == 800
            assert got.height == 600
            # 不应查 PG（fetchrow 不应被调用）
            mock_conn.fetchrow.assert_not_called()

        asyncio.run(_run())

    def test_falls_back_to_pg_and_promotes_to_redis(self):
        """Redis 未命中时查 PG，命中后回写 Redis"""
        result = _make_result()
        content_hash = result.content_hash
        masks_json = json.dumps([m.model_dump() for m in result.masks])

        mock_redis = AsyncMock()
        mock_redis.get.return_value = None  # Redis 未命中

        # 模拟 PG 返回
        mock_row = {
            "masks_jsonb": masks_json,
            "width": 800,
            "height": 600,
        }
        mock_conn = AsyncMock()
        mock_conn.fetchrow.return_value = mock_row
        mock_conn.execute.return_value = "UPDATE 1"

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    got = await get_cached_segmentation(content_hash)

            assert got is not None
            assert got.content_hash == content_hash
            assert len(got.masks) == 2

            # 验证更新了 last_accessed_at
            execute_calls = mock_conn.execute.call_args_list
            assert len(execute_calls) == 1
            assert "UPDATE segmentation_cache" in execute_calls[0][0][0]

            # 验证回写 Redis
            assert mock_redis.setex.call_count == 1
            setex_args = mock_redis.setex.call_args[0]
            assert setex_args[0] == f"seg:hash:{content_hash}"
            assert setex_args[1] == SEG_CACHE_TTL

        asyncio.run(_run())

    def test_returns_none_when_both_miss(self):
        """Redis 和 PG 都未命中时返回 None"""
        mock_redis = AsyncMock()
        mock_redis.get.return_value = None

        mock_conn = AsyncMock()
        mock_conn.fetchrow.return_value = None

        async def _run():
            with patch("core.redis.get_redis", return_value=mock_redis):
                with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                    got = await get_cached_segmentation("b" * 64)

            assert got is None

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# evict_lru_cache_entries 测试
# ---------------------------------------------------------------------------


class TestEvictLruCacheEntries:
    """evict_lru_cache_entries LRU 淘汰"""

    def test_evicts_entries_beyond_limit(self):
        """淘汰超出上限的条目"""
        mock_conn = AsyncMock()
        mock_conn.execute.return_value = "DELETE 5"

        async def _run():
            with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                deleted = await evict_lru_cache_entries(max_entries=100)

            assert deleted == 5
            # 验证 SQL 使用了 OFFSET
            sql = mock_conn.execute.call_args[0][0]
            assert "ORDER BY last_accessed_at ASC" in sql
            assert "OFFSET" in sql

        asyncio.run(_run())

    def test_returns_zero_when_nothing_to_evict(self):
        """无需淘汰时返回 0"""
        mock_conn = AsyncMock()
        mock_conn.execute.return_value = "DELETE 0"

        async def _run():
            with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                deleted = await evict_lru_cache_entries(max_entries=500)

            assert deleted == 0

        asyncio.run(_run())

    def test_handles_db_failure_gracefully(self):
        """数据库失败时不抛异常，返回 0"""
        mock_conn = AsyncMock()
        mock_conn.execute.side_effect = Exception("连接池耗尽")

        async def _run():
            with patch("core.pool.acquire", _mock_acquire(mock_conn)):
                deleted = await evict_lru_cache_entries()

            assert deleted == 0

        asyncio.run(_run())
