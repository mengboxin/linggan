"""
后端错误报警服务
- 跟踪错误频率（Redis 滑动窗口）
- 达到阈值时发送邮件通知管理员
- 冷却机制防止邮件轰炸
"""
import asyncio
import logging
import time
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, parseaddr
from html import escape

import aiosmtplib

from core.config import settings
from services.emailer import BRAND_NAME, linggan_email_layout

logger = logging.getLogger(__name__)

# ─── 配置 ──────────────────────────────────────────────────────────────────────
ERROR_WINDOW_SECONDS = 300      # 统计窗口：5 分钟
ERROR_THRESHOLD = 10            # 窗口内错误数达此值触发报警
ALERT_COOLDOWN_SECONDS = 600    # 报警冷却：10 分钟内不重复发

_last_alert_ts: float = 0       # 上次发送报警的时间戳


async def record_error(path: str, status_code: int, detail: str = ""):
    """
    记录一次错误请求。在窗口内累计错误数，超阈值时发邮件。
    """
    global _last_alert_ts

    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        return  # 未配置邮件，跳过

    try:
        from core.redis import get_redis
        r = get_redis()
        now = time.time()
        key = "error_alert:window"

        pipe = r.pipeline()
        pipe.zadd(key, {f"{now}:{path}:{status_code}": now})
        pipe.zremrangebyscore(key, 0, now - ERROR_WINDOW_SECONDS)
        pipe.zcard(key)
        pipe.expire(key, ERROR_WINDOW_SECONDS + 60)
        results = await pipe.execute()

        error_count = results[2]

        if error_count >= ERROR_THRESHOLD and (now - _last_alert_ts) > ALERT_COOLDOWN_SECONDS:
            _last_alert_ts = now
            # 异步发送，不阻塞请求
            asyncio.create_task(_send_alert_email(error_count, path, status_code, detail))
    except Exception as e:
        logger.error(f"[ErrorAlert] 记录错误失败: {e}")


def build_error_alert_email_html(
    count: int,
    latest_path: str,
    latest_code: int,
    detail: str,
    *,
    now_str: str | None = None,
) -> str:
    now_str = now_str or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    detail_row = ""
    if detail:
        detail_row = f"""
          <tr><td style="padding:8px 0;color:#777777;">错误详情</td>
            <td style="padding:8px 0;color:#111111;font-weight:600;text-align:right;word-break:break-all;">{escape(detail[:200])}</td></tr>
        """
    body = f"""
      <p style="margin:0 0 22px;">{BRAND_NAME}后端在近 5 分钟内检测到 <strong style="color:#111111;">{count} 次</strong>错误请求，请及时排查。</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5;border:1px solid #d9d9d9;padding:12px 16px;">
        <tr><td style="padding:8px 0;color:#777777;">报警时间</td><td style="padding:8px 0;color:#111111;font-weight:600;text-align:right;">{escape(now_str)}</td></tr>
        <tr><td style="padding:8px 0;color:#777777;">错误数量</td><td style="padding:8px 0;color:#111111;font-weight:700;text-align:right;">{count} 次 / 5 分钟</td></tr>
        <tr><td style="padding:8px 0;color:#777777;">最新错误路径</td><td style="padding:8px 0;color:#111111;font-weight:600;text-align:right;word-break:break-all;">{escape(latest_path)}</td></tr>
        <tr><td style="padding:8px 0;color:#777777;">HTTP 状态码</td><td style="padding:8px 0;color:#111111;font-weight:600;text-align:right;">{latest_code}</td></tr>
        {detail_row}
      </table>
      <p style="margin:22px 0 0;padding:16px;border-left:3px solid #111111;background:#fafafa;color:#444444;font-size:13px;line-height:1.8;">
        建议：检查后端日志、数据库和 Redis 状态；如为预期行为，可忽略此邮件。
      </p>
    """
    return linggan_email_layout(title="系统异常报警", eyebrow="运行监控", body_html=body)


async def _send_alert_email(count: int, latest_path: str, latest_code: int, detail: str):
    """发送错误报警邮件"""
    try:
        subject = f"[{BRAND_NAME}] 系统异常报警 — 近5分钟 {count} 次错误"
        from_addr = parseaddr(settings.SMTP_FROM or settings.SMTP_USER)[1] or settings.SMTP_USER

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = formataddr((f"{BRAND_NAME}监控", from_addr))
        msg["To"] = from_addr  # 发给自己
        msg.attach(MIMEText(build_error_alert_email_html(count, latest_path, latest_code, detail), "html", "utf-8"))

        await aiosmtplib.send(
            msg,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USER,
            password=settings.SMTP_PASSWORD,
            use_tls=settings.SMTP_SSL,
        )
        logger.info(f"[ErrorAlert] 报警邮件已发送: {count} errors in last {ERROR_WINDOW_SECONDS}s")
    except Exception as e:
        logger.error(f"[ErrorAlert] 发送报警邮件失败: {e}")
