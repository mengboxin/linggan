"""
SDXL Inpainting Provider — Flux Fill 超时兜底

当 Flux Fill 主路径超时或失败时，自动降级到 SDXL Inpainting。
SDXL 速度更快、成本更低，但生成质量略逊于 Flux Fill。

支持 Replace / Recolor / Remove 三种模式：
- Replace 模式：用户 prompt + mask + 8px 边缘模糊
- Recolor 模式：自动构造 prompt + 0.6 strength
- Remove 模式：使用 "remove object, fill with background" prompt

Requirements: R2.2, R2.3, R2.4
"""

import asyncio
import base64
from io import BytesIO
from typing import Literal, Optional

import httpx
from PIL import Image, ImageFilter

from core.config import settings


class SdxlInpaintProvider:
    """
    SDXL Inpainting Provider。

    通过 Replicate API 调用 SDXL Inpainting 模型。
    作为 Flux Fill 超时/失败时的兜底方案。
    """

    def __init__(self):
        self.endpoint = settings.SDXL_INPAINT_ENDPOINT
        self.api_key = settings.SDXL_INPAINT_API_KEY or settings.REPLICATE_API_TOKEN

    async def inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        执行 SDXL Inpainting。

        流程:
        1. 根据 mode 构造最终 prompt
        2. 对 mask 边缘进行 8px 高斯模糊
        3. 确定 strength（recolor 使用 0.6，其他使用 0.95）
        4. 调用 SDXL Inpainting API

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 蒙版 PNG bytes（白色区域为编辑区域）
            prompt: 文本提示（replace 模式由用户提供）
            mode: 编辑模式
            target_color: 目标颜色 hex 值（仅 recolor 模式）

        返回:
            编辑后的图像 PNG bytes
        """
        # 步骤 1：根据 mode 构造 prompt
        final_prompt = self._build_prompt(prompt, mode, target_color)

        # 步骤 2：对 mask 边缘进行 8px 高斯模糊
        blurred_mask_bytes = _blur_mask_edges(mask_bytes, blur_px=8)

        # 步骤 3：确定 strength
        strength = 0.6 if mode == "recolor" else 0.95

        # 步骤 4：调用 SDXL Inpainting API
        result_bytes = await self._call_sdxl_inpaint(
            image_bytes, blurred_mask_bytes, final_prompt, strength
        )
        return result_bytes

    def _build_prompt(
        self,
        user_prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> str:
        """
        根据编辑模式构造最终 prompt。

        - replace: 直接使用用户 prompt
        - recolor: "change color to {hex}, preserve texture and lighting"
        - remove: "remove object, fill with background, seamless"
        """
        if mode == "replace":
            return user_prompt
        elif mode == "recolor":
            color = target_color or "#000000"
            return f"change color to {color}, preserve texture and lighting"
        elif mode == "remove":
            return "remove object, fill with background, seamless"
        else:
            return user_prompt

    async def _call_sdxl_inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        strength: float,
    ) -> bytes:
        """
        调用 SDXL Inpainting API。

        参数:
            image_bytes: 原始图像 PNG bytes
            mask_bytes: 模糊后的蒙版 PNG bytes
            prompt: 最终文本提示
            strength: 生成强度（0.0-1.0）

        返回:
            生成结果图像 PNG bytes
        """
        if not self.api_key:
            raise RuntimeError(
                "未配置 SDXL Inpaint API Key"
                "（SDXL_INPAINT_API_KEY 或 REPLICATE_API_TOKEN）"
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
                "prompt": prompt,
                "strength": strength,
                "num_outputs": 1,
            }
        }

        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"SDXL Inpaint API 调用失败: {resp.status_code} "
                    f"{resp.text[:300]}"
                )

            data = resp.json()

            # 等待预测完成（Replicate 异步模式）
            prediction_url = (data.get("urls") or {}).get("get")
            for _ in range(90):
                status = data.get("status")
                if status == "succeeded":
                    break
                if status in {"failed", "canceled"}:
                    raise RuntimeError(
                        f"SDXL Inpaint 任务失败: "
                        f"{data.get('error', '未知错误')}"
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
                        f"SDXL Inpaint 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output")
        if not output:
            raise RuntimeError("SDXL Inpaint 返回空结果")

        # output 可能是 URL 列表或单个 URL
        if isinstance(output, list):
            output = output[0] if output else None
        if not output:
            raise RuntimeError("SDXL Inpaint 返回空结果")

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
                            f"下载 SDXL Inpaint 结果失败: "
                            f"{dl_resp.status_code}"
                        )
                    img_data = dl_resp.content
        else:
            raise RuntimeError(
                f"SDXL Inpaint 返回格式异常: {type(output)}"
            )

        # 确保输出为 PNG 格式
        img = Image.open(BytesIO(img_data)).convert("RGBA")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ---------------------------------------------------------------------------
# 纯工具函数（可独立测试）
# ---------------------------------------------------------------------------


def _blur_mask_edges(mask_bytes: bytes, blur_px: int = 8) -> bytes:
    """
    对蒙版边缘进行高斯模糊，避免 Inpainting 产生硬边。

    参数:
        mask_bytes: 蒙版 PNG bytes（灰度，白色=编辑区域）
        blur_px: 高斯模糊半径（像素），默认 8px

    返回:
        模糊后的蒙版 PNG bytes
    """
    if blur_px <= 0:
        return mask_bytes

    mask_img = Image.open(BytesIO(mask_bytes)).convert("L")
    blurred = mask_img.filter(ImageFilter.GaussianBlur(radius=blur_px))

    buf = BytesIO()
    blurred.save(buf, format="PNG")
    return buf.getvalue()
