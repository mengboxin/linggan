"""Feature Flag 仓库 —— 解析 system_settings 中的功能开关配置

从 system_settings 表读取 feature.{name}.enabled 与 feature.{name}.allowlist，
结合 Redis 缓存（TTL 300s）返回用户级 flag 状态。

Requirements: R14.1
"""
import hashlib
import json
from typing import Optional

from core.pool import acquire
from core.redis import get_redis

# 支持的 feature flag 名称
FEATURE_NAMES = ("touch_edit", "agent_orchestrator", "ppt_canvas")

# Redis 缓存 TTL（秒）
FLAG_CACHE_TTL = 300


def _compute_percent_hash(user_id: str, salt: str) -> int:
    """基于 MD5 计算用户灰度 hash 值（0-99）。

    算法：取 md5(user_id + salt) 前 8 位十六进制转整数，mod 100。
    """
    digest = hashlib.md5(f"{user_id}{salt}".encode()).hexdigest()
    return int(digest[:8], 16) % 100


def _check_allowlist(user_id: str, allowlist_value: str) -> bool:
    """解析 allowlist 值，判断用户是否命中。

    三种格式：
    1. JSON 数组（精确 user_id 匹配）：["uid-1", "uid-2"]
    2. 灰度对象：{"percent": N, "salt": "..."}
    3. 空数组 []：仅依赖 enabled，此处返回 False
    """
    try:
        parsed = json.loads(allowlist_value)
    except (json.JSONDecodeError, TypeError):
        return False

    if isinstance(parsed, list):
        # 空数组 → flag OFF；非空数组 → 精确匹配
        return user_id in parsed

    if isinstance(parsed, dict):
        percent = parsed.get("percent")
        salt = parsed.get("salt", "")
        if isinstance(percent, (int, float)) and 0 <= percent <= 100:
            return _compute_percent_hash(user_id, salt) < int(percent)

    return False


async def _fetch_flag_settings() -> dict[str, str]:
    """从 system_settings 表批量读取所有 feature flag 相关配置。

    返回 {key: value} 字典，如：
    {"feature.touch_edit.enabled": "true", "feature.touch_edit.allowlist": "[]", ...}
    """
    async with acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM system_settings WHERE key LIKE 'feature.%'"
        )
        return {row["key"]: row["value"] for row in rows}


def _resolve_flags(user_id: str, settings: dict[str, str]) -> dict[str, bool]:
    """根据 settings 数据解析每个 flag 对用户的最终状态。

    逻辑：
    1. enabled=true → flag ON（全量开启）
    2. enabled=false → 检查 allowlist：
       a. allowlist 是 user_id 数组 → 命中则 ON
       b. allowlist 是 {"percent": N, "salt": "..."} → hash 灰度命中则 ON
       c. allowlist 是空数组 [] → flag OFF
    """
    result = {}
    for name in FEATURE_NAMES:
        enabled_key = f"feature.{name}.enabled"
        allowlist_key = f"feature.{name}.allowlist"

        enabled_value = settings.get(enabled_key, "false")

        # 解析 enabled：JSONB 存储的 'true'/'false' 字符串
        try:
            enabled = json.loads(enabled_value)
        except (json.JSONDecodeError, TypeError):
            enabled = False

        if enabled is True:
            result[name] = True
        else:
            # enabled=false，检查 allowlist
            allowlist_value = settings.get(allowlist_key, "[]")
            result[name] = _check_allowlist(user_id, allowlist_value)

    return result


async def get_user_flags(user_id: str) -> dict[str, bool]:
    """获取用户的 feature flag 状态，带 Redis 缓存。

    返回格式：{"touch_edit": True/False, "agent_orchestrator": True/False, "ppt_canvas": True/False}
    """
    cache_key = f"flag:user:{user_id}"

    # 尝试从 Redis 缓存读取
    try:
        r = get_redis()
        cached = await r.hgetall(cache_key)
        if cached:
            # Redis hash 存储的值为 "1"/"0"
            return {
                name: cached.get(name, "0") == "1"
                for name in FEATURE_NAMES
            }
    except Exception:
        pass  # Redis 不可用时降级到直查

    # 从数据库读取并解析
    settings = await _fetch_flag_settings()
    flags = _resolve_flags(user_id, settings)

    # 写入 Redis 缓存
    try:
        r = get_redis()
        cache_data = {name: "1" if val else "0" for name, val in flags.items()}
        await r.hset(cache_key, mapping=cache_data)
        await r.expire(cache_key, FLAG_CACHE_TTL)
    except Exception:
        pass  # Redis 写入失败不影响功能

    return flags
