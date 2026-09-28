"""Task wrapper for image generation.

All image generation paths should go through ``services.ai_client.call_image`` so
admin model settings control the provider, endpoint, key, and Responses
``image_generation`` mode in one place.
"""

from __future__ import annotations

import base64
from typing import Optional

import repositories.model_repo as model_repo
import repositories.task_repo as task_repo
from services.ai_client import call_image


async def run_image_generate(
    task_id: str,
    model_id: str,
    prompt: str,
    image_bytes: Optional[bytes],
    params: dict,
    images_bytes: Optional[list[bytes]] = None,
):
    try:
        await task_repo.set_processing(task_id, 10)

        model = await model_repo.get_model_internal(model_id)
        if not model:
            raise ValueError(f"Model {model_id!r} does not exist or is disabled")

        endpoint = str(model.get("endpoint") or "").rstrip("/")
        api_key = str(model.get("api_key") or "")
        if not endpoint:
            raise ValueError(f"Model {model_id!r} has no endpoint configured")
        if not api_key:
            raise ValueError(f"Model {model_id!r} has no API key configured")

        await task_repo.set_progress(task_id, 20)

        ref_images: list[bytes] = []
        if images_bytes:
            ref_images = images_bytes[:4]
        elif image_bytes:
            ref_images = [image_bytes]

        result_bytes = await call_image(
            model_id=model_id,
            prompt=prompt,
            ref_images=ref_images or None,
            size=params.get("size", "1024x1024"),
            n=int(params.get("n", 1)),
            quality=params.get("image_quality", "auto"),
            force_size=bool(params.get("force_size", True)),
            aspect_ratio=params.get("aspect_ratio"),
            output_resolution=params.get("output_resolution"),
        )

        await task_repo.set_completed(task_id, {
            "imageBase64": base64.b64encode(result_bytes).decode(),
            "model_id": model_id,
        })

        try:
            await model_repo.increment_calls(model_id, 0)
        except Exception:
            pass

    except Exception as e:
        print(f"[image_generate] task {task_id} failed: {e}")
        await task_repo.set_failed(task_id, str(e))
