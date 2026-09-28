"""Measure Python memory retained by Redis queue image envelopes.

``legacy`` reproduces the former representation:
raw bytes -> Base64 string -> JSON stream field -> parsed JSON -> decoded bytes.
``asset-ref`` models the new representation: a small object-storage reference
in Redis and one raw image buffer only after the worker gets an execution slot.
It deliberately uses only the standard library so it can run in a production
container without touching Redis, Postgres, storage, or an image model.

Example:
    python scripts/profile_queue_payload_memory.py --image-mb 20 --concurrency 4 --max-mib 300
"""

from __future__ import annotations

import argparse
import base64
import gc
import json
import sys
import tracemalloc


MEBIBYTE = 1024 * 1024


def mib(value: int) -> float:
    return round(value / MEBIBYTE, 1)


def legacy_queue_payload(image_bytes: int) -> str:
    # Matches the pre-migration routers before enqueue().
    raw = bytes(image_bytes)
    encoded = base64.b64encode(raw).decode("ascii")
    return json.dumps({"images_bytes_b64": [encoded]}, ensure_ascii=False)


def decode_legacy_worker_payload(payload: str) -> tuple[dict, list[bytes]]:
    # Matches core/worker.py reading an old message after Redis returns it.
    decoded_payload = json.loads(payload)
    images = [base64.b64decode(value) for value in decoded_payload["images_bytes_b64"]]
    return decoded_payload, images


def asset_ref_queue_payload() -> str:
    # New Redis message: object metadata only, never image bytes/Base64.
    return json.dumps({
        "image_assets": [{
            "role": "source",
            "key": "assets/users/example/queue-inputs/task/files/input.png",
            "content_type": "image/png",
            "size_bytes": 20 * MEBIBYTE,
        }],
        "images_bytes_b64": [],
    }, ensure_ascii=False)


def decode_asset_ref_worker_payload(payload: str, image_bytes: int) -> tuple[dict, list[bytes]]:
    # A worker loads raw bytes only after it has acquired its concurrency slot.
    return json.loads(payload), [bytes(image_bytes)]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-mb", type=int, default=20, help="Raw image size for each task")
    parser.add_argument("--concurrency", type=int, default=4, help="Active worker jobs to retain")
    parser.add_argument("--max-mib", type=float, default=0, help="Fail when traced peak exceeds this budget")
    parser.add_argument("--mode", choices=("legacy", "asset-ref"), default="legacy")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.image_mb <= 0 or args.concurrency <= 0:
        raise SystemExit("--image-mb and --concurrency must be positive")

    image_bytes = args.image_mb * MEBIBYTE
    gc.collect()
    tracemalloc.start()

    make_payload = legacy_queue_payload if args.mode == "legacy" else asset_ref_queue_payload
    decode_payload = decode_legacy_worker_payload if args.mode == "legacy" else (
        lambda payload: decode_asset_ref_worker_payload(payload, image_bytes)
    )
    stream_fields = [make_payload(image_bytes) if args.mode == "legacy" else make_payload() for _ in range(args.concurrency)]
    queued_current, queued_peak = tracemalloc.get_traced_memory()

    active_jobs = [decode_payload(payload) for payload in stream_fields]
    active_current, active_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    encoded_mib = mib(len(stream_fields[0].encode("utf-8")))
    print(
        "queue-payload-memory "
        f"mode={args.mode} "
        f"image_mib={args.image_mb} concurrency={args.concurrency} "
        f"stream_field_mib={encoded_mib} "
        f"queued_current_mib={mib(queued_current)} queued_peak_mib={mib(queued_peak)} "
        f"active_current_mib={mib(active_current)} active_peak_mib={mib(active_peak)}"
    )

    # Keep the decoded data alive until after the measurement. This mirrors
    # worker jobs waiting on the upstream image provider concurrently.
    if not active_jobs:
        raise AssertionError("measurement failed to retain worker jobs")
    if args.max_mib and active_peak > args.max_mib * MEBIBYTE:
        print(
            f"FAIL: active peak {mib(active_peak)} MiB exceeds budget {args.max_mib:.1f} MiB",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
