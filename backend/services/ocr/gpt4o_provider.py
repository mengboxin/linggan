"""
GPT-4o Vision OCR Provider — 兜底路径

当 PaddleOCR confidence < 0.5 时启用，通过 GPT-4o Vision API
识别图像中的文字并推断字体族。

使用提示："请识别图中文字并输出 JSON"，要求模型返回结构化结果。
字体推断失败时回退 'system-ui' 默认。

Requirements: R3.1, R3.4
"""

import base64
import json
import logging

from core.config import settings
from services.ocr import FontInfo, OcrResult
from services.ai_client import call_vision

logger = logging.getLogger(__name__)

# GPT-4o Vision 识别提示词
OCR_SYSTEM_PROMPT = """你是一个专业的 OCR 文字识别助手。请识别图中的文字并输出 JSON 格式结果。"""

OCR_USER_PROMPT = """请识别图中文字并输出 JSON，格式如下：
{
  "text": "识别到的完整文字内容",
  "font_family": "推断的字体族名称（如：宋体、黑体、楷体、Arial、Helvetica、Sans-serif、Serif 等）",
  "font_weight": 400,
  "text_align": "left"
}

注意：
1. text 字段包含图中所有可见文字，多行用换行符分隔
2. font_family 根据文字的视觉风格推断最接近的字体族
3. font_weight 为字重（400=常规，700=粗体）
4. text_align 为对齐方式（left/center/right）
5. 只输出 JSON，不要其他内容"""


class Gpt4oOcrProvider:
    """
    GPT-4o Vision OCR Provider。

    当 PaddleOCR 置信度低于阈值时作为兜底方案，
    利用 GPT-4o 的视觉理解能力识别文字并推断字体族。

    特点：
    - 高准确率，尤其对风格化/艺术字体
    - 能推断字体族（宋体/黑体/Sans 等）
    - 需要网络调用，延迟较高
    - 字体推断失败时回退 'system-ui'
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 10.0,
    ):
        """
        初始化 GPT-4o Vision Provider。

        参数:
            api_key: OpenAI API Key（默认从 settings 读取）
            base_url: API Base URL（默认从 settings 读取）
            model: 模型名称（默认从 settings 读取）
            timeout: 请求超时时间（秒）
        """
        self.api_key = api_key or settings.OPENAI_API_KEY
        self.base_url = (base_url or settings.OPENAI_BASE_URL).rstrip("/")
        self.model = model or settings.LLM_MODEL
        self.timeout = timeout

    async def recognize(self, image_bytes: bytes) -> OcrResult:
        """
        使用 GPT-4o Vision 进行文字识别。

        流程:
        1. 将图像编码为 base64
        2. 构造 Vision API 请求（含 OCR 提示词）
        3. 解析 JSON 响应
        4. 字体推断失败时回退 'system-ui'

        参数:
            image_bytes: 图像 PNG bytes

        返回:
            OcrResult 包含识别结果（confidence 固定为 0.85，
            因为 GPT-4o 不提供置信度分数）
        """
        if not self.api_key:
            logger.error("未配置 OPENAI_API_KEY，GPT-4o OCR 不可用")
            return self._empty_result()

        try:
            response_text = await self._call_vision_api(image_bytes)
            return self._parse_response(response_text)
        except Exception as e:
            logger.error(f"GPT-4o Vision OCR 失败: {e}")
            return self._empty_result()

    async def _call_vision_api(self, image_bytes: bytes) -> str:
        """
        调用 GPT-4o Vision API。

        参数:
            image_bytes: 图像 PNG bytes

        返回:
            模型响应文本
        """
        return await call_vision(
            model_id=self.model,
            prompt=OCR_USER_PROMPT,
            image_bytes=image_bytes,
            system=OCR_SYSTEM_PROMPT,
            max_tokens=1000,
        )

    def _parse_response(self, response_text: str) -> OcrResult:
        """
        解析 GPT-4o 返回的 JSON 响应。

        如果 JSON 解析失败，尝试从文本中提取有用信息。
        字体推断失败时回退 'system-ui'。

        参数:
            response_text: 模型响应文本

        返回:
            OcrResult
        """
        # 尝试提取 JSON（模型可能在 JSON 前后加了其他文字）
        json_str = self._extract_json(response_text)

        if json_str:
            try:
                data = json.loads(json_str)
                text = data.get("text", "")
                font_family = data.get("font_family", "system-ui") or "system-ui"
                font_weight = data.get("font_weight", 400)
                text_align = data.get("text_align", "left")

                # 验证 font_weight 合法性
                if not isinstance(font_weight, int) or font_weight < 100:
                    font_weight = 400

                # 验证 text_align 合法性
                if text_align not in ("left", "center", "right"):
                    text_align = "left"

                return OcrResult(
                    text=text,
                    confidence=0.85,  # GPT-4o 不提供置信度，使用固定高值
                    font_info=FontInfo(
                        family=font_family,
                        size=16,  # GPT-4o 无法准确估算字号，由调用方覆盖
                        weight=font_weight,
                        align=text_align,
                    ),
                    color_hex="#000000",  # 颜色由调用方从图像提取
                )
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning(f"GPT-4o 响应 JSON 解析失败: {e}")

        # JSON 解析失败，尝试将整个响应作为纯文字结果
        # 字体推断失败，回退 'system-ui'
        return OcrResult(
            text=response_text.strip()[:500],  # 截断到 500 字符
            confidence=0.6,
            font_info=FontInfo(family="system-ui"),
            color_hex="#000000",
        )

    def _extract_json(self, text: str) -> str | None:
        """
        从文本中提取 JSON 字符串。

        支持以下格式：
        - 纯 JSON
        - ```json ... ``` 代码块
        - 文本中嵌入的 { ... }

        参数:
            text: 原始文本

        返回:
            提取的 JSON 字符串，或 None
        """
        text = text.strip()

        # 尝试直接解析
        if text.startswith("{"):
            # 找到匹配的右花括号
            depth = 0
            for i, ch in enumerate(text):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return text[: i + 1]

        # 尝试从 ```json ... ``` 代码块提取
        if "```json" in text:
            start = text.index("```json") + 7
            end = text.find("```", start)
            if end > start:
                return text[start:end].strip()

        # 尝试从 ``` ... ``` 代码块提取
        if "```" in text:
            parts = text.split("```")
            if len(parts) >= 3:
                candidate = parts[1].strip()
                if candidate.startswith("{"):
                    return candidate

        # 尝试找到第一个 { 和最后一个 }
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace >= 0 and last_brace > first_brace:
            return text[first_brace: last_brace + 1]

        return None

    def _empty_result(self) -> OcrResult:
        """返回空结果（字体回退 'system-ui'）"""
        return OcrResult(
            text="",
            confidence=0.0,
            font_info=FontInfo(family="system-ui"),
            color_hex="#000000",
        )
