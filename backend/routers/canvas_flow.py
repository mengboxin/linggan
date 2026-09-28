"""Canvas-flow director routes."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from core.rate_limit import RateLimitExceeded, rate_limit
from routers.auth import get_current_user
from services.agents.canvas_flow_director import (
    CanvasFlowDirectRequest,
    CanvasFlowDirectResponse,
    direct_canvas_flow_plan,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/canvas-flow", tags=["自由画布导演"])


@router.post("/direct", response_model=CanvasFlowDirectResponse)
async def direct_canvas_flow(
    body: CanvasFlowDirectRequest,
    user: dict = Depends(get_current_user),
):
    try:
        await rate_limit(user["id"], "agent")
    except RateLimitExceeded as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(exc.retry_after)})
    return await direct_canvas_flow_plan(body, user_id=str(user["id"]))
