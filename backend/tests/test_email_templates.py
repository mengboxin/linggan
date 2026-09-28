from services.emailer import storage_notice_email_html
from services.error_alert import build_error_alert_email_html
from services.otp import build_otp_email_html


def _assert_monochrome_brand_frame(html: str) -> None:
    assert "灵感" in html
    assert "#111111" in html
    assert "#f2f2f2" in html
    assert "gradient" not in html.lower()
    assert "#fdf8f0" not in html.lower()


def test_otp_template_uses_current_brand_and_black_white_style():
    html = build_otp_email_html("12<345", "login", 300)

    _assert_monochrome_brand_frame(html)
    assert "12&lt;345" in html
    assert "登录您的灵感工作区" in html
    assert "5 分钟" in html


def test_error_alert_template_escapes_runtime_details():
    html = build_error_alert_email_html(
        12,
        "/api/<health>",
        500,
        "<script>alert(1)</script>",
        now_str="2026-08-22 12:00:00",
    )

    _assert_monochrome_brand_frame(html)
    assert "/api/&lt;health&gt;" in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "系统异常报警" in html


def test_storage_notice_template_escapes_title_and_action_url():
    html = storage_notice_email_html(
        title="清理 <待处理>",
        body="<p>有一项记录需要处理。</p>",
        action_url="https://example.com/storage?a=1&b=2",
    )

    _assert_monochrome_brand_frame(html)
    assert "清理 &lt;待处理&gt;" in html
    assert "https://example.com/storage?a=1&amp;b=2" in html
    assert "打开存储管理" in html
