"""Logging filters that prevent credentials in query strings from reaching logs."""
from __future__ import annotations

import logging
import re
from typing import Any


_SENSITIVE_QUERY_PATTERN = re.compile(
    r"(?i)([?&](?:token|access_token|refresh_token|api_key|secret|key)=)([^&\s\"]*)",
)


def redact_sensitive_query_values(value: str) -> str:
    return _SENSITIVE_QUERY_PATTERN.sub(r"\1[REDACTED]", value)


def _redact_arg(value: Any) -> Any:
    return redact_sensitive_query_values(value) if isinstance(value, str) else value


class SensitiveQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_sensitive_query_values(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_arg(value) for value in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _redact_arg(value) for key, value in record.args.items()}
        return True


def install_sensitive_query_filters() -> None:
    for logger_name in ("uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, SensitiveQueryFilter) for item in logger.filters):
            logger.addFilter(SensitiveQueryFilter())
