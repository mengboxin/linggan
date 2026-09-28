"""
快速关闭所有 feature flags 并清除 Redis 缓存

执行方式：
    cd backend
    python scripts/disable_feature_flags.py

效果：
    - 将 system_settings 中 feature.*.enabled 全部设为 false
    - 将 feature.*.allowlist 全部设为 []
    - 清除 Redis 中所有 flag:user:* 缓存
    - 前端 5 分钟内自动降级到 legacy UI（或用户刷新页面立即生效）
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


DISABLE_SQL = """
UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'feature.touch_edit.enabled';
UPDATE system_settings SET value = '[]'::jsonb WHERE key = 'feature.touch_edit.allowlist';
UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'feature.agent_orchestrator.enabled';
UPDATE system_settings SET value = '[]'::jsonb WHERE key = 'feature.agent_orchestrator.allowlist';
UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'feature.ppt_canvas.enabled';
UPDATE system_settings SET value = '[]'::jsonb WHERE key = 'feature.ppt_canvas.allowlist';
"""


async def disable_flags():
    import asyncpg
    from core.config import settings

    dsn = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)

    try:
        for stmt in DISABLE_SQL.strip().split("\n"):
            stmt = stmt.strip()
            if stmt and not stmt.startswith("--"):
                result = await conn.execute(stmt)
                print(f"  {result}: {stmt[:60]}...")

        print("\n[OK] Feature flags disabled in database")
    finally:
        await conn.close()

    # 清除 Redis 缓存
    try:
        from core.redis import get_redis
        r = get_redis()
        cursor = 0
        deleted = 0
        while True:
            cursor, keys = await r.scan(cursor, match="flag:user:*", count=100)
            if keys:
                await r.delete(*keys)
                deleted += len(keys)
            if cursor == 0:
                break
        print(f"[OK] Cleared {deleted} Redis flag cache entries")
    except Exception as e:
        print(f"[WARN] Redis cache clear failed (non-critical): {e}")
        print("       Caches will expire naturally in 5 minutes")

    print("\n Done! Users will see legacy UI on next page refresh.")


if __name__ == "__main__":
    asyncio.run(disable_flags())
