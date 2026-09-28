"""Regression coverage for task-scoped reservations at paid task submission."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from routers import generate, layer_edit, segmentation


USER = {"id": "user-route-reservation-1"}


@pytest.mark.asyncio
async def test_direct_go_image2_shortcut_defers_terminal_billing_until_callback():
    async def create(*_args, **kwargs) -> str:
        return kwargs["task_id"]

    create_mock = AsyncMock(side_effect=create)
    with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
        "routers.generate.model_repo.get_model",
        new=AsyncMock(return_value={
            "name": "image2",
            "category": "generate",
            "price_credits": 2,
        }),
    ), patch("routers.generate._claim_submit_key", new=AsyncMock(return_value=None)), patch(
        "routers.generate._remember_submit_key", new=AsyncMock()
    ), patch("routers.generate.reserve_for_task", new=AsyncMock(return_value=True)), patch(
        "routers.generate.task_repo.create", new=create_mock
    ), patch(
        "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": ""})
    ), patch(
        "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=[])
    ), patch(
        "routers.generate.conversation_repo.create_conversation",
        new=AsyncMock(return_value={"id": "go-image2-conversation"}),
    ), patch("routers.generate.enqueue", new=AsyncMock()), patch.object(
        generate.settings, "GO_IMAGE2_WORKER_ENABLED", True
    ), patch.object(
        generate.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"
    ), patch.object(generate.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"):
        result = await generate.submit(
            model_id="image2",
            prompt="extend this image",
            size="1024x1024",
            n=1,
            llm_model_id="",
            vision_model_id="",
            conversation_id="",
            source="desktop_image2_shortcut",
            client_request_id="go-image2-reservation",
            images=[],
            user=USER,
        )

    # The direct Go callback arms terminal settlement immediately before it
    # completes the task. Keeping this false at submission prevents a Python
    # fallback from being charged both by the Agent and terminal outbox.
    assert create_mock.await_args.kwargs["charge_on_complete"] is False
    assert create_mock.await_args.kwargs["task_id"] == result["taskId"]


@pytest.mark.asyncio
async def test_paid_layer_edit_reserves_the_same_id_passed_to_task_creation():
    events: list[tuple[str, str]] = []

    async def reserve(_user_id: str, task_id: str, _amount: float) -> bool:
        events.append(("reserve", task_id))
        return True

    async def create(*_args, **kwargs) -> str:
        task_id = kwargs["task_id"]
        events.append(("create", task_id))
        return task_id

    image = SimpleNamespace(filename="input.png", content_type="image/png")
    with patch("routers.layer_edit.rate_limit", new=AsyncMock()), patch(
        "routers.layer_edit.read_image_upload", new=AsyncMock(return_value=b"image")
    ), patch(
        "routers.layer_edit.model_repo.get_model",
        new=AsyncMock(return_value={"name": "Paid edit", "price_credits": 4}),
    ), patch("routers.layer_edit.reserve_for_task", new=AsyncMock(side_effect=reserve)), patch(
        "routers.layer_edit.task_repo.create", new=AsyncMock(side_effect=create)
    ), patch(
        "routers.layer_edit.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=None)
    ), patch("routers.layer_edit.enqueue", new=AsyncMock()):
        result = await layer_edit.submit(
            image=image,
            model_id="paid-edit",
            prompt="replace background",
            negative_prompt="",
            strength=0.75,
            style="",
            user=USER,
        )

    assert events[0][0] == "reserve"
    assert events == [("reserve", result["taskId"]), ("create", result["taskId"])]


@pytest.mark.asyncio
async def test_paid_segmentation_reserves_the_same_id_passed_to_task_creation():
    events: list[tuple[str, str]] = []

    async def reserve(_user_id: str, task_id: str, _amount: float) -> bool:
        events.append(("reserve", task_id))
        return True

    async def create(*_args, **kwargs) -> str:
        task_id = kwargs["task_id"]
        events.append(("create", task_id))
        return task_id

    image = SimpleNamespace(filename="input.png", content_type="image/png")
    with patch("routers.segmentation.rate_limit", new=AsyncMock()), patch(
        "routers.segmentation.read_image_upload", new=AsyncMock(return_value=b"image")
    ), patch(
        "routers.segmentation.require_platform_provider_sku",
        new=AsyncMock(return_value={
            "name": "Paid segmentation",
            "category": "segmentation",
            "price_credits": 3,
        }),
    ), patch("routers.segmentation.reserve_for_task", new=AsyncMock(side_effect=reserve)), patch(
        "routers.segmentation.task_repo.create", new=AsyncMock(side_effect=create)
    ), patch(
        "routers.segmentation._persist_queue_inputs", new=AsyncMock(return_value=None)
    ), patch("routers.segmentation._enqueue_submission", new=AsyncMock()):
        result = await segmentation.submit(
            image=image,
            model_id="paid-segmentation",
            prompt="",
            negative_prompt="",
            seed=0,
            randomize_seed=True,
            go_fast=True,
            description="auto",
            output_format="webp",
            output_quality=95,
            disable_safety_checker=False,
            guidance_scale=4.0,
            num_inference_steps=50,
            num_layers=10,
            cfg_normalization=True,
            auto_caption_en=True,
            provider="qwen",
            max_layers=4,
            user=USER,
        )

    assert events[0][0] == "reserve"
    assert events == [("reserve", result["taskId"]), ("create", result["taskId"])]


@pytest.mark.asyncio
async def test_layer_edit_create_failure_releases_only_its_task_reservation():
    reserved_ids: list[str] = []
    released_ids: list[str] = []

    async def reserve(_user_id: str, task_id: str, _amount: float) -> bool:
        reserved_ids.append(task_id)
        return True

    async def release(task_id: str) -> float:
        released_ids.append(task_id)
        return 4.0

    image = SimpleNamespace(filename="input.png", content_type="image/png")
    with patch("routers.layer_edit.rate_limit", new=AsyncMock()), patch(
        "routers.layer_edit.read_image_upload", new=AsyncMock(return_value=b"image")
    ), patch(
        "routers.layer_edit.model_repo.get_model",
        new=AsyncMock(return_value={"name": "Paid edit", "price_credits": 4}),
    ), patch("routers.layer_edit.reserve_for_task", new=AsyncMock(side_effect=reserve)), patch(
        "routers.layer_edit.release_task_reservation", new=AsyncMock(side_effect=release)
    ), patch(
        "routers.layer_edit.task_repo.create", new=AsyncMock(side_effect=RuntimeError("redis unavailable"))
    ):
        with pytest.raises(RuntimeError, match="redis unavailable"):
            await layer_edit.submit(
                image=image,
                model_id="paid-edit",
                prompt="replace background",
                negative_prompt="",
                strength=0.75,
                style="",
                user=USER,
            )

    assert len(reserved_ids) == 1
    assert released_ids == reserved_ids


@pytest.mark.asyncio
async def test_rejected_segmentation_reservation_does_not_create_a_task():
    image = SimpleNamespace(filename="input.png", content_type="image/png")
    create = AsyncMock()
    with patch("routers.segmentation.rate_limit", new=AsyncMock()), patch(
        "routers.segmentation.read_image_upload", new=AsyncMock(return_value=b"image")
    ), patch(
        "routers.segmentation.require_platform_provider_sku",
        new=AsyncMock(return_value={
            "name": "Paid segmentation",
            "category": "segmentation",
            "price_credits": 3,
        }),
    ), patch("routers.segmentation.reserve_for_task", new=AsyncMock(return_value=False)), patch(
        "routers.segmentation.get_available_balance", new=AsyncMock(return_value=0.0)
    ), patch("routers.segmentation.task_repo.create", new=create):
        with pytest.raises(HTTPException) as exc_info:
            await segmentation.submit(
                image=image,
                model_id="paid-segmentation",
                prompt="",
                negative_prompt="",
                seed=0,
                randomize_seed=True,
                go_fast=True,
                description="auto",
                output_format="webp",
                output_quality=95,
                disable_safety_checker=False,
                guidance_scale=4.0,
                num_inference_steps=50,
                num_layers=10,
                cfg_normalization=True,
                auto_caption_en=True,
                provider="qwen",
                max_layers=4,
                user=USER,
            )

    assert exc_info.value.status_code == 402
    create.assert_not_awaited()
