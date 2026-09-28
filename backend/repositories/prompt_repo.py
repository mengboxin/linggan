"""Prompt 资产数据仓库 —— 使用全局 asyncpg 连接池"""
from typing import Optional
from core.pool import acquire


async def save_prompt(
    user_id: str,
    content: str,
    model_id: Optional[str] = None,
    mode: Optional[str] = None,
    tags: Optional[list[str]] = None,
    note: Optional[str] = None,
) -> dict:
    """保存提示词，若已存在则增加 use_count"""
    async with acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM prompt_history WHERE user_id = $1::uuid AND content = $2 LIMIT 1",
            user_id, content,
        )
        if existing:
            row = await conn.fetchrow(
                """
                UPDATE prompt_history
                SET use_count = use_count + 1,
                    model_id  = COALESCE($3, model_id),
                    mode      = COALESCE($4, mode),
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id::text, user_id::text, content, model_id, mode,
                          tags, note, use_count, is_starred,
                          created_at::text, updated_at::text
                """,
                existing["id"], user_id, model_id, mode,
            )
        else:
            row = await conn.fetchrow(
                """
                INSERT INTO prompt_history (user_id, content, model_id, mode, tags, note)
                VALUES ($1::uuid, $2, $3, $4, $5, $6)
                RETURNING id::text, user_id::text, content, model_id, mode,
                          tags, note, use_count, is_starred,
                          created_at::text, updated_at::text
                """,
                user_id, content, model_id, mode, tags or [], note,
            )
        return dict(row)


async def list_prompts(user_id: str, page: int = 1, page_size: int = 20) -> dict:
    async with acquire() as conn:
        offset = (page - 1) * page_size
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM prompt_history WHERE user_id = $1::uuid", user_id,
        )
        rows = await conn.fetch(
            """
            SELECT id::text, content, model_id, mode, tags, note,
                   use_count, is_starred, created_at::text, updated_at::text
            FROM prompt_history WHERE user_id = $1::uuid
            ORDER BY updated_at DESC LIMIT $2 OFFSET $3
            """,
            user_id, page_size, offset,
        )
        return {"total": total, "page": page, "page_size": page_size, "items": [dict(r) for r in rows]}


async def list_starred(user_id: str, page: int = 1, page_size: int = 50) -> dict:
    async with acquire() as conn:
        offset = (page - 1) * page_size
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM prompt_history WHERE user_id = $1::uuid AND is_starred = TRUE", user_id,
        )
        rows = await conn.fetch(
            """
            SELECT id::text, content, model_id, mode, tags, note,
                   use_count, is_starred, created_at::text, updated_at::text
            FROM prompt_history WHERE user_id = $1::uuid AND is_starred = TRUE
            ORDER BY updated_at DESC LIMIT $2 OFFSET $3
            """,
            user_id, page_size, offset,
        )
        return {"total": total, "page": page, "page_size": page_size, "items": [dict(r) for r in rows]}


async def search_prompts(user_id: str, query: str, limit: int = 20) -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, content, model_id, mode, tags, note,
                   use_count, is_starred, created_at::text, updated_at::text,
                   similarity(content, $2) AS score
            FROM prompt_history
            WHERE user_id = $1::uuid AND content ILIKE $3
            ORDER BY score DESC, use_count DESC, updated_at DESC
            LIMIT $4
            """,
            user_id, query, f"%{query}%", limit,
        )
        return [dict(r) for r in rows]


async def toggle_star(user_id: str, prompt_id: str) -> bool:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE prompt_history SET is_starred = NOT is_starred, updated_at = NOW()
            WHERE id = $1::uuid AND user_id = $2::uuid RETURNING is_starred
            """,
            prompt_id, user_id,
        )
        if not row:
            raise ValueError("记录不存在")
        return row["is_starred"]


async def delete_prompt(user_id: str, prompt_id: str) -> bool:
    async with acquire() as conn:
        result = await conn.execute(
            "DELETE FROM prompt_history WHERE id = $1::uuid AND user_id = $2::uuid",
            prompt_id, user_id,
        )
        return result == "DELETE 1"


async def get_popular_prompts(user_id: str, limit: int = 10) -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, content, model_id, mode, tags, note,
                   use_count, is_starred, created_at::text, updated_at::text
            FROM prompt_history WHERE user_id = $1::uuid
            ORDER BY use_count DESC, updated_at DESC LIMIT $2
            """,
            user_id, limit,
        )
        return [dict(r) for r in rows]
