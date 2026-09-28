"""Persistent, credential-free audit records for unified model calls."""
from __future__ import annotations

from typing import Optional

from core.pool import acquire


async def record_model_call(
    *,
    user_id: Optional[str],
    billing_mode: str,
    model_id: str,
    model_name: str,
    model_category: str,
    provider: str,
    success: bool,
    duration_ms: int,
    error_message: str = "",
) -> None:
    """Store one completed upstream request without any request payload data."""
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO model_call_logs (
                user_id, billing_mode, model_id, model_name, model_category,
                provider, success, duration_ms, error_message
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            user_id or None,
            str(billing_mode or "platform_credits"),
            str(model_id or "unknown"),
            str(model_name or model_id or "unknown"),
            str(model_category or "other"),
            str(provider or ""),
            bool(success),
            max(0, int(duration_ms or 0)),
            str(error_message or "")[:500] or None,
        )
