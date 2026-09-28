from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from core import queue


@pytest.fixture
def image2_payload() -> dict:
    return {
        "model_id": "image2",
        "prompt": "extend this image to a 16:9 frame",
        "image_assets": [{"key": "assets/users/user-1/queue-inputs/task/input.png"}],
        "images_bytes_b64": [],
        "llm_model_id": "",
        "vision_model_id": "",
        "params": {"source": "desktop_image2_shortcut", "n": 1},
    }


def test_go_image2_route_requires_explicit_feature_switch(image2_payload):
    with patch.object(queue.settings, "GO_IMAGE2_WORKER_ENABLED", False), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"):
        assert queue._should_use_go_image2_worker("generate", image2_payload) is False


@pytest.mark.parametrize(
    "mutator",
    [
        lambda payload: payload["params"].update({"source": "workflow_edit"}),
        lambda payload: payload["params"].update({"n": 2}),
        lambda payload: payload["params"].update({"enable_visual_review": True}),
        lambda payload: payload.update({"llm_model_id": "planner"}),
        lambda payload: payload.update({"images_bytes_b64": ["legacy-base64"]}),
        lambda payload: payload.update({"image_bytes": "legacy-base64"}),
    ],
)
def test_go_image2_route_rejects_unsafe_payloads(image2_payload, mutator):
    mutator(image2_payload)
    with patch.object(queue.settings, "GO_IMAGE2_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"):
        assert queue._should_use_go_image2_worker("generate", image2_payload) is False


@pytest.mark.asyncio
async def test_go_image2_enqueue_sets_dedicated_execution_target(image2_payload):
    redis = type("Redis", (), {"sadd": AsyncMock(), "set": AsyncMock(), "expire": AsyncMock()})()
    with patch("core.queue.get_redis", return_value=redis), patch(
        "core.queue._prune_user_active_slots", new=AsyncMock(return_value=0)
    ), patch.object(queue.settings, "GO_IMAGE2_WORKER_ENABLED", True), patch.object(
        queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"), patch(
        "core.queue._enqueue_via_go_control_plane", new=AsyncMock(return_value="1-0")
    ) as enqueue_go:
        await queue.enqueue(
            task_type="generate",
            task_id="task-1",
            payload=image2_payload,
            user_id="user-1",
        )

    assert enqueue_go.await_args.kwargs["execution_target"] == "go-image2"


@pytest.mark.asyncio
async def test_go_control_plane_queue_full_is_mapped_to_retryable_capacity_error():
    class Response:
        status_code = 503

        @staticmethod
        def json():
            return {"error": "queue is temporarily full"}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def post(self, *_args, **_kwargs):
            return Response()

    with patch.object(queue.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"), patch.object(
        queue.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"
    ), patch("httpx.AsyncClient", return_value=Client()):
        with pytest.raises(queue.QueueCapacityExceeded) as error:
            await queue._enqueue_via_go_control_plane(
                task_id="task-full",
                task_type="generate",
                user_id="user-1",
                priority="normal",
                payload={},
                billing_mode="platform_credits",
                execution_target="go-image2",
            )

    assert error.value.limit == queue.QUEUE_GLOBAL_MAX_ENTRIES
