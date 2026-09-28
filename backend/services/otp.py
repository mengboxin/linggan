"""
验证码管理 + 邮件发送
验证码存 Redis，5分钟过期，同一邮箱60秒内不能重复发送
key 规则：
  otp:{purpose}:{email}  → 验证码
  otp:cd:{email}         → 冷却标记（60s TTL）
"""
import random
import string
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, parseaddr
from html import escape

import aiosmtplib

from core.config import settings
from core.redis import get_redis
from services.emailer import BRAND_NAME, linggan_email_layout


def _generate_code(length: int = 6) -> str:
    return "".join(random.choices(string.digits, k=length))


async def create_otp(email: str, purpose: str) -> tuple[str, int]:
    """生成验证码写入 Redis，返回 (code, wait_seconds)。"""
    r = get_redis()
    cd_key = f"otp:cd:{email}"
    ttl = await r.ttl(cd_key)
    if ttl > 0:
        return "", ttl

    code = _generate_code()
    otp_key = f"otp:{purpose}:{email}"
    pipe = r.pipeline()
    pipe.set(otp_key, code, ex=settings.OTP_EXPIRE_SECONDS)
    pipe.set(cd_key, "1", ex=60)
    await pipe.execute()
    return code, 0


async def verify_otp(email: str, code: str, purpose: str) -> bool:
    """验证并原子删除验证码。"""
    if not await check_otp(email, code, purpose):
        return False
    return await consume_otp(email, code, purpose)


async def check_otp(email: str, code: str, purpose: str) -> bool:
    """Validate an OTP without consuming it while durable side effects are prepared."""
    r = get_redis()
    stored = await r.get(f"otp:{purpose}:{email}")
    if not stored:
        return False
    return stored == code.strip()


async def consume_otp(email: str, code: str, purpose: str) -> bool:
    """Delete the OTP only if it still matches, atomically preventing replay."""
    r = get_redis()
    deleted = await r.eval(
        """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
        """,
        1,
        f"otp:{purpose}:{email}",
        code.strip(),
    )
    return bool(deleted)


def build_otp_email_html(code: str, purpose: str, expire_seconds: int) -> str:
    title_map = {
        "register": "创建您的灵感账号",
        "login": "登录您的灵感工作区",
        "reset": "重置您的账号密码",
    }
    action_map = {
        "register": "完成注册",
        "login": "完成登录",
        "reset": "重置密码",
    }
    title = title_map.get(purpose, "验证您的邮箱")
    action = action_map.get(purpose, "继续操作")
    expire_minutes = max(1, expire_seconds // 60)
    body = f"""
      <p style="margin:0 0 24px;">请使用下方验证码{action}。验证码仅用于本次安全验证。</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
        <tr><td align="center" style="padding:22px 16px;background:#f5f5f5;border:1px solid #d9d9d9;color:#111111;font-size:38px;line-height:1;font-weight:700;letter-spacing:10px;font-family:Arial,'Microsoft YaHei',sans-serif;">
          {escape(code)}
        </td></tr>
      </table>
      <p style="margin:0;color:#555555;font-size:13px;line-height:1.8;">验证码 <strong style="color:#111111;">{expire_minutes} 分钟</strong>内有效，请勿泄露给他人。</p>
      <p style="margin:8px 0 0;color:#777777;font-size:12px;line-height:1.8;">如非本人操作，请忽略此邮件。</p>
    """
    return linggan_email_layout(title=title, eyebrow="安全验证", body_html=body)


async def send_otp_email(email: str, code: str, purpose: str):
    """发送验证码邮件。"""
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        print(f"\n📧 [开发模式] 验证码 → {email}: {code}  (用途: {purpose})\n")
        return

    from_addr = parseaddr(settings.SMTP_FROM or settings.SMTP_USER)[1] or settings.SMTP_USER
    subject_map = {
        "register": f"{BRAND_NAME} 注册验证码",
        "login": f"{BRAND_NAME} 登录验证码",
        "reset": f"{BRAND_NAME} 重置密码验证码",
    }
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject_map.get(purpose, f"{BRAND_NAME} 验证码")
    msg["From"] = formataddr((str(Header(BRAND_NAME, "utf-8")), from_addr))
    msg["To"] = email
    msg.attach(MIMEText(build_otp_email_html(code, purpose, settings.OTP_EXPIRE_SECONDS), "html", "utf-8"))

    await aiosmtplib.send(
        msg,
        hostname=settings.SMTP_HOST,
        port=settings.SMTP_PORT,
        username=settings.SMTP_USER,
        password=settings.SMTP_PASSWORD,
        use_tls=settings.SMTP_SSL,
    )
