"""Safely reclaim old Redis Stream records that every consumer group has ACKed.

The queue now removes terminal entries atomically. This command is only for
records written before that behaviour was deployed. It never deletes pending
or undispatched entries, and defaults to a dry run.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


DEFAULT_STREAMS = ("queue:high", "queue:normal", "queue:low", "queue:image2")

# Recheck all current consumer groups inside Redis immediately before XDEL.
# This closes the race between scanning the stream and an active worker reading
# its next entry.
_DELETE_ACKNOWLEDGED_SCRIPT = """
local function value_for(info, wanted)
    for index = 1, #info, 2 do
        if info[index] == wanted then
            return info[index + 1]
        end
    end
    return nil
end

local function delivered_before_or_at(candidate, last_delivered)
    local candidate_ms, candidate_seq = string.match(candidate, '^(%d+)%-(%d+)$')
    local delivered_ms, delivered_seq = string.match(last_delivered or '', '^(%d+)%-(%d+)$')
    if not candidate_ms or not delivered_ms then
        return false
    end
    candidate_ms = tonumber(candidate_ms)
    candidate_seq = tonumber(candidate_seq)
    delivered_ms = tonumber(delivered_ms)
    delivered_seq = tonumber(delivered_seq)
    return candidate_ms < delivered_ms or (candidate_ms == delivered_ms and candidate_seq <= delivered_seq)
end

local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
if #groups == 0 then
    return 0
end

local deleted = 0
for _, candidate in ipairs(ARGV) do
    local safe_to_delete = true
    for _, group_info in ipairs(groups) do
        local group = value_for(group_info, 'name')
        local last_delivered = value_for(group_info, 'last-delivered-id')
        if not group or not delivered_before_or_at(candidate, last_delivered) then
            safe_to_delete = false
            break
        end
        local pending = redis.call('XPENDING', KEYS[1], group, candidate, candidate, 1)
        if #pending > 0 then
            safe_to_delete = false
            break
        end
    end
    if safe_to_delete then
        deleted = deleted + redis.call('XDEL', KEYS[1], candidate)
    end
end
return deleted
"""


def _stream_id_key(value: object) -> tuple[int, int] | None:
    try:
        milliseconds, sequence = str(value).split("-", 1)
        return int(milliseconds), int(sequence)
    except (AttributeError, TypeError, ValueError):
        return None


def _group_cutoff(groups: Iterable[dict[str, Any]]) -> str | None:
    delivered: list[tuple[tuple[int, int], str]] = []
    for group in groups:
        value = str(group.get("last-delivered-id") or "")
        sort_key = _stream_id_key(value)
        if sort_key is not None:
            delivered.append((sort_key, value))
    return min(delivered, default=(None, None), key=lambda item: item[0])[1]


async def cleanup_acknowledged_entries(
    redis: Any,
    streams: Iterable[str] = DEFAULT_STREAMS,
    *,
    apply: bool = False,
    batch_size: int = 200,
) -> dict[str, dict[str, int | str]]:
    """Inspect streams and optionally delete records ACKed by every group."""
    if batch_size < 1:
        raise ValueError("batch_size must be positive")

    summary: dict[str, dict[str, int | str]] = {}
    for stream in streams:
        report: dict[str, int | str] = {
            "groups": 0,
            "candidates": 0,
            "deleted": 0,
        }
        try:
            groups = await redis.xinfo_groups(stream)
        except Exception as exc:
            report["skipped"] = str(exc)
            summary[stream] = report
            continue

        report["groups"] = len(groups)
        cutoff = _group_cutoff(groups)
        if not groups or not cutoff:
            summary[stream] = report
            continue

        minimum = "0-0"
        while True:
            entries = await redis.xrange(
                stream,
                min=minimum,
                max=cutoff,
                count=batch_size,
            )
            if not entries:
                break
            entry_ids = [str(entry[0]) for entry in entries]
            report["candidates"] += len(entry_ids)
            if apply:
                deleted = await redis.eval(
                    _DELETE_ACKNOWLEDGED_SCRIPT,
                    1,
                    stream,
                    *entry_ids,
                )
                report["deleted"] += int(deleted or 0)

            last_id = entry_ids[-1]
            if _stream_id_key(last_id) is None or _stream_id_key(last_id) >= _stream_id_key(cutoff):
                break
            minimum = f"({last_id}"

        summary[stream] = report
    return summary


async def main() -> None:
    from core.redis import close_redis_clients, get_redis

    parser = argparse.ArgumentParser(
        description="Inspect or reclaim Redis Stream records acknowledged by every consumer group."
    )
    parser.add_argument(
        "--stream",
        action="append",
        dest="streams",
        help="Stream to inspect. May be passed more than once.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete eligible records. Without this flag the command is a dry run.",
    )
    parser.add_argument("--batch-size", type=int, default=200)
    args = parser.parse_args()

    redis = get_redis()
    try:
        await redis.ping()
        summary = await cleanup_acknowledged_entries(
            redis,
            args.streams or DEFAULT_STREAMS,
            apply=args.apply,
            batch_size=args.batch_size,
        )
        print(json.dumps({"apply": args.apply, "streams": summary}, ensure_ascii=False))
    finally:
        await close_redis_clients()


if __name__ == "__main__":
    asyncio.run(main())
