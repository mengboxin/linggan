"""
图形验证码：生成 base64 图片，验证码存 Redis（5分钟过期）
key 规则：captcha:{captcha_id} → 验证码文本
"""
import base64
import random
import string
import uuid
from io import BytesIO

from captcha.image import ImageCaptcha

from core.redis import get_redis

_EXPIRE = 300  # 5分钟
_generator = ImageCaptcha(width=120, height=44, font_sizes=(28, 32, 36))


def _gen_text() -> str:
    chars = string.ascii_uppercase + string.digits
    # 去掉容易混淆的字符
    for c in "0O1ILl":
        chars = chars.replace(c, "")
    return "".join(random.choices(chars, k=4))


async def create_captcha() -> tuple[str, str]:
    """生成验证码，返回 (captcha_id, base64_png_data_url)"""
    text = _gen_text()
    buf = BytesIO()
    _generator.write(text, buf)
    b64 = base64.b64encode(buf.getvalue()).decode()

    captcha_id = str(uuid.uuid4())
    r = get_redis()
    await r.set(f"captcha:{captcha_id}", text.upper(), ex=_EXPIRE)

    return captcha_id, f"data:image/png;base64,{b64}"


async def verify_captcha(captcha_id: str, user_input: str) -> bool:
    """验证并删除（兼容 Redis < 6.2）"""
    r = get_redis()
    key = f"captcha:{captcha_id}"
    stored = await r.get(key)
    if not stored:
        return False
    await r.delete(key)   # 无论对错都删，防重放
    return stored == user_input.strip().upper()
