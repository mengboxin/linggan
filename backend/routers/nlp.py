"""
自然语言操作路由
用户输入自然语言指令，后端解析意图并返回结构化操作计划
前端根据计划自动选图层、选模型、填参数、执行
"""
import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.auth import get_current_user
from services import provider_policy
from services.ai_client import call_chat_messages
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

router = APIRouter(prefix="/api/nlp", tags=["自然语言操作"])


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class LayerInfo(BaseModel):
    id: str
    name: str
    index: int

class NLPParseRequest(BaseModel):
    instruction: str          # 用户输入，如"把天空换成夜晚"
    layers: list[LayerInfo]   # 当前画布的图层列表
    client_request_id: str = ""

class ActionPlan(BaseModel):
    target_layer_id: Optional[str] = None   # 目标图层 ID，None 表示无法确定
    target_layer_name: Optional[str] = None
    model_id: str                            # 要调用的模型
    params: dict                             # 模型参数
    description: str                         # 人类可读的操作描述
    confidence: float                        # 置信度 0~1

class NLPParseResponse(BaseModel):
    ok: bool
    plan: Optional[ActionPlan] = None
    error: Optional[str] = None
    raw_response: Optional[str] = None      # 调试用


# ─── 规则引擎（无需 LLM，覆盖常见场景）──────────────────────────────────────

# 图层语义关键词映射
LAYER_KEYWORDS = {
    "天空": ["天空", "sky", "云", "cloud"],
    "背景": ["背景", "background", "bg", "后面", "后景"],
    "人物": ["人物", "人", "person", "人像", "主体", "角色"],
    "服饰": ["服饰", "衣服", "衣物", "clothing", "服装", "穿着"],
    "植被": ["植被", "树", "草", "植物", "vegetation", "绿色"],
    "物体": ["物体", "物品", "object", "东西"],
    "五官": ["五官", "脸", "面部", "facial", "眼睛", "嘴"],
}

# 操作意图 → 模型映射
INTENT_MODEL_MAP = [
    # (关键词列表, model_id, 默认参数)
    (["换成", "替换", "改成", "变成", "换为"],  "sd-inpaint",    {"strength": 0.85}),
    (["风格", "画风", "转换", "变为", "改为"],  "style-transfer", {"strength": 0.7}),
    (["增强", "清晰", "超分", "提升质量"],       "enhance",        {}),
    (["生成", "创建", "添加", "画"],             "sd-inpaint",    {"strength": 0.9}),
    (["修复", "修补", "去除", "删除", "消除"],   "sd-inpaint",    {"strength": 0.8}),
]

# 风格关键词
STYLE_KEYWORDS = {
    "水彩": "watercolor painting style, soft edges",
    "油画": "oil painting style, thick brushstrokes",
    "素描": "pencil sketch style, black and white",
    "动漫": "anime style, vibrant colors, cel shading",
    "赛博朋克": "cyberpunk style, neon lights, dark atmosphere",
    "写实": "photorealistic, high detail, 8k",
    "夜晚": "night time, dark sky, stars, moonlight",
    "白天": "daytime, bright sky, sunlight",
    "黄昏": "sunset, golden hour, warm colors",
    "下雨": "rainy weather, wet, rain drops",
    "下雪": "snowy weather, snow, winter",
    "春天": "spring, cherry blossoms, fresh green",
    "秋天": "autumn, fall leaves, warm colors",
}


def _find_target_layer(instruction: str, layers: list[LayerInfo]) -> Optional[LayerInfo]:
    """根据指令找到最匹配的图层"""
    instruction_lower = instruction.lower()

    # 1. 直接匹配图层名称
    for layer in layers:
        if layer.name.lower() in instruction_lower:
            return layer

    # 2. 语义关键词匹配
    for semantic_name, keywords in LAYER_KEYWORDS.items():
        for kw in keywords:
            if kw in instruction_lower:
                # 找图层名称中包含该语义的图层
                for layer in layers:
                    if any(k in layer.name.lower() for k in keywords):
                        return layer
                # 没找到精确匹配，返回语义最接近的
                break

    # 3. 如果只有一个图层，直接用
    if len(layers) == 1:
        return layers[0]

    return None


def _detect_intent(instruction: str) -> tuple[str, dict]:
    """检测操作意图，返回 (model_id, params)"""
    instruction_lower = instruction.lower()

    for keywords, model_id, default_params in INTENT_MODEL_MAP:
        if any(kw in instruction_lower for kw in keywords):
            params = dict(default_params)
            # 提取风格描述
            style_prompts = []
            for style_kw, style_prompt in STYLE_KEYWORDS.items():
                if style_kw in instruction:
                    style_prompts.append(style_prompt)
            if style_prompts:
                params["prompt"] = ", ".join(style_prompts)
            else:
                # 把整个指令作为 prompt
                params["prompt"] = instruction
            return model_id, params

    # 默认：重绘
    return "sd-inpaint", {"prompt": instruction, "strength": 0.75}


def _rule_based_parse(instruction: str, layers: list[LayerInfo]) -> Optional[ActionPlan]:
    """规则引擎解析，无需 LLM"""
    target = _find_target_layer(instruction, layers)
    model_id, params = _detect_intent(instruction)

    # 生成描述
    layer_desc = f"「{target.name}」" if target else "自动选择图层"
    action_desc = {
        "sd-inpaint":    "重绘",
        "style-transfer": "风格化",
        "enhance":        "增强",
    }.get(model_id, "处理")

    description = f"{action_desc} {layer_desc}：{params.get('prompt', instruction)}"

    return ActionPlan(
        target_layer_id=target.id if target else None,
        target_layer_name=target.name if target else None,
        model_id=model_id,
        params=params,
        description=description,
        confidence=0.8 if target else 0.5,
    )


async def _llm_parse_raw(instruction: str, layers: list[LayerInfo], model_id: str) -> str:
    """Call the configured LLM and return its raw response."""
    layer_list = "\n".join([f"- ID: {l.id}, 名称: {l.name}" for l in layers])

    system_prompt = """你是一个图像编辑助手，负责将用户的自然语言指令解析为结构化的操作计划。

可用的模型：
- sd-inpaint: 局部重绘，适合替换内容、修改场景
- style-transfer: 风格迁移，适合改变画风
- enhance: 图像增强，适合提升清晰度
- qwen-gen: AI 生成，适合创建新内容

请返回 JSON 格式：
{
  "target_layer_id": "图层ID或null",
  "target_layer_name": "图层名称或null",
  "model_id": "模型ID",
  "params": {"prompt": "英文提示词", "strength": 0.8},
  "description": "中文操作描述",
  "confidence": 0.9
}

注意：prompt 必须是英文，strength 在 0.1-1.0 之间。"""

    user_prompt = f"""当前图层列表：
{layer_list}

用户指令：{instruction}

请解析并返回操作计划 JSON："""

    return await call_chat_messages(
        model_id=model_id,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=1200,
        temperature=0.1,
    )


def _parse_llm_response(content: str) -> ActionPlan:
    """Validate a raw LLM response as an actionable edit plan."""
    parsed = json.loads(content)
    return ActionPlan(**parsed)


async def _llm_parse(instruction: str, layers: list[LayerInfo], model_id: str) -> ActionPlan:
    """Compatibility entrypoint for callers that do not own billing."""
    content = await _llm_parse_raw(instruction, layers, model_id)
    return _parse_llm_response(content)


# ─── 路由 ──────────────────────────────────────────────────────────────────────

@router.post("/parse", response_model=NLPParseResponse)
async def parse_instruction(
    body: NLPParseRequest,
    _user: dict = Depends(get_current_user),
):
    """
    解析自然语言指令为操作计划
    优先使用 LLM（更准确），没有配置 API Key 时降级到规则引擎
    """
    if not body.instruction.strip():
        raise HTTPException(400, "指令不能为空")

    if not body.layers:
        raise HTTPException(400, "没有可操作的图层，请先上传图片并分割")

    try:
        model_id = await provider_policy.choose_llm_model_id()
        if model_id:
            async def invoke() -> str:
                return await _llm_parse_raw(body.instruction, body.layers, model_id)

            raw = await execute_billed_model_call(
                user_id=str(_user["id"]),
                model_id=model_id,
                expected_category="llm",
                description="Natural language image edit parsing",
                idempotency_key=model_billing_operation_key(
                    namespace="nlp-parse",
                    user_id=str(_user["id"]),
                    operation_scope=body.client_request_id,
                    material={
                        "model_id": model_id,
                        "instruction": body.instruction,
                        "layers": [layer.model_dump() for layer in body.layers],
                    },
                ),
                invoke=invoke,
            )
            plan = _parse_llm_response(raw)
        else:
            plan = _rule_based_parse(body.instruction, body.layers)

        return NLPParseResponse(ok=True, plan=plan)

    except HTTPException:
        raise
    except Exception as e:
        # LLM 失败时降级到规则引擎
        try:
            plan = _rule_based_parse(body.instruction, body.layers)
            return NLPParseResponse(ok=True, plan=plan)
        except Exception as e2:
            return NLPParseResponse(ok=False, error=str(e2))


@router.get("/suggestions")
async def get_suggestions():
    """返回示例指令，帮助用户了解能做什么"""
    return {
        "suggestions": [
            "把天空换成星空夜晚",
            "将背景改成水彩画风格",
            "把人物服饰变成赛博朋克风格",
            "增强人物图层的清晰度",
            "把背景替换成秋天的森林",
            "将天空改成黄昏日落效果",
            "把植被变成动漫风格",
            "修复背景中的噪点",
        ]
    }
