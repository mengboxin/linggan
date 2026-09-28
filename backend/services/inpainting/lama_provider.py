"""
LaMa Inpainting Provider — Remove 模式专用

通过 Replicate API 调用 LaMa（Large Mask Inpainting）模型执行对象移除。
LaMa 对纯背景填充质量高、速度快（比 Flux Fill 快 5-10x），
适合 Remove 模式下的背景补全任务。

- 4px mask 边缘羽化（避免硬边，R2.4）
- prompt 留空（LaMa 不需要文本提示，纯视觉补全）

Requirements: R2.4
"""

import asyncio
import base64
from io import BytesIO
from typing import Literal, Optional

import httpx
from PIL import Image, ImageFilter

from core.config import settings


class LaMaProvider:
    """
    LaMa Inpainting Provider。

    通过 Replicate API 调用 LaMa 模型，专用于 Remove 模式。
    LaMa 是轻量级图像补全模型，对背景填充效果优异。
    """

    def __init__(self):
        self.endpoint = settings.LAMA_ENDPOINT
        self.api_key = settings.LAMA_API_KEY or settings.REPLICATE_API_TOKEN

    async def inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        执行 LaMa Inpainting（对象移除 + 背景补全）。

        流程:
        1. 对 mask 边缘进行 4px 高斯羽化（R2.4）
        2. prompt 留空（LaMa 纯视觉补全，不需要文本提示）
        3. 调用 LaMa API

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 蒙版 PNG bytes（白色区域为需要移除的区域）
            prompt: 忽略（LaMa 不使用文本提示）
            mode: 编辑模式（LaMa 仅用于 remove 模式）
            target_color: 忽略

        返回:
            补全后的图像 PNG bytes
        """
        # 步骤 1：对 mask 边缘进行 4px 高斯羽化
        feathered_mask_bytes = _feather_mask(mask_bytes, feather_px=4)

        # 步骤 2：调用 LaMa API（prompt 留空）
        result_bytes = await self._call_lama(image_bytes, feathered_mask_bytes)
        return result_bytes

    async def _call_lama(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
    ) -> bytes:
        """
        调用 LaMa API 执行背景补全。

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 羽化后的蒙版 PNG bytes

        返回:
            补全结果图像 PNG bytes
        """
        if not self.api_key:
            raise RuntimeError(
                "未配置 LaMa API Key（LAMA_API_KEY 或 REPLICATE_API_TOKEN）"
            )

        img_b64 = base64.b64encode(image_bytes).decode()
        mask_b64 = base64.b64encode(mask_bytes).decode()

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }

        payload = {
            "input": {
                "image": f"data:image/png;base64,{img_b64}",
                "mask": f"data:image/png;base64,{mask_b64}",
            }
        }

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"LaMa API 调用失败: {resp.status_code} {resp.text[:300]}"
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
                        f"LaMa 任务失败: {data.get('error', '未知错误')}"
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
                        f"LaMa 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output")
        if not output:
            raise RuntimeError("LaMa 返回空结果")

        # output 可能是 URL 字符串或 base64 data URI
        if isinstance(output, list):
            output = output[0] if output else None
        if not output:
            raise RuntimeError("LaMa 返回空结果")

        if isinstance(output, str):
            if output.startswith("data:image"):
                # base64 data URI
                img_data = base64.b64decode(output.split(",", 1)[1])
            else:
                # URL，需要下载
                async with httpx.AsyncClient(timeout=60) as dl_client:
                    dl_resp = await dl_client.get(output)
                    if dl_resp.status_code >= 400:
                        raise RuntimeError(
                            f"下载 LaMa 结果失败: {dl_resp.status_code}"
                        )
                    img_data = dl_resp.content
        else:
            raise RuntimeError(f"LaMa 返回格式异常: {type(output)}")

        # 确保输出为 PNG 格式
        img = Image.open(BytesIO(img_data)).convert("RGBA")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ---------------------------------------------------------------------------
# 纯工具函数（可独立测试）
# ---------------------------------------------------------------------------


def _feather_mask(mask_bytes: bytes, feather_px: int = 4) -> bytes:
    """
    对蒙版边缘进行高斯羽化，避免 Inpainting 产生硬边。

    参数:
        mask_bytes: 蒙版 PNG bytes（灰度，白色=编辑区域）
        feather_px: 羽化半径（像素），默认 4px（R2.4 规定）

    返回:
        羽化后的蒙版 PNG bytes

    说明:
        使用 4px 高斯模糊实现边缘羽化。
        相比 Flux Fill 的 8px 模糊，LaMa 使用更小的羽化半径，
        因为 LaMa 本身对边缘处理较好，过大的羽化会导致补全区域过大。
    """
    if feather_px <= 0:
        return mask_bytes

    mask_img = Image.open(BytesIO(mask_bytes)).convert("L")

    # 对蒙版应用高斯模糊实现羽化效果
    feathered = mask_img.filter(ImageFilter.GaussianBlur(radius=feather_px))

    buf = BytesIO()
    feathered.save(buf, format="PNG")
    return buf.getvalue()
