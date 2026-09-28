"""图像处理工具函数，无业务逻辑依赖"""
import base64
from io import BytesIO

import httpx
from PIL import Image, ImageChops


def pil_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    buf = BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def bytes_to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def to_png_bytes(image_bytes: bytes) -> tuple[bytes, int, int]:
    """任意格式图片 → PNG bytes，同时返回 (width, height)"""
    img = Image.open(BytesIO(image_bytes)).convert("RGBA")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), img.width, img.height


def invert_alpha(img: Image.Image) -> Image.Image:
    r, g, b, a = img.split()
    return Image.merge("RGBA", (r, g, b, ImageChops.invert(a)))


def apply_inverted_alpha_mask(base: Image.Image, fg: Image.Image) -> Image.Image:
    """用 fg 的反转 alpha 作为 base 的透明度，生成背景层"""
    base = base.convert("RGBA")
    _, _, _, alpha = invert_alpha(fg).split()
    base.putalpha(alpha)
    return base


async def fetch_bytes(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content
