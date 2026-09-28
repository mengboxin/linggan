"""Grok image/video output contract.

Grok Imagine Image accepts aspect_ratio + resolution, not OpenAI WxH sizes.
Image: 1k/2k only (no 4k). 4:5 is rejected by upstream; 3:4 is the closest portrait.
Video: image-to-video with a single reference image and a 1–15s duration; it does
not accept image-generation aspect-ratio or resolution controls.
"""
from __future__ import annotations

from services.image_output import infer_image_aspect_ratio, infer_output_resolution_from_size


GROK_IMAGE_ASPECT_RATIOS = (
    "1:1",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
)
GROK_IMAGE_RESOLUTIONS = ("1k", "2k")
GROK_VIDEO_RESOLUTIONS = ("480p", "720p", "1080p")
GROK_VIDEO_MIN_DURATION = 1
GROK_VIDEO_MAX_DURATION = 15
GROK_VIDEO_DEFAULT_DURATION = 6
_GROK_VIDEO_REFERENCE_REQUIRED_PREFIXES = (
    "grok-imagine-video",
    "grok-imagine-video-1.5",
    "grok-video-1.5",
)

_GROK_ASPECT_ALIASES = {
    "4:5": "3:4",
    "5:4": "4:3",
}


def grok_image_aspect_ratio(value: str | None, *, size: str | None = None) -> str:
    candidate = str(value or "").strip()
    if not candidate and size:
        candidate = infer_image_aspect_ratio(size) or ""
    candidate = _GROK_ASPECT_ALIASES.get(candidate, candidate)
    return candidate if candidate in GROK_IMAGE_ASPECT_RATIOS else "1:1"


def grok_image_resolution(value: str | None, *, size: str | None = None) -> str:
    candidate = str(value or "").strip().lower()
    if candidate == "4k":
        return "2k"
    if candidate in GROK_IMAGE_RESOLUTIONS:
        return candidate
    if size:
        inferred = infer_output_resolution_from_size(size)
        if inferred == "4k":
            return "2k"
        if inferred in GROK_IMAGE_RESOLUTIONS:
            return inferred
    return "1k"


def grok_video_aspect_ratio(value: str | None, *, size: str | None = None) -> str:
    return grok_image_aspect_ratio(value, size=size)


def grok_video_resolution(value: str | None) -> str:
    candidate = str(value or "").strip().lower()
    if candidate in GROK_VIDEO_RESOLUTIONS:
        return candidate
    if candidate in {"1k", "480", "sd"}:
        return "480p"
    if candidate in {"2k", "720", "hd"}:
        return "720p"
    if candidate in {"4k", "1080", "fhd"}:
        return "1080p"
    return "720p"


def grok_video_duration(value: object) -> int:
    try:
        duration = int(value)
    except (TypeError, ValueError):
        duration = GROK_VIDEO_DEFAULT_DURATION
    return max(GROK_VIDEO_MIN_DURATION, min(GROK_VIDEO_MAX_DURATION, duration))


def grok_video_requires_reference_image(model_id: object) -> bool:
    """Return whether the known Grok video variant only accepts image-to-video input."""
    normalized = str(model_id or "").strip().lower()
    return normalized.startswith(_GROK_VIDEO_REFERENCE_REQUIRED_PREFIXES)
