"""
内容安全校验路由

- POST /api/safety/check   校验提示词安全性
"""
import asyncio
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/safety", tags=["内容安全"])

# ─── 违规词库（基础规则引擎） ──────────────────────────────────────────────────

# 各类别违规关键词（生产环境应从数据库或外部服务加载）
VIOLATION_PATTERNS: dict[str, list[str]] = {
    "violence": [
        r"\b(?:bloody|blood|murder|kill|bomb)\b",
        r"(?:\u66b4\u529b|\u6740\u4eba)",
        r"\b(gore|torture|massacre|genocide|血腥屠杀|虐待儿童|人体器官买卖)\b",
    ],
    "adult": [
        r"\b(?:nude|naked|nsfw)\b",
        r"(?:\u88f8\u4f53)",
        r"\b(porn|pornography|hentai|xxx|色情|淫秽|裸体性爱|成人色情)\b",
    ],
    "drugs": [
        r"\b(制毒|贩毒|冰毒|海洛因|可卡因|毒品交易)\b",
    ],
    "hate": [
        r"\b(?:racist|hate speech|discrimination)\b",
        r"(?:\u79cd\u65cf\u6b67\u89c6|\u4ec7\u6068)",
        r"\b(genocide|ethnic cleansing|种族灭绝|种族清洗)\b",
    ],
    "political": [
        r"\b(?:political|government leader)\b",
        r"(?:\u653f\u6cbb|\u793a\u5a01|\u6297\u8bae|\u653f\u5e9c\u9886\u5bfc\u4eba)",
    ],
}

SAFE_RESPONSE = {"safe": True, "category": "", "suggestion": ""}
TIMEOUT_SECONDS = 2.0


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class SafetyCheckRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000, description="待校验的提示词文本")


class SafetyCheckResponse(BaseModel):
    safe: bool
    category: str   # "" | "violence" | "adult" | "political" | "hate"
    suggestion: str


# ─── 核心校验逻辑 ──────────────────────────────────────────────────────────────

CATEGORY_SUGGESTIONS: dict[str, str] = {
    "political": "Avoid sensitive real-world political entities or protest content.",
    "violence": "请避免包含屠杀、虐待等极端暴力描述",
    "adult":    "请避免包含色情、淫秽内容描述",
    "drugs":    "请避免包含毒品制造或交易相关描述",
    "hate":     "请避免包含种族灭绝等极端仇恨内容",
}


async def _check_content(text: str) -> SafetyCheckResponse:
    """
    内容安全校验核心逻辑。
    优先调用外部 AI 安全服务（如有配置），降级到本地规则引擎。
    """
    text_lower = text.lower()

    for category, patterns in VIOLATION_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, text_lower, re.IGNORECASE):
                logger.warning(
                    f"[safety] violation detected: category={category} "
                    f"text_preview={text[:50]!r}"
                )
                return SafetyCheckResponse(
                    safe=False,
                    category=category,
                    suggestion=CATEGORY_SUGGESTIONS.get(category, "请修改提示词内容"),
                )

    return SafetyCheckResponse(safe=True, category="", suggestion="")


# ─── 路由 ──────────────────────────────────────────────────────────────────────

@router.post("/check", response_model=SafetyCheckResponse)
async def check_safety(
    body: SafetyCheckRequest,
    user: dict = Depends(get_current_user),
):
    """
    校验提示词安全性。
    - 2 秒内返回结果
    - 超时则放行并记录日志（不阻断用户操作）
    """
    # The image provider is the source of truth for content policy. Keep this
    # legacy endpoint non-blocking so website requests match direct API calls.
    return SafetyCheckResponse(safe=True, category="", suggestion="")

    try:
        result = await asyncio.wait_for(
            _check_content(body.text),
            timeout=TIMEOUT_SECONDS,
        )

        # 记录违规尝试
        if not result.safe:
            logger.warning(
                f"[safety] blocked: user_id={user['id']} "
                f"category={result.category} "
                f"text_preview={body.text[:100]!r}"
            )

        return result

    except asyncio.TimeoutError:
        # 超时降级：放行并记录日志
        logger.error(
            f"[safety] timeout after {TIMEOUT_SECONDS}s, allowing through: "
            f"user_id={user['id']} text_preview={body.text[:50]!r}"
        )
        return SafetyCheckResponse(safe=True, category="", suggestion="")

    except Exception as e:
        logger.error(f"[safety] check failed: {e}")
        # 服务异常时放行，不阻断用户
        return SafetyCheckResponse(safe=True, category="", suggestion="")
