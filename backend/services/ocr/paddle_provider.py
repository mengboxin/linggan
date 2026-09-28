"""
PaddleOCR Provider — 本地推理主路径

通过 PaddleOCR 库进行本地文字识别，2s 内返回结果。
包含字号估算（基于检测框高度）和主色提取。

Requirements: R3.1, R3.4
"""

import asyncio
import logging
from io import BytesIO
from typing import Optional

from PIL import Image

from services.ocr import FontInfo, OcrResult

logger = logging.getLogger(__name__)

# PaddleOCR 实例延迟初始化（避免导入时加载模型）
_paddle_ocr_instance: Optional[object] = None


def _get_paddle_ocr():
    """
    延迟初始化 PaddleOCR 实例。

    使用 use_angle_cls=True 支持旋转文字，
    lang='ch' 支持中英文混合识别。
    """
    global _paddle_ocr_instance
    if _paddle_ocr_instance is None:
        try:
            from paddleocr import PaddleOCR

            _paddle_ocr_instance = PaddleOCR(
                use_angle_cls=True,
                lang="ch",
                show_log=False,
            )
        except ImportError:
            logger.warning(
                "PaddleOCR 未安装，请执行: pip install paddleocr"
            )
            raise
    return _paddle_ocr_instance


def estimate_font_size(bbox_points: list[list[float]]) -> int:
    """
    根据检测框高度估算字号。

    PaddleOCR 返回的 bbox 是四个角点坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]，
    取左侧两点的垂直距离作为文字高度，近似为字号（pt ≈ px * 0.75）。

    参数:
        bbox_points: 四个角点坐标列表

    返回:
        估算的字号（像素），最小为 8
    """
    if not bbox_points or len(bbox_points) < 4:
        return 16  # 默认字号

    # 取左上和左下两点的垂直距离
    top_left = bbox_points[0]
    bottom_left = bbox_points[3]
    height = abs(bottom_left[1] - top_left[1])

    # 文字高度近似等于字号（像素单位）
    font_size = max(8, int(round(height)))
    return font_size


def extract_dominant_color(image: Image.Image) -> str:
    """
    提取图像中文字的主色调。

    策略：对图像进行颜色量化，排除接近白色/浅色的背景像素，
    取剩余像素中出现频率最高的颜色。

    参数:
        image: PIL Image 对象（RGB 模式）

    返回:
        主色调 hex 值（如 '#000000'）
    """
    if image.mode != "RGB":
        image = image.convert("RGB")

    # 缩小图像加速处理
    small = image.resize((50, 50), Image.LANCZOS)
    pixels = list(small.get_flattened_data())

    if not pixels:
        return "#000000"

    # 过滤掉接近白色的背景像素（亮度 > 200）
    dark_pixels = []
    for r, g, b in pixels:
        brightness = (r + g + b) / 3
        if brightness < 200:
            dark_pixels.append((r, g, b))

    # 如果没有深色像素，说明文字可能是浅色的，取所有像素
    if not dark_pixels:
        dark_pixels = pixels

    if not dark_pixels:
        return "#000000"

    # 量化到 32 级并统计频率
    from collections import Counter

    quantize = 32
    quantized = [
        ((r // quantize) * quantize, (g // quantize) * quantize, (b // quantize) * quantize)
        for r, g, b in dark_pixels
    ]
    counter = Counter(quantized)
    most_common = counter.most_common(1)[0][0]

    return f"#{most_common[0]:02x}{most_common[1]:02x}{most_common[2]:02x}"


class PaddleOcrProvider:
    """
    PaddleOCR 本地推理 Provider。

    特点：
    - 本地推理，零网络延迟
    - 支持中英文混合识别
    - 2s 内返回结果（R3.1）
    - 包含字号估算（基于检测框高度）
    - 包含文字颜色提取
    """

    def __init__(self, timeout: float = 2.0):
        """
        初始化 PaddleOCR Provider。

        参数:
            timeout: 推理超时时间（秒），默认 2s（R3.1 要求）
        """
        self.timeout = timeout

    async def recognize(self, image_bytes: bytes) -> OcrResult:
        """
        使用 PaddleOCR 进行本地文字识别。

        流程:
        1. 解码图像
        2. 在线程池中运行 PaddleOCR 推理（避免阻塞事件循环）
        3. 合并所有检测到的文字行
        4. 计算平均置信度
        5. 估算字号（基于检测框高度）
        6. 提取文字主色调

        参数:
            image_bytes: 图像 PNG bytes

        返回:
            OcrResult 包含识别结果
        """
        try:
            result = await asyncio.wait_for(
                self._run_ocr(image_bytes),
                timeout=self.timeout,
            )
            return result
        except asyncio.TimeoutError:
            logger.warning(f"PaddleOCR 推理超时（>{self.timeout}s）")
            return OcrResult(
                text="",
                confidence=0.0,
                font_info=FontInfo(),
                color_hex="#000000",
            )
        except Exception as e:
            logger.error(f"PaddleOCR 推理失败: {e}")
            return OcrResult(
                text="",
                confidence=0.0,
                font_info=FontInfo(),
                color_hex="#000000",
            )

    async def _run_ocr(self, image_bytes: bytes) -> OcrResult:
        """在线程池中运行 PaddleOCR 推理"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._sync_ocr, image_bytes)

    def _sync_ocr(self, image_bytes: bytes) -> OcrResult:
        """
        同步执行 PaddleOCR 推理。

        在线程池中调用，避免阻塞异步事件循环。
        """
        import numpy as np

        # 解码图像
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        img_array = np.array(image)

        # 运行 PaddleOCR
        ocr = _get_paddle_ocr()
        results = ocr.ocr(img_array, cls=True)

        if not results or not results[0]:
            return OcrResult(
                text="",
                confidence=0.0,
                font_info=FontInfo(),
                color_hex="#000000",
            )

        # 合并所有检测到的文字行
        texts = []
        confidences = []
        font_sizes = []

        for line in results[0]:
            bbox_points = line[0]  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            text_info = line[1]  # (text, confidence)

            text = text_info[0]
            conf = text_info[1]

            texts.append(text)
            confidences.append(conf)
            font_sizes.append(estimate_font_size(bbox_points))

        # 合并文字（多行用换行连接）
        full_text = "\n".join(texts) if len(texts) > 1 else (texts[0] if texts else "")

        # 计算平均置信度
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        # 取中位数字号作为估算值
        estimated_size = sorted(font_sizes)[len(font_sizes) // 2] if font_sizes else 16

        # 提取文字颜色
        color_hex = extract_dominant_color(image)

        return OcrResult(
            text=full_text,
            confidence=avg_confidence,
            font_info=FontInfo(
                family="system-ui",  # PaddleOCR 无法推断字体族
                size=estimated_size,
                weight=400,
                align="left",
            ),
            color_hex=color_hex,
        )
