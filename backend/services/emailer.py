from __future__ import annotations

from html import escape
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, parseaddr

from core.config import settings

BRAND_NAME = "灵感"
BRAND_DESCRIPTOR = "创作工作区"


def linggan_email_layout(*, title: str, body_html: str, eyebrow: str = "") -> str:
    """Render the shared monochrome email frame used by product messages."""
    eyebrow_html = (
        f'<p style="margin:0 0 12px;color:#666666;font-size:11px;line-height:1.4;letter-spacing:1.5px;">'
        f"{escape(eyebrow.upper())}</p>"
        if eyebrow
        else ""
    )
    return f"""
    <!doctype html>
    <html lang="zh-CN">
      <body style="margin:0;padding:0;background:#f2f2f2;color:#111111;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{escape(title)}</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
          style="background:#f2f2f2;padding:32px 16px;font-family:Arial,'Microsoft YaHei',sans-serif;">
          <tr><td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
              style="max-width:560px;background:#ffffff;border:1px solid #d9d9d9;">
              <tr><td style="height:6px;background:#111111;font-size:0;line-height:0;">&nbsp;</td></tr>
              <tr><td style="padding:24px 32px;border-bottom:1px solid #e5e5e5;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="width:38px;">
                      <div style="width:32px;height:32px;background:#111111;color:#ffffff;font-size:17px;line-height:32px;text-align:center;font-weight:700;">灵</div>
                    </td>
                    <td style="padding-left:10px;color:#111111;font-size:16px;line-height:1.3;font-weight:700;">
                      {BRAND_NAME}
                      <span style="color:#888888;font-size:12px;font-weight:400;"> / {BRAND_DESCRIPTOR}</span>
                    </td>
                  </tr>
                </table>
              </td></tr>
              <tr><td style="padding:34px 32px 36px;">
                {eyebrow_html}
                <h1 style="margin:0 0 14px;color:#111111;font-size:24px;line-height:1.35;font-weight:700;">{escape(title)}</h1>
                <div style="color:#444444;font-size:14px;line-height:1.8;">{body_html}</div>
              </td></tr>
              <tr><td style="padding:16px 32px;border-top:1px solid #e5e5e5;color:#888888;font-size:12px;line-height:1.7;">
                {BRAND_NAME} · {BRAND_DESCRIPTOR}<br />
                这是一封系统邮件，请勿直接回复。
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
    """


async def send_html_email(to_email: str, subject: str, html: str) -> bool:
    if not to_email:
        return False
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        print(f"[email:dev] to={to_email} subject={subject}\n{html[:500]}\n")
        return False
    import aiosmtplib

    from_addr = parseaddr(settings.SMTP_FROM or settings.SMTP_USER)[1] or settings.SMTP_USER
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((str(Header(BRAND_NAME, "utf-8")), from_addr))
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html", "utf-8"))

    await aiosmtplib.send(
        msg,
        hostname=settings.SMTP_HOST,
        port=settings.SMTP_PORT,
        username=settings.SMTP_USER,
        password=settings.SMTP_PASSWORD,
        use_tls=settings.SMTP_SSL,
    )
    return True


def storage_notice_email_html(*, title: str, body: str, action_url: str = "") -> str:
    button = ""
    if action_url:
        safe_action_url = escape(action_url, quote=True)
        button = f"""
        <p style="margin:26px 0 0;">
          <a href="{safe_action_url}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 18px;font-weight:700;">
            打开存储管理
          </a>
        </p>
        """
    content = f"""
      {body}
      {button}
      <p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #e5e5e5;color:#777777;font-size:12px;line-height:1.8;">
        网页端云端历史会定期清理。需要长期保存的内容，建议及时下载或保存到桌面端。
      </p>
    """
    return linggan_email_layout(title=title, eyebrow="存储提醒", body_html=content)
