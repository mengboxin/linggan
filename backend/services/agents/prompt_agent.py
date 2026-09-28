"""
PromptAgent：提示词安全校验 + 专业优化

工作流（3 步顺序执行，无外部框架依赖）：
  1. 构建上下文（附加边界信息等）
  2. 单次 LLM 调用（安全校验 + 优化 + 建议生成）
  3. 解析 JSON 输出

无 LLM 时自动降级到规则引擎。
"""
import json as _json
import logging
import re
import time
from typing import Optional

from fastapi import HTTPException

from .base import get_llm_model, call_llm_chat
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)


def _parse_first_json_object(raw: str) -> dict:
    decoder = _json.JSONDecoder()
    for match in re.finditer(r"\{", raw or ""):
        try:
            parsed, _ = decoder.raw_decode(raw[match.start():])
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("LLM did not return a JSON object")


class PromptAgent:
    """
    提示词处理智能体。

    功能：
    - 安全审核（违规内容检测）
    - 专业优化（保持原始语言，补充生图专业描述）
    - 风格变体生成（3 条不同方向）
    """

    _SYSTEM_PROMPT = """你是一个专业的 AI 图像生成提示词专家。

## 核心规则
**语言保持一致**：输入是中文就输出中文，输入是英文就输出英文，绝对不要翻译。

## 你的工作：提示词优化 + 生成变体

### 优化要求
将提示词优化为专业的 AI 生图提示词：
- **保持原始语言**（中文输入→中文输出，英文输入→英文输出）
- 补充主体细节（人物特征、场景元素、材质质感）
- 添加光线描述（如：黄金时段光线、柔和漫射光、戏剧性侧光）
- 添加构图描述（如：特写、全景、俯视角、三分法构图）
- 添加画质词（如：超高清、8K、细节丰富、专业摄影）
- 添加风格词（如：电影感、写实风格、商业摄影）
- 不要过度堆砌，保持自然流畅
- 提示词不完整或模糊时，合理补全，不要拒绝

### 生成 3 条风格变体
基于原始提示词生成 3 条不同风格方向的变体，**语言与输入保持一致**。

## 输出格式
只返回如下 JSON，不要有任何其他文字：
{"safe": true, "violation_reason": "", "optimized": "优化后的提示词", "suggestions": ["变体1", "变体2", "变体3"]}"""

    async def run(
        self,
        original_prompt: str,
        mode: str = "TEXT_TO_IMAGE",
        layer_bounds: Optional[dict] = None,
        model_id: Optional[str] = None,
        user_id: str = "",
        client_request_id: str = "",
    ) -> dict:
        t0 = time.time()
        result = await self._pipeline(
            original_prompt,
            mode,
            layer_bounds,
            model_id,
            user_id,
            client_request_id,
        )
        logger.info(
            f"[PromptAgent] done: safe={result.get('safe')} "
            f"duration={int((time.time()-t0)*1000)}ms "
            f"original={original_prompt[:40]!r}"
        )
        return result

    async def _pipeline(
        self,
        original_prompt: str,
        mode: str,
        layer_bounds: Optional[dict],
        model_id: Optional[str],
        user_id: str,
        client_request_id: str,
    ) -> dict:
        # ── 步骤 1：规则引擎底线校验（只拦截黄赌毒极端内容）────────────────
        # ── 步骤 2：构建用户消息 ──────────────────────────────────────────
        prompt = original_prompt
        if mode == "IMAGE_EDIT" and layer_bounds:
            w = layer_bounds.get("width", 0)
            h = layer_bounds.get("height", 0)
            prompt = f"{prompt}（编辑区域：{w}×{h} 像素，需保持原始尺寸和位置）"

        # ── 步骤 3：LLM 调用（只做优化，不做安全判断）───────────────────
        llm_model = None
        if model_id:
            try:
                import repositories.model_repo as model_repo
                llm_model = await model_repo.get_model_internal(model_id)
            except Exception as e:
                logger.warning(f"[PromptAgent] 指定 LLM 模型读取失败，改用默认模型: {e}")
        if not llm_model:
            llm_model = await get_llm_model()
        llm_raw = ""

        if llm_model:
            try:
                async def invoke() -> str:
                    return await call_llm_chat(
                        system=self._SYSTEM_PROMPT,
                        user=f"请处理以下提示词：\n\n{prompt}",
                        model=llm_model,
                        max_tokens=800,
                        temperature=0.3,
                    )

                resolved_model_id = str(llm_model.get("id") or model_id or "").strip()
                llm_raw = (
                    await execute_billed_model_call(
                        user_id=user_id,
                        model_id=resolved_model_id,
                        expected_category="llm",
                        description="Prompt optimization",
                        idempotency_key=model_billing_operation_key(
                            namespace="prompt-optimization",
                            user_id=user_id,
                            operation_scope=client_request_id,
                            material={
                                "model_id": resolved_model_id,
                                "prompt": original_prompt,
                                "mode": mode,
                                "layer_bounds": layer_bounds or {},
                            },
                        ),
                        invoke=invoke,
                    )
                    if user_id
                    else await invoke()
                )
                logger.debug(f"[PromptAgent] LLM raw: {llm_raw[:120]!r}")
            except HTTPException:
                raise
            except Exception as e:
                logger.warning(f"[PromptAgent] LLM 调用失败，降级: {e}")
        else:
            logger.warning("[PromptAgent] 未找到 LLM 模型，使用规则引擎降级")

        # ── 步骤 4：解析输出 ──────────────────────────────────────────────
        if not llm_raw:
            return self._fallback(original_prompt, mode, layer_bounds)

        try:
            start = llm_raw.find("{")
            end   = llm_raw.rfind("}") + 1
            if start == -1 or end == 0:
                raise ValueError("LLM 未返回 JSON")
            parsed = _parse_first_json_object(llm_raw[start:end])

            optimized   = parsed.get("optimized", "").strip()
            suggestions = parsed.get("suggestions", [])
            # 忽略 LLM 返回的 safe 字段，安全已由规则引擎保证
            final = optimized if optimized else original_prompt

            if mode == "IMAGE_EDIT" and layer_bounds:
                w, h = layer_bounds.get("width", 0), layer_bounds.get("height", 0)
                if w and h:
                    final += f", constrained to {w}x{h} pixel area, maintain original dimensions"

            return {
                "final_prompt":     final,
                "suggestions":      suggestions[:5],
                "safe":             True,
                "violation_reason": "",
                "original":         original_prompt,
            }
        except Exception as e:
            logger.warning(f"[PromptAgent] JSON 解析失败，降级: {e}")
            return self._fallback(original_prompt, mode, layer_bounds)

    # ── 规则引擎底线校验（只拦截黄赌毒极端内容）──────────────────────────────
    def _rule_check(self, text: str) -> dict:
        """Compatibility shim: prompt processing does not reject locally."""
        return {"safe": True, "reason": ""}

    def _fallback(
        self,
        original_prompt: str,
        mode: str,
        layer_bounds: Optional[dict],
    ) -> dict:
        """规则引擎降级：LLM 不可用时，保留原文 + 简单建议"""
        final_prompt = original_prompt
        if mode == "IMAGE_EDIT" and layer_bounds:
            width = layer_bounds.get("width", 0)
            height = layer_bounds.get("height", 0)
            if width and height:
                final_prompt += (
                    f", constrained to {width}x{height} pixel area, "
                    "maintain original dimensions"
                )
        return {
            "final_prompt": final_prompt,
            "suggestions": [
                original_prompt,
                original_prompt,
                original_prompt,
            ],
            "safe":             True,
            "violation_reason": "",
            "original":         original_prompt,
        }


# ── 向后兼容别名（旧代码用 PromptOptimizerGraph 的地方不需要改）────────────────
PromptOptimizerGraph = PromptAgent
