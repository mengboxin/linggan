from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException, UploadFile

from routers import layer_edit_agent


def _upload() -> UploadFile:
    return UploadFile(filename="layer.png", file=BytesIO(b"image"))


@pytest.mark.asyncio
async def test_agent_submit_does_not_charge_a_model_failure_returned_as_fallback_image():
    graph = SimpleNamespace(run=AsyncMock(return_value={
        "result": "original-image",
        "size_valid": False,
        "error": "upstream model failed",
    }))
    async def execute(**kwargs):
        return await kwargs["invoke"]()

    billed_call = AsyncMock(side_effect=execute)

    with patch(
        "routers.layer_edit_agent.read_image_upload",
        new=AsyncMock(return_value=b"image"),
    ), patch(
        "routers.layer_edit_agent.model_repo.get_model",
        new=AsyncMock(return_value={
            "id": "edit-model",
            "name": "Edit model",
            "category": "generate",
            "price_credits": 2,
        }),
    ), patch(
        "routers.layer_edit_agent.execute_billed_model_call",
        new=billed_call,
    ), patch(
        "services.agents.LayerEditAgent",
        return_value=graph,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await layer_edit_agent.agent_submit(
                image=_upload(),
                prompt="replace the object",
                model_id="edit-model",
                bounds_x=0,
                bounds_y=0,
                bounds_width=64,
                bounds_height=64,
                user={"id": "user-1"},
            )

    assert exc_info.value.status_code == 502
    billed_call.assert_awaited_once()


@pytest.mark.asyncio
async def test_agent_submit_executes_a_success_through_success_only_billing():
    graph = SimpleNamespace(run=AsyncMock(return_value={
        "result": "edited-image",
        "size_valid": True,
    }))

    async def execute(**kwargs):
        return await kwargs["invoke"]()

    billed_call = AsyncMock(side_effect=execute)
    with patch(
        "routers.layer_edit_agent.read_image_upload",
        new=AsyncMock(return_value=b"image"),
    ), patch(
        "routers.layer_edit_agent.model_repo.get_model",
        new=AsyncMock(return_value={
            "id": "edit-model",
            "name": "Edit model",
            "category": "generate",
            "price_credits": 2,
        }),
    ), patch(
        "routers.layer_edit_agent.execute_billed_model_call",
        new=billed_call,
    ), patch(
        "services.agents.LayerEditAgent",
        return_value=graph,
    ):
        result = await layer_edit_agent.agent_submit(
            image=_upload(),
            prompt="replace the object",
            model_id="edit-model",
            bounds_x=0,
            bounds_y=0,
            bounds_width=64,
            bounds_height=64,
            client_request_id="layer-edit-request-1",
            user={"id": "user-1"},
        )
        await layer_edit_agent.agent_submit(
            image=_upload(),
            prompt="replace the object",
            model_id="edit-model",
            bounds_x=0,
            bounds_y=0,
            bounds_width=64,
            bounds_height=64,
            client_request_id="layer-edit-request-1",
            user={"id": "user-1"},
        )

    assert result["result"] == "edited-image"
    billing = billed_call.await_args.kwargs
    assert billing["model_id"] == "edit-model"
    assert billing["expected_category"] == "generate"
    assert billed_call.await_args_list[0].kwargs["idempotency_key"] == billed_call.await_args_list[1].kwargs["idempotency_key"]
    assert billing["idempotency_key"]
