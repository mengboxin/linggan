"""
Flux Fill Inpainting Provider — 主路径实现

通过 Replicate API 调用 Flux Fill 模型执行 Inpainting。
支持 Replace / Recolor / Remove 三种模式。

- Replace 模式：用户 prompt + mask + 8px 边缘高斯模糊（R2.2）
- Recolor 模式：自动构造 prompt + 0.6 strength（R2.3）
- Remove 模式：使用 "remove object, fill with background" prompt（R2.4 后续由 LaMa 接管）
- 风格保留（R4.4）：mask 周围 32px 环带颜色直方图统计加入 prompt

Requirements: R2.2, R2.3, R4.4
"""

import asyncio
import base64
import collections
from io import BytesIO
from typing import Literal, Optional

import httpx
from PIL import Image, ImageFilter

from core.config import settings


class FluxFillProvider:
    """
    Flux Fill Inpainting Provider。

    通过 Replicate API 调用 Flux Fill Pro 模型。
    """

    def __init__(self):
        self.endpoint = settings.FLUX_FILL_ENDPOINT
        self.api_key = settings.FLUX_FILL_API_KEY or settings.REPLICATE_API_TOKEN

    async def inpaint(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        mode: Literal["replace", "recolor", "remove"],
        target_color: Optional[str] = None,
    ) -> bytes:
        """
        执行 Flux Fill Inpainting。

        流程:
        1. 根据 mode 构造最终 prompt
        2. 对 mask 边缘进行 8px 高斯模糊（避免硬边）
        3. 分析 mask 周围 32px 环带颜色直方图（R4.4 风格保留）
        4. 将颜色信息加入 prompt
        5. 调用 Flux Fill API
        """
        # 步骤 1：根据 mode 构造 prompt
        final_prompt = self._build_prompt(prompt, mode, target_color)

        # 步骤 2：对 mask 边缘进行 8px 高斯模糊
        blurred_mask_bytes = _blur_mask_edges(mask_bytes, blur_px=8)

        # 步骤 3 & 4：分析周围颜色并加入 prompt（R4.4 风格保留）
        palette_colors = _analyze_surrounding_palette(
            image_bytes, mask_bytes, ring_width=32
        )
        if palette_colors:
            palette_str = ", ".join(palette_colors)
            final_prompt += f", matching surrounding palette: {palette_str}"

        # 步骤 5：确定 strength（recolor 模式使用 0.6）
        strength = 0.6 if mode == "recolor" else 0.95

        # 步骤 6：调用 Flux Fill API
        result_bytes = await self._call_flux_fill(
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
        - remove: "remove object, fill with background"
        """
        if mode == "replace":
            return user_prompt
        elif mode == "recolor":
            color = target_color or "#000000"
            return f"change color to {color}, preserve texture and lighting"
        elif mode == "remove":
            return "remove object, fill with background"
        else:
            return user_prompt

    async def _call_flux_fill(
        self,
        image_bytes: bytes,
        mask_bytes: bytes,
        prompt: str,
        strength: float,
    ) -> bytes:
        """
        调用 Flux Fill API 执行 Inpainting。

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
                "未配置 Flux Fill API Key（FLUX_FILL_API_KEY 或 REPLICATE_API_TOKEN）"
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
            }
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"Flux Fill API 调用失败: {resp.status_code} {resp.text[:300]}"
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
                        f"Flux Fill 任务失败: {data.get('error', '未知错误')}"
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
                        f"Flux Fill 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output")
        if not output:
            raise RuntimeError("Flux Fill 返回空结果")

        # output 可能是 URL 字符串或 base64 data URI
        if isinstance(output, list):
            output = output[0] if output else None
        if not output:
            raise RuntimeError("Flux Fill 返回空结果")

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
                            f"下载 Flux Fill 结果失败: {dl_resp.status_code}"
                        )
                    img_data = dl_resp.content
        else:
            raise RuntimeError(f"Flux Fill 返回格式异常: {type(output)}")

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

    说明:
        仅对边缘进行模糊处理。核心区域保持全白（255），
        边缘区域通过高斯模糊产生平滑过渡。
    """
    if blur_px <= 0:
        return mask_bytes

    mask_img = Image.open(BytesIO(mask_bytes)).convert("L")

    # 对整个蒙版应用高斯模糊
    # GaussianBlur 的 radius 参数控制模糊范围
    blurred = mask_img.filter(ImageFilter.GaussianBlur(radius=blur_px))

    buf = BytesIO()
    blurred.save(buf, format="PNG")
    return buf.getvalue()


def _analyze_surrounding_palette(
    image_bytes: bytes,
    mask_bytes: bytes,
    ring_width: int = 32,
) -> list[str]:
    """
    分析 mask 周围 32px 环带的颜色直方图，返回主要颜色（R4.4 风格保留）。

    参数:
        image_bytes: 原始图像 PNG bytes
        mask_bytes: 蒙版 PNG bytes（灰度，白色=编辑区域）
        ring_width: 环带宽度（像素），默认 32px

    返回:
        主要颜色 hex 列表（3-5 个），按出现频率降序排列。
        如果环带区域为空或图像无法解析，返回空列表。

    算法:
        1. 将蒙版膨胀 ring_width 像素得到外环边界
        2. 外环 - 原始蒙版 = 环带区域
        3. 在环带区域内采样像素颜色
        4. 将颜色量化到 16 级（每通道），统计频率
        5. 返回 top 3-5 颜色的 hex 值
    """
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        mask = Image.open(BytesIO(mask_bytes)).convert("L")
    except Exception:
        return []

    # 确保尺寸一致
    if img.size != mask.size:
        mask = mask.resize(img.size, Image.NEAREST)

    width, height = img.size
    if width == 0 or height == 0:
        return []

    # 膨胀蒙版得到外环边界
    # 使用 MaxFilter 实现膨胀效果
    dilated = mask.copy()
    # 多次应用 MaxFilter 以达到 ring_width 的膨胀效果
    # MaxFilter(size=3) 每次膨胀 1px，需要 ring_width 次
    # 为了效率，使用较大的 kernel 减少迭代次数
    remaining = ring_width
    while remaining > 0:
        kernel_size = min(remaining * 2 + 1, 15)  # 最大 kernel 15
        # kernel_size 必须为奇数
        if kernel_size % 2 == 0:
            kernel_size -= 1
        if kernel_size < 3:
            kernel_size = 3
        dilated = dilated.filter(ImageFilter.MaxFilter(size=kernel_size))
        remaining -= (kernel_size - 1) // 2

    # 获取像素数据
    img_pixels = img.load()
    mask_pixels = mask.load()
    dilated_pixels = dilated.load()

    # 收集环带区域像素（膨胀区域 - 原始蒙版区域）
    # 颜色量化到 16 级（每通道 256/16 = 16 个 bin）
    quantize_factor = 16
    color_counts: dict[tuple[int, int, int], int] = collections.defaultdict(int)
    sample_count = 0

    # 为了性能，对大图进行步进采样
    step = max(1, min(width, height) // 256)

    for y in range(0, height, step):
        for x in range(0, width, step):
            # 环带条件：在膨胀区域内（>128）且不在原始蒙版内（<=128）
            if dilated_pixels[x, y] > 128 and mask_pixels[x, y] <= 128:
                r, g, b = img_pixels[x, y]
                # 量化颜色
                qr = (r // quantize_factor) * quantize_factor
                qg = (g // quantize_factor) * quantize_factor
                qb = (b // quantize_factor) * quantize_factor
                color_counts[(qr, qg, qb)] += 1
                sample_count += 1

    if sample_count == 0:
        return []

    # 按频率降序排列，取 top 3-5
    sorted_colors = sorted(color_counts.items(), key=lambda x: x[1], reverse=True)
    top_n = min(5, len(sorted_colors))

    # 过滤掉占比过低的颜色（< 5%）
    threshold = sample_count * 0.05
    result = []
    for (r, g, b), count in sorted_colors[:top_n]:
        if count >= threshold:
            hex_color = f"#{r:02x}{g:02x}{b:02x}"
            result.append(hex_color)

    # 至少返回 3 个（如果有的话）
    if len(result) < 3 and len(sorted_colors) >= 3:
        for (r, g, b), _ in sorted_colors[:3]:
            hex_color = f"#{r:02x}{g:02x}{b:02x}"
            if hex_color not in result:
                result.append(hex_color)
            if len(result) >= 3:
                break

    return result[:5]
