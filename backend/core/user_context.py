"""Request/task-local user identity for per-user provider routing."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional


_current_user_id: ContextVar[Optional[str]] = ContextVar("current_user_id", default=None)
_current_billing_mode: ContextVar[Optional[str]] = ContextVar("current_billing_mode", default=None)
_current_storage_workspace: ContextVar[str] = ContextVar("current_storage_workspace", default="cloud")


def get_current_user_id() -> Optional[str]:
    return _current_user_id.get()


def get_current_billing_mode() -> Optional[str]:
    return _current_billing_mode.get()


def get_current_storage_workspace() -> str:
    return "local" if _current_storage_workspace.get() == "local" else "cloud"


@contextmanager
def bind_user_context(
    user_id: Optional[str],
    billing_mode: Optional[str] = None,
    storage_workspace: Optional[str] = None,
) -> Iterator[None]:
    user_token = _current_user_id.set(str(user_id) if user_id else None)
    billing_token = _current_billing_mode.set(str(billing_mode) if billing_mode else None)
    workspace_token = _current_storage_workspace.set("local" if storage_workspace == "local" else "cloud")
    try:
        yield
    finally:
        _current_storage_workspace.reset(workspace_token)
        _current_billing_mode.reset(billing_token)
        _current_user_id.reset(user_token)
