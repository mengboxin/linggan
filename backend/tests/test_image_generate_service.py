import base64
from unittest.mock import AsyncMock, patch

import pytest

from services.image_generate import run_image_generate


@pytest.mark.asyncio
async def test_run_image_generate_uses_unified_call_image():
    fake_png = b"png-bytes"
    model = {
        "id": "image2",
        "endpoint": "https://api.openai.com/v1",
        "api_key": "sk-test",
        "meta": {
            "use_openai_responses_image_generation": True,
            "responses_model": "gpt-5.5",
        },
    }

    with patch("services.image_generate.model_repo.get_model_internal", new=AsyncMock(return_value=model)), \
         patch("services.image_generate.task_repo.set_processing", new=AsyncMock()) as set_processing, \
         patch("services.image_generate.task_repo.set_progress", new=AsyncMock()) as set_progress, \
         patch("services.image_generate.task_repo.set_completed", new=AsyncMock()) as set_completed, \
         patch("services.image_generate.model_repo.increment_calls", new=AsyncMock()) as increment_calls, \
         patch("services.image_generate.call_image", new=AsyncMock(return_value=fake_png)) as call_image:

        await run_image_generate(
            task_id="task-1",
            model_id="image2",
            prompt="draw a cat",
            image_bytes=b"reference",
            params={"size": "1536x1024", "n": 1},
        )

    set_processing.assert_awaited_once_with("task-1", 10)
    set_progress.assert_awaited_once_with("task-1", 20)
    call_image.assert_awaited_once_with(
        model_id="image2",
        prompt="draw a cat",
        ref_images=[b"reference"],
        size="1536x1024",
        n=1,
        quality="auto",
        force_size=True,
        aspect_ratio=None,
        output_resolution=None,
    )
    set_completed.assert_awaited_once_with("task-1", {
        "imageBase64": base64.b64encode(fake_png).decode(),
        "model_id": "image2",
    })
    increment_calls.assert_awaited_once_with("image2", 0)
