"""
AnyText 文字渲染 Provider — 主路径实现

通过 API 调用 AnyText 模型执行文字渲染。
AnyText 对中英文风格保留效果最佳，能够在保持原始图像风格的同时
渲染新文字内容。

特点:
- 中英文混合渲染支持
- 保留原始字体风格（字重、衬线等视觉特征）
- 基于 diffusion 的文字生成，与背景自然融合

Requirements: R3.2, R3.5
"""

import asyncio
import base64
from io import BytesIO
from typing import Optional

import httpx
from PIL import Image

from core.config import settings
from services.ocr import FontInfo


class AnyTextProvider:
    """
    AnyText 文字渲染 Provider。

    通过 Replicate 或自托管 API 调用 AnyText 模型。
    适用于中英文风格保留渲染场景。
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None):
        self.endpoint = endpoint or getattr(settings, "ANYTEXT_ENDPOINT", "")
        self.api_key = api_key or getattr(
            settings, "ANYTEXT_API_KEY", None
        ) or getattr(settings, "REPLICATE_API_TOKEN", None)

    async def render(
        self,
        base_image: bytes,
        mask: bytes,
        text: str,
        font_info: FontInfo,
        color_hex: str,
    ) -> bytes:
        """
        使用 AnyText 模型渲染文字。

        流程:
        1. 将输入图像和蒙版编码为 base64
        2. 构造 AnyText 请求参数（包含文字、字体信息、颜色）
        3. 调用 AnyText API
        4. 等待结果并返回渲染后的图像

        参数:
            base_image: 原始图像 PNG bytes
            mask: 文字区域蒙版 PNG bytes
            text: 要渲染的文字内容
            font_info: 字体信息
            color_hex: 文字颜色 hex 值

        返回:
            渲染后的图像 PNG bytes
        """
        if not self.endpoint:
            raise RuntimeError(
                "未配置 AnyText 端点（ANYTEXT_ENDPOINT）"
            )
        if not self.api_key:
            raise RuntimeError(
                "未配置 AnyText API Key（ANYTEXT_API_KEY 或 REPLICATE_API_TOKEN）"
            )

        img_b64 = base64.b64encode(base_image).decode()
        mask_b64 = base64.b64encode(mask).decode()

        # 构造 AnyText 特定的 prompt 格式
        # AnyText 使用特殊标记来指定文字内容
        prompt = self._build_prompt(text, font_info, color_hex)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }

        payload = {
            "input": {
                "image": f"data:image/png;base64,{img_b64}",
                "mask": f"data:image/png;base64,{mask_b64}",
                "prompt": prompt,
                "text_content": text,
                "font_size": font_info.size,
                "font_color": color_hex,
                "mode": "text-editing",
            }
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"AnyText API 调用失败: {resp.status_code} {resp.text[:300]}"
                )

            data = resp.json()

            # 等待预测完成（Replicate 异步模式）
            prediction_url = (data.get("urls") or {}).get("get")
            for _ in range(60):
                status = data.get("status")
                if status == "succeeded":
                    break
                if status in {"failed", "canceled"}:
                    raise RuntimeError(
                        f"AnyText 任务失败: {data.get('error', '未知错误')}"
                    )
                if not prediction_url:
                    break
                await asyncio.sleep(1)
                poll = await client.get(
                    prediction_url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                if poll.status_code >= 400:
                    raise RuntimeError(
                        f"AnyText 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output")
        if not output:
            raise RuntimeError("AnyText 返回空结果")

        if isinstance(output, list):
            output = output[0] if output else None
        if not output:
            raise RuntimeError("AnyText 返回空结果")

        # 下载或解码结果图像
        img_data = await self._fetch_output(output)

        # 确保输出为 PNG 格式
        img = Image.open(BytesIO(img_data)).convert("RGBA")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _build_prompt(
        self, text: str, font_info: FontInfo, color_hex: str
    ) -> str:
        """
        构造 AnyText 渲染 prompt。

        AnyText 使用特殊格式来指定文字属性：
        - 文字内容通过 text_content 参数传递
        - prompt 用于描述整体风格和上下文
        """
        style_hints = []

        # 字重描述
        if font_info.weight >= 700:
            style_hints.append("bold")
        elif font_info.weight <= 300:
            style_hints.append("light")

        # 字体族描述
        if font_info.family and font_info.family != "system-ui":
            style_hints.append(f"{font_info.family} style")

        # 颜色描述
        style_hints.append(f"color {color_hex}")

        style_desc = ", ".join(style_hints) if style_hints else "default style"
        return f"render text with {style_desc}, preserve surrounding style"

    async def _fetch_output(self, output) -> bytes:
        """获取输出图像数据（支持 URL 和 base64 data URI）"""
        if isinstance(output, str):
            if output.startswith("data:image"):
                return base64.b64decode(output.split(",", 1)[1])
            else:
                # URL，需要下载
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.get(output)
                    if resp.status_code >= 400:
                        raise RuntimeError(
                            f"下载 AnyText 结果失败: {resp.status_code}"
                        )
                    return resp.content
        raise RuntimeError(f"AnyText 返回格式异常: {type(output)}")
