from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from core import queue


def _payload() -> dict:
    return {
        "image_asset": {"key": "assets/users/u/queue-inputs/t/image.png"},
        "mask_asset": {"key": "assets/users/u/queue-inputs/t/mask.png"},
        "image_bytes": "",
        "mask_bytes": "",
        "prompt": "replace the selected area",
        "mode": "replace",
    }


@pytest.mark.parametrize("task_type", ["touch-replace", "touch-recolor"])
def test_go_image_heavy_route_requires_asset_refs(task_type):
    with patch.object(queue.settings, "GO_IMAGE_HEAVY_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"):
        assert queue._should_use_go_image_heavy_worker(task_type, _payload()) is True


@pytest.mark.parametrize("task_type", ["touch-remove", "icon-alternatives"])
def test_go_image_heavy_route_keeps_fallback_and_fanout_paths_in_python(task_type):
    with patch.object(queue.settings, "GO_IMAGE_HEAVY_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"):
        assert queue._should_use_go_image_heavy_worker(task_type, _payload()) is False


def test_go_image_heavy_route_rejects_legacy_bytes():
    payload = _payload()
    payload["image_bytes"] = "legacy"
    with patch.object(queue.settings, "GO_IMAGE_HEAVY_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"):
        assert queue._should_use_go_image_heavy_worker("touch-replace", payload) is False


@pytest.mark.asyncio
async def test_enqueue_selects_heavy_execution_target():
    redis = type("Redis", (), {"sadd": AsyncMock(), "set": AsyncMock(), "expire": AsyncMock()})()
    with patch("core.queue.get_redis", return_value=redis), patch(
        "core.queue._prune_user_active_slots", new=AsyncMock(return_value=0)
    ), patch.object(queue.settings, "GO_IMAGE_HEAVY_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"), patch(
        "core.queue._enqueue_via_go_control_plane", new=AsyncMock(return_value="1-0")
    ) as enqueue_go:
        await queue.enqueue("touch-replace", "task-1", _payload(), user_id="user-1")

    assert enqueue_go.await_args.kwargs["execution_target"] == "go-image-heavy"
