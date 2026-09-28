from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from routers import go_image2
from services.asset_storage import StoredImageAsset


def _runtime_model() -> dict:
    return {
        "id": "image2",
        "category": "generate",
        "endpoint": "https://images.example/v1",
        "api_key": "provider-secret",
        "meta": {
            "responses_model": "gpt-5.5",
            "responses_image_size": "1536x1024",
            "image_generation_quality": "high",
            "responses_reasoning_effort": "low",
            "responses_reasoning_summary": "auto",
        },
    }


def _stored_asset() -> StoredImageAsset:
    return StoredImageAsset(
        id="asset-1",
        original_url="/api/assets/asset-1/original",
        preview_url="/api/assets/asset-1/preview",
        thumb_url="/api/assets/asset-1/thumb",
        original_key="assets/users/user-1/images/task-1/images/result/original.png",
        preview_key="assets/users/user-1/images/task-1/images/result/preview.webp",
        thumb_key="assets/users/user-1/images/task-1/images/result/thumb.webp",
        width=32,
        height=32,
        mime_type="image/png",
        size_bytes=4,
        sha256="digest",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["platform_credits", "external_api_key"])
async def test_go_image2_uses_only_task_frozen_billing_mode(mode: str):
    assert await go_image2._resolve_billing_mode({"_billing_mode": mode}) == mode

    with pytest.raises(HTTPException) as exc_info:
        await go_image2._resolve_billing_mode({})

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_finalize_completion_creates_history_conversation_when_callback_omits_id():
    persist_history = AsyncMock()
    create_conversation = AsyncMock(return_value={"id": "fallback-conversation"})
    with patch.object(go_image2.task_repo, "_update", new=AsyncMock(return_value=True)), patch.object(
        go_image2.task_repo,
        "set_completed",
        new=AsyncMock(return_value=SimpleNamespace(won=True)),
    ), patch(
        "repositories.conversation_repo.create_conversation",
        new=create_conversation,
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history",
        new=persist_history,
    ):
        completed = await go_image2._finalize_completion(
            task_id="task-1",
            user_id="user-1",
            billing_mode="platform_credits",
            model_id="image2",
            prompt="remove the marked object",
            conversation_id="",
            source="mobile_retouch_image2_shortcut",
            reference_count=2,
            stored=_stored_asset(),
            size="1024x1024",
            output_resolution="1k",
            image_quality="auto",
            completion_id="provider-completion-1",
        )

    assert completed is True
    create_conversation.assert_awaited_once_with(
        user_id="user-1",
        conv_type="image",
        title="remove the marked object",
        creation_key="go-image2:task-1",
    )
    assert persist_history.await_args.kwargs["conversation_id"] == "fallback-conversation"


def test_lease_runtime_config_matches_python_responses_options():
    runtime = go_image2._lease_runtime_config(
        model=_runtime_model(),
        prompt="extend the canvas with a natural background",
        reference_count=1,
        size="1536x1024",
        image_quality="auto",
        force_size=True,
    )

    assert runtime["endpoint"] == "https://images.example/v1/responses"
    assert runtime["model"] == "gpt-5.5"
    assert runtime["action"] == "edit"
    assert runtime["size"] == "1536x1024"
    assert runtime["force_size"] is True
    assert runtime["quality"] == "high"
    assert runtime["reasoning_effort"] == "low"
    assert runtime["reasoning_summary"] == "auto"
    assert "REFERENCE IMAGE CONTRACT" in runtime["final_prompt"]
    assert "Output contract:" in runtime["final_prompt"]


def test_cancelled_task_is_not_executable_by_go_worker():
    with pytest.raises(Exception) as error:
        go_image2._require_active_task({"status": "cancelled"})

    assert getattr(error.value, "status_code", None) == 409


@pytest.mark.asyncio
async def test_lease_returns_go_nested_tool_contract_and_claims_execution():
    task = {"status": "pending", "_user_id": "user-1", "_model_id": "image2"}
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch(
        "routers.go_image2.generation_execution.claim_generate_execution_once", new=AsyncMock(return_value=True)
    ) as claim, patch(
        "routers.go_image2._resolve_billing_mode", new=AsyncMock(return_value="platform_credits")
    ), patch(
        "routers.go_image2.model_repo.get_model_internal", new=AsyncMock(return_value=_runtime_model())
    ), patch(
        "routers.go_image2.task_repo.set_processing", new=AsyncMock()
    ), patch(
        "routers.go_image2.check_model_call", new=AsyncMock()
    ) as check_billing:
        result = await go_image2.lease(
            go_image2.LeaseBody(
                task_id="task-1",
                user_id="user-1",
                model_id="image2",
                prompt="replace the sky",
                size="1536x1024",
                image_quality="auto",
                force_size=True,
                reference_count=1,
            ),
            secret="test-secret",
        )

    claim.assert_awaited_once_with("task-1")
    check_billing.assert_awaited_once()
    assert check_billing.await_args.kwargs["reservation_task_id"] == "task-1"
    assert result["billing_mode"] == "platform_credits"
    assert result["prompt"].endswith("Target output clarity: 1K. Prioritize the highest available detail and resolution for this target.")
    assert result["tool"] == {
        "action": "edit",
        "size": "1536x1024",
        "quality": "high",
        "force_size": True,
        "reasoning": {"effort": "low", "summary": "auto"},
    }


@pytest.mark.asyncio
async def test_complete_uses_a_stable_asset_id_for_callback_retries():
    task = {"status": "processing", "_user_id": "user-1", "_model_id": "image2"}
    store = AsyncMock(return_value=_stored_asset())
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch("routers.go_image2._claim_finalization", new=AsyncMock(return_value=True)), patch(
        "routers.go_image2._resolve_billing_mode", new=AsyncMock(return_value="platform_credits")
    ), patch("routers.go_image2.asset_storage.store_generated_image_best_effort", new=store), patch(
        "routers.go_image2.task_repo._update", new=AsyncMock(return_value=True)
    ) as arm_charge, patch(
        "routers.go_image2.task_repo.set_completed", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        response = await go_image2.complete(
            task_id="task-1",
            user_id="user-1",
            model_id="image2",
            prompt="extend the sky",
            size="1024x1024",
            output_resolution="1k",
            image_quality="auto",
            conversation_id="",
            source="",
            reference_count=0,
            completion_id="provider-completion-1",
            billing_mode="",
            image=UploadFile(filename="result.png", file=BytesIO(b"data")),
            secret="test-secret",
        )

    assert response == {"ok": True, "asset_id": "asset-1"}
    assert store.await_args.kwargs["asset_id"] == go_image2._completion_asset_id(
        "task-1", "provider-completion-1", b"data"
    )
    arm_charge.assert_awaited_once_with("task-1", {"_charge_on_complete": True})


@pytest.mark.asyncio
async def test_complete_releases_finalization_claim_when_output_validation_fails():
    task = {"status": "processing", "_user_id": "user-1", "_model_id": "image2"}
    release = AsyncMock()
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch("routers.go_image2._claim_finalization", new=AsyncMock(return_value=True)), patch(
        "routers.go_image2._release_finalization_claim", new=release
    ):
        with pytest.raises(Exception) as error:
            await go_image2.complete(
                task_id="task-1",
                user_id="user-1",
                model_id="image2",
                prompt="extend the sky",
                size="1024x1024",
                output_resolution="1k",
                image_quality="auto",
                conversation_id="",
                source="",
                reference_count=0,
                completion_id="provider-completion-1",
                billing_mode="",
                image=UploadFile(filename="result.png", file=BytesIO()),
                secret="test-secret",
            )

    assert getattr(error.value, "status_code", None) == 400
    release.assert_awaited_once_with("task-1")


@pytest.mark.asyncio
async def test_failed_recovers_an_archived_output_instead_of_marking_task_failed():
    task = {"status": "processing", "_user_id": "user-1", "_model_id": "image2"}
    archived = {
        "id": "asset-1",
        "task_id": "task-1",
        "model_id": "image2",
        "prompt": "server-approved prompt",
        "conversation_id": "conversation-1",
        "original_url": "/api/assets/asset-1/original",
        "preview_url": "/api/assets/asset-1/preview",
        "thumb_url": "/api/assets/asset-1/thumb",
        "original_key": "assets/users/user-1/images/task-1/images/result/original.png",
        "preview_key": "assets/users/user-1/images/task-1/images/result/preview.webp",
        "thumb_key": "assets/users/user-1/images/task-1/images/result/thumb.webp",
        "width": 1536,
        "height": 1024,
        "mime_type": "image/png",
        "size_bytes": 4,
        "sha256": "digest",
    }
    complete_task = AsyncMock()
    mark_failed = AsyncMock()
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch(
        "routers.go_image2._resolve_billing_mode", new=AsyncMock(return_value="platform_credits")
    ), patch(
        "routers.go_image2.image_asset_repo.list_assets_by_task_ids", new=AsyncMock(return_value=[archived])
    ), patch(
        "routers.go_image2.task_repo._update", new=AsyncMock(return_value=True)
    ), patch(
        "routers.go_image2.task_repo.set_completed", new=complete_task
    ), patch(
        "routers.go_image2.task_repo.set_failed", new=mark_failed
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        response = await go_image2.failed(
            go_image2.FailureBody(task_id="task-1", user_id="user-1", error="callback response lost"),
            secret="test-secret",
        )

    assert response == {"ok": True, "already_finalized": True, "recovered": True}
    mark_failed.assert_not_awaited()
    completed_result = complete_task.await_args.args[1]
    assert completed_result["assetId"] == "asset-1"
    assert completed_result["go_image2_recovered"] is True
    assert completed_result["size"] == "1536x1024"


@pytest.mark.asyncio
async def test_complete_recovers_archived_output_when_finalization_lock_is_stale():
    task = {"status": "processing", "_user_id": "user-1", "_model_id": "image2"}
    archived = {
        "id": "asset-1",
        "task_id": "task-1",
        "model_id": "image2",
        "prompt": "server-approved prompt",
        "conversation_id": "",
        "original_url": "/api/assets/asset-1/original",
        "preview_url": "/api/assets/asset-1/preview",
        "thumb_url": "/api/assets/asset-1/thumb",
        "original_key": "assets/users/user-1/images/task-1/images/result/original.png",
        "preview_key": "assets/users/user-1/images/task-1/images/result/preview.webp",
        "thumb_key": "assets/users/user-1/images/task-1/images/result/thumb.webp",
        "width": 1024,
        "height": 1024,
        "mime_type": "image/png",
        "size_bytes": 4,
        "sha256": "digest",
    }
    complete_task = AsyncMock()
    store = AsyncMock()
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch("routers.go_image2._claim_finalization", new=AsyncMock(return_value=False)), patch(
        "routers.go_image2._resolve_billing_mode", new=AsyncMock(return_value="platform_credits")
    ), patch(
        "routers.go_image2.image_asset_repo.list_assets_by_task_ids", new=AsyncMock(return_value=[archived])
    ), patch(
        "routers.go_image2.task_repo._update", new=AsyncMock(return_value=True)
    ), patch(
        "routers.go_image2.task_repo.set_completed", new=complete_task
    ), patch(
        "routers.go_image2.asset_storage.store_generated_image_best_effort", new=store
    ), patch(
        "services.agents.image_generation_agent._charge_successful_call", new=AsyncMock()
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history", new=AsyncMock()
    ):
        response = await go_image2.complete(
            task_id="task-1",
            user_id="user-1",
            model_id="image2",
            prompt="extend the sky",
            size="1024x1024",
            output_resolution="1k",
            image_quality="auto",
            conversation_id="",
            source="image2_shortcut",
            reference_count=0,
            completion_id="provider-completion-1",
            billing_mode="",
            image=UploadFile(filename="result.png", file=BytesIO()),
            secret="test-secret",
        )

    assert response == {"ok": True, "already_finalized": True, "recovered": True}
    store.assert_not_awaited()
    assert complete_task.await_args.args[1]["assetId"] == "asset-1"


@pytest.mark.asyncio
async def test_complete_rejects_a_cancelled_task_before_archiving_output():
    task = {"status": "cancelled", "_user_id": "user-1", "_model_id": "image2"}
    store = AsyncMock()
    with patch.object(go_image2.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"), patch(
        "routers.go_image2.task_repo.get", new=AsyncMock(return_value=task)
    ), patch("routers.go_image2.asset_storage.store_generated_image_best_effort", new=store):
        with pytest.raises(Exception) as error:
            await go_image2.complete(
                task_id="task-1",
                user_id="user-1",
                model_id="image2",
                prompt="extend the sky",
                size="1024x1024",
                output_resolution="1k",
                image_quality="auto",
                conversation_id="",
                source="image2_shortcut",
                reference_count=0,
                completion_id="provider-completion-1",
                billing_mode="",
                image=UploadFile(filename="result.png", file=BytesIO(b"data")),
                secret="test-secret",
            )

    assert getattr(error.value, "status_code", None) == 409
    store.assert_not_awaited()


@pytest.mark.asyncio
async def test_losing_completion_transition_never_persists_history_or_self_charges():
    persist_history = AsyncMock()
    with patch(
        "routers.go_image2.task_repo._update", new=AsyncMock(return_value=True)
    ), patch(
        "routers.go_image2.task_repo.set_completed",
        new=AsyncMock(return_value=SimpleNamespace(won=False)),
    ), patch(
        "services.agents.image_generation_agent._persist_generation_history",
        new=persist_history,
    ):
        completed = await go_image2._finalize_completion(
            task_id="task-1",
            user_id="user-1",
            billing_mode="platform_credits",
            model_id="image2",
            prompt="extend the sky",
            conversation_id="",
            source="image2_shortcut",
            reference_count=0,
            stored=_stored_asset(),
            size="1024x1024",
            output_resolution="1k",
            image_quality="auto",
            completion_id="provider-completion-1",
        )

    assert completed is False
    persist_history.assert_not_awaited()
