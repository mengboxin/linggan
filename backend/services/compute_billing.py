"""Shared billing-mode constants for platform, FoxAPI, and Grok channels."""
from __future__ import annotations

from typing import Optional

PLATFORM_BILLING_MODE = "platform_credits"
FOXAPI_BILLING_MODE = "external_api_key"
GROK_BILLING_MODE = "grok_api_key"

ALL_BILLING_MODES = frozenset({
    PLATFORM_BILLING_MODE,
    FOXAPI_BILLING_MODE,
    GROK_BILLING_MODE,
})
EXTERNAL_BILLING_MODES = frozenset({
    FOXAPI_BILLING_MODE,
    GROK_BILLING_MODE,
})


def normalize_billing_mode(value: object) -> Optional[str]:
    mode = str(value or "").strip()
    return mode if mode in ALL_BILLING_MODES else None


def is_external_billing_mode(value: object) -> bool:
    return str(value or "").strip() in EXTERNAL_BILLING_MODES
