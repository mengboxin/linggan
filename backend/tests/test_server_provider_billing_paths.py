import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from routers import go_image_heavy, layer_edit, segmentation
from services import openai_layering, touch_edit
from services.agents import ppt_agent


def _sku(model_id: str, category: str = "generate", price: float = 2.0) -> dict:
    return {
        "id": model_id,
        "name": model_id,
        "category": category,
        "enabled": True,
        "price_type": "credits",
        "price_credits": price,
    }


@pytest.mark.asyncio
async def test_icon_task_reserves_four_calls_and_worker_settles_each_candidate():
    create = AsyncMock(return_value="task-icon")
    reserve = AsyncMock(return_value=True)
    with patch(
        "routers.layer_edit.require_platform_provider_sku",
        new=AsyncMock(return_value=_sku("inpainting-icon-alternatives")),
    ), patch("routers.layer_edit.reserve_for_task", new=reserve), patch(
        "routers.layer_edit.task_repo.create",
        new=create,
    ):
        task_id = await layer_edit._create_provider_billed_task(
            task_type="icon-alternatives",
            user_id="user-1",
            model_id="inpainting-icon-alternatives",
            model_name="Icon Alternatives",
            call_count=4,
        )

    assert task_id == "task-icon"
    assert reserve.await_args.args[2] == 8.0
    assert create.await_args.kwargs["cost"] == 8.0
    assert create.await_args.kwargs["charge_on_complete"] is False

    calls: list[dict] = []

    async def billed(**kwargs):
        calls.append(kwargs)
        return await kwargs["invoke"]()

    router = MagicMock()
    router.inpaint = AsyncMock(return_value=b"rendered")
    with patch(
        "services.inpainting.flux_fill_provider._analyze_surrounding_palette",
        return_value=[],
    ), patch("services.touch_edit._get_router", return_value=router), patch(
        "services.touch_edit.execute_platform_provider_call",
        side_effect=billed,
    ), patch("services.touch_edit.task_repo.set_processing", new=AsyncMock()), patch(
        "services.touch_edit.task_repo.set_progress",
        new=AsyncMock(),
    ), patch("services.touch_edit.task_repo.set_completed", new=AsyncMock()), patch(
        "services.touch_edit.asset_storage.store_generated_image_best_effort",
        new=AsyncMock(return_value=None),
    ):
        await touch_edit.run_icon_alternatives(
            task_id="task-icon",
            image_bytes=b"image",
            mask_bytes=b"mask",
            element_id="icon-1",
            user_id="user-1",
            billing_model_id="inpainting-icon-alternatives",
        )

    assert len(calls) == 4
    assert {call["idempotency_key"] for call in calls} == {
        f"task:task-icon:provider:inpainting-icon-alternatives:candidate:{index}"
        for index in range(1, 5)
    }
    assert all(call["related_task_id"] is None for call in calls)
    assert all(call["reservation_task_id"] == "task-icon" for call in calls)


@pytest.mark.asyncio
async def test_partial_segmentation_reserves_pipeline_sku_without_terminal_double_charge():
    create = AsyncMock(return_value="task-segment")
    reserve = AsyncMock(return_value=True)
    model_id = segmentation.PARTIAL_SEGMENTATION_BILLING_MODEL_ID
    with patch(
        "routers.segmentation.require_platform_provider_sku",
        new=AsyncMock(return_value=_sku(model_id, "segmentation", 3)),
    ), patch("routers.segmentation.reserve_for_task", new=reserve), patch(
        "routers.segmentation.task_repo.create",
        new=create,
    ):
        task_id = await segmentation._create_partial_segmentation_task("user-1")

    assert task_id == "task-segment"
    assert reserve.await_args.args[2] == 3
    assert create.await_args.kwargs["model_id"] == model_id
    assert create.await_args.kwargs["charge_on_complete"] is False


@pytest.mark.asyncio
async def test_openai_layering_bills_each_successful_layer_with_task_keys():
    calls: list[dict] = []

    async def billed(**kwargs):
        calls.append(kwargs)
        return await kwargs["invoke"]()

    rendered = base64.b64encode(b"layer-png").decode()
    with patch.object(openai_layering.settings, "OPENAI_API_KEY", "server-key"), patch(
        "services.openai_layering.to_png_bytes",
        return_value=(b"source-png", 64, 64),
    ), patch(
        "services.openai_layering.model_repo.get_model_internal",
        new=AsyncMock(return_value={"id": "segmentation-openai-layer", "meta": {}}),
    ), patch(
        "services.openai_layering._call_openai_edit",
        new=AsyncMock(return_value=rendered),
    ), patch(
        "services.openai_layering._normalize_png_layer",
        side_effect=lambda value, _w, _h: value,
    ), patch(
        "services.openai_layering.execute_platform_provider_call",
        side_effect=billed,
    ), patch("services.openai_layering.task_repo.set_processing", new=AsyncMock()), patch(
        "services.openai_layering.task_repo.set_progress",
        new=AsyncMock(),
    ), patch("services.openai_layering.task_repo.set_completed", new=AsyncMock()):
        await openai_layering.run_openai_layering(
            "task-layers",
            b"source",
            {"model_id": "segmentation-openai-layer", "max_layers": 3},
            user_id="user-1",
            billing_model_id="segmentation-openai-layer",
        )

    assert len(calls) == 3
    assert [call["idempotency_key"] for call in calls] == [
        f"task:task-layers:provider:segmentation-openai-layer:layer:{index}"
        for index in range(1, 4)
    ]
    assert all(call["related_task_id"] is None for call in calls)
    assert all(call["reservation_task_id"] == "task-layers" for call in calls)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "model_id"),
    [
        ("replicate", "ppt-inpainting-replicate"),
        ("iopaint", "ppt-inpainting-iopaint"),
    ],
)
async def test_ppt_explicit_inpainting_uses_direct_call_sku_without_task_id(
    provider: str,
    model_id: str,
):
    billed = AsyncMock(return_value=b"clean-slide")
    environment = {
        "PPT_INPAINT_PROVIDER": provider,
        "REPLICATE_API_TOKEN": "server-token",
        "PPT_INPAINT_URL": "http://iopaint.test/api/v1/inpaint",
    }
    with patch.dict("os.environ", environment, clear=False), patch(
        "services.agents.ppt_agent._build_text_mask",
        return_value=b"mask",
    ), patch(
        "services.agents.ppt_agent.execute_platform_provider_call",
        new=billed,
    ):
        result = await ppt_agent._inpaint_text_regions_with_service(
            img_bytes=b"slide",
            text_elements=[{"content": "title"}],
            user_id="user-1",
            job_id="ppt-job-1",
            slide_index=2,
        )

    assert result == b"clean-slide"
    kwargs = billed.await_args.kwargs
    assert kwargs["model_id"] == model_id
    assert kwargs["related_task_id"] is None
    assert kwargs["idempotency_key"].endswith(f"{provider}:slide:3")
    assert kwargs["success_when"] is bool


class _RedisClaim:
    async def set(self, *_args, **_kwargs):
        return True

    async def delete(self, *_args, **_kwargs):
        return 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["platform_credits", "external_api_key"])
async def test_go_heavy_uses_only_task_frozen_billing_mode(mode: str):
    assert await go_image_heavy._billing_mode({"_billing_mode": mode}) == mode

    with pytest.raises(HTTPException) as exc_info:
        await go_image_heavy._billing_mode({})

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_go_heavy_completion_arms_task_terminal_billing():
    task = {
        "status": "processing",
        "_user_id": "user-1",
        "_model_id": "inpainting-flux-fill",
    }
    staged = SimpleNamespace(
        path="staged.png",
        sha256="abc123",
        size_bytes=100,
    )
    stored = SimpleNamespace(
        id="asset-1",
        original_url="/asset/original",
        preview_url="/asset/preview",
        thumb_url="/asset/thumb",
    )
    transition = SimpleNamespace(won=True)
    update = AsyncMock(return_value=True)
    completed = AsyncMock(return_value=transition)

    with patch.object(go_image_heavy.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"), patch(
        "routers.go_image_heavy._owned_task",
        new=AsyncMock(return_value=task),
    ), patch("routers.go_image_heavy.get_redis", return_value=_RedisClaim()), patch(
        "routers.go_image_heavy.asset_storage.stage_uploaded_image",
        new=AsyncMock(return_value=staged),
    ), patch(
        "routers.go_image_heavy.asset_storage.store_generated_image_best_effort",
        new=AsyncMock(return_value=stored),
    ), patch(
        "routers.go_image_heavy.asset_storage.remove_staged_image_file",
        new=AsyncMock(),
    ), patch(
        "routers.go_image_heavy._billing_mode",
        new=AsyncMock(return_value="platform_credits"),
    ), patch("routers.go_image_heavy.task_repo._update", new=update), patch(
        "routers.go_image_heavy.task_repo.set_completed",
        new=completed,
    ):
        result = await go_image_heavy.complete(
            task_id="task-1",
            user_id="user-1",
            model_id="inpainting-flux-fill",
            prompt="replace object",
            mode="replace",
            element_id="element-1",
            completion_id="completion-1",
            billing_mode="platform_credits",
            image=MagicMock(),
            secret="secret",
        )

    assert result["ok"] is True
    update.assert_awaited_once_with("task-1", {"_charge_on_complete": True})
    completed.assert_awaited_once()


@pytest.mark.asyncio
async def test_go_heavy_lease_requires_priced_sku_before_returning_server_key():
    task = {
        "status": "pending",
        "_user_id": "user-1",
        "_model_id": "inpainting-flux-fill",
    }
    failed = AsyncMock()
    with patch.object(go_image_heavy.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "secret"), patch(
        "routers.go_image_heavy._owned_task",
        new=AsyncMock(return_value=task),
    ), patch(
        "routers.go_image_heavy.generation_execution.claim_generate_execution_once",
        new=AsyncMock(return_value=True),
    ), patch(
        "routers.go_image_heavy._billing_mode",
        new=AsyncMock(return_value="platform_credits"),
    ), patch(
        "routers.go_image_heavy.require_platform_provider_sku",
        new=AsyncMock(side_effect=HTTPException(503, "missing SKU")),
    ), patch("routers.go_image_heavy.task_repo.set_failed", new=failed):
        with pytest.raises(HTTPException) as exc_info:
            await go_image_heavy.lease(
                go_image_heavy.LeaseBody(
                    task_id="task-1",
                    user_id="user-1",
                    model_id="inpainting-flux-fill",
                    prompt="replace object",
                    mode="replace",
                    billing_mode="platform_credits",
                ),
                secret="secret",
            )

    assert exc_info.value.status_code == 503
    failed.assert_awaited_once()
