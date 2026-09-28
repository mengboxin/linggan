"""
PPT 生成路由（对话式，带历史记录）
注意：此文件目前未被 main.py 导入，实际 PPT 路由使用 ppt.py
保留此文件供未来扩展使用
"""
import json
from typing import Optional, List
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

from core.config import settings
from routers.auth import get_current_user
from services.agents.ppt_agent import PPTAgent
from repositories import conversation_repo

router = APIRouter(prefix="/api/ppt-conv", tags=["ppt-conversation"])


async def _conn() -> asyncpg.Connection:
    dsn = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    return await asyncpg.connect(dsn)


class PPTGenerateRequest(BaseModel):
    """PPT 生成请求"""
    topic: str = Field(..., min_length=1, max_length=500, description="PPT 主题")
    style_requirement: Optional[str] = Field(None, max_length=200, description="风格要求")
    page_count: int = Field(10, ge=6, le=20, description="页数")
    optimize_prompt: bool = Field(True, description="是否优化提示词")
    project_id: Optional[str] = Field(None, description="关联的项目 ID")


class PPTGenerationResponse(BaseModel):
    """PPT 生成响应"""
    id: str
    status: str
    topic: str
    optimized_topic: Optional[str]
    page_count: int
    progress: int
    created_at: str


@router.post("/generate", response_model=PPTGenerationResponse)
async def generate_ppt(
    req: PPTGenerateRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """生成 PPT（对话式，自动创建对话记录）"""
    # 检查积分
    if float(user.get("credits", 0)) < 10:
        raise HTTPException(status_code=402, detail="积分不足")

    # 1. 使用 LLM 从用户输入中提取标题
    agent = PPTAgent()
    conversation_title = await agent.extract_title(req.topic, req.style_requirement)

    # 2. 创建对话记录
    conversation = await conversation_repo.create_conversation(
        user_id=user["id"],
        conv_type="ppt",
        title=conversation_title,
    )
    conversation_id = conversation["id"]

    # 3. 保存用户输入消息
    user_input = f"主题: {req.topic}"
    if req.style_requirement:
        user_input += f"\n风格要求: {req.style_requirement}"
    user_input += f"\n页数: {req.page_count}"

    await conversation_repo.add_message(
        conversation_id=conversation_id,
        role="user",
        content=user_input,
        meta={
            "topic": req.topic,
            "style_requirement": req.style_requirement,
            "page_count": req.page_count,
            "optimize_prompt": req.optimize_prompt,
        },
    )

    # 4. 创建生成记录
    conn = await _conn()
    try:
        gen_id = await conn.fetchval(
            """
            INSERT INTO ppt_generations (
                user_id, project_id, topic, style_requirement,
                page_count, optimize_prompt, status
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, 'pending')
            RETURNING id
            """,
            user["id"],
            req.project_id,
            req.topic,
            req.style_requirement,
            req.page_count,
            req.optimize_prompt,
        )
        created_at = await conn.fetchval("SELECT NOW()")
    finally:
        await conn.close()

    # 5. 后台任务：执行 PPT 生成
    background_tasks.add_task(
        _generate_ppt_task,
        gen_id=str(gen_id),
        conversation_id=conversation_id,
        user_id=user["id"],
        topic=req.topic,
        style_requirement=req.style_requirement,
        page_count=req.page_count,
        optimize_prompt=req.optimize_prompt,
    )

    return PPTGenerationResponse(
        id=str(gen_id),
        status="pending",
        topic=req.topic,
        optimized_topic=None,
        page_count=req.page_count,
        progress=0,
        created_at=str(created_at),
    )


async def _generate_ppt_task(
    gen_id: str,
    conversation_id: str,
    user_id: str,
    topic: str,
    style_requirement: Optional[str],
    page_count: int,
    optimize_prompt: bool,
):
    """后台任务：生成 PPT"""
    agent = PPTAgent()

    async def get_conn():
        return await _conn()

    conn = await get_conn()
    try:
        # 1. 优化提示词
        if optimize_prompt:
            await conn.execute(
                "UPDATE ppt_generations SET status = 'optimizing', progress = 10 WHERE id = $1::uuid",
                gen_id,
            )
            optimized_topic = await agent.optimize_prompt(topic, style_requirement)
            await conn.execute(
                "UPDATE ppt_generations SET optimized_topic = $1 WHERE id = $2::uuid",
                optimized_topic,
                gen_id,
            )
        else:
            optimized_topic = topic

        # 2. 生成大纲
        await conn.execute(
            "UPDATE ppt_generations SET status = 'generating', progress = 20 WHERE id = $1::uuid",
            gen_id,
        )
        outline = await agent.generate_outline(optimized_topic, page_count)
        await conn.execute(
            "UPDATE ppt_generations SET outline = $1::jsonb, progress = 40 WHERE id = $2::uuid",
            json.dumps(outline) if not isinstance(outline, str) else outline,
            gen_id,
        )

        # 3. 生成图片
        images = await agent.generate_images(outline, style_requirement)
        await conn.execute(
            "UPDATE ppt_generations SET images = $1::jsonb, progress = 80 WHERE id = $2::uuid",
            json.dumps(images) if not isinstance(images, str) else images,
            gen_id,
        )

        # 4. 组装 PPTX
        pptx_url = await agent.build_pptx(gen_id, outline, images)
        await conn.execute(
            """
            UPDATE ppt_generations
            SET pptx_url = $1, status = 'completed', progress = 100, completed_at = NOW()
            WHERE id = $2::uuid
            """,
            pptx_url,
            gen_id,
        )

        # 5. 保存 AI 响应消息
        response_content = "✅ PPT 生成完成\n\n"
        if optimize_prompt and optimized_topic != topic:
            response_content += f"**优化后的主题**: {optimized_topic}\n\n"
        response_content += f"**页数**: {page_count}\n"
        response_content += f"**下载链接**: {pptx_url}"

        await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=response_content,
            meta={
                "gen_id": gen_id,
                "status": "completed",
                "pptx_url": pptx_url,
                "optimized_topic": optimized_topic if optimize_prompt else None,
            },
        )

        # 6. 扣除积分
        cost = page_count * 1.0
        await conn.execute(
            "UPDATE users SET credits = credits - $1 WHERE id = $2::uuid",
            cost,
            user_id,
        )

    except Exception as e:
        await conn.execute(
            "UPDATE ppt_generations SET status = 'failed', error = $1 WHERE id = $2::uuid",
            str(e),
            gen_id,
        )
        await conversation_repo.add_message(
            conversation_id=conversation_id,
            role="assistant",
            content=f"❌ PPT 生成失败\n\n错误信息: {str(e)}",
            meta={"gen_id": gen_id, "status": "failed", "error": str(e)},
        )
    finally:
        await conn.close()
