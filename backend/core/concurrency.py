"""Small helpers for bounded fan-out inside worker tasks."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import TypeVar

T = TypeVar("T")
R = TypeVar("R")


async def gather_limited(
    items: Iterable[T],
    limit: int,
    fn: Callable[[T], Awaitable[R]],
    *,
    return_exceptions: bool = False,
) -> list[R]:
    """Run async work with a fixed in-process concurrency cap."""

    normalized_limit = max(1, int(limit or 1))
    semaphore = asyncio.Semaphore(normalized_limit)

    async def run_one(item: T):
        async with semaphore:
            return await fn(item)

    return await asyncio.gather(
        *(run_one(item) for item in items),
        return_exceptions=return_exceptions,
    )
