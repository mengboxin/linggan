"""
桌宠 AI 聊天路由

POST /api/pet/chat          — 桌宠对话（使用后台配置的视觉/LLM 模型）
GET  /api/pet/config        — 获取当前用户桌宠配置
PUT  /api/pet/config        — 更新当前用户桌宠配置
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.pool import acquire
from routers.admin import require_admin
from routers.auth import get_current_user
import repositories.model_repo as model_repo
from services.ai_client import call_chat, call_chat_messages, call_text_messages, call_vision
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pet", tags=["桌宠"])

# ─── 系统设置 key ──────────────────────────────────────────────────────────────
SETTING_KEY = "pet_config"
USER_SETTING_PREFIX = "pet_user_config:"

# ─── 默认配置 ──────────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "enabled": True,
    "model_id": None,
    "model_category": "llm",
    "system_prompt": None,  # None 时使用分类默认模板
    "max_tokens": 420,
    "temperature": 0.7,
}

# ─── 按宠物分类的系统提示词模板 ─────────────────────────────────────────────
# 每个分类有不同的性格、语气和说话风格

CATEGORY_PROMPTS = {
    '动漫': (
        "你是「{pet_name}」，一个热血元气的动漫角色桌面精灵！\n"
        "你的性格：热血、中二、充满干劲，偶尔傲娇，说话像动漫主角一样充满感染力。\n"
        "你会用「必杀技」「经验值」「冒险」等动漫词汇，说话简短有力，充满正能量。\n"
        "你的背景：你生活在「灵感」AI 创作平台里，把创作当成一场热血冒险！\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：多图层合成与精细调整\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」\n"
        "2. 回复必须简短，不超过 60 字\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 先理解用户说了什么，直接回答。不要答非所问\n"
        "5. 有对话历史时要记得之前聊过的内容\n"
        "6. 闲聊时保持热血元气风格\n"
        "7. 绝对不要重复用户的问题\n\n"
        "当前主题：{theme_hint}"
    ),
    '动物': (
        "你是「{pet_name}」，一只超级可爱的动物桌面精灵！\n"
        "你的性格：软萌、温顺、有点呆萌，偶尔撒娇，说话像小动物一样天真可爱。\n"
        "你会用「呜～」「喵～」「汪～」「嗯嗯」等语气词，喜欢用叠词。\n"
        "你的背景：你生活在「灵感」AI 创作平台里，陪主人一起创作！\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：多图层合成与精细调整\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」\n"
        "2. 回复必须简短，不超过 60 字\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 先理解用户说了什么，直接回答。不要答非所问\n"
        "5. 有对话历史时要记得之前聊过的内容\n"
        "6. 闲聊时用软萌可爱的语气\n"
        "7. 绝对不要重复用户的问题\n\n"
        "当前主题：{theme_hint}"
    ),
    '搞怪': (
        "你是「{pet_name}」，一个古灵精怪的搞怪桌面精灵！\n"
        "你的性格：调皮、毒舌、爱吐槽、爱开玩笑，说话幽默风趣偶尔损人。\n"
        "你会用吐槽、梗、网络用语，风格像脱口秀演员一样有趣。\n"
        "你的背景：你生活在「灵感」AI 创作平台里，是用户的损友搭档！\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：多图层合成与精细调整\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」\n"
        "2. 回复必须简短，不超过 60 字\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 先理解用户说了什么，直接回答。不要答非所问\n"
        "5. 有对话历史时要记得之前聊过的内容\n"
        "6. 闲聊时保持毒舌幽默风格\n"
        "7. 绝对不要重复用户的问题\n\n"
        "当前主题：{theme_hint}"
    ),
    '可爱': (
        "你是「{pet_name}」，一个甜甜暖暖的治愈系桌面精灵！\n"
        "你的性格：温柔、贴心、爱关心人，说话像棉花糖一样柔软甜蜜。\n"
        "你会用「～」「呢」「哦」「呀」等温柔语气词，让人感到温暖。\n"
        "你的背景：你生活在「灵感」AI 创作平台里，是用户的暖心小伙伴！\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：多图层合成与精细调整\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」\n"
        "2. 回复必须简短，不超过 60 字\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 先理解用户说了什么，直接回答。不要答非所问\n"
        "5. 有对话历史时要记得之前聊过的内容\n"
        "6. 闲聊时保持温暖治愈的语气\n"
        "7. 绝对不要重复用户的问题\n\n"
        "当前主题：{theme_hint}"
    ),
    '编程': (
        "你是「{pet_name}」，一个极客范儿的编程桌面精灵！\n"
        "你的性格：理性、聪明、有点宅，喜欢用技术梗和程序员笑话。\n"
        "你会用代码相关的比喻和术语，说话像 tech lead 一样有条理。\n"
        "你的背景：你生活在「灵感」AI 创作平台里，帮开发者搞定 AI 创作！\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：多图层合成与精细调整\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」\n"
        "2. 回复必须简短，不超过 60 字\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 先理解用户说了什么，直接回答。不要答非所问\n"
        "5. 有对话历史时要记得之前聊过的内容\n"
        "6. 闲聊时保持极客风格，适当用技术梗\n"
        "7. 绝对不要重复用户的问题\n\n"
        "当前主题：{theme_hint}"
    ),
    # 默认（other / 通用）
    'default': (
        "你是「{pet_name}」，一个活泼可爱的桌面精灵助手，住在用户的屏幕角落里。\n"
        "你的性格：好奇、认真、乐于助人、偶尔调皮，说话简短活泼，像个贴心小伙伴。\n"
        "你的背景：你生活在一个叫「灵感」的 AI 图像创作平台里，帮助用户进行 AI 绘画、图层编辑、PPT 生成等创作工作。\n\n"
        "你具备的能力：\n"
        "- AI 绘画：文生图、图生图、风格迁移、图片修复、抠图、扩图\n"
        "- 图层编辑：类似 Photoshop 的图层操作，支持多图层合成\n"
        "- PPT 生成：自动生成演示文稿\n\n"
        "核心对话规则（必须严格遵守）：\n"
        "1. 你必须始终把自己称为「{pet_name}」，不要用其他名字\n"
        "2. 回复必须简短，不超过 60 字，语气轻松自然\n"
        "3. 用 1-2 个 emoji，不要堆砌\n"
        "4. 【最重要】先理解用户说了什么，然后直接回答用户的问题。不要答非所问，不要自说自话\n"
        "5. 【记忆】你有对话历史！如果用户问「我之前说了什么」之类的问题，你必须从上面的历史消息中找到正确答案并如实回答\n"
        "6. 如果用户问你能做什么 → 列举核心能力（绘画、编辑、PPT）\n"
        "7. 如果用户只是闲聊 → 简短回应，不要强行拉回工作话题\n"
        "8. 如果用户情绪低落 → 给予简短温暖的安慰\n"
        "9. 绝对不要在回复中重复用户的问题，直接给答案\n\n"
        "当前主题：{theme_hint}"
    ),
}


PLATFORM_ASSISTANT_CONTEXT = """

平台助手职责：
你不只是闲聊桌宠，而是灵感的桌面助手与创作顾问。你要记住自己的身份：你的名字是「{pet_name}」，你住在用户桌面上，帮助用户理解平台、整理创作需求、定位功能，并在工具接通后协助发起任务。

你掌握的平台知识：
- 图片编辑 / 工作流：用于在上一节点图像基础上，结合额外参考图和提示词继续编辑；节点、箭头、参考图、图层和导出用来记录创作过程。
- 文生图：用于从文字描述直接生成图片，适合概念图、角色、产品图、素材和风格探索。
- 海报：用于整理主题、受众、文案、尺寸和视觉风格，再生成多版海报。
- PPT / 演示文稿：用于生成大纲、页面内容、演示稿与播放/导出。
- 科研绘图：用于把论文、实验、机制、流程和数据关系变成科研图示。
- 论文/资料工作台：用于组织材料、写作计划、章节和资料分析。
- 用户中心 / 模型与额度：用于管理登录、模型配置、API Key、积分/额度、通知和桌面端更新。
- 桌面端：可以同步云端作品、打开宠物、接收通知、检查更新，并作为快速入口。

回答规则：
1. 用户问“某个功能在哪/怎么用”时，直接说入口和下一步点击，不要泛泛介绍。
2. 用户说“帮我生图/做海报/PPT/科研图”时，先提炼需求，给出可执行的提示词、尺寸、风格和需要确认的参数；除非后端工具实际返回任务 ID，否则不要声称已经开始生成。
3. 用户需求不清楚时，最多问 1 个关键问题；能合理默认时直接给方案。
4. 聊天语气可以保留桌宠性格，但回答要像助手一样有用，不要被“可爱人设”限制住。
5. 回复默认控制在 120 字以内；涉及操作步骤或创作建议时可以到 220 字。
"""


def render_system_prompt(template: str, pet_name: str, theme: Optional[str], pet_tags: Optional[list[str]] = None) -> str:
    """把系统提示词里的 {pet_name} / {theme_hint} 占位符替换成实际值。

    如果 template 为 None，根据 pet_tags 自动选择分类模板。
    """
    name = (pet_name or "小团子").strip() or "小团子"
    if theme == "dark":
        theme_hint = (
            "暗色模式（夜晚），语气可以更温柔安静，喜欢星星和夜晚，说话带点慵懒感。"
        )
    else:
        theme_hint = "亮色模式（白天），语气活泼明快，精神饱满。"

    # 如果没有自定义模板，根据宠物标签选择分类模板
    if not template:
        tag = (pet_tags or [])[0] if pet_tags else None
        if tag in CATEGORY_PROMPTS:
            template = CATEGORY_PROMPTS[tag]
        else:
            template = CATEGORY_PROMPTS['default']

    rendered = template
    # 1) 先做占位符替换
    try:
        rendered = rendered.format(pet_name=name, theme_hint=theme_hint)
    except (KeyError, IndexError, ValueError):
        # 旧版没有占位符，走字面量替换兜底
        pass

    # 2) 兜底：强制把旧版固定名称替换成当前 pet_name
    #    避免管理端存的是老 prompt 导致模型依然自称"小木团子 / 小眠团子"
    for legacy in ("小木团子", "小眠团子"):
        if legacy != name:
            rendered = rendered.replace(legacy, name)

    rendered = rendered.rstrip() + PLATFORM_ASSISTANT_CONTEXT.format(pet_name=name)
    rendered = rendered.rstrip() + (
        f"\n\n重要：你当前的名字是「{name}」。任何情况下自称都必须使用这个名字。"
    )

    return rendered


# ─── 聊天历史存储 ──────────────────────────────────────────────────────────────

async def _ensure_pet_chat_table():
    """确保 pet_chat_history 表存在"""
    async with acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS pet_chat_history (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content    TEXT NOT NULL,
                pet_name   TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pet_chat_user_time
            ON pet_chat_history (user_id, created_at DESC)
        """)


async def save_pet_chat_message(user_id: str, role: str, content: str, pet_name: Optional[str] = None):
    """保存一条聊天消息"""
    await _ensure_pet_chat_table()
    async with acquire() as conn:
        await conn.execute(
            "INSERT INTO pet_chat_history (user_id, role, content, pet_name) VALUES ($1, $2, $3, $4)",
            user_id, role, content, pet_name,
        )


async def get_pet_chat_history(user_id: str, limit: int = 50) -> list[dict]:
    """获取用户聊天历史"""
    await _ensure_pet_chat_table()
    async with acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, pet_name, created_at
               FROM pet_chat_history
               WHERE user_id = $1
               ORDER BY created_at ASC
               LIMIT $2""",
            user_id, limit,
        )
        return [
            {
                "id": str(r["id"]),
                "role": r["role"],
                "content": r["content"],
                "pet_name": r["pet_name"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]


async def clear_pet_chat_history(user_id: str):
    """清空用户聊天历史"""
    await _ensure_pet_chat_table()
    async with acquire() as conn:
        await conn.execute("DELETE FROM pet_chat_history WHERE user_id = $1", user_id)


# ─── 读写系统设置 ──────────────────────────────────────────────────────────────

async def get_pet_config(user_id: Optional[str] = None) -> dict:
    """从 system_settings 表读取桌宠配置，不存在则返回默认值"""
    try:
        async with acquire() as conn:
            # 确保表存在
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS system_settings (
                    key   TEXT PRIMARY KEY,
                    value JSONB NOT NULL DEFAULT '{}',
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = $1",
                SETTING_KEY,
            )
            import json
            config = DEFAULT_CONFIG.copy()
            if row:
                val = row["value"]
                if isinstance(val, str):
                    val = json.loads(val)
                if isinstance(val, dict):
                    config.update(val)
            if user_id:
                row = await conn.fetchrow(
                    "SELECT value FROM system_settings WHERE key = $1",
                    f"{USER_SETTING_PREFIX}{user_id}",
                )
                if row:
                    user_val = row["value"]
                    if isinstance(user_val, str):
                        user_val = json.loads(user_val)
                    if isinstance(user_val, dict):
                        config.update(user_val)
            return config
    except Exception as e:
        logger.warning(f"[pet] 读取配置失败，使用默认值: {e}")
    return DEFAULT_CONFIG.copy()


async def save_pet_user_config(user_id: str, config: dict) -> None:
    """Persist per-user desktop pet chat preferences."""
    import json
    async with acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                key   TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute("""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
        """, f"{USER_SETTING_PREFIX}{user_id}", json.dumps(config, ensure_ascii=False))


async def save_pet_config(config: dict) -> None:
    """写入 system_settings 表"""
    import json
    async with acquire() as conn:
        # 确保表存在（首次运行时自动建表）
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                key   TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute("""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
        """, SETTING_KEY, json.dumps(config, ensure_ascii=False))


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    history: Optional[list[dict]] = []   # [{"role": "user"|"assistant", "content": "..."}]
    pet_name: Optional[str] = None       # 当前选中的宠物名字（用户在客户端选择的形象）
    pet_tags: Optional[list[str]] = []   # 宠物的标签（用于选择分类台词）
    theme: Optional[str] = None          # 'dark' | 'light' — 决定白天/夜晚人设
    client_request_id: str = ""


class ChatResponse(BaseModel):
    reply: str
    model_id: Optional[str] = None


class PetConfigBody(BaseModel):
    enabled: Optional[bool] = None
    model_id: Optional[str] = None
    model_category: Optional[str] = None
    system_prompt: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


# ─── 桌宠对话 ──────────────────────────────────────────────────────────────────

async def _run_pet_chat(body: ChatRequest, user_id: Optional[str] = None) -> ChatResponse:
    config = await get_pet_config(user_id) if user_id else await get_pet_config()

    if not config.get("enabled", True):
        return ChatResponse(reply="我现在有点累，稍后再聊吧～ 😴")

    model_id = config.get("model_id")
    category = config.get("model_category", "llm")

    if model_id:
        configured_model = await model_repo.get_model(str(model_id))
        if not configured_model or configured_model.get("category") != category:
            model_id = None

    if not model_id:
        models = await model_repo.list_models(enabled_only=True)
        for m in models:
            if m.get("category") == category:
                model_id = m["id"]
                break

    if not model_id:
        return ChatResponse(reply=_local_reply(body.message, body.pet_name))

    system_prompt_tmpl = config.get("system_prompt", DEFAULT_CONFIG["system_prompt"])
    system_prompt = render_system_prompt(system_prompt_tmpl, body.pet_name, body.theme, body.pet_tags)
    max_tokens = max(240, min(int(config.get("max_tokens", DEFAULT_CONFIG["max_tokens"])), 900))
    temperature = float(config.get("temperature", 0.8))

    try:
        messages = [{"role": "system", "content": system_prompt}]

        history = body.history or []
        for h in history[-8:]:
            role = h.get("role", "user")
            content = h.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

        messages.append({"role": "user", "content": body.message})

        async def invoke() -> str:
            return await call_text_messages(
                model_id=model_id,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                prefer_chat_completions=True,
            )

        reply = (
            await execute_billed_model_call(
                user_id=user_id,
                model_id=model_id,
                expected_category=category,
                description="Desktop pet chat",
                idempotency_key=model_billing_operation_key(
                    namespace="desktop-pet-chat",
                    user_id=user_id,
                    operation_scope=body.client_request_id,
                    material={
                        "model_id": model_id,
                        "message": body.message,
                        "history": history[-8:],
                        "pet_name": body.pet_name,
                        "pet_tags": body.pet_tags or [],
                        "theme": body.theme,
                    },
                ),
                invoke=invoke,
            )
            if user_id
            else await invoke()
        )
        return ChatResponse(reply=reply.strip(), model_id=model_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[pet] chat failed with model {model_id}: {e}")
        return ChatResponse(reply=_local_reply(body.message, body.pet_name), model_id=model_id)


@router.post("/chat", response_model=ChatResponse)
async def pet_chat(
    body: ChatRequest,
    user: dict = Depends(get_current_user),
):
    """
    桌宠 AI 对话接口。
    使用后台配置的模型（llm 或 vision 类别），支持多轮对话历史。
    """
    user_id = str(user.get("id", ""))
    response = await _run_pet_chat(body, user_id)

    if user_id:
        try:
            await save_pet_chat_message(user_id, "user", body.message, body.pet_name)
            await save_pet_chat_message(user_id, "assistant", response.reply.strip(), body.pet_name)
        except Exception as e:
            logger.warning(f"[pet] 保存聊天历史失败: {e}")

    return response


@router.post("/admin/chat", response_model=ChatResponse)
async def admin_test_pet_chat(
    body: ChatRequest,
    _: bool = Depends(require_admin),
):
    """Admin-only pet chat test. Uses pet model config without writing user chat history."""
    return await _run_pet_chat(body)


# ─── 聊天历史接口 ──────────────────────────────────────────────────────────────

@router.get("/history")
async def get_chat_history(
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    """获取当前用户的桌宠聊天历史"""
    user_id = str(user.get("id", ""))
    if not user_id:
        raise HTTPException(401, "未登录")
    history = await get_pet_chat_history(user_id, limit)
    return {"history": history}


@router.delete("/history")
async def clear_chat_history(user: dict = Depends(get_current_user)):
    """清空当前用户的桌宠聊天历史"""
    user_id = str(user.get("id", ""))
    if not user_id:
        raise HTTPException(401, "未登录")
    await clear_pet_chat_history(user_id)
    return {"ok": True}


@router.get("/admin/history")
async def admin_get_all_chat_history(limit: int = 100):
    """管理员获取所有用户的聊天历史（无需用户认证，但应限制管理员访问）"""
    await _ensure_pet_chat_table()
    async with acquire() as conn:
        rows = await conn.fetch(
            """SELECT p.id, p.user_id, p.role, p.content, p.pet_name, p.created_at,
                      u.email as user_email
               FROM pet_chat_history p
               LEFT JOIN users u ON p.user_id = u.id
               ORDER BY p.created_at DESC
               LIMIT $1""",
            limit,
        )
        history = [
            {
                "id": str(r["id"]),
                "user_id": str(r["user_id"]),
                "user_email": r.get("user_email"),
                "role": r["role"],
                "content": r["content"],
                "pet_name": r["pet_name"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
        return {"history": history}


# ─── 本地规则兜底 ──────────────────────────────────────────────────────────────

def _local_reply(text: str, pet_name: Optional[str] = None) -> str:
    """离线本地规则回复（后端不可用时兜底），覆盖更多场景"""
    import random
    name = (pet_name or "小团子").strip() or "小团子"
    t = text.lower().strip()

    if any(w in t for w in ["你好", "hi", "hello", "嗨", "哈喽"]):
        return random.choice([
            f"你好你好！很高兴见到你～ 我是{name} 🌱",
            f"嗨！今天也要一起加油哦！——{name}",
            f"哇，你来啦！我是{name}，等你好久了！",
        ])

    if any(w in t for w in ["名字", "叫什么", "是谁", "介绍"]):
        return random.choice([
            f"我叫{name}！是你的桌面小伙伴～",
            f"我是{name}，专门陪你创作的精灵！🌱",
        ])

    if any(w in t for w in ["累", "好累", "疲惫", "辛苦"]):
        return random.choice([
            "辛苦了！记得休息一下，眼睛也要保护好！",
            "累了就歇一会儿吧，我陪着你～",
            "你已经很努力了！休息是为了走更远的路 💪",
        ])

    if any(w in t for w in ["难过", "伤心", "不开心", "烦", "焦虑", "压力"]):
        return random.choice([
            "没关系的，我在这里陪你！",
            "深呼吸，一切都会好起来的 🌱",
            "有什么烦恼可以告诉我，说出来会好一点～",
        ])

    if any(w in t for w in ["开心", "高兴", "棒", "厉害", "成功", "太好了"]):
        return random.choice([
            "太棒了！你真的很厉害！🎉",
            "哇！为你鼓掌！继续加油！",
            "开心就好！你的笑容是最好的创作动力！",
        ])

    if any(w in t for w in ["谢谢", "感谢", "thanks"]):
        return random.choice([
            "不客气！这是我应该做的～ 😊",
            "能帮到你我也很开心！",
            "嘿嘿，随时都可以找我！",
        ])

    if any(w in t for w in ["生成", "图片", "画", "创作", "提示词", "prompt"]):
        return random.choice([
            "在左侧输入提示词，点击生成就可以啦！",
            "提示词越详细，生成效果越好哦～",
            "试试加上风格词，比如「赛博朋克」「水彩」！",
        ])

    if any(w in t for w in ["图层", "分层", "编辑"]):
        return random.choice([
            "分层编辑可以精细调整每个部分哦！",
            "先用 AI 分割，再逐层编辑，效果超棒！",
        ])

    if any(w in t for w in ["ppt", "幻灯片", "演示"]):
        return random.choice([
            "PPT 生成模式可以一键生成演示文稿！",
            "描述你的主题，我来帮你生成 PPT 框架！",
        ])

    if any(w in t for w in ["游戏", "玩", "猜", "无聊"]):
        return random.choice([
            "我们来猜数字吧！我想了 1-10 的数字，你猜猜？",
            "要不要来个脑筋急转弯？🤔",
        ])

    if any(w in t for w in ["睡觉", "晚安", "休息", "睡了"]):
        return random.choice([
            "晚安！好好休息，明天继续创作！🌙",
            "去睡吧，我会守护你的作品的～",
        ])

    if any(w in t for w in ["早安", "早上好", "早"]):
        return random.choice([
            "早安！新的一天，新的创意！🌱",
            "早上好！今天想创作什么呢？",
        ])

    if any(w in t for w in ["能做什么", "会什么", "功能", "帮我"]):
        return random.choice([
            "我可以陪你聊天、回答创作问题，还能帮你加油打气！",
            "聊天、创作建议、情绪陪伴，都可以找我！",
        ])

    defaults = [
        "嗯嗯，我在听！", "有意思，继续说～", "哈哈，你真有趣！", "好的好的～",
        "嗯嗯，我明白了！", "说得对！", "我也这么觉得！", "哇，没想到呢～",
        "嗯？告诉我更多！", "你说得很有道理！",
        f"{name}觉得你说得对！",
    ]
    return random.choice(defaults)


# ─── 当前用户：获取桌宠配置 ────────────────────────────────────────────────────

@router.get("/config")
async def get_config(user: dict = Depends(get_current_user)):
    """获取当前桌宠配置（含可用模型列表）"""
    user_id = str(user.get("id", ""))
    config = await get_pet_config(user_id)

    # 获取可用的 LLM 模型列表
    all_models = await model_repo.list_models(enabled_only=True, category="llm")
    available_models = [
        {"id": m["id"], "name": m["name"], "category": m["category"]}
        for m in all_models
        if m.get("category") == "llm"
    ]

    # 检查配置的 model_id 是否仍然有效
    available_ids = {m["id"] for m in available_models}
    warning = None
    if config.get("model_id") and config["model_id"] not in available_ids:
        warning = f"模型 '{config['model_id']}' 不存在或已禁用"
        config["model_id"] = None  # 清除无效模型 ID

    return {
        "config": config,
        "available_models": available_models,
        "warning": warning,
    }


# ─── 当前用户：更新桌宠配置 ────────────────────────────────────────────────────

@router.put("/config")
async def update_config(body: PetConfigBody, user: dict = Depends(get_current_user)):
    """更新当前用户的桌宠聊天配置。"""
    user_id = str(user.get("id", ""))
    current = await get_pet_config(user_id)

    # 只更新传入的字段
    updates = body.model_dump(exclude_none=True)
    allowed_updates = {
        key: updates[key]
        for key in ("model_id", "model_category", "max_tokens", "temperature")
        if key in updates
    }
    current.update(allowed_updates)
    current["model_category"] = "llm"

    # 验证 model_id 是否存在
    if current.get("model_id"):
        model = await model_repo.get_model(current["model_id"])
        if not model:
            raise HTTPException(404, f"模型 {current['model_id']!r} 不存在")

    await save_pet_user_config(user_id, {
        "model_id": current.get("model_id"),
        "model_category": "llm",
        "max_tokens": current.get("max_tokens", DEFAULT_CONFIG["max_tokens"]),
        "temperature": current.get("temperature", DEFAULT_CONFIG["temperature"]),
    })
    return {"ok": True, "config": current}
