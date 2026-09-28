"""
Feature Flags 路由

GET /api/system/flags — 返回当前用户的功能开关状态

端点返回格式：
{
    "touch_edit": bool,
    "agent_orchestrator": bool,
    "ppt_canvas": bool,
    "user_id": str
}

Redis 缓存 `flag:user:{uid}` TTL 300s，命中时跳过 PG 查询（已在 feature_flag_repo 中实现）。

Requirements: R14.1, R14.2
"""
from fastapi import APIRouter, Depends

from repositories.feature_flag_repo import get_user_flags
from routers.auth import get_current_user

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/flags")
async def get_flags(user: dict = Depends(get_current_user)):
    """获取当前用户的 feature flag 状态。

    需要认证，未登录返回 401。
    Redis 缓存命中时跳过 PG 查询（TTL 300s）。
    """
    flags = await get_user_flags(user["id"])
    return {
        "touch_edit": flags["touch_edit"],
        "agent_orchestrator": flags["agent_orchestrator"],
        "ppt_canvas": flags["ppt_canvas"],
        "user_id": user["id"],
    }
