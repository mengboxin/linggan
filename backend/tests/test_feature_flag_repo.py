"""
Feature Flag 仓库单元测试

覆盖场景：
- enabled=true 全开
- enabled=false + allowlist 精确匹配命中
- enabled=false + allowlist 精确匹配未命中
- percent 灰度命中边界（0%/50%/100%）
- 空 allowlist（flag OFF）
- Redis 缓存命中/未命中
- 异常降级

Requirements: R14.1
"""
import asyncio
import hashlib
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from repositories.feature_flag_repo import (
    FEATURE_NAMES,
    FLAG_CACHE_TTL,
    _check_allowlist,
    _compute_percent_hash,
    _resolve_flags,
    get_user_flags,
)


# ─── 辅助函数测试 ─────────────────────────────────────────────────────────────


class TestComputePercentHash:
    """测试灰度 hash 计算。"""

    def test_returns_int_in_range(self):
        """返回值应在 [0, 99] 范围内。"""
        result = _compute_percent_hash("user-123", "salt-abc")
        assert 0 <= result <= 99

    def test_deterministic(self):
        """相同输入应返回相同结果。"""
        r1 = _compute_percent_hash("user-123", "salt-abc")
        r2 = _compute_percent_hash("user-123", "salt-abc")
        assert r1 == r2

    def test_different_users_may_differ(self):
        """不同用户可能得到不同 hash（非绝对，但统计上应如此）。"""
        results = set()
        for i in range(100):
            results.add(_compute_percent_hash(f"user-{i}", "test-salt"))
        # 100 个用户至少应有多个不同值
        assert len(results) > 1

    def test_matches_expected_algorithm(self):
        """验证算法与规范一致：md5(user_id + salt) 前 8 位 hex → int → mod 100。"""
        user_id = "test-user-42"
        salt = "ppt-5pct-2025"
        expected_digest = hashlib.md5(f"{user_id}{salt}".encode()).hexdigest()
        expected = int(expected_digest[:8], 16) % 100
        assert _compute_percent_hash(user_id, salt) == expected


class TestCheckAllowlist:
    """测试 allowlist 解析逻辑。"""

    def test_empty_array_returns_false(self):
        """空数组 [] → flag OFF。"""
        assert _check_allowlist("user-1", "[]") is False

    def test_user_in_array_returns_true(self):
        """用户在数组中 → flag ON。"""
        allowlist = json.dumps(["user-1", "user-2", "user-3"])
        assert _check_allowlist("user-2", allowlist) is True

    def test_user_not_in_array_returns_false(self):
        """用户不在数组中 → flag OFF。"""
        allowlist = json.dumps(["user-1", "user-2", "user-3"])
        assert _check_allowlist("user-99", allowlist) is False

    def test_percent_0_always_false(self):
        """percent=0 → 所有用户都不命中。"""
        allowlist = json.dumps({"percent": 0, "salt": "test"})
        # 测试多个用户，全部应为 False
        for i in range(50):
            assert _check_allowlist(f"user-{i}", allowlist) is False

    def test_percent_100_always_true(self):
        """percent=100 → 所有用户都命中。"""
        allowlist = json.dumps({"percent": 100, "salt": "test"})
        # 测试多个用户，全部应为 True
        for i in range(50):
            assert _check_allowlist(f"user-{i}", allowlist) is True

    def test_percent_50_partial_hit(self):
        """percent=50 → 大约一半用户命中（统计验证）。"""
        allowlist = json.dumps({"percent": 50, "salt": "half-test"})
        hits = sum(
            1 for i in range(1000)
            if _check_allowlist(f"user-{i}", allowlist)
        )
        # 允许 ±10% 的统计偏差
        assert 400 <= hits <= 600, f"50% 灰度命中 {hits}/1000，偏差过大"

    def test_invalid_json_returns_false(self):
        """无效 JSON → flag OFF。"""
        assert _check_allowlist("user-1", "not-json") is False

    def test_none_value_returns_false(self):
        """None 值 → flag OFF。"""
        assert _check_allowlist("user-1", None) is False

    def test_percent_with_empty_salt(self):
        """percent 对象 salt 为空字符串时仍正常工作。"""
        allowlist = json.dumps({"percent": 100, "salt": ""})
        assert _check_allowlist("user-1", allowlist) is True

    def test_percent_boundary_exact(self):
        """验证 hash < percent 的边界条件。"""
        # 找一个已知 hash 值的用户来精确验证
        user_id = "boundary-test"
        salt = "boundary-salt"
        hash_val = _compute_percent_hash(user_id, salt)

        # percent 刚好等于 hash_val → 不命中（因为是 < 而非 <=）
        allowlist_eq = json.dumps({"percent": hash_val, "salt": salt})
        assert _check_allowlist(user_id, allowlist_eq) is False

        # percent = hash_val + 1 → 命中
        allowlist_above = json.dumps({"percent": hash_val + 1, "salt": salt})
        assert _check_allowlist(user_id, allowlist_above) is True


# ─── _resolve_flags 测试 ──────────────────────────────────────────────────────


class TestResolveFlags:
    """测试 flag 解析逻辑。"""

    def test_all_enabled_true(self):
        """所有 flag enabled=true → 全部 ON。"""
        settings = {
            "feature.touch_edit.enabled": "true",
            "feature.touch_edit.allowlist": "[]",
            "feature.agent_orchestrator.enabled": "true",
            "feature.agent_orchestrator.allowlist": "[]",
            "feature.ppt_canvas.enabled": "true",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("any-user", settings)
        assert result == {
            "touch_edit": True,
            "agent_orchestrator": True,
            "ppt_canvas": True,
        }

    def test_all_disabled_empty_allowlist(self):
        """所有 flag enabled=false + 空 allowlist → 全部 OFF。"""
        settings = {
            "feature.touch_edit.enabled": "false",
            "feature.touch_edit.allowlist": "[]",
            "feature.agent_orchestrator.enabled": "false",
            "feature.agent_orchestrator.allowlist": "[]",
            "feature.ppt_canvas.enabled": "false",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("any-user", settings)
        assert result == {
            "touch_edit": False,
            "agent_orchestrator": False,
            "ppt_canvas": False,
        }

    def test_disabled_but_in_allowlist(self):
        """enabled=false 但用户在 allowlist 中 → flag ON。"""
        settings = {
            "feature.touch_edit.enabled": "false",
            "feature.touch_edit.allowlist": json.dumps(["user-42", "user-99"]),
            "feature.agent_orchestrator.enabled": "false",
            "feature.agent_orchestrator.allowlist": "[]",
            "feature.ppt_canvas.enabled": "false",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("user-42", settings)
        assert result["touch_edit"] is True
        assert result["agent_orchestrator"] is False
        assert result["ppt_canvas"] is False

    def test_disabled_not_in_allowlist(self):
        """enabled=false 且用户不在 allowlist 中 → flag OFF。"""
        settings = {
            "feature.touch_edit.enabled": "false",
            "feature.touch_edit.allowlist": json.dumps(["user-42", "user-99"]),
            "feature.agent_orchestrator.enabled": "false",
            "feature.agent_orchestrator.allowlist": "[]",
            "feature.ppt_canvas.enabled": "false",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("user-1", settings)
        assert result["touch_edit"] is False

    def test_percent_grayscale(self):
        """enabled=false + percent 灰度 → 根据 hash 判断。"""
        settings = {
            "feature.touch_edit.enabled": "false",
            "feature.touch_edit.allowlist": json.dumps({"percent": 100, "salt": "all"}),
            "feature.agent_orchestrator.enabled": "false",
            "feature.agent_orchestrator.allowlist": json.dumps({"percent": 0, "salt": "none"}),
            "feature.ppt_canvas.enabled": "false",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("any-user", settings)
        assert result["touch_edit"] is True  # 100% → 全命中
        assert result["agent_orchestrator"] is False  # 0% → 全不命中
        assert result["ppt_canvas"] is False  # 空 allowlist

    def test_missing_settings_default_to_off(self):
        """缺失的 settings key 默认为 OFF。"""
        result = _resolve_flags("user-1", {})
        assert result == {
            "touch_edit": False,
            "agent_orchestrator": False,
            "ppt_canvas": False,
        }

    def test_mixed_flags(self):
        """混合场景：一个全开、一个 allowlist 命中、一个关闭。"""
        settings = {
            "feature.touch_edit.enabled": "true",
            "feature.touch_edit.allowlist": "[]",
            "feature.agent_orchestrator.enabled": "false",
            "feature.agent_orchestrator.allowlist": json.dumps(["target-user"]),
            "feature.ppt_canvas.enabled": "false",
            "feature.ppt_canvas.allowlist": "[]",
        }
        result = _resolve_flags("target-user", settings)
        assert result["touch_edit"] is True
        assert result["agent_orchestrator"] is True
        assert result["ppt_canvas"] is False


# ─── get_user_flags 集成测试（mock DB + Redis） ───────────────────────────────


class TestGetUserFlags:
    """测试 get_user_flags 完整流程（mock 外部依赖）。"""

    def test_cache_hit(self):
        """Redis 缓存命中时直接返回，不查 DB。"""
        async def _run():
            mock_redis = AsyncMock()
            mock_redis.hgetall = AsyncMock(return_value={
                "touch_edit": "1",
                "agent_orchestrator": "0",
                "ppt_canvas": "1",
            })

            with patch("repositories.feature_flag_repo.get_redis", return_value=mock_redis):
                result = await get_user_flags("user-123")

            assert result == {
                "touch_edit": True,
                "agent_orchestrator": False,
                "ppt_canvas": True,
            }
            # 不应查询数据库
            mock_redis.hgetall.assert_called_once_with("flag:user:user-123")

        asyncio.run(_run())

    def test_cache_miss_queries_db(self):
        """Redis 缓存未命中时查询 DB 并写入缓存。"""
        async def _run():
            mock_redis = AsyncMock()
            mock_redis.hgetall = AsyncMock(return_value={})  # 缓存未命中
            mock_redis.hset = AsyncMock()
            mock_redis.expire = AsyncMock()

            # Mock DB 返回
            mock_rows = [
                {"key": "feature.touch_edit.enabled", "value": "true"},
                {"key": "feature.touch_edit.allowlist", "value": "[]"},
                {"key": "feature.agent_orchestrator.enabled", "value": "false"},
                {"key": "feature.agent_orchestrator.allowlist", "value": "[]"},
                {"key": "feature.ppt_canvas.enabled", "value": "false"},
                {"key": "feature.ppt_canvas.allowlist", "value": "[]"},
            ]

            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=mock_rows)

            with patch("repositories.feature_flag_repo.get_redis", return_value=mock_redis), \
                 patch("repositories.feature_flag_repo.acquire") as mock_acquire:
                mock_acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
                mock_acquire.return_value.__aexit__ = AsyncMock(return_value=False)

                result = await get_user_flags("user-456")

            assert result == {
                "touch_edit": True,
                "agent_orchestrator": False,
                "ppt_canvas": False,
            }
            # 验证写入缓存
            mock_redis.hset.assert_called_once()
            mock_redis.expire.assert_called_once_with("flag:user:user-456", FLAG_CACHE_TTL)

        asyncio.run(_run())

    def test_redis_failure_fallback_to_db(self):
        """Redis 不可用时降级到直查 DB。"""
        async def _run():
            mock_redis = AsyncMock()
            mock_redis.hgetall = AsyncMock(side_effect=Exception("Redis down"))
            mock_redis.hset = AsyncMock(side_effect=Exception("Redis down"))
            mock_redis.expire = AsyncMock(side_effect=Exception("Redis down"))

            mock_rows = [
                {"key": "feature.touch_edit.enabled", "value": "true"},
                {"key": "feature.touch_edit.allowlist", "value": "[]"},
                {"key": "feature.agent_orchestrator.enabled", "value": "true"},
                {"key": "feature.agent_orchestrator.allowlist", "value": "[]"},
                {"key": "feature.ppt_canvas.enabled", "value": "true"},
                {"key": "feature.ppt_canvas.allowlist", "value": "[]"},
            ]

            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=mock_rows)

            with patch("repositories.feature_flag_repo.get_redis", return_value=mock_redis), \
                 patch("repositories.feature_flag_repo.acquire") as mock_acquire:
                mock_acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
                mock_acquire.return_value.__aexit__ = AsyncMock(return_value=False)

                result = await get_user_flags("user-789")

            # 即使 Redis 失败，仍应返回正确结果
            assert result == {
                "touch_edit": True,
                "agent_orchestrator": True,
                "ppt_canvas": True,
            }

        asyncio.run(_run())

    def test_allowlist_with_percent_grayscale(self):
        """percent 灰度场景完整流程。"""
        async def _run():
            mock_redis = AsyncMock()
            mock_redis.hgetall = AsyncMock(return_value={})
            mock_redis.hset = AsyncMock()
            mock_redis.expire = AsyncMock()

            mock_rows = [
                {"key": "feature.touch_edit.enabled", "value": "false"},
                {"key": "feature.touch_edit.allowlist", "value": json.dumps({"percent": 100, "salt": "all-in"})},
                {"key": "feature.agent_orchestrator.enabled", "value": "false"},
                {"key": "feature.agent_orchestrator.allowlist", "value": json.dumps({"percent": 0, "salt": "none"})},
                {"key": "feature.ppt_canvas.enabled", "value": "false"},
                {"key": "feature.ppt_canvas.allowlist", "value": json.dumps({"percent": 50, "salt": "half"})},
            ]

            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=mock_rows)

            with patch("repositories.feature_flag_repo.get_redis", return_value=mock_redis), \
                 patch("repositories.feature_flag_repo.acquire") as mock_acquire:
                mock_acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
                mock_acquire.return_value.__aexit__ = AsyncMock(return_value=False)

                result = await get_user_flags("test-user")

            assert result["touch_edit"] is True  # 100% → 全命中
            assert result["agent_orchestrator"] is False  # 0% → 全不命中
            # ppt_canvas 取决于 hash，不做断言

        asyncio.run(_run())

    def test_cache_stores_correct_format(self):
        """验证写入 Redis 的格式为 hash，值为 '1'/'0'。"""
        async def _run():
            mock_redis = AsyncMock()
            mock_redis.hgetall = AsyncMock(return_value={})
            mock_redis.hset = AsyncMock()
            mock_redis.expire = AsyncMock()

            mock_rows = [
                {"key": "feature.touch_edit.enabled", "value": "true"},
                {"key": "feature.touch_edit.allowlist", "value": "[]"},
                {"key": "feature.agent_orchestrator.enabled", "value": "false"},
                {"key": "feature.agent_orchestrator.allowlist", "value": "[]"},
                {"key": "feature.ppt_canvas.enabled", "value": "false"},
                {"key": "feature.ppt_canvas.allowlist", "value": "[]"},
            ]

            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=mock_rows)

            with patch("repositories.feature_flag_repo.get_redis", return_value=mock_redis), \
                 patch("repositories.feature_flag_repo.acquire") as mock_acquire:
                mock_acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
                mock_acquire.return_value.__aexit__ = AsyncMock(return_value=False)

                await get_user_flags("user-cache-test")

            # 验证 hset 调用参数
            call_args = mock_redis.hset.call_args
            assert call_args.kwargs["mapping"] == {
                "touch_edit": "1",
                "agent_orchestrator": "0",
                "ppt_canvas": "0",
            }

        asyncio.run(_run())
