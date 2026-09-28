"""Worker-side invariants for queued Image2 icon alternatives."""
import base64
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from PIL import Image

from services import touch_edit


async def _run_provider_call(**kwargs):
    return await kwargs["invoke"]()


@pytest.fixture(autouse=True)
def _provider_billing_passthrough():
    with patch(
        "services.touch_edit.execute_platform_provider_call",
        side_effect=_run_provider_call,
    ):
        yield


def _png(width: int = 64, height: int = 48) -> bytes:
    image = Image.new("RGBA", (width, height), (32, 128, 255, 255))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@pytest.mark.asyncio
async def test_icon_worker_returns_four_candidates_with_input_dimensions():
    source = _png()
    router = MagicMock()
    router.inpaint = AsyncMock(return_value=source)
    completed = AsyncMock()

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_completed", new=completed
    ):
        await touch_edit.run_icon_alternatives(
            task_id="icon-task",
            image_bytes=source,
            mask_bytes=_png(),
            element_id="icon-1",
            prompt="star icon",
        )

    router.inpaint.assert_awaited()
    assert router.inpaint.await_count == 4
    result = completed.await_args.args[1]
    assert result["element_id"] == "icon-1"
    assert result["total"] == 4
    for candidate in result["candidates"]:
        rendered = Image.open(BytesIO(base64.b64decode(candidate["image_base64"])))
        assert rendered.size == (64, 48)


@pytest.mark.asyncio
async def test_icon_worker_retains_successes_when_one_candidate_fails():
    source = _png()
    router = MagicMock()
    router.inpaint = AsyncMock(side_effect=[source, RuntimeError("upstream"), source, source])
    completed = AsyncMock()

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_completed", new=completed
    ):
        await touch_edit.run_icon_alternatives(
            task_id="icon-task",
            image_bytes=source,
            mask_bytes=_png(),
            element_id="icon-1",
        )

    assert completed.await_args.args[1]["total"] == 3


@pytest.mark.asyncio
async def test_icon_worker_marks_task_failed_when_no_candidate_succeeds():
    router = MagicMock()
    router.inpaint = AsyncMock(side_effect=RuntimeError("upstream"))
    failed = AsyncMock()

    with patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.task_repo.set_processing", new=AsyncMock()
    ), patch("services.touch_edit.task_repo.set_progress", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_failed", new=failed
    ):
        with pytest.raises(RuntimeError, match="all icon alternatives failed"):
            await touch_edit.run_icon_alternatives(
                task_id="icon-task",
                image_bytes=_png(),
                mask_bytes=_png(),
                element_id="icon-1",
            )

    failed.assert_awaited_once()
