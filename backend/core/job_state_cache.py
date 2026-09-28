"""Bounded, process-local fallback storage for Redis-backed job state.

This cache is deliberately a last-resort bridge during a Redis outage.  It is
not a second durable store: callers should write to it only after a Redis
operation fails and remove the local value after Redis succeeds again.
"""
from __future__ import annotations

from collections import OrderedDict
import json
import logging
import time
from typing import Any, Callable, Iterator, MutableMapping

logger = logging.getLogger(__name__)


class BoundedJobStateCache(MutableMapping[str, dict]):
    """LRU cache with TTL and a best-effort serialized-size budget.

    States remain mutable dictionaries because several in-flight workflows
    update the object returned by ``get`` before persisting it again.  The byte
    accounting therefore reflects the state size when it was inserted; the
    next fallback write refreshes that accounting.
    """

    def __init__(
        self,
        *,
        max_entries: int,
        ttl_seconds: int,
        max_bytes: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_entries = max(0, int(max_entries))
        self._ttl_seconds = max(0, int(ttl_seconds))
        self._max_bytes = max(0, int(max_bytes))
        self._clock = clock
        self._entries: OrderedDict[str, tuple[float, int, dict]] = OrderedDict()
        self._total_bytes = 0

    def _purge_expired(self) -> None:
        if self._ttl_seconds <= 0:
            self.clear()
            return
        now = self._clock()
        expired = [
            key
            for key, (created_at, _, _) in self._entries.items()
            if now - created_at >= self._ttl_seconds
        ]
        for key in expired:
            self._remove(key)

    def _remove(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        if entry is not None:
            self._total_bytes -= entry[1]

    @staticmethod
    def _serialized_size(state: dict) -> int | None:
        try:
            payload = json.dumps(
                state,
                ensure_ascii=False,
                default=str,
                separators=(",", ":"),
            )
            return len(payload.encode("utf-8"))
        except Exception:
            # A state that cannot be represented as JSON could not have been
            # persisted to Redis either. Do not keep an unmeasurable object in
            # the fallback cache because that would bypass its byte budget.
            return None

    def set(self, key: str, state: dict) -> bool:
        """Store a fallback state, returning False when its budget rejects it."""
        self._purge_expired()
        if self._max_entries <= 0 or self._ttl_seconds <= 0 or self._max_bytes <= 0:
            return False

        size = self._serialized_size(state)
        if size is None:
            logger.warning("job-state fallback skipped key=%s reason=unmeasurable-state", key)
            return False
        if size > self._max_bytes:
            logger.warning(
                "job-state fallback skipped key=%s size=%s cap=%s",
                key,
                size,
                self._max_bytes,
            )
            return False

        self._remove(key)
        while self._entries and (
            len(self._entries) >= self._max_entries
            or self._total_bytes + size > self._max_bytes
        ):
            oldest_key = next(iter(self._entries))
            self._remove(oldest_key)

        self._entries[key] = (self._clock(), size, state)
        self._total_bytes += size
        return True

    def get(self, key: str, default: Any = None) -> dict | Any:
        self._purge_expired()
        entry = self._entries.get(key)
        if entry is None:
            return default
        self._entries.move_to_end(key)
        return entry[2]

    def discard(self, key: str) -> None:
        self._purge_expired()
        self._remove(key)

    @property
    def total_bytes(self) -> int:
        self._purge_expired()
        return self._total_bytes

    def __getitem__(self, key: str) -> dict:
        sentinel = object()
        value = self.get(key, sentinel)
        if value is sentinel:
            raise KeyError(key)
        return value

    def __setitem__(self, key: str, value: dict) -> None:
        self.set(key, value)

    def __delitem__(self, key: str) -> None:
        self._purge_expired()
        if key not in self._entries:
            raise KeyError(key)
        self._remove(key)

    def __iter__(self) -> Iterator[str]:
        self._purge_expired()
        return iter(tuple(self._entries))

    def __len__(self) -> int:
        self._purge_expired()
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()
        self._total_bytes = 0
