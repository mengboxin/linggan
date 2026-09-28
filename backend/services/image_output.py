from __future__ import annotations

import math
import re
from dataclasses import dataclass


OUTPUT_RESOLUTIONS = {"1k", "2k", "4k"}
IMAGE_RENDER_QUALITIES = {"auto", "low", "medium", "high"}
IMAGE_ASPECT_RATIOS = (
    "1:1",
    "5:4",
    "4:5",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
)

_OUTPUT_SIZE_MAP = {
    "1:1": {
        "1k": "1024x1024",
        "2k": "2048x2048",
        "4k": "2880x2880",
    },
    "5:4": {
        "1k": "1280x1024",
        "2k": "2000x1600",
        "4k": "3200x2560",
    },
    "4:5": {
        "1k": "1024x1280",
        "2k": "1600x2000",
        "4k": "2560x3200",
    },
    "4:3": {
        "1k": "1344x1008",
        "2k": "2048x1536",
        "4k": "3264x2448",
    },
    "3:4": {
        "1k": "1008x1344",
        "2k": "1536x2048",
        "4k": "2448x3264",
    },
    "3:2": {
        "1k": "1536x1024",
        "2k": "2016x1344",
        "4k": "3456x2304",
    },
    "2:3": {
        "1k": "1024x1536",
        "2k": "1344x2016",
        "4k": "2304x3456",
    },
    "16:9": {
        "1k": "1792x1008",
        "2k": "2048x1152",
        "4k": "3840x2160",
    },
    "9:16": {
        "1k": "1008x1792",
        "2k": "1152x2048",
        "4k": "2160x3840",
    },
}

_PROMPT_RESOLUTION_RE = re.compile(r"(?<!\d)([124])\s*[kK](?![A-Za-z0-9])")
_PROMPT_RATIO_RE = re.compile(
    r"(?<!\d)(16|9|5|4|3|2|1)\s*(?:[:\uff1a\u6bd4])\s*(16|9|5|4|3|2|1)(?!\d)"
)


@dataclass(frozen=True)
class ResolvedImageOutput:
    size: str
    output_resolution: str
    aspect_ratio: str
    prompt_resolution: str | None = None
    prompt_aspect_ratio: str | None = None


def normalize_output_resolution(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "standard":
        return "1k"
    return normalized if normalized in OUTPUT_RESOLUTIONS else "1k"


def normalize_image_quality(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in IMAGE_RENDER_QUALITIES else "auto"


def image_output_size(aspect_ratio: str, resolution: str | None) -> str:
    sizes = _OUTPUT_SIZE_MAP.get(aspect_ratio, _OUTPUT_SIZE_MAP["1:1"])
    return sizes[normalize_output_resolution(resolution)]


def infer_output_resolution_from_size(size: str | None) -> str:
    normalized = str(size or "").strip().lower().replace("*", "x")
    for resolution in ("1k", "2k", "4k"):
        if any(sizes[resolution].lower() == normalized for sizes in _OUTPUT_SIZE_MAP.values()):
            return resolution
    return "1k"


def normalize_image_aspect_ratio(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    return candidate if candidate in IMAGE_ASPECT_RATIOS else None


def infer_image_aspect_ratio(size: str | None) -> str | None:
    match = re.fullmatch(r"\s*(\d+)\s*[xX*]\s*(\d+)\s*", str(size or ""))
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return _nearest_image_aspect_ratio(width, height)


def _nearest_image_aspect_ratio(width: int, height: int) -> str:
    ratio = width / height
    return min(
        IMAGE_ASPECT_RATIOS,
        key=lambda candidate: abs(
            math.log(ratio / (int(candidate.split(":", 1)[0]) / int(candidate.split(":", 1)[1])))
        ),
    )


def _prompt_output_options(prompt: str) -> tuple[str | None, str | None]:
    prompt_resolution = None
    for match in _PROMPT_RESOLUTION_RE.finditer(prompt or ""):
        prompt_resolution = f"{match.group(1)}k"

    prompt_aspect_ratio = None
    for match in _PROMPT_RATIO_RE.finditer(prompt or ""):
        candidate = f"{match.group(1)}:{match.group(2)}"
        if candidate in IMAGE_ASPECT_RATIOS:
            prompt_aspect_ratio = candidate
    return prompt_resolution, prompt_aspect_ratio


def resolve_image_output_options(
    *,
    prompt: str,
    requested_size: str | None,
    output_resolution: str | None,
    requested_aspect_ratio: str | None = None,
    reference_size: tuple[int, int] | None = None,
) -> ResolvedImageOutput:
    prompt_resolution, prompt_aspect_ratio = _prompt_output_options(prompt)
    resolution = prompt_resolution or normalize_output_resolution(output_resolution)
    aspect_ratio = (
        prompt_aspect_ratio
        or normalize_image_aspect_ratio(requested_aspect_ratio)
        or infer_image_aspect_ratio(requested_size)
    )
    if not aspect_ratio and reference_size:
        width, height = reference_size
        if width > 0 and height > 0:
            aspect_ratio = _nearest_image_aspect_ratio(width, height)
    aspect_ratio = aspect_ratio or "1:1"
    return ResolvedImageOutput(
        size=image_output_size(aspect_ratio, resolution),
        output_resolution=resolution,
        aspect_ratio=aspect_ratio,
        prompt_resolution=prompt_resolution,
        prompt_aspect_ratio=prompt_aspect_ratio,
    )
