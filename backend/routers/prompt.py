"""
Prompt 资产路由

- POST /api/prompt/process          一次调用完成：安全校验 + 优化 + 建议生成（LangGraph）
- POST /api/prompt/history          保存提示词记录
- GET  /api/prompt/history          分页获取历史（最近使用）
- GET  /api/prompt/history/starred  获取收藏列表
- GET  /api/prompt/history/search   关键词搜索
- POST /api/prompt/history/{id}/star    收藏/取消收藏
- DELETE /api/prompt/history/{id}   删除
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

import repositories.prompt_repo as prompt_repo
import repositories.model_repo as model_repo
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt", tags=["Prompt 资产"])


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class ProcessPromptRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    mode: Optional[str] = Field(default="TEXT_TO_IMAGE", pattern="^(TEXT_TO_IMAGE|IMAGE_EDIT)$")
    layer_bounds: Optional[dict] = None
    model_id: Optional[str] = None
    optimize: bool = True
    client_request_id: str = Field(default="", max_length=160)


class SavePromptRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    model_id: Optional[str] = None
    mode: Optional[str] = Field(default=None, pattern="^(TEXT_TO_IMAGE|IMAGE_EDIT)$")
    tags: Optional[list[str]] = []
    note: Optional[str] = None


# ─── 核心：一次调用完成安全校验 + 优化 + 建议 ─────────────────────────────────

@router.post("/process")
async def process_prompt(
    body: ProcessPromptRequest,
    user: dict = Depends(get_current_user),
):
    """
    LangGraph 工作流：input_parse → llm_process → output_format
    单次 LLM 调用完成：
      1. 安全校验（是否包含违规内容）
      2. 提示词优化（中文翻译 + 质量词 + 风格词）
      3. 生成 3 条建议变体
    """
    try:
        from services.agents import PromptAgent
        graph = PromptAgent()
        if not body.optimize:
            return {
                "safe":             True,
                "violation_reason": "",
                "optimized":        body.prompt,
                "suggestions":      [],
                "original":         body.prompt,
            }
        if body.model_id:
            model = await model_repo.get_model(body.model_id)
            if not model:
                raise HTTPException(404, f"模型 {body.model_id!r} 不存在或已禁用")
            if model.get("category") != "llm":
                raise HTTPException(400, "AI 优化请选择文本模型")
        result = await graph.run(
            original_prompt=body.prompt,
            mode=body.mode or "IMAGE_EDIT",
            layer_bounds=body.layer_bounds,
            model_id=body.model_id,
            user_id=str(user["id"]),
            client_request_id=body.client_request_id,
        )
        return {
            "safe":             result.get("safe", True),
            "violation_reason": result.get("violation_reason", ""),
            "optimized":        result.get("final_prompt", body.prompt),
            "suggestions":      result.get("suggestions", []),
            "original":         body.prompt,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[prompt] process failed: %s", e, exc_info=True)
        # 降级：直接返回原始提示词，标记为安全
        return {
            "safe":             True,
            "violation_reason": "",
            "optimized":        body.prompt,
            "suggestions":      [],
            "original":         body.prompt,
            "error":            "处理服务暂时不可用",
            "error_code":       "prompt_optimization_unavailable",
            "degraded":         True,
        }


# ─── 兼容旧接口 /optimize ──────────────────────────────────────────────────────

@router.post("/optimize")
async def optimize_prompt(
    body: ProcessPromptRequest,
    user: dict = Depends(get_current_user),
):
    """兼容旧接口，内部调用 /process"""
    result = await process_prompt(body, user)
    return {
        "optimized":   result["optimized"],
        "suggestions": result["suggestions"],
        "original":    result["original"],
        "safe":        result["safe"],
    }


# ─── 保存提示词 ────────────────────────────────────────────────────────────────

@router.post("/history")
async def save_prompt_history(
    body: SavePromptRequest,
    user: dict = Depends(get_current_user),
):
    """保存提示词记录（相同内容自动累加使用次数）"""
    try:
        record = await prompt_repo.save_prompt(
            user_id=user["id"],
            content=body.content,
            model_id=body.model_id,
            mode=body.mode,
            tags=body.tags,
            note=body.note,
        )
        return {"ok": True, "item": record}
    except Exception as e:
        logger.error(f"[prompt] save_prompt failed: {e}")
        raise HTTPException(status_code=500, detail="保存提示词失败")


# ─── 获取最近历史 ──────────────────────────────────────────────────────────────

@router.get("/history")
async def list_prompt_history(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    """分页获取当前用户的提示词历史（最近使用，按时间倒序）"""
    try:
        return await prompt_repo.list_prompts(
            user_id=user["id"],
            page=page,
            page_size=page_size,
        )
    except Exception as e:
        logger.error(f"[prompt] list_prompts failed: {e}")
        raise HTTPException(status_code=500, detail="获取提示词历史失败")


# ─── 获取收藏列表 ──────────────────────────────────────────────────────────────

@router.get("/history/starred")
async def list_starred_prompts(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    """获取用户收藏的提示词"""
    try:
        return await prompt_repo.list_starred(
            user_id=user["id"],
            page=page,
            page_size=page_size,
        )
    except Exception as e:
        logger.error(f"[prompt] list_starred failed: {e}")
        raise HTTPException(status_code=500, detail="获取收藏失败")


# ─── 搜索历史 ──────────────────────────────────────────────────────────────────

@router.get("/history/search")
async def search_prompt_history(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    """按关键词搜索当前用户的提示词历史"""
    try:
        items = await prompt_repo.search_prompts(
            user_id=user["id"],
            query=q,
            limit=limit,
        )
        return {"items": items, "query": q}
    except Exception as e:
        logger.error(f"[prompt] search_prompts failed: {e}")
        raise HTTPException(status_code=500, detail="搜索提示词失败")


# ─── 收藏 / 取消收藏 ──────────────────────────────────────────────────────────

@router.post("/history/{prompt_id}/star")
async def toggle_star(
    prompt_id: str,
    user: dict = Depends(get_current_user),
):
    """切换收藏状态"""
    try:
        result = await prompt_repo.toggle_star(user["id"], prompt_id)
        return {"ok": True, "is_starred": result}
    except Exception as e:
        logger.error(f"[prompt] toggle_star failed: {e}")
        raise HTTPException(status_code=500, detail="操作失败")


# ─── 删除 ──────────────────────────────────────────────────────────────────────

@router.delete("/history/{prompt_id}")
async def delete_prompt(
    prompt_id: str,
    user: dict = Depends(get_current_user),
):
    """删除指定提示词记录"""
    try:
        ok = await prompt_repo.delete_prompt(user["id"], prompt_id)
        if not ok:
            raise HTTPException(status_code=404, detail="记录不存在")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[prompt] delete_prompt failed: {e}")
        raise HTTPException(status_code=500, detail="删除失败")
