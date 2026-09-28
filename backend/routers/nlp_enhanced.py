"""
增强版自然语言操作路由
支持上下文记忆、多轮对话、智能意图识别
"""
import json
import re
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.config import settings

router = APIRouter(prefix="/api/nlp-enhanced", tags=["增强自然语言操作"])

# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class LayerInfo(BaseModel):
    id: str
    name: str
    index: int
    type: str  # 人物、背景、物体等

class ContextMemory(BaseModel):
    session_id: str
    user_id: str
    conversation_history: List[Dict[str, Any]]
    last_actions: List[Dict[str, Any]]
    timestamp: datetime

class NLPParseRequest(BaseModel):
    instruction: str
    layers: List[LayerInfo]
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    context_memory: Optional[ContextMemory] = None

class ActionPlan(BaseModel):
    target_layer_id: Optional[str] = None
    target_layer_name: Optional[str] = None
    target_layer_type: Optional[str] = None
    model_id: str
    params: dict
    description: str
    confidence: float
    reasoning: str  # 推理过程

class NLPParseResponse(BaseModel):
    ok: bool
    plan: Optional[ActionPlan] = None
    context_memory: Optional[ContextMemory] = None
    suggestions: List[str] = []
    error: Optional[str] = None

# ─── 上下文管理器 ─────────────────────────────────────────────────────────────

class ContextManager:
    def __init__(self):
        self.memories: Dict[str, ContextMemory] = {}
        self.max_history = 10  # 保留最近10条对话

    def get_memory(self, session_id: str, user_id: str) -> ContextMemory:
        key = f"{user_id}:{session_id}"
        if key not in self.memories:
            self.memories[key] = ContextMemory(
                session_id=session_id,
                user_id=user_id,
                conversation_history=[],
                last_actions=[],
                timestamp=datetime.now()
            )
        return self.memories[key]

    def update_memory(self, memory: ContextMemory, instruction: str, plan: ActionPlan):
        # 添加到对话历史
        memory.conversation_history.append({
            "timestamp": datetime.now().isoformat(),
            "instruction": instruction,
            "plan": plan.dict(),
            "result": None  # 后续可以更新结果
        })

        # 更新最近操作
        memory.last_actions.append({
            "timestamp": datetime.now().isoformat(),
            "action": plan.description,
            "target_layer": plan.target_layer_name
        })

        # 保持历史记录在限制范围内
        if len(memory.conversation_history) > self.max_history:
            memory.conversation_history.pop(0)

        if len(memory.last_actions) > self.max_history:
            memory.last_actions.pop(0)

        memory.timestamp = datetime.now()
        return memory

# 全局上下文管理器
context_manager = ContextManager()

# ─── 智能意图识别 ─────────────────────────────────────────────────────────────

class IntentRecognizer:
    def __init__(self):
        # 语义映射
        self.semantic_map = {
            "空间操作": {
                "移动": ["移到", "移动到", "搬到", "放到", "位置", "position"],
                "旋转": ["旋转", "turn", "rotate", "角度"],
                "缩放": ["放大", "缩小", "scale", "size", "尺寸"],
                "翻转": ["翻转", "mirror", "reflect", "对称"],
            },
            "属性操作": {
                "颜色": ["变", "颜色", "color", "色调", "hue", "饱和", "satur"],
                "亮度": ["亮度", "brightness", "暗", "light", "dark"],
                "对比度": ["对比", "contrast"],
                "模糊": ["模糊", "blur", "清晰", "sharpen"],
            },
            "内容操作": {
                "替换": ["换", "替换", "replace", "改成", "变成"],
                "删除": ["删", "删除", "remove", "去掉", "清除"],
                "添加": ["加", "添加", "add", "增加", "新"],
                "修改": ["改", "修改", "modify", "调整", "alter"],
            },
            "风格操作": {
                "整体": ["风格", "style", "画风", "art style"],
                "局部": ["局部", "part", "area", "region"],
                "材质": ["材质", "texture", "material", "表面"],
                "光照": ["光", "light", "阴影", "shadow", "光照"],
            }
        }

        # 情感分析词库
        self.sentiment_words = {
            "积极": ["好", "棒", "美", "漂亮", "喜欢", "想要", "希望"],
            "消极": ["不好", "差", "丑", "讨厌", "不要", "去掉", "删除"],
        }

    def recognize_intent(self, instruction: str, context: ContextMemory = None) -> Dict[str, Any]:
        instruction_lower = instruction.lower()

        # 1. 情感分析
        sentiment = self.analyze_sentiment(instruction_lower)

        # 2. 提取关键词
        keywords = self.extract_keywords(instruction_lower)

        # 3. 匹配意图
        intent = self.match_intent(keywords, instruction_lower)

        # 4. 上下文分析
        if context:
            intent = self.enhance_with_context(intent, context, instruction_lower)

        return {
            "sentiment": sentiment,
            "keywords": keywords,
            "intent": intent,
            "complexity": self.assess_complexity(instruction_lower)
        }

    def analyze_sentiment(self, text: str) -> str:
        for sentiment, words in self.sentiment_words.items():
            if any(word in text for word in words):
                return sentiment
        return "中性"

    def extract_keywords(self, text: str) -> List[str]:
        # 移除停用词
        stop_words = {"的", "了", "是", "在", "和", "与", "或", "但是", "就", "要", "不", "没有"}
        words = re.findall(r'\b\w+\b', text)
        return [word for word in words if word not in stop_words]

    def match_intent(self, keywords: List[str], text: str) -> Dict[str, Any]:
        for category, intents in self.semantic_map.items():
            for intent_type, intent_words in intents.items():
                if any(word in text for word in intent_words):
                    return {
                        "category": category,
                        "type": intent_type,
                        "confidence": self.calculate_confidence(keywords, intent_words)
                    }
        return {"category": "未知", "type": "通用", "confidence": 0.3}

    def enhance_with_context(self, intent: Dict[str, Any], context: ContextMemory, text: str) -> Dict[str, Any]:
        # 基于上下文提升意图识别的准确性
        if context.conversation_history:
            last_intent = context.conversation_history[-1].get("plan", {}).get("intent", {})

            # 如果用户在继续上次的操作
            if any(phrase in text for phrase in ["继续", "然后", "接下来", "还要"]):
                intent["previous_intent"] = last_intent
                intent["confidence"] = min(1.0, intent["confidence"] + 0.2)

        return intent

    def calculate_confidence(self, keywords: List[str], intent_words: List[str]) -> float:
        match_count = sum(1 for word in keywords if word in intent_words)
        return min(1.0, match_count / len(intent_words))

    def assess_complexity(self, text: str) -> str:
        if len(text.split()) < 3:
            return "简单"
        elif any(word in text for word in ["如果", "那么", "而且", "同时", "同时", "既要也要"]):
            return "复杂"
        else:
            return "中等"

# 全局意图识别器
intent_recognizer = IntentRecognizer()

# ─── 智能图层选择 ─────────────────────────────────────────────────────────────

class SmartLayerSelector:
    def __init__(self):
        # 语义类别映射
        self.layer_types = {
            "人物": ["人", "人物", "人像", "角色", "主体", "man", "person", "character"],
            "背景": ["背景", "background", "bg", "后面", "后景", "远景", "back"],
            "天空": ["天空", "sky", "云", "cloud", "天空", "云朵"],
            "地面": ["地面", "地", "floor", "ground", "陆地"],
            "建筑": ["建筑", "building", "房子", "house", "楼", "建筑"],
            "植被": ["树", "草", "植物", "vegetation", "绿色", "forest"],
            "物体": ["物体", "物品", "object", "东西", "道具"],
            "文字": ["文字", "text", "文字", "label", "文字"],
        }

    def select_layer(self, instruction: str, layers: List[LayerInfo], context: ContextMemory = None) -> Optional[LayerInfo]:
        instruction_lower = instruction.lower()

        # 1. 直接匹配图层名称
        for layer in layers:
            if layer.name.lower() in instruction_lower:
                return layer

        # 2. 语义匹配
        for layer_type, keywords in self.layer_types.items():
            if any(keyword in instruction_lower for keyword in keywords):
                # 找到该类型的图层
                matched_layers = [l for l in layers if any(kw in l.name.lower() for kw in keywords)]
                if matched_layers:
                    # 如果有上下文，选择最相关的
                    if context and context.last_actions:
                        return self.relevant_layer(matched_layers, context)
                    return matched_layers[0]  # 返回第一个匹配的

        # 3. 位置描述解析
        layer = self.parse_position_description(instruction, layers)
        if layer:
            return layer

        # 4. 默认选择（最中间的图层）
        if len(layers) == 1:
            return layers[0]

        # 5. 选择最突出的图层（通常是最上面的）
        return layers[0] if layers else None

    def relevant_layer(self, layers: List[LayerInfo], context: ContextMemory) -> LayerInfo:
        # 基于上下文选择最相关的图层
        # 如果上次操作了某个图层，可能用户想要继续操作它
        if context.last_actions:
            last_action = context.last_actions[-1]
            last_layer = last_action.get("target_layer")
            if last_layer:
                for layer in layers:
                    if layer.name == last_layer:
                        return layer

        return layers[0]

    def parse_position_description(self, instruction: str, layers: List[LayerInfo]) -> Optional[LayerInfo]:
        # 解析位置描述，如"左边的天空"、"右边的建筑"
        position_words = ["左", "右", "上", "下", "中", "边", "中间"]

        for word in position_words:
            if word in instruction:
                # 这里可以添加更复杂的逻辑来解析位置
                # 目前简单返回第一个包含位置词的图层
                for layer in layers:
                    if word in layer.name:
                        return layer

        return None

# 全局图层选择器
layer_selector = SmartLayerSelector()

# ─── 智能参数生成 ─────────────────────────────────────────────────────────────

class SmartParameterGenerator:
    def __init__(self):
        # 预设参数模板
        self.templates = {
            "风格转换": {
                "strength": 0.7,
                "prompt_templates": {
                    "油画": "oil painting style, thick brushstrokes",
                    "水彩": "watercolor painting style, soft edges",
                    "素描": "pencil sketch style, black and white",
                    "动漫": "anime style, vibrant colors",
                    "写实": "photorealistic, high detail",
                    "赛博朋克": "cyberpunk style, neon lights, dark atmosphere",
                }
            },
            "颜色调整": {
                "hue_shift": 0,
                "saturation": 1.0,
                "brightness": 1.0,
            },
            "图像增强": {
                "denoise": True,
                "sharpen": 0.5,
                "detail": 0.8,
            }
        }

    def generate_params(self, intent: Dict[str, Any], instruction: str) -> dict:
        category = intent.get("category", "")
        intent_type = intent.get("type", "")

        if category == "风格操作":
            return self.generate_style_params(intent_type, instruction)
        elif category == "属性操作":
            return self.generate_attribute_params(intent_type)
        elif category == "内容操作":
            return self.generate_content_params(intent_type, instruction)
        else:
            return self.generate_default_params(instruction)

    def generate_style_params(self, intent_type: str, instruction: str) -> dict:
        params = self.templates["风格转换"].copy()

        # 从指令中提取风格关键词
        for style, prompt in self.templates["风格转换"]["prompt_templates"].items():
            if style in instruction:
                params["prompt"] = prompt
                break
        else:
            params["prompt"] = instruction  # 使用整个指令

        return params

    def generate_attribute_params(self, intent_type: str) -> dict:
        params = self.templates["属性操作"].copy()

        # 根据意图类型调整参数
        if intent_type == "颜色":
            params["color_shift"] = 0.1
        elif intent_type == "亮度":
            params["brightness"] = 1.2 if "亮" in intent_type else 0.8
        elif intent_type == "对比度":
            params["contrast"] = 1.2
        elif intent_type == "模糊":
            params["blur_strength"] = 2.0

        return params

    def generate_content_params(self, intent_type: str, instruction: str) -> dict:
        params = {}

        if intent_type in ["替换", "修改"]:
            params["inpaint_strength"] = 0.8
            params["prompt"] = instruction
        elif intent_type == "删除":
            params["remove_strength"] = 1.0
            params["prompt"] = "remove unwanted elements"
        elif intent_type == "添加":
            params["generate_strength"] = 0.7
            params["prompt"] = instruction

        return params

    def generate_default_params(self, instruction: str) -> dict:
        # 默认参数
        return {
            "prompt": instruction,
            "strength": 0.7,
            "style": "default",
        }

# 全局参数生成器
param_generator = SmartParameterGenerator()

# ─── 增强解析函数 ─────────────────────────────────────────────────────────────

async def enhanced_nlp_parse(
    instruction: str,
    layers: List[LayerInfo],
    session_id: str = None,
    user_id: str = None
) -> NLPParseResponse:
    # 获取或创建上下文
    if session_id and user_id:
        memory = context_manager.get_memory(session_id, user_id)
    else:
        memory = ContextMemory(
            session_id=session_id or f"session_{datetime.now().timestamp()}",
            user_id=user_id or "anonymous",
            conversation_history=[],
            last_actions=[],
            timestamp=datetime.now()
        )

    # 1. 意图识别
    intent_info = intent_recognizer.recognize_intent(instruction, memory)

    # 2. 智能图层选择
    target_layer = layer_selector.select_layer(instruction, layers, memory)

    # 3. 生成参数
    params = param_generator.generate_params(intent_info, instruction)

    # 4. 选择模型
    model_id = select_model_for_intent(intent_info, target_layer)

    # 5. 生成推理过程
    reasoning = generate_reasoning(
        instruction,
        intent_info,
        target_layer,
        model_id,
        params,
        memory
    )

    # 6. 创建行动计划
    plan = ActionPlan(
        target_layer_id=target_layer.id if target_layer else None,
        target_layer_name=target_layer.name if target_layer else None,
        target_layer_type=target_layer.type if target_layer else None,
        model_id=model_id,
        params=params,
        description=f"操作：{intent_info.get('type', '未知')} - {target_layer.name if target_layer else '自动选择'}",
        confidence=intent_info.get("confidence", 0.5),
        reasoning=reasoning
    )

    # 7. 更新上下文
    memory = context_manager.update_memory(memory, instruction, plan)

    # 8. 生成建议
    suggestions = generate_suggestions(intent_info, memory)

    return NLPParseResponse(
        ok=True,
        plan=plan,
        context_memory=memory,
        suggestions=suggestions
    )

def select_model_for_intent(intent: Dict[str, Any], target_layer) -> str:
    category = intent.get("category", "")
    sentiment = intent.get("sentiment", "中性")

    # 根据意图选择模型
    model_mapping = {
        "风格操作": "generate",
        "属性操作": "generate",
        "内容操作": "sd-inpaint",
        "空间操作": "sd-inpaint",
    }

    default_model = model_mapping.get(category, "sd-inpaint")

    return default_model

def generate_reasoning(
    instruction: str,
    intent: Dict[str, Any],
    target_layer,
    model_id: str,
    params: dict,
    memory: ContextMemory
) -> str:
    reasons = []

    # 1. 意图推理
    reasons.append(f"识别意图：{intent.get('category', '未知')} - {intent.get('type', '未知')}")

    # 2. 图层选择推理
    if target_layer:
        reasons.append(f"选择图层：{target_layer.name}（基于语义匹配）")
    else:
        reasons.append("选择图层：自动选择（无法确定目标）")

    # 3. 模型选择推理
    model_names = {
        "style-transfer": "风格转换",
        "enhance": "图像增强",
        "sd-inpaint": "局部重绘",
    }
    reasons.append(f"选择模型：{model_names.get(model_id, model_id)}")

    # 4. 参数设置推理
    if "prompt" in params:
        reasons.append(f"设置提示词：{params['prompt']}")

    # 5. 上下文推理
    if memory.last_actions:
        reasons.append(f"基于上下文：最近操作了{memory.last_actions[-1].get('action', '未知')}")

    return "；".join(reasons)

def generate_suggestions(intent: Dict[str, Any], memory: ContextMemory) -> List[str]:
    suggestions = []

    # 基于意图生成建议
    intent_type = intent.get("type", "")
    if intent_type in ["移动", "旋转", "缩放"]:
        suggestions.append("尝试使用空间操作：把图层移到右边")
    elif intent_type in ["颜色", "亮度"]:
        suggestions.append("可以尝试调整整体效果：让画面更明亮")
    elif intent_type in ["替换", "删除"]:
        suggestions.append("注意：删除操作不可撤销，建议先保存")

    # 基于历史生成建议
    if memory.last_actions:
        last_action = memory.last_actions[-1]
        if "风格" in last_action.get("action", ""):
            suggestions.append("继续风格调整：尝试不同的艺术风格")

    return suggestions[:3]  # 最多返回3条建议

# ─── 路由 ──────────────────────────────────────────────────────────────────────

@router.post("/parse")
async def parse_enhanced_instruction(body: NLPParseRequest):
    """增强版自然语言指令解析"""
    if not body.instruction.strip():
        raise HTTPException(400, "指令不能为空")

    if not body.layers:
        raise HTTPException(400, "没有可操作的图层，请先上传图片并分割")

    try:
        return await enhanced_nlp_parse(
            body.instruction,
            body.layers,
            body.session_id,
            body.user_id
        )
    except Exception as e:
        return NLPParseResponse(ok=False, error=str(e))

@router.get("/context/{session_id}")
async def get_context(session_id: str, user_id: str):
    """获取上下文记忆"""
    memory = context_manager.get_memory(session_id, user_id)
    return memory

@router.post("/clear-context/{session_id}")
async def clear_context(session_id: str, user_id: str):
    """清除上下文记忆"""
    key = f"{user_id}:{session_id}"
    if key in context_manager.memories:
        del context_manager.memories[key]
    return {"ok": True}

@router.get("/suggestions")
async def get_enhanced_suggestions():
    """获取智能建议"""
    return {
        "context_aware_suggestions": [
            "继续上次的风格调整",
            "优化刚才修改的区域",
            "保持整体风格统一",
        ],
        "intent_based_suggestions": [
            "把天空换成夜晚",
            "给人物添加阴影",
            "调整整体色调",
            "增强画面细节",
        ],
        "quick_actions": [
            "放大图层",
            "调整不透明度",
            "添加蒙版",
            "复制图层",
        ]
    }