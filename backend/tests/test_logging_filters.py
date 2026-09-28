import logging

from core.logging_filters import SensitiveQueryFilter, redact_sensitive_query_values


def test_redacts_sensitive_query_values_without_removing_other_parameters():
    redacted = redact_sensitive_query_values(
        "/api/events/stream?token=secret-jwt&client=mobile&access_token=another-secret",
    )

    assert "secret-jwt" not in redacted
    assert "another-secret" not in redacted
    assert "token=[REDACTED]" in redacted
    assert "client=mobile" in redacted


def test_uvicorn_style_log_record_is_redacted():
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1", "GET", "/api/events/stream?token=secret", "1.1", 200),
        exc_info=None,
    )

    assert SensitiveQueryFilter().filter(record)
    assert "secret" not in record.getMessage()
    assert "token=[REDACTED]" in record.getMessage()
