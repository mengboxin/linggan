"""
智能体公共基础工具

- get_llm_model()：从数据库读取可用的 LLM 模型配置
- call_llm()：调用共享 AI 客户端执行单轮文本请求
- call_llm_chat()：调用共享 AI 客户端执行 system + user 对话
"""
import json as _json
import logging
from typing import Optional

from services.ai_client import call_chat

logger = logging.getLogger(__name__)


async def get_llm_model() -> Optional[dict]:
    """从数据库读取第一个启用的 category=llm 模型（含 api_key）。"""
    try:
        import repositories.model_repo as model_repo

        models = await model_repo.list_models()
        for m in models:
            if m.get("category") == "llm" and m.get("enabled", True):
                return await model_repo.get_model_internal(m["id"])
    except Exception as e:
        logger.error(f"[agents.base] get_llm_model failed: {e}")
    return None


def _resolve_model_name(model: dict) -> str:
    """模型调用名：meta.model_name > model.id。"""
    meta = model.get("meta") or {}
    if isinstance(meta, str):
        try:
            meta = _json.loads(meta)
        except Exception:
            meta = {}
    return meta.get("model_name") or model.get("id", "")


async def call_llm(
    prompt: str,
    model: dict,
    max_tokens: int = 500,
    temperature: float = 0.7,
) -> str:
    """单消息 LLM 调用。"""
    return await call_llm_chat(
        system="",
        user=prompt,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
    )


async def call_llm_chat(
    system: str,
    user: str,
    model: dict,
    max_tokens: int = 800,
    temperature: float = 0.3,
) -> str:
    """system + user 双消息 LLM 调用。"""
    model_name = _resolve_model_name(model)
    model_id = str(model.get("id") or "").strip()
    if not model_id:
        raise RuntimeError("LLM model is missing its runtime id")
    logger.info(
        "[agents.base] call_llm_chat model=%s endpoint=%s",
        model_name,
        model.get("endpoint", ""),
    )
    return await call_chat(
        model_id=model_id,
        user=user,
        system=system or None,
        max_tokens=max_tokens,
        temperature=temperature,
    )
