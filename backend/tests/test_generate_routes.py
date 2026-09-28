import time

from routers.generate import _finalize_if_stale, _submit_idempotency_keys


def test_submit_idempotency_always_includes_content_fingerprint():
    base = {
        "user_id": "user-1",
        "model_id": "image-model",
        "prompt": "  draw   one cat  ",
        "size": "1024x1024",
        "n": 1,
        "llm_model_id": "llm-model",
        "vision_model_id": "vision-model",
        "conversation_id": "conversation-1",
        "source": "mobile",
        "image_hashes": ["hash-1"],
    }

    first = _submit_idempotency_keys(client_request_id="uuid-a", **base)
    second = _submit_idempotency_keys(client_request_id="uuid-b", **base)

    assert first[0] != second[0]
    assert first[-1] == second[-1]


def test_finalize_if_stale_marks_old_processing_task_failed():
    stale_task = {
        "status": "processing",
        "progress": 12,
        "error": None,
        "_start_ms": int(time.time() * 1000) - 900_000,
        "_updated_ms": int(time.time() * 1000) - 900_000,
    }
    failed_task = {
        **stale_task,
        "status": "failed",
        "error": "任务长时间未更新，已按超时结束。超过 720 秒未收到生成进度，请重试一次。",
    }

    async def _run():
        import asyncio
        from unittest.mock import AsyncMock, patch

        with patch("routers.generate.task_repo.set_failed", new=AsyncMock()) as set_failed_mock, patch(
            "routers.generate.task_repo.get", new=AsyncMock(return_value=failed_task)
        ):
            result = await _finalize_if_stale("task-stale-001", stale_task)

        assert result["status"] == "failed"
        assert "长时间未更新" in result["error"]
        set_failed_mock.assert_awaited_once()

    import asyncio

    asyncio.run(_run())


def test_delete_generate_task_releases_and_removes_task():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import delete

        task = {
            "status": "completed",
            "_user_id": "user-1",
            "result": {
                "assetId": "asset-1",
                "images": [{"assetId": "asset-1"}, {"assetId": "asset-2"}],
            },
        }
        with patch("routers.generate.task_repo.get", new=AsyncMock(return_value=task)), patch(
            "routers.generate.task_repo.delete", new=AsyncMock()
        ) as delete_mock, patch(
            "routers.generate.asset_lifecycle.create_record_cleanup_intent",
            new=AsyncMock(return_value="intent-1"),
        ) as stage_mock, patch(
            "routers.generate.asset_lifecycle.process_record_cleanup_intent",
            new=AsyncMock(return_value={"asset_rows_deleted": 2, "object_keys_deleted": 6}),
        ) as cleanup_mock:
            result = await delete("task-1", user={"id": "user-1"})

        assert result["ok"] is True
        assert result["cleanup"]["object_keys_deleted"] == 6
        delete_mock.assert_awaited_once_with("task-1")
        stage_mock.assert_awaited_once_with(
            user_id="user-1",
            records={"task_id": "task-1", "result": task["result"]},
            reason="generation-task-delete",
        )
        cleanup_mock.assert_awaited_once_with("intent-1")

    import asyncio

    asyncio.run(_run())


def test_generate_status_and_result_are_isolated_by_user():
    async def _run():
        from unittest.mock import AsyncMock, patch

        import pytest
        from fastapi import HTTPException
        from routers.generate import result, status

        task = {
            "status": "completed",
            "_user_id": "user-2",
            "result": {"imageBase64": "private-image"},
        }
        with patch("routers.generate.task_repo.get", new=AsyncMock(return_value=task)):
            with pytest.raises(HTTPException) as status_error:
                await status("task-private", user={"id": "user-1"})
            with pytest.raises(HTTPException) as result_error:
                await result("task-private", user={"id": "user-1"})

        assert status_error.value.status_code == 404
        assert result_error.value.status_code == 404

    import asyncio

    asyncio.run(_run())


def test_submit_passes_conversation_id_to_worker_payload():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        model = {"enabled": True, "category": "generate", "name": "Image Model", "price_type": "free"}
        llm_model = {"enabled": True, "category": "llm", "name": "LLM", "price_type": "free"}
        vision_model = {"enabled": True, "category": "vision", "name": "Vision", "price_type": "free"}

        async def get_model(model_id):
            return {
                "image-model": model,
                "llm-model": llm_model,
                "vision-model": vision_model,
            }.get(model_id)

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(side_effect=get_model)
        ), patch("routers.generate.conversation_repo.conversation_belongs_to_user", new=AsyncMock(return_value=True)), patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-123")
        ), patch("routers.generate._claim_submit_key", new=AsyncMock(return_value=None)), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch("routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "fast-run-123"})), patch(
            "routers.generate.update_run", new=AsyncMock()
        ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image-model",
                prompt="draw an ice pet in a 5:4 ratio",
                size="1024x1024",
                output_resolution="4k",
                image_quality="high",
                n=1,
                llm_model_id="llm-model",
                vision_model_id="vision-model",
                conversation_id="11111111-1111-1111-1111-111111111111",
                source="mobile",
                client_request_id="req-conversation",
                agent_plan='{"summary":"Preserve the character identity","answers":{"reference-priority":"identity"}}',
                images=[],
                user={"id": "user-1"},
            )

        assert result["taskId"] == "task-123"
        payload = enqueue_mock.await_args.kwargs["payload"]
        assert payload["params"]["conversation_id"] == "11111111-1111-1111-1111-111111111111"
        assert payload["params"]["source"] == "mobile"
        assert payload["params"]["user_id"] == "user-1"
        assert payload["params"]["output_resolution"] == "4k"
        assert payload["params"]["size"] == "3200x2560"
        assert payload["params"]["image_quality"] == "high"
        assert payload["params"]["agent_plan"] == {
            "summary": "Preserve the character identity",
            "answers": {"reference-priority": "identity"},
        }
        assert payload["params"]["agent_run_id"] == "fast-run-123"
        assert payload["params"]["agent_mode"] == "fast"
        assert payload["params"]["enable_visual_review"] is False
        assert result["agent_run_id"] == "fast-run-123"
        assert payload["params"]["allow_image_retry"] is True
        assert payload["params"]["max_image_attempts"] == 2
        assert enqueue_mock.await_args.kwargs["user_id"] == "user-1"

    import asyncio

    asyncio.run(_run())


def test_image2_shortcut_without_conversation_creates_durable_history_conversation():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        model = {"enabled": True, "category": "generate", "name": "Image2", "price_type": "free"}
        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch("routers.generate.task_repo.create", new=AsyncMock(return_value="task-retouch-history")), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
        ), patch("routers.generate._remember_submit_key", new=AsyncMock()), patch(
            "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "retouch-run"})
        ), patch("routers.generate.update_run", new=AsyncMock()), patch(
            "routers.generate.conversation_repo.create_conversation",
            new=AsyncMock(return_value={"id": "retouch-conversation"}),
        ) as create_conversation, patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image2",
                prompt="remove the marked object",
                size="1024x1024",
                output_resolution="1k",
                image_quality="auto",
                n=1,
                conversation_id="",
                source="mobile_retouch_image2_shortcut",
                client_request_id="req-retouch-history",
                agent_plan='{"image2_shortcut":{"operation":"remove"}}',
                images=[],
                user={"id": "user-1"},
            )

        assert result["taskId"] == "task-retouch-history"
        create_conversation.assert_awaited_once()
        payload = enqueue_mock.await_args.kwargs["payload"]
        assert payload["params"]["conversation_id"] == "retouch-conversation"

    import asyncio

    asyncio.run(_run())


def test_go_control_plane_status_read_falls_back_without_changing_task_contract():
    async def _run():
        from unittest.mock import AsyncMock, patch

        from routers import generate

        task = {"status": "processing", "_user_id": "user-1", "progress": 42}

        class Response:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return task

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, url, headers):
                assert url.endswith("/internal/v1/tasks/task-1")
                assert headers["X-Task-User-ID"] == "user-1"
                return Response()

        with patch.object(generate.settings, "GO_CONTROL_PLANE_URL", "http://go-controlplane:8082"), patch.object(
            generate.settings, "GO_CONTROL_PLANE_SHARED_SECRET", "test-secret"
        ), patch("httpx.AsyncClient", return_value=Client()), patch(
            "routers.generate.task_repo.get", new=AsyncMock()
        ) as redis_get:
            result = await generate._get_task_for_user("task-1", "user-1")

        assert result == task
        redis_get.assert_not_awaited()

    import asyncio

    asyncio.run(_run())


def test_submit_is_not_blocked_by_legacy_storage_quota():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        model = {"enabled": True, "category": "generate", "name": "Image Model", "price_type": "free"}
        quota_summary = AsyncMock(return_value={
            "quota_bytes": 1,
            "used_bytes": 1,
            "remaining_bytes": 0,
            "limit_exceeded": True,
        })

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "repositories.storage_repo.storage_summary", new=quota_summary
        ), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch(
            "routers.generate.get_default_model_id", new=AsyncMock(return_value="")
        ), patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-unlimited-storage")
        ), patch("routers.generate._claim_submit_key", new=AsyncMock(return_value=None)), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch(
            "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "run-unlimited-storage"})
        ), patch("routers.generate.update_run", new=AsyncMock()), patch(
            "routers.generate.enqueue", new=AsyncMock()
        ):
            result = await submit(
                model_id="image-model",
                prompt="draw without a user storage limit",
                size="1024x1024",
                n=1,
                llm_model_id="",
                vision_model_id="",
                conversation_id="",
                source="web",
                client_request_id="req-unlimited-storage",
                images=[],
                user={"id": "user-1"},
            )

        assert result["taskId"] == "task-unlimited-storage"
        quota_summary.assert_not_awaited()

    import asyncio

    asyncio.run(_run())


def test_image2_shortcut_disables_planning_and_visual_review():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        class StubUpload:
            async def read(self, _size=-1):
                return b"reference-image"

        model = {"enabled": True, "category": "generate", "name": "Image2", "price_type": "free"}
        default_model_mock = AsyncMock(return_value="unexpected-llm")

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch("routers.generate.get_default_model_id", new=default_model_mock), patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-image2-shortcut")
        ), patch("routers.generate._claim_submit_key", new=AsyncMock(return_value=None)), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch("routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "fast-image2-run"})), patch(
            "routers.generate.update_run", new=AsyncMock()
        ), patch(
            "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=None)
        ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image2",
                prompt="图1是干净原图，图2是定位参考图。输出比例 3:2。",
                size="1536x1024",
                output_resolution="1k",
                image_quality="auto",
                n=1,
                llm_model_id="must-be-ignored",
                vision_model_id="",
                conversation_id="",
                source="workflow_edit",
                client_request_id="req-image2-shortcut",
                agent_plan='{"image2_shortcut":{"operation":"modify"}}',
                images=[StubUpload(), StubUpload()],
                user={"id": "user-1"},
            )

        payload = enqueue_mock.await_args.kwargs["payload"]
        assert result["taskId"] == "task-image2-shortcut"
        assert payload["llm_model_id"] == ""
        assert payload["vision_model_id"] == ""
        assert payload["params"]["source"] == "workflow_edit"
        assert payload["params"]["size"] == "1536x1024"
        assert payload["params"]["agent_plan"]["image2_shortcut"]["operation"] == "modify"
        assert payload["params"]["enable_visual_review"] is False
        assert len(payload["images_bytes_b64"]) == 2
        default_model_mock.assert_not_awaited()

    import asyncio

    asyncio.run(_run())


def test_image2_shortcut_rejects_other_generate_models():
    async def _run():
        from unittest.mock import AsyncMock, patch

        import pytest
        from fastapi import HTTPException
        from routers.generate import submit

        other_model = {
            "enabled": True,
            "category": "generate",
            "name": "Flux Fill",
            "price_type": "free",
        }
        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=other_model)
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit(
                    model_id="flux-fill",
                    prompt="edit the marked region",
                    n=1,
                    source="image2_shortcut",
                    images=[],
                    user={"id": "user-1"},
                )

        assert exc_info.value.status_code == 400
        assert "image2" in str(exc_info.value.detail)

    import asyncio

    asyncio.run(_run())


def test_submit_duplicate_client_request_reuses_existing_task_without_charging():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        duplicate_payload = {
            "taskId": "task-existing",
            "cost": 8,
            "call_count": 1,
            "llm_model_id": "",
            "vision_model_id": "",
            "duplicate": True,
        }
        model = {
            "enabled": True,
            "category": "generate",
            "name": "Paid Image Model",
            "price_type": "credits",
            "price_credits": 8,
        }

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch("routers.generate.get_default_model_id", new=AsyncMock(return_value="")), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=duplicate_payload)
        ), patch(
            "routers.generate.reserve_for_task", new=AsyncMock(return_value=True)
        ) as reserve_mock, patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-new")
        ) as create_mock, patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image-model",
                prompt="draw an ice pet",
                size="1024x1024",
                n=1,
                llm_model_id="",
                vision_model_id="",
                conversation_id="",
                source="",
                client_request_id="req-1",
                images=[],
                user={"id": "user-1"},
            )

        assert result == duplicate_payload
        reserve_mock.assert_not_awaited()
        create_mock.assert_not_awaited()
        enqueue_mock.assert_not_awaited()

    import asyncio

    asyncio.run(_run())


def test_submit_workflow_edit_with_reference_uses_default_planning_model():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        class DummyUpload:
            async def read(self, _size=-1):
                return b"source-image"

        model = {"enabled": True, "category": "generate", "name": "Image Model", "price_type": "free"}
        llm_model = {"enabled": True, "category": "llm", "name": "Default LLM", "price_type": "free"}

        async def get_model(model_id):
            return {
                "image-model": model,
                "default-llm": llm_model,
            }.get(model_id)

        async def get_default_model(category):
            return "default-llm" if category == "llm" else ""

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(side_effect=get_model)
        ), patch("routers.generate.get_default_model_id", new=AsyncMock(side_effect=get_default_model)), patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-edit")
        ), patch("routers.generate._claim_submit_key", new=AsyncMock(return_value=None)), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch("routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "edit-run-1"})) as create_run_mock, patch(
            "routers.generate.update_run", new=AsyncMock()
        ), patch(
            "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=None)
        ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image-model",
                prompt="replace the car with a sci-fi bike",
                size="1024x1024",
                n=1,
                llm_model_id="",
                vision_model_id="",
                conversation_id="",
                source="workflow_edit",
                client_request_id="req-workflow-edit",
                images=[DummyUpload()],
                user={"id": "user-1"},
            )

        assert result["taskId"] == "task-edit"
        assert result["llm_model_id"] == "default-llm"
        assert result["call_count"] == 3
        assert result["review_model_id"] == "default-llm"
        assert result["vision_model_id"] == ""
        payload = enqueue_mock.await_args.kwargs["payload"]
        assert payload["llm_model_id"] == "default-llm"
        assert payload["params"]["review_model_id"] == "default-llm"
        assert payload["params"]["review_model_category"] == "llm"
        assert payload["params"]["source"] == "workflow_edit"
        assert payload["params"]["agent_run_id"] == "edit-run-1"
        assert len(payload["images_bytes_b64"]) == 1
        assert create_run_mock.await_args.kwargs["module"] == "image_edit"
        assert create_run_mock.await_args.kwargs["context"]["reference_roles"] == ["source"]

    import asyncio

    asyncio.run(_run())


def test_submit_fast_generation_reserves_existing_default_llm_review_without_planning():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        image_model = {
            "enabled": True,
            "category": "generate",
            "name": "Paid Image Model",
            "price_type": "credits",
            "price_credits": 2,
        }
        review_model = {
            "enabled": True,
            "category": "llm",
            "name": "Multimodal LLM",
            "price_type": "credits",
            "price_credits": 1,
        }

        async def get_model(model_id):
            return {
                "image-model": image_model,
                "default-llm": review_model,
            }.get(model_id)

        async def get_default_model(category):
            return "default-llm" if category == "llm" else ""

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(side_effect=get_model)
        ), patch(
            "routers.generate.get_default_model_id", new=AsyncMock(side_effect=get_default_model)
        ), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
        ), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch(
            "routers.generate.reserve_for_task", new=AsyncMock(return_value=True)
        ) as reserve_mock, patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-fast")
        ), patch(
            "routers.generate.create_module_run", new=AsyncMock(return_value={"run_id": "run-fast"})
        ), patch(
            "routers.generate.update_run", new=AsyncMock()
        ), patch(
            "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=None)
        ), patch("routers.generate.enqueue", new=AsyncMock()) as enqueue_mock:
            result = await submit(
                model_id="image-model",
                prompt="draw a product hero",
                size="1024x1024",
                n=1,
                llm_model_id="",
                vision_model_id="",
                conversation_id="",
                source="workflow_text",
                client_request_id="req-fast-review",
                images=[],
                user={"id": "user-1"},
            )

        assert result["llm_model_id"] == ""
        assert result["vision_model_id"] == ""
        assert result["review_model_id"] == "default-llm"
        assert result["cost"] == 3
        assert result["call_count"] == 2
        assert reserve_mock.await_args.args[2] == 3
        payload = enqueue_mock.await_args.kwargs["payload"]
        assert payload["llm_model_id"] == ""
        assert payload["params"]["review_model_id"] == "default-llm"
        assert payload["params"]["review_model_category"] == "llm"

    import asyncio

    asyncio.run(_run())


def test_submit_creative_count_is_capped_and_charged_per_image():
    async def _run():
        from unittest.mock import AsyncMock, patch
        from routers.generate import submit

        model = {
            "enabled": True,
            "category": "generate",
            "name": "Paid Image Model",
            "price_type": "credits",
            "price_credits": 2,
        }
        llm_model = {
            "enabled": True,
            "category": "llm",
            "name": "Paid LLM",
            "price_type": "credits",
            "price_credits": 1,
        }
        async def get_model(model_id):
            return {
                "image-model": model,
                "llm-model": llm_model,
            }.get(model_id)

        async def get_default_model(category):
            return ""

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(side_effect=get_model)
        ), patch("routers.generate.get_default_model_id", new=AsyncMock(side_effect=get_default_model)), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
        ), patch(
            "routers.generate._remember_submit_key", new=AsyncMock()
        ), patch("routers.generate.reserve_for_task", new=AsyncMock(return_value=True)) as reserve_mock, patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-count")
        ) as create_mock, patch(
            "routers.generate.enqueue", new=AsyncMock()
        ) as enqueue_mock:
            result = await submit(
                model_id="image-model",
                prompt="creative variants",
                size="1024x1024",
                n=8,
                llm_model_id="llm-model",
                vision_model_id="",
                conversation_id="",
                source="workflow_text",
                client_request_id="req-count",
                images=[],
                user={"id": "user-1"},
            )

        # Three requested images each receive one visual QA call in addition
        # to the single planning call.  The reservation must cover the exact
        # seven upstream operations before the task enters the queue.
        assert result["cost"] == 10
        assert result["call_count"] == 7
        reserve_args = reserve_mock.await_args.args
        assert reserve_args[0] == "user-1"
        assert reserve_args[2] == 10
        assert reserve_args[1] == create_mock.await_args.kwargs["task_id"]
        payload = enqueue_mock.await_args.kwargs["payload"]
        assert payload["params"]["n"] == 3
        assert payload["params"]["review_model_id"] == "llm-model"
        assert payload["params"]["review_model_category"] == "llm"

    import asyncio

    asyncio.run(_run())


def test_submit_releases_reserved_credits_when_user_concurrency_exceeded():
    async def _run():
        from unittest.mock import AsyncMock, patch

        import pytest
        from fastapi import HTTPException
        from core.queue import UserConcurrencyExceeded
        from routers.generate import submit

        model = {
            "enabled": True,
            "category": "generate",
            "name": "Paid Image Model",
            "price_type": "credits",
            "price_credits": 8,
        }

        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch("routers.generate.get_default_model_id", new=AsyncMock(return_value="")), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
        ), patch(
            "routers.generate._forget_submit_key", new=AsyncMock()
        ), patch("routers.generate.reserve_for_task", new=AsyncMock(return_value=True)) as reserve_mock, patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-123")
        ), patch("routers.generate.task_repo.set_failed", new=AsyncMock()) as failed_mock, patch(
            "routers.generate.enqueue",
            new=AsyncMock(side_effect=UserConcurrencyExceeded("user-1", 10, 10)),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit(
                    model_id="image-model",
                    prompt="draw an ice pet",
                    size="1024x1024",
                    n=1,
                    llm_model_id="",
                    vision_model_id="",
                    conversation_id="",
                    source="",
                    client_request_id="req-2",
                    images=[],
                    user={"id": "user-1"},
                )

        assert exc_info.value.status_code == 429
        reserve_mock.assert_awaited_once()
        failed_mock.assert_awaited_once_with("task-123", "当前生成任务过多，请等待已有任务完成或清理后再提交")

    import asyncio

    asyncio.run(_run())


def test_submit_releases_persisted_queue_inputs_when_enqueue_is_rejected():
    async def _run():
        from unittest.mock import AsyncMock, patch

        import pytest
        from core.queue import QueueCapacityExceeded
        from routers.generate import submit

        model = {
            "enabled": True,
            "category": "generate",
            "name": "Paid Image Model",
            "price_type": "credits",
            "price_credits": 8,
        }
        stored_inputs = [{
            "role": "source",
            "file_asset_id": "file-input",
            "key": "assets/users/user-1/queue-inputs/task-123/files/00-source-input.png",
        }]
        release_inputs = AsyncMock()
        with patch("routers.generate.rate_limit", new=AsyncMock()), patch(
            "routers.generate.model_repo.get_model", new=AsyncMock(return_value=model)
        ), patch("routers.generate.get_default_model_id", new=AsyncMock(return_value="")), patch(
            "routers.generate._claim_submit_key", new=AsyncMock(return_value=None)
        ), patch(
            "routers.generate._forget_submit_key", new=AsyncMock()
        ), patch("routers.generate.reserve_for_task", new=AsyncMock(return_value=True)), patch(
            "routers.generate.task_repo.create", new=AsyncMock(return_value="task-123")
        ), patch("routers.generate.task_repo.set_failed", new=AsyncMock()) as failed_mock, patch(
            "routers.generate.queue_assets.persist_queue_inputs", new=AsyncMock(return_value=stored_inputs)
        ), patch(
            "routers.generate.queue_assets.release_consumed_queue_inputs", new=release_inputs
        ), patch(
            "routers.generate.enqueue", new=AsyncMock(side_effect=QueueCapacityExceeded(100, 100))
        ):
            with pytest.raises(QueueCapacityExceeded):
                await submit(
                    model_id="image-model",
                    prompt="draw an ice pet",
                    size="1024x1024",
                    n=1,
                    llm_model_id="",
                    vision_model_id="",
                    conversation_id="",
                    source="",
                    client_request_id="req-queue-full",
                    images=[],
                    user={"id": "user-1"},
                )

        failed_mock.assert_awaited_once_with("task-123", "任务提交失败，已释放预占积分")
        release_call = release_inputs.await_args.kwargs
        assert release_call["user_id"] == "user-1"
        assert release_call["payload"]["image_assets"] == stored_inputs

    import asyncio

    asyncio.run(_run())
