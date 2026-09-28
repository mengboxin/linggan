"""
TextDiffuser-2 文字渲染 Provider — 辅路径实现

通过 API 调用 TextDiffuser-2 模型执行文字渲染。
TextDiffuser-2 适用于英文长段落渲染场景，对多行英文文本
的排版和渲染效果优于 AnyText。

特点:
- 英文长段落渲染优化
- 多行文本自动排版
- 基于 diffusion 的文字生成

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


class TextDiffuserProvider:
    """
    TextDiffuser-2 文字渲染 Provider。

    通过 Replicate 或自托管 API 调用 TextDiffuser-2 模型。
    适用于英文长段落渲染场景。
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None):
        self.endpoint = endpoint or getattr(settings, "TEXTDIFFUSER_ENDPOINT", "")
        self.api_key = api_key or getattr(
            settings, "TEXTDIFFUSER_API_KEY", None
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
        使用 TextDiffuser-2 模型渲染文字。

        流程:
        1. 将输入图像和蒙版编码为 base64
        2. 构造 TextDiffuser-2 请求参数
        3. 调用 TextDiffuser-2 API
        4. 等待结果并返回渲染后的图像

        参数:
            base_image: 原始图像 PNG bytes
            mask: 文字区域蒙版 PNG bytes
            text: 要渲染的文字内容（英文长段落）
            font_info: 字体信息
            color_hex: 文字颜色 hex 值

        返回:
            渲染后的图像 PNG bytes
        """
        if not self.endpoint:
            raise RuntimeError(
                "未配置 TextDiffuser 端点（TEXTDIFFUSER_ENDPOINT）"
            )
        if not self.api_key:
            raise RuntimeError(
                "未配置 TextDiffuser API Key（TEXTDIFFUSER_API_KEY 或 REPLICATE_API_TOKEN）"
            )

        img_b64 = base64.b64encode(base_image).decode()
        mask_b64 = base64.b64encode(mask).decode()

        # 构造 TextDiffuser-2 的 prompt
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
                "mode": "text-inpainting",
            }
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"TextDiffuser API 调用失败: {resp.status_code} {resp.text[:300]}"
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
                        f"TextDiffuser 任务失败: {data.get('error', '未知错误')}"
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
                        f"TextDiffuser 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output")
        if not output:
            raise RuntimeError("TextDiffuser 返回空结果")

        if isinstance(output, list):
            output = output[0] if output else None
        if not output:
            raise RuntimeError("TextDiffuser 返回空结果")

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
        构造 TextDiffuser-2 渲染 prompt。

        TextDiffuser-2 使用自然语言 prompt 描述文字渲染需求。
        """
        parts = [f'render the text "{text}"']

        # 字体描述
        if font_info.family and font_info.family != "system-ui":
            parts.append(f"in {font_info.family} font")

        # 字重
        if font_info.weight >= 700:
            parts.append("bold weight")
        elif font_info.weight <= 300:
            parts.append("light weight")

        # 颜色
        parts.append(f"with color {color_hex}")

        # 对齐
        if font_info.align != "left":
            parts.append(f"{font_info.align} aligned")

        return ", ".join(parts)

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
                            f"下载 TextDiffuser 结果失败: {resp.status_code}"
                        )
                    return resp.content
        raise RuntimeError(f"TextDiffuser 返回格式异常: {type(output)}")
