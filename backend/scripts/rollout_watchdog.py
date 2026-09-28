"""
Rollout Watchdog — SLO 监控与自动回滚

每分钟检查关键指标，命中阈值时自动关闭 feature flag 并通知。

阈值规则（R14.2, R14.5）：
- 5xx 错误率 > 2% 持续 5min → 自动 disable
- SLO 违反 > 5% 流量持续 5min → 自动 disable
- 崩溃率 > 0.5% 持续 10min → 自动 disable

用法：
  python backend/scripts/rollout_watchdog.py [--once] [--force-disable touch_edit|agent|ppt_canvas]
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

# 添加项目根目录到 path
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from core.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [watchdog] %(message)s")
logger = logging.getLogger(__name__)

# ─── 阈值配置 ─────────────────────────────────────────────────────────────────

THRESHOLDS = {
    "5xx_rate": {"value": 0.02, "duration_min": 5},       # 2% 持续 5 分钟
    "slo_violation": {"value": 0.05, "duration_min": 5},   # 5% 持续 5 分钟
    "crash_rate": {"value": 0.005, "duration_min": 10},    # 0.5% 持续 10 分钟
}

FEATURE_FLAGS = ["touch_edit", "agent_orchestrator", "ppt_canvas"]
CHECK_INTERVAL_SEC = 60  # 每 60 秒检查一次


# ─── 状态跟踪（防抖）─────────────────────────────────────────────────────────

@dataclass
class AlertState:
    """单个指标的告警状态（用于防抖）"""
    first_breach_at: Optional[float] = None
    is_active: bool = False

    def record_breach(self, now: float) -> None:
        if self.first_breach_at is None:
            self.first_breach_at = now

    def clear(self) -> None:
        self.first_breach_at = None
        self.is_active = False

    def duration_sec(self, now: float) -> float:
        if self.first_breach_at is None:
            return 0
        return now - self.first_breach_at


alert_states: dict[str, AlertState] = {
    "5xx_rate": AlertState(),
    "slo_violation": AlertState(),
    "crash_rate": AlertState(),
}


# ─── 指标获取（占位 — 生产环境对接 Prometheus/Sentry）────────────────────────

async def fetch_metrics() -> dict[str, float]:
    """
    获取当前监控指标。

    生产环境应对接 Prometheus query API 或 Sentry API。
    当前为占位实现，返回安全值。
    """
    # TODO: 对接 Prometheus
    # 示例：
    # async with httpx.AsyncClient() as client:
    #     resp = await client.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": "..."})
    return {
        "5xx_rate": 0.0,
        "slo_violation": 0.0,
        "crash_rate": 0.0,
    }


# ─── Feature Flag 操作 ────────────────────────────────────────────────────────

async def disable_feature(flag_name: str, reason: str) -> None:
    """
    关闭指定 feature flag。

    通过直接更新 Redis 缓存 + 数据库实现即时生效。
    """
    from core.redis import get_redis

    r = get_redis()

    # 清除所有用户的 flag 缓存（强制下次请求重新查询）
    # 生产环境应使用 SCAN 或 pub/sub 通知
    logger.warning(f"DISABLING feature flag: {flag_name} | reason: {reason}")

    # 更新数据库
    try:
        from core.pool import acquire
        async with acquire() as conn:
            await conn.execute(
                "UPDATE system_settings SET value = 'false' WHERE key = $1",
                f"feature.{flag_name}.enabled",
            )
    except Exception as e:
        logger.error(f"Failed to update DB for {flag_name}: {e}")

    # 清除 Redis 缓存
    try:
        # 删除所有 flag 缓存 key（简化实现）
        keys = await r.keys("flag:user:*")
        if keys:
            await r.delete(*keys)
    except Exception as e:
        logger.error(f"Failed to clear Redis cache: {e}")


async def notify_team(flag_name: str, reason: str, metrics: dict) -> None:
    """
    发送告警通知（飞书/Slack webhook）。

    生产环境应配置 WEBHOOK_URL 环境变量。
    """
    webhook_url = getattr(settings, "ALERT_WEBHOOK_URL", "")
    if not webhook_url:
        logger.info(f"[notify] No webhook configured. Alert: {flag_name} disabled - {reason}")
        return

    try:
        import httpx
        payload = {
            "msg_type": "text",
            "content": {
                "text": (
                    f"[Rollout Watchdog] Feature '{flag_name}' has been DISABLED.\n"
                    f"Reason: {reason}\n"
                    f"Metrics: {json.dumps(metrics)}\n"
                    f"Time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}"
                ),
            },
        }
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(webhook_url, json=payload)
    except Exception as e:
        logger.error(f"[notify] Failed to send alert: {e}")


# ─── 主检查循环 ───────────────────────────────────────────────────────────────

async def check_once() -> list[str]:
    """
    执行一次检查。返回被禁用的 flag 列表。
    """
    metrics = await fetch_metrics()
    now = time.time()
    disabled_flags: list[str] = []

    for metric_name, threshold_config in THRESHOLDS.items():
        threshold_value = threshold_config["value"]
        duration_min = threshold_config["duration_min"]
        current_value = metrics.get(metric_name, 0.0)
        state = alert_states[metric_name]

        if current_value > threshold_value:
            state.record_breach(now)
            duration = state.duration_sec(now)

            if duration >= duration_min * 60 and not state.is_active:
                # 触发！禁用所有 feature flags
                state.is_active = True
                reason = (
                    f"{metric_name}={current_value:.4f} > {threshold_value} "
                    f"for {duration/60:.1f} min (threshold: {duration_min} min)"
                )
                logger.critical(f"THRESHOLD BREACHED: {reason}")

                for flag in FEATURE_FLAGS:
                    await disable_feature(flag, reason)
                    disabled_flags.append(flag)

                await notify_team("ALL", reason, metrics)
        else:
            # 指标恢复正常，清除状态
            if state.first_breach_at is not None:
                logger.info(f"{metric_name} recovered (was breached for {state.duration_sec(now)/60:.1f} min)")
            state.clear()

    return disabled_flags


async def run_loop() -> None:
    """持续运行检查循环"""
    logger.info(f"Watchdog started. Check interval: {CHECK_INTERVAL_SEC}s")
    logger.info(f"Thresholds: {json.dumps(THRESHOLDS)}")

    while True:
        try:
            await check_once()
        except Exception as e:
            logger.error(f"Check failed: {e}")
        await asyncio.sleep(CHECK_INTERVAL_SEC)


async def force_disable(flag_name: str) -> None:
    """强制禁用指定 flag（手动回滚）"""
    if flag_name not in FEATURE_FLAGS:
        logger.error(f"Unknown flag: {flag_name}. Valid: {FEATURE_FLAGS}")
        return
    await disable_feature(flag_name, "Manual force-disable via CLI")
    await notify_team(flag_name, "Manual force-disable", {})
    logger.info(f"Force-disabled: {flag_name}")


# ─── CLI 入口 ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Rollout Watchdog")
    parser.add_argument("--once", action="store_true", help="Run check once and exit")
    parser.add_argument("--force-disable", type=str, help="Force disable a feature flag")
    args = parser.parse_args()

    if args.force_disable:
        asyncio.run(force_disable(args.force_disable))
    elif args.once:
        result = asyncio.run(check_once())
        if result:
            logger.info(f"Disabled flags: {result}")
            sys.exit(1)
        else:
            logger.info("All clear.")
            sys.exit(0)
    else:
        asyncio.run(run_loop())


if __name__ == "__main__":
    main()
