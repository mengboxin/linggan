"""分割业务逻辑 — 扩展 SAM2 Provider + GroundingDINO 类别打标"""
import uuid
import base64
import asyncio
import os
import hashlib
from io import BytesIO
from typing import Optional, Protocol, runtime_checkable

import httpx
from fastapi import HTTPException
from PIL import Image
from pydantic import BaseModel

from core.config import settings
import repositories.task_repo as task_repo
import repositories.model_repo as model_repo
from services.image_utils import pil_to_base64, bytes_to_base64, to_png_bytes, fetch_bytes
from services.platform_provider_billing import (
    execute_platform_provider_call,
    require_platform_provider_sku,
)


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------

class BBox(BaseModel):
    """包围盒"""
    x: int
    y: int
    w: int
    h: int


class ElementMask(BaseModel):
    """单个语义元素蒙版"""
    id: str
    category: str  # 'person'|'object'|'text'|'background'|'icon'|'shape'
    mask_base64: str  # PNG alpha mask (base64 编码)
    bbox: BBox
    confidence: float


class SegmentationResult(BaseModel):
    """完整分割结果"""
    masks: list[ElementMask]
    width: int
    height: int
    content_hash: str


# ---------------------------------------------------------------------------
# Provider 协议
# ---------------------------------------------------------------------------

VALID_CATEGORIES = {"person", "object", "text", "background", "icon", "shape"}


@runtime_checkable
class SegmentationProvider(Protocol):
    """分割服务 Provider 协议"""

    async def segment(
        self,
        image_bytes: bytes,
        region: Optional[BBox] = None,
        categories: Optional[list[str]] = None,
    ) -> list[ElementMask]: ...


# ---------------------------------------------------------------------------
# 纯工具函数：降采样 / 上采样蒙版
# ---------------------------------------------------------------------------

def downsample_if_needed(
    image_bytes: bytes, max_size: int = 4096
) -> tuple[bytes, tuple[int, int], tuple[int, int], bool]:
    """
    R1.7 降采样：若图像最长边 > max_size，等比缩放至最长边 = max_size。

    返回:
        (处理后的 PNG bytes, 原始尺寸 (w, h), 处理后尺寸 (w, h), 是否进行了缩放)
    """
    img = Image.open(BytesIO(image_bytes)).convert("RGBA")
    original_size = (img.width, img.height)

    max_dim = max(img.width, img.height)
    if max_dim <= max_size:
        # 无需缩放，直接返回 PNG 格式
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), original_size, original_size, False

    # 等比缩放至最长边 = max_size
    scale = max_size / max_dim
    new_w = max(1, int(img.width * scale))
    new_h = max(1, int(img.height * scale))
    img_resized = img.resize((new_w, new_h), Image.LANCZOS)

    buf = BytesIO()
    img_resized.save(buf, format="PNG")
    return buf.getvalue(), original_size, (new_w, new_h), True


def upscale_masks(
    masks_data: list[dict],
    original_size: tuple[int, int],
    downsampled_size: tuple[int, int],
) -> list[dict]:
    """
    将降采样后的蒙版双线性放大回原始尺寸。

    参数:
        masks_data: 蒙版数据列表，每项含 'mask_bytes' (PNG bytes) 和 'bbox' dict
        original_size: (原始宽, 原始高)
        downsampled_size: (降采样后宽, 降采样后高)

    返回:
        放大后的蒙版数据列表（同结构，mask_bytes 和 bbox 已更新）
    """
    if original_size == downsampled_size:
        return masks_data

    orig_w, orig_h = original_size
    ds_w, ds_h = downsampled_size
    scale_x = orig_w / ds_w
    scale_y = orig_h / ds_h

    result = []
    for mask_item in masks_data:
        # 放大蒙版图像（双线性插值）
        mask_img = Image.open(BytesIO(mask_item["mask_bytes"])).convert("L")
        upscaled = mask_img.resize((orig_w, orig_h), Image.BILINEAR)
        buf = BytesIO()
        upscaled.save(buf, format="PNG")

        # 放大 bbox
        bbox = mask_item["bbox"]
        new_bbox = {
            "x": int(bbox["x"] * scale_x),
            "y": int(bbox["y"] * scale_y),
            "w": int(bbox["w"] * scale_x),
            "h": int(bbox["h"] * scale_y),
        }

        result.append({
            "mask_bytes": buf.getvalue(),
            "bbox": new_bbox,
        })

    return result


def compute_content_hash(image_bytes: bytes) -> str:
    """计算图像内容的 SHA-256 哈希"""
    return hashlib.sha256(image_bytes).hexdigest()


def _mask_bytes_to_base64(mask_bytes: bytes) -> str:
    """将蒙版 PNG bytes 转为 base64 字符串"""
    return base64.b64encode(mask_bytes).decode()


def _extract_bbox_from_mask(mask_img: Image.Image) -> BBox:
    """从灰度蒙版图像中提取非零区域的包围盒"""
    # getbbox() 返回 (left, upper, right, lower) 或 None
    bbox_tuple = mask_img.getbbox()
    if bbox_tuple is None:
        return BBox(x=0, y=0, w=mask_img.width, h=mask_img.height)
    left, upper, right, lower = bbox_tuple
    return BBox(x=left, y=upper, w=right - left, h=lower - upper)


# ---------------------------------------------------------------------------
# GroundingDINO 类别打标
# ---------------------------------------------------------------------------


async def classify_mask_with_grounding_dino(
    image_bytes: bytes,
    bbox: BBox,
    candidate_categories: list[str] | None = None,
) -> tuple[str, float]:
    """
    使用 GroundingDINO 对 SAM2 mask 的 bbox 区域做零样本分类。

    参数:
        image_bytes: 原始图像 PNG bytes
        bbox: 蒙版的包围盒
        candidate_categories: 候选类别列表，默认使用全部 VALID_CATEGORIES

    返回:
        (category, confidence)
    """
    categories = candidate_categories or list(VALID_CATEGORIES)
    api_key = settings.GROUNDING_DINO_API_KEY or settings.SAM2_API_KEY or settings.REPLICATE_API_TOKEN
    if not api_key:
        # 无 API key 时返回默认类别
        return "object", 0.5

    # 裁剪 bbox 区域
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    x2 = min(bbox.x + bbox.w, img.width)
    y2 = min(bbox.y + bbox.h, img.height)
    crop = img.crop((bbox.x, bbox.y, x2, y2))

    buf = BytesIO()
    crop.save(buf, format="PNG")
    crop_b64 = base64.b64encode(buf.getvalue()).decode()

    # 构造 GroundingDINO 文本提示（所有候选类别用 . 分隔）
    text_prompt = " . ".join(categories) + " ."

    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }
        payload = {
            "input": {
                "image": f"data:image/png;base64,{crop_b64}",
                "text_prompt": text_prompt,
                "box_threshold": 0.25,
                "text_threshold": 0.25,
            }
        }

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                settings.GROUNDING_DINO_ENDPOINT,
                headers=headers,
                json=payload,
            )
            if resp.status_code >= 400:
                return "object", 0.5

            data = resp.json()
            # 等待预测完成
            prediction_url = (data.get("urls") or {}).get("get")
            for _ in range(30):
                status = data.get("status")
                if status == "succeeded":
                    break
                if status in {"failed", "canceled"}:
                    return "object", 0.5
                if not prediction_url:
                    break
                await asyncio.sleep(1)
                poll = await client.get(
                    prediction_url,
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if poll.status_code >= 400:
                    return "object", 0.5
                data = poll.json()

            # 解析结果：取置信度最高的检测
            output = data.get("output") or data.get("detections") or []
            if isinstance(output, str):
                # 某些模型返回 JSON 字符串
                import json
                try:
                    output = json.loads(output)
                except Exception:
                    output = []

            best_category = "object"
            best_confidence = 0.5

            if isinstance(output, list):
                for det in output:
                    if isinstance(det, dict):
                        label = det.get("label", "").lower().strip()
                        conf = float(det.get("confidence", 0) or det.get("score", 0))
                        # 将检测标签映射到有效类别
                        mapped = _map_label_to_category(label, categories)
                        if mapped and conf > best_confidence:
                            best_category = mapped
                            best_confidence = conf

            return best_category, best_confidence

    except Exception:
        # 网络/解析失败时返回默认
        return "object", 0.5


def _map_label_to_category(label: str, valid: list[str]) -> str | None:
    """将 GroundingDINO 检测标签映射到有效类别"""
    label = label.lower().strip()
    # 直接匹配
    if label in valid:
        return label
    # 模糊匹配
    mapping = {
        "person": ["person", "man", "woman", "people", "human", "face", "body"],
        "text": ["text", "word", "letter", "character", "font", "writing"],
        "icon": ["icon", "logo", "symbol", "emoji", "sticker"],
        "shape": ["shape", "circle", "rectangle", "triangle", "line", "arrow"],
        "background": ["background", "sky", "wall", "floor", "ground", "scene"],
    }
    for category, keywords in mapping.items():
        if category in valid and any(kw in label for kw in keywords):
            return category
    # 未匹配到则归为 object
    if "object" in valid:
        return "object"
    return valid[0] if valid else None


# ---------------------------------------------------------------------------
# GroundingDinoProvider 实现（文本提示分割）
# ---------------------------------------------------------------------------


class GroundingDinoProvider:
    """
    GroundingDINO 文本提示分割 Provider。

    用于 Agent 收到"找出图中所有红色按钮"等指令式分割场景。
    接收 categories 文本提示列表，调用 GroundingDINO API 检测目标区域，
    返回矩形蒙版（GroundingDINO 仅输出 bbox，不输出像素级 mask）。
    """

    def __init__(self):
        self.endpoint = settings.GROUNDING_DINO_ENDPOINT
        self.api_key = (
            settings.GROUNDING_DINO_API_KEY
            or settings.SAM2_API_KEY
            or settings.REPLICATE_API_TOKEN
        )
        self.max_image_size = getattr(settings, "SAM2_MAX_IMAGE_SIZE", 4096)

    async def segment(
        self,
        image_bytes: bytes,
        region: Optional[BBox] = None,
        categories: Optional[list[str]] = None,
    ) -> list[ElementMask]:
        """
        使用 GroundingDINO 执行文本提示分割。

        流程:
        1. 降采样（R1.7）：若图像 > 4096×4096 等比缩放
        2. 构造文本提示：将 categories 用 " . " 连接
        3. 调用 GroundingDINO API
        4. 解析检测结果（bbox + label + confidence）
        5. 为每个检测生成矩形蒙版（bbox 内全白，外全黑）
        6. 若进行了降采样，将 bbox 和蒙版放大回原尺寸
        """
        if not categories or len(categories) == 0:
            raise ValueError("GroundingDinoProvider 需要至少一个 category 文本提示")

        if not self.api_key:
            raise RuntimeError(
                "未配置 GroundingDINO API Key"
                "（GROUNDING_DINO_API_KEY / SAM2_API_KEY / REPLICATE_API_TOKEN）"
            )

        # 步骤 1：降采样
        processed_bytes, original_size, processed_size, was_downsampled = (
            downsample_if_needed(image_bytes, self.max_image_size)
        )

        # 步骤 2：构造文本提示
        text_prompt = self._build_text_prompt(categories)

        # 步骤 3：调用 GroundingDINO API
        detections = await self._call_grounding_dino(processed_bytes, text_prompt)

        # 步骤 4 & 5：为每个检测生成矩形蒙版
        proc_w, proc_h = processed_size
        element_masks: list[ElementMask] = []

        for det in detections:
            label = det.get("label", "").lower().strip()
            confidence = float(det.get("confidence", 0) or det.get("score", 0))
            raw_bbox = det.get("bbox") or det.get("box") or []

            # 解析 bbox（支持 [x1, y1, x2, y2] 或 {x1, y1, x2, y2} 格式）
            bbox = self._parse_detection_bbox(raw_bbox, proc_w, proc_h)
            if bbox is None:
                continue

            # 映射标签到有效类别
            category = _map_label_to_category(label, categories) or label or "object"
            # 如果映射结果不在 VALID_CATEGORIES 中，归为 object
            if category not in VALID_CATEGORIES:
                category = "object"

            # 步骤 6：若进行了降采样，将 bbox 放大回原尺寸
            if was_downsampled:
                scale_x = original_size[0] / processed_size[0]
                scale_y = original_size[1] / processed_size[1]
                final_bbox = BBox(
                    x=int(bbox.x * scale_x),
                    y=int(bbox.y * scale_y),
                    w=int(bbox.w * scale_x),
                    h=int(bbox.h * scale_y),
                )
                mask_w, mask_h = original_size
            else:
                final_bbox = bbox
                mask_w, mask_h = proc_w, proc_h

            # 生成矩形蒙版（bbox 内全白 255，外全黑 0）
            mask_base64 = self._generate_rectangular_mask(
                final_bbox, mask_w, mask_h
            )

            element_masks.append(ElementMask(
                id=str(uuid.uuid4()),
                category=category,
                mask_base64=mask_base64,
                bbox=final_bbox,
                confidence=confidence,
            ))

        return element_masks

    @staticmethod
    def _build_text_prompt(categories: list[str]) -> str:
        """
        构造 GroundingDINO 文本提示。

        格式: "red button . title text . icon ."
        """
        return " . ".join(c.strip() for c in categories if c.strip()) + " ."

    async def _call_grounding_dino(
        self, image_bytes: bytes, text_prompt: str
    ) -> list[dict]:
        """
        调用 GroundingDINO API 执行文本提示检测。

        返回:
            检测结果列表，每项含 'label', 'confidence'/'score', 'bbox'/'box'
        """
        img_b64 = base64.b64encode(image_bytes).decode()

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }

        payload = {
            "input": {
                "image": f"data:image/png;base64,{img_b64}",
                "text_prompt": text_prompt,
                "box_threshold": 0.25,
                "text_threshold": 0.25,
            }
        }

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"GroundingDINO API 调用失败: {resp.status_code} {resp.text[:300]}"
                )

            data = resp.json()

            # 等待预测完成（Replicate 异步模式）
            prediction_url = (data.get("urls") or {}).get("get")
            for _ in range(30):
                status = data.get("status")
                if status == "succeeded":
                    break
                if status in {"failed", "canceled"}:
                    raise RuntimeError(
                        f"GroundingDINO 任务失败: {data.get('error', '未知错误')}"
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
                        f"GroundingDINO 轮询失败: {poll.status_code}"
                    )
                data = poll.json()

        # 解析输出
        output = data.get("output") or data.get("detections") or []
        if isinstance(output, str):
            import json as json_mod
            try:
                output = json_mod.loads(output)
            except Exception:
                output = []

        if not isinstance(output, list):
            return []

        return [det for det in output if isinstance(det, dict)]

    @staticmethod
    def _parse_detection_bbox(
        raw_bbox, img_w: int, img_h: int
    ) -> Optional[BBox]:
        """
        解析检测结果中的 bbox。

        支持格式:
        - [x1, y1, x2, y2] 归一化坐标 (0-1) 或像素坐标
        - {"x1": ..., "y1": ..., "x2": ..., "y2": ...}
        """
        try:
            if isinstance(raw_bbox, dict):
                x1 = float(raw_bbox.get("x1", raw_bbox.get("left", 0)))
                y1 = float(raw_bbox.get("y1", raw_bbox.get("top", 0)))
                x2 = float(raw_bbox.get("x2", raw_bbox.get("right", 0)))
                y2 = float(raw_bbox.get("y2", raw_bbox.get("bottom", 0)))
            elif isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) >= 4:
                x1, y1, x2, y2 = (
                    float(raw_bbox[0]),
                    float(raw_bbox[1]),
                    float(raw_bbox[2]),
                    float(raw_bbox[3]),
                )
            else:
                return None

            # 判断是否为归一化坐标（所有值 <= 1.0）
            if all(0 <= v <= 1.0 for v in [x1, y1, x2, y2]):
                x1 = int(x1 * img_w)
                y1 = int(y1 * img_h)
                x2 = int(x2 * img_w)
                y2 = int(y2 * img_h)
            else:
                x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

            # 确保坐标有效
            x1 = max(0, min(x1, img_w))
            y1 = max(0, min(y1, img_h))
            x2 = max(0, min(x2, img_w))
            y2 = max(0, min(y2, img_h))

            w = x2 - x1
            h = y2 - y1
            if w <= 0 or h <= 0:
                return None

            return BBox(x=x1, y=y1, w=w, h=h)

        except (TypeError, ValueError):
            return None

    @staticmethod
    def _generate_rectangular_mask(
        bbox: BBox, img_w: int, img_h: int
    ) -> str:
        """
        生成矩形蒙版：bbox 区域内全白 (255)，外全黑 (0)。

        GroundingDINO 仅输出 bbox 不输出像素级 mask，
        因此用矩形蒙版近似表示检测区域。
        """
        from PIL import ImageDraw

        mask = Image.new("L", (img_w, img_h), 0)
        draw = ImageDraw.Draw(mask)
        x2 = min(bbox.x + bbox.w, img_w) - 1
        y2 = min(bbox.y + bbox.h, img_h) - 1
        draw.rectangle(
            [max(0, bbox.x), max(0, bbox.y), x2, y2],
            fill=255,
        )

        buf = BytesIO()
        mask.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------
# Sam2Provider 实现
# ---------------------------------------------------------------------------


class Sam2Provider:
    """
    SAM2 语义分割 Provider。

    通过 Replicate API 或自托管 ComfyUI 调用 SAM2 模型。
    模型常驻避免冷启动（Replicate 使用 warm pool / 自托管保持 GPU 常驻）。
    """

    def __init__(self):
        self.endpoint = settings.SAM2_ENDPOINT
        self.api_key = settings.SAM2_API_KEY or settings.REPLICATE_API_TOKEN
        self.max_image_size = settings.SAM2_MAX_IMAGE_SIZE

    async def segment(
        self,
        image_bytes: bytes,
        region: Optional[BBox] = None,
        categories: Optional[list[str]] = None,
    ) -> list[ElementMask]:
        """
        执行 SAM2 自动分割。

        流程:
        1. 降采样（R1.7）：若图像 > 4096×4096 等比缩放
        2. 若指定 region，裁剪子图
        3. 调用 SAM2 API（自动模式，网格 prompt）
        4. 获取蒙版
        5. 若进行了降采样，双线性放大蒙版回原尺寸
        6. 用 GroundingDINO 对每个 mask bbox 做零样本分类
        """
        # 步骤 1：降采样
        processed_bytes, original_size, processed_size, was_downsampled = (
            downsample_if_needed(image_bytes, self.max_image_size)
        )

        # 步骤 2：若指定 region，裁剪子图
        if region:
            img = Image.open(BytesIO(processed_bytes)).convert("RGBA")
            # 将 region 坐标映射到处理后尺寸
            if was_downsampled:
                scale_x = processed_size[0] / original_size[0]
                scale_y = processed_size[1] / original_size[1]
                crop_box = (
                    int(region.x * scale_x),
                    int(region.y * scale_y),
                    int((region.x + region.w) * scale_x),
                    int((region.y + region.h) * scale_y),
                )
            else:
                crop_box = (
                    region.x, region.y,
                    region.x + region.w, region.y + region.h,
                )
            # 确保不越界
            crop_box = (
                max(0, crop_box[0]),
                max(0, crop_box[1]),
                min(img.width, crop_box[2]),
                min(img.height, crop_box[3]),
            )
            cropped = img.crop(crop_box)
            buf = BytesIO()
            cropped.save(buf, format="PNG")
            processed_bytes = buf.getvalue()

        # 步骤 3：调用 SAM2 API
        raw_masks = await self._call_sam2(processed_bytes)

        # 步骤 4 & 5：若进行了降采样，放大蒙版回原尺寸
        if was_downsampled and not region:
            raw_masks = upscale_masks(raw_masks, original_size, processed_size)

        # 步骤 6：用 GroundingDINO 对每个 mask 做类别打标
        # 使用原始图像进行分类（质量更高）
        classify_image = image_bytes
        element_masks: list[ElementMask] = []

        for mask_item in raw_masks:
            mask_bbox = BBox(**mask_item["bbox"])

            # 类别打标
            category, confidence = await classify_mask_with_grounding_dino(
                classify_image, mask_bbox, categories
            )

            element_masks.append(ElementMask(
                id=str(uuid.uuid4()),
                category=category,
                mask_base64=_mask_bytes_to_base64(mask_item["mask_bytes"]),
                bbox=mask_bbox,
                confidence=confidence,
            ))

        return element_masks

    async def _call_sam2(self, image_bytes: bytes) -> list[dict]:
        """
        调用 SAM2 API 执行自动分割（网格 prompt 模式）。

        返回:
            蒙版数据列表，每项含 'mask_bytes' (PNG bytes) 和 'bbox' dict
        """
        if not self.api_key:
            raise RuntimeError("未配置 SAM2 API Key（SAM2_API_KEY 或 REPLICATE_API_TOKEN）")

        img_b64 = base64.b64encode(image_bytes).decode()

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }

        # SAM2 自动模式：使用网格点作为 prompt 实现全图分割
        payload = {
            "input": {
                "image": f"data:image/png;base64,{img_b64}",
                "use_m2m": True,
                "multimask_output": True,
                "points_per_side": 32,
            }
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                self.endpoint, headers=headers, json=payload
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"SAM2 API 调用失败: {resp.status_code} {resp.text[:300]}"
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
                        f"SAM2 任务失败: {data.get('error', '未知错误')}"
                    )
                if not prediction_url:
                    break
                await asyncio.sleep(2)
                poll = await client.get(
                    prediction_url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                if poll.status_code >= 400:
                    raise RuntimeError(f"SAM2 轮询失败: {poll.status_code}")
                data = poll.json()

        # 解析 SAM2 输出为蒙版列表
        return await self._parse_sam2_output(data, image_bytes)

    async def _parse_sam2_output(
        self, data: dict, source_image_bytes: bytes
    ) -> list[dict]:
        """
        解析 SAM2 API 返回的输出为标准蒙版格式。

        SAM2 输出格式可能为:
        - output: list[str]  (蒙版图像 URL 列表)
        - output: dict with 'masks' key
        - combined_mask + individual_masks
        """
        output = data.get("output") or {}
        masks_result = []

        # 获取源图像尺寸用于 bbox 计算
        src_img = Image.open(BytesIO(source_image_bytes))
        img_w, img_h = src_img.width, src_img.height

        # 处理不同输出格式
        mask_urls = []
        if isinstance(output, list):
            mask_urls = [u for u in output if isinstance(u, str)]
        elif isinstance(output, dict):
            # 某些 SAM2 模型返回 combined_mask + individual masks
            individual = output.get("individual_masks") or output.get("masks") or []
            if isinstance(individual, list):
                mask_urls = [u for u in individual if isinstance(u, str)]
            elif isinstance(output.get("combined_mask"), str):
                mask_urls = [output["combined_mask"]]

        for url in mask_urls:
            try:
                if url.startswith("data:image"):
                    mask_data = base64.b64decode(url.split(",", 1)[1])
                else:
                    mask_data = await fetch_bytes(url)

                mask_img = Image.open(BytesIO(mask_data)).convert("L")
                # 确保蒙版与源图像尺寸一致
                if mask_img.size != (img_w, img_h):
                    mask_img = mask_img.resize((img_w, img_h), Image.BILINEAR)

                bbox = _extract_bbox_from_mask(mask_img)

                buf = BytesIO()
                mask_img.save(buf, format="PNG")

                masks_result.append({
                    "mask_bytes": buf.getvalue(),
                    "bbox": bbox.model_dump(),
                })
            except Exception as e:
                print(f"[SAM2] 解析蒙版失败: {e}")
                continue

        return masks_result


# ---------------------------------------------------------------------------
# 原有业务函数（保持向后兼容）
# ---------------------------------------------------------------------------


async def run_segmentation(task_id: str, image_bytes: bytes, params: dict):
    """已废弃：Gradio 分层接口已移除，请使用 run_replicate_layering"""
    raise NotImplementedError("Qwen Gradio 分层接口已废弃，请使用 Replicate 分层")


async def run_replicate_layering(
    task_id: str,
    image_bytes: bytes,
    params: dict,
    user_id: str = "",
    billing_model_id: str = "",
):
    try:
        model_id = billing_model_id or str(params.get("billing_model_id") or params.get("model_id") or "")
        sku = await require_platform_provider_sku(
            user_id=user_id,
            model_id=model_id,
            expected_category="segmentation",
            description="Replicate image layering",
        )
        task = await task_repo.get(task_id)
        if sku is not None and float((task or {}).get("_cost") or 0) <= 0:
            raise HTTPException(503, "Replicate layering task has no platform credit quote")
        await task_repo.set_processing(task_id, 10)

        png_bytes, width, height = to_png_bytes(image_bytes)
        png_b64 = bytes_to_base64(png_bytes)
        await task_repo.set_progress(task_id, 20)

        model = await model_repo.get_model_internal(model_id) if model_id else None
        meta = (model or {}).get("meta") or {}
        endpoint = (
            (model or {}).get("endpoint")
            or meta.get("model")
            or "qwen/qwen-image-layered"
        )
        token = (
            (model or {}).get("api_key")
            or os.getenv("REPLICATE_API_TOKEN", "")
        )
        if not token:
            raise RuntimeError("未配置 Replicate API Token")

        owner_name = str(endpoint).strip()
        if owner_name.startswith("https://api.replicate.com/v1/models/"):
            owner_name = owner_name.split("/models/", 1)[1].split(
                "/predictions", 1
            )[0]
        owner_name = owner_name.strip("/")
        if "/" not in owner_name:
            owner_name = "qwen/qwen-image-layered"

        try:
            seed_int = int(params.get("seed") or 0)
        except Exception:
            seed_int = 0

        input_payload = {
            "image": f"data:image/png;base64,{png_b64}",
            "go_fast": bool(params.get("go_fast", True)),
            "num_layers": max(
                2, min(int(params.get("num_layers", 4) or 4), 8)
            ),
            "description": str(params.get("description") or "auto"),
            "output_format": str(
                params.get("output_format") or "webp"
            ).lower(),
            "output_quality": max(
                0, min(int(params.get("output_quality", 95) or 95), 100)
            ),
        }
        if seed_int:
            input_payload["seed"] = seed_int
        if bool(params.get("disable_safety_checker", False)):
            input_payload["disable_safety_checker"] = True

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "wait",
        }
        url = f"https://api.replicate.com/v1/models/{owner_name}/predictions"

        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                url, headers=headers, json={"input": input_payload}
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"Replicate 调用失败: {resp.status_code} {resp.text[:300]}"
                )
            data = resp.json()
            prediction_url = (data.get("urls") or {}).get("get")

            for i in range(120):
                status = data.get("status")
                if status == "succeeded":
                    break
                if status in {"failed", "canceled"}:
                    raise RuntimeError(
                        f"Replicate 任务失败: {data.get('error')}"
                    )
                if not prediction_url:
                    break
                await task_repo.set_progress(
                    task_id, min(76, 24 + int((i + 1) / 120 * 52))
                )
                await asyncio.sleep(2)
                poll = await client.get(
                    prediction_url,
                    headers={"Authorization": f"Bearer {token}"},
                )
                poll.raise_for_status()
                data = poll.json()

        output = data.get("output") or []
        if isinstance(output, str):
            output = [output]
        if not isinstance(output, list):
            raise RuntimeError("Replicate 输出格式无法识别")

        await task_repo.set_progress(task_id, 82)
        layers = await _parse_layers({"data": output}, width, height)
        await task_repo.set_completed(task_id, {"layers": layers})
    except Exception as e:
        print(f"[segmentation] Replicate 任务 {task_id} 失败: {e}")
        await task_repo.set_failed(task_id, str(e))


async def _parse_layers(
    result_data: dict, width: int, height: int
) -> list[dict]:
    layers, images = [], []
    for item in result_data.get("data", []):
        if isinstance(item, list):
            images.extend(item)
        elif isinstance(item, str) and (
            item.startswith("data:image") or item.startswith("http")
        ):
            images.append(item)
        elif isinstance(item, dict) and "url" in item:
            images.append(item["url"])

    for i, src in enumerate(images):
        try:
            if src.startswith("data:image"):
                img_bytes = base64.b64decode(src.split(",", 1)[1])
            else:
                img_bytes = await fetch_bytes(src)
            pil = Image.open(BytesIO(img_bytes)).convert("RGBA")
            layers.append(
                {
                    "id": str(uuid.uuid4()),
                    "name": f"图层 {i + 1}",
                    "imageBase64": pil_to_base64(pil),
                    "boundingBox": {
                        "x": 0,
                        "y": 0,
                        "width": width,
                        "height": height,
                    },
                }
            )
        except Exception as e:
            print(f"[segmentation] 解析图层 {i} 失败: {e}")

    return layers


# ---------------------------------------------------------------------------
# SAM2 分割任务入口（供 worker 调用）
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 跨设备 Redis + PG 缓存层（R12.3, R12.4）
# ---------------------------------------------------------------------------

# Redis 缓存 TTL：7 天
SEG_CACHE_TTL = 604800

# LRU 淘汰：PG 表最大保留条目数
SEG_CACHE_MAX_PG_ENTRIES = 500


async def cache_segmentation_result(
    content_hash: str,
    result: SegmentationResult,
    user_id: str | None = None,
) -> None:
    """
    将分割结果写入 Redis 缓存 + PG 持久化。

    - Redis key: seg:hash:{content_hash}，TTL 7 天
    - PG segmentation_cache 表：upsert，更新 last_accessed_at
    """
    import json as json_mod
    from core.redis import get_redis
    from core.pool import acquire

    result_json = result.model_dump()
    result_str = json_mod.dumps(result_json, ensure_ascii=False)

    # 写入 Redis
    try:
        redis = get_redis()
        cache_key = f"seg:hash:{content_hash}"
        await redis.setex(cache_key, SEG_CACHE_TTL, result_str)
    except Exception as e:
        print(f"[cache] Redis 写入失败: {e}")

    # 写入 PG（upsert：存在则更新 last_accessed_at 和 masks）
    try:
        masks_json = json_mod.dumps(
            [m.model_dump() for m in result.masks], ensure_ascii=False
        )
        async with acquire() as conn:
            await conn.execute(
                """
                INSERT INTO segmentation_cache
                    (content_hash, user_id, masks_jsonb, width, height, last_accessed_at, access_count)
                VALUES ($1, $2, $3::jsonb, $4, $5, NOW(), 1)
                ON CONFLICT (content_hash) DO UPDATE SET
                    masks_jsonb = EXCLUDED.masks_jsonb,
                    width = EXCLUDED.width,
                    height = EXCLUDED.height,
                    last_accessed_at = NOW(),
                    access_count = segmentation_cache.access_count + 1
                """,
                content_hash,
                user_id,
                masks_json,
                result.width,
                result.height,
            )
    except Exception as e:
        print(f"[cache] PG 写入失败: {e}")


async def get_cached_segmentation(content_hash: str) -> SegmentationResult | None:
    """
    从 Redis 或 PG 读取缓存的分割结果。

    优先查 Redis，未命中则查 PG 并回写 Redis（write-through）。
    """
    import json as json_mod
    from core.redis import get_redis
    from core.pool import acquire

    # 1. 查 Redis
    try:
        redis = get_redis()
        cache_key = f"seg:hash:{content_hash}"
        cached = await redis.get(cache_key)
        if cached:
            data = json_mod.loads(cached)
            return SegmentationResult(**data)
    except Exception as e:
        print(f"[cache] Redis 读取失败: {e}")

    # 2. 查 PG
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT masks_jsonb, width, height
                FROM segmentation_cache
                WHERE content_hash = $1
                """,
                content_hash,
            )
            if row is None:
                return None

            # 更新 last_accessed_at
            await conn.execute(
                """
                UPDATE segmentation_cache
                SET last_accessed_at = NOW(), access_count = access_count + 1
                WHERE content_hash = $1
                """,
                content_hash,
            )

        # 解析 PG 数据
        masks_data = json_mod.loads(row["masks_jsonb"]) if isinstance(row["masks_jsonb"], str) else row["masks_jsonb"]
        masks = [ElementMask(**m) for m in masks_data]
        result = SegmentationResult(
            masks=masks,
            width=row["width"],
            height=row["height"],
            content_hash=content_hash,
        )

        # 回写 Redis（write-through）
        try:
            redis = get_redis()
            cache_key = f"seg:hash:{content_hash}"
            result_str = json_mod.dumps(result.model_dump(), ensure_ascii=False)
            await redis.setex(cache_key, SEG_CACHE_TTL, result_str)
        except Exception as e:
            print(f"[cache] Redis 回写失败: {e}")

        return result

    except Exception as e:
        print(f"[cache] PG 读取失败: {e}")
        return None


async def evict_lru_cache_entries(max_entries: int = SEG_CACHE_MAX_PG_ENTRIES) -> int:
    """
    启动时按 last_accessed_at LRU 淘汰超出上限的 PG 缓存条目。

    返回被淘汰的条目数。
    """
    from core.pool import acquire

    try:
        async with acquire() as conn:
            # 删除超出 max_entries 的最旧条目
            result = await conn.execute(
                """
                DELETE FROM segmentation_cache
                WHERE content_hash IN (
                    SELECT content_hash FROM segmentation_cache
                    ORDER BY last_accessed_at ASC
                    OFFSET $1
                )
                """,
                max_entries,
            )
            # 解析删除行数（格式: "DELETE N"）
            deleted = int(result.split()[-1]) if result else 0
            if deleted > 0:
                print(f"[cache] LRU 淘汰了 {deleted} 条 PG 缓存条目")
            return deleted
    except Exception as e:
        print(f"[cache] LRU 淘汰失败: {e}")
        return 0


# ---------------------------------------------------------------------------
# SAM2 分割任务入口
# ---------------------------------------------------------------------------


async def run_sam2_segmentation(
    task_id: str,
    image_bytes: bytes,
    params: dict,
    user_id: str = "",
    billing_model_id: str = "",
):
    """SAM2 分割任务入口，供 worker 调用"""
    try:
        await task_repo.set_processing(task_id, 10)

        # 计算内容哈希
        content_hash = compute_content_hash(image_bytes)

        # 先检查缓存（Redis → PG）
        cached_result = await get_cached_segmentation(content_hash)
        if cached_result:
            await task_repo.set_progress(task_id, 90)
            await task_repo.set_completed(
                task_id, {"segmentation": cached_result.model_dump()}
            )
            return

        provider = Sam2Provider()

        # 解析可选参数
        region = None
        if params.get("region"):
            region = BBox(**params["region"])

        categories = params.get("categories")

        await task_repo.set_progress(task_id, 20)

        # 执行分割
        model_id = billing_model_id or "segmentation-sam2-grounding-dino"
        element_masks = await execute_platform_provider_call(
            user_id=user_id,
            model_id=model_id,
            expected_category="segmentation",
            description="SAM2 and GroundingDINO partial segmentation",
            related_task_id=None,
            reservation_task_id=task_id,
            idempotency_key=f"task:{task_id}:provider:{model_id}:segment",
            invoke=lambda: provider.segment(
                image_bytes,
                region=region,
                categories=categories,
            ),
        )

        await task_repo.set_progress(task_id, 80)

        # 构造结果
        _, width, height = to_png_bytes(image_bytes)
        result = SegmentationResult(
            masks=element_masks,
            width=width,
            height=height,
            content_hash=content_hash,
        )

        # 写入缓存（Redis + PG）
        await cache_segmentation_result(content_hash, result)

        await task_repo.set_completed(
            task_id, {"segmentation": result.model_dump()}
        )

    except Exception as e:
        print(f"[SAM2 segmentation] 任务 {task_id} 失败: {e}")
        await task_repo.set_failed(task_id, str(e))
