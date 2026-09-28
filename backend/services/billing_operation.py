"""Stable operation identities for replay-safe model billing."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any


_SPACE_RE = re.compile(r"\s+")
_SCOPE_RE = re.compile(r"[^a-zA-Z0-9:_-]+")


def _canonical(value: Any) -> Any:
    """Return a small, deterministic JSON value without retaining binary input."""
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, bytes):
        return {
            "sha256": hashlib.sha256(value).hexdigest(),
            "size": len(value),
        }
    if isinstance(value, str):
        return _SPACE_RE.sub(" ", value).strip()
    if isinstance(value, Mapping):
        return {
            str(key): _canonical(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_canonical(item) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _canonical(model_dump())
    return _SPACE_RE.sub(" ", str(value)).strip()


def model_billing_operation_key(
    *,
    namespace: str,
    user_id: str,
    material: Any,
    operation_scope: str = "",
) -> str | None:
    """Build a user-scoped key that is stable for the same logical request.

    Explicit client/task/conversation scopes are included when available, but
    the request material remains part of the digest. Reusing a client request
    id with different input therefore cannot silently merge two billable calls.
    """
    normalized_namespace = _SCOPE_RE.sub("-", str(namespace or "").strip().lower()).strip("-")
    if not normalized_namespace:
        raise ValueError("model billing operation requires a namespace")
    normalized_scope = str(operation_scope or "").strip()[:200]
    if not normalized_scope:
        # A permanent input-only digest would make a later intentional repeat
        # look settled while still spending another upstream model call.
        return None
    payload = {
        "namespace": normalized_namespace,
        "user_id": str(user_id or "").strip(),
        "operation_scope": normalized_scope,
        "material": _canonical(material),
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"model:{normalized_namespace}:{digest}"
