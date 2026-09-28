"""
速率限制（Rate Limiting）
基于 Redis 滑动窗口算法，防止单用户/IP 过度请求

使用方式：
    from core.rate_limit import rate_limit, RateLimitExceeded

    # 在路由中使用
    await rate_limit(user_id="xxx", action="generate", limit=5, window=60)
"""
import time
import logging
from fastapi import HTTPException

from core.redis import get_redis

logger = logging.getLogger(__name__)

# ─── 预设限制规则 ──────────────────────────────────────────────────────────────

# (每窗口最大请求数, 窗口秒数)
RATE_LIMITS = {
    "generate":     (10, 60),    # 图像生成：每分钟 10 次
    "segmentation": (5,  60),    # 分割：每分钟 5 次
    "layer-edit":   (10, 60),    # 图层编辑：每分钟 10 次
    "batch":        (3,  300),   # 批处理：每 5 分钟 3 次
    "nlp":          (30, 60),    # NLP 解析：每分钟 30 次
    "prompt":       (20, 60),    # Prompt 操作：每分钟 20 次
    "auth-login":   (10, 60),    # 密码/OTP 登录：每 IP 每分钟 10 次
    "auth-otp":     (5, 600),    # 邮箱验证码：每 IP 每 10 分钟 5 次
    "auth-register": (5, 600),   # 注册提交：每 IP 每 10 分钟 5 次
    "auth-captcha": (30, 60),    # 图形验证码生成：每 IP 每分钟 30 次
    "default":      (60, 60),    # 默认：每分钟 60 次
}


class RateLimitExceeded(Exception):
    def __init__(self, action: str, limit: int, window: int, retry_after: int):
        self.action = action
        self.limit = limit
        self.window = window
        self.retry_after = retry_after
        super().__init__(
            f"请求过于频繁，{action} 每 {window} 秒最多 {limit} 次，"
            f"请 {retry_after} 秒后重试"
        )


class RateLimitUnavailable(RuntimeError):
    """The caller requested fail-closed rate limiting but Redis is unavailable."""


async def rate_limit(
    user_id: str,
    action: str,
    limit: int | None = None,
    window: int | None = None,
    fail_closed: bool = False,
) -> int:
    """
    滑动窗口速率限制。
    返回当前窗口内的请求次数。
    超限时抛出 RateLimitExceeded。
    """
    preset = RATE_LIMITS.get(action, RATE_LIMITS["default"])
    _limit  = limit  or preset[0]
    _window = window or preset[1]

    key = f"rate:{action}:{user_id}"
    now = time.time()
    window_start = now - _window

    try:
        r = get_redis()
        pipe = r.pipeline()
        # pipeline 内部命令不 await，只 await 最终的 execute()
        pipe.zremrangebyscore(key, "-inf", window_start)
        pipe.zadd(key, {str(now): now})
        pipe.zcard(key)
        pipe.expire(key, _window + 1)
        results = await pipe.execute()

        count = results[2]  # zcard 的结果

        if count > _limit:
            # 计算最早请求的过期时间
            oldest = await r.zrange(key, 0, 0, withscores=True)
            if oldest:
                retry_after = int(_window - (now - oldest[0][1])) + 1
            else:
                retry_after = _window

            logger.warning(
                f"[rate_limit] 超限: user={user_id} action={action} "
                f"count={count}/{_limit} retry_after={retry_after}s"
            )
            raise RateLimitExceeded(action, _limit, _window, retry_after)

        return count

    except RateLimitExceeded:
        raise
    except Exception as e:
        if fail_closed:
            logger.error(f"[rate_limit] Redis 异常，拒绝受保护请求: {e}")
            raise RateLimitUnavailable(f"rate limiting unavailable for {action}") from e
        # Most legacy routes preserve their existing fail-open behavior.
        logger.error(f"[rate_limit] Redis 异常，跳过限制: {e}")
        return 0


async def check_rate_limit(user_id: str, action: str) -> dict:
    """
    查询速率限制状态（不计入请求次数）。
    返回 {count, limit, window, remaining, reset_in}
    """
    preset = RATE_LIMITS.get(action, RATE_LIMITS["default"])
    _limit  = preset[0]
    _window = preset[1]

    r = get_redis()
    key = f"rate:{action}:{user_id}"
    now = time.time()
    window_start = now - _window

    try:
        await r.zremrangebyscore(key, "-inf", window_start)
        count = await r.zcard(key)

        oldest = await r.zrange(key, 0, 0, withscores=True)
        reset_in = int(_window - (now - oldest[0][1])) + 1 if oldest else _window

        return {
            "count":     count,
            "limit":     _limit,
            "window":    _window,
            "remaining": max(0, _limit - count),
            "reset_in":  reset_in,
        }
    except Exception:
        return {"count": 0, "limit": _limit, "window": _window, "remaining": _limit, "reset_in": 0}


def rate_limit_http(action: str):
    """
    FastAPI 依赖注入版速率限制。
    用法：
        @router.post("/submit")
        async def submit(..., _=Depends(rate_limit_http("generate"))):
    """
    from fastapi import Depends
    from routers.auth import get_current_user

    async def _check(user: dict = Depends(get_current_user)):
        try:
            await rate_limit(user["id"], action)
        except RateLimitExceeded as e:
            raise HTTPException(
                status_code=429,
                detail=str(e),
                headers={"Retry-After": str(e.retry_after)},
            )
        return user

    return _check
