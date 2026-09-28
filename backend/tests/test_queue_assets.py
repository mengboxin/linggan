import asyncio
from unittest.mock import AsyncMock, patch

from services import queue_assets


def test_queue_inputs_use_distinct_object_keys_for_duplicate_upload_names():
    async def run() -> None:
        stored = AsyncMock(side_effect=[
            {"id": "file-1", "key": "assets/users/user/queue-inputs/task/files/00-reference-image.png", "size_bytes": 3},
            {"id": "file-2", "key": "assets/users/user/queue-inputs/task/files/01-reference-image.png", "size_bytes": 3},
        ])
        with patch("services.queue_assets.asset_storage.is_asset_storage_enabled", return_value=True), patch(
            "services.queue_assets.asset_storage.store_file_bytes", new=stored
        ):
            refs = await queue_assets.persist_queue_inputs(
                user_id="user", task_id="task", inputs=[
                    {"role": "reference", "data": b"one", "filename": "image.png", "content_type": "image/png"},
                    {"role": "reference", "data": b"two", "filename": "image.png", "content_type": "image/png"},
                ],
            )
        assert refs and [item["key"] for item in refs] == [
            "assets/users/user/queue-inputs/task/files/00-reference-image.png",
            "assets/users/user/queue-inputs/task/files/01-reference-image.png",
        ]
        assert [call.kwargs["filename"] for call in stored.await_args_list] == [
            "00-reference-image.png", "01-reference-image.png",
        ]
        assert all(call.kwargs["retention_class"] == "temporary" for call in stored.await_args_list)

    asyncio.run(run())


def test_queue_inputs_release_already_stored_references_when_a_later_upload_fails():
    async def run() -> None:
        stored = AsyncMock(side_effect=[
            {"id": "file-1", "key": "assets/users/user/queue-inputs/task/files/00-image-image.png", "size_bytes": 3},
            None,
        ])
        release = AsyncMock(return_value={"released": 1, "deferred": False})
        with patch("services.queue_assets.asset_storage.is_asset_storage_enabled", return_value=True), patch(
            "services.queue_assets.asset_storage.store_file_bytes", new=stored
        ), patch("services.queue_assets.release_consumed_queue_inputs", new=release):
            try:
                await queue_assets.persist_queue_inputs(
                    user_id="user",
                    task_id="task",
                    inputs=[
                        {"role": "image", "data": b"one", "filename": "image.png", "content_type": "image/png"},
                        {"role": "mask", "data": b"two", "filename": "mask.png", "content_type": "image/png"},
                    ],
                )
            except RuntimeError as exc:
                assert str(exc) == "failed to store queue input mask"
            else:
                raise AssertionError("expected the failed queue input upload to propagate")

        release.assert_awaited_once_with(
            user_id="user",
            payload={
                "queue_input_assets": [{
                    "role": "image",
                    "file_asset_id": "file-1",
                    "key": "assets/users/user/queue-inputs/task/files/00-image-image.png",
                    "content_type": "image/png",
                    "size_bytes": 3,
                }],
            },
        )

    asyncio.run(run())


def test_consumed_queue_inputs_create_a_durable_cleanup_intent():
    async def run() -> None:
        create_intent = AsyncMock(return_value="cleanup-1")
        process_intent = AsyncMock(return_value={"deleted_file_ids": ["file-1"]})
        with patch("services.asset_lifecycle.create_record_cleanup_intent", new=create_intent), patch(
            "services.asset_lifecycle.process_record_cleanup_intent", new=process_intent
        ):
            result = await queue_assets.release_consumed_queue_inputs(
                user_id="user-1",
                payload={
                    "image_asset": {
                        "file_asset_id": "file-1",
                        "key": "assets/users/user/queue-inputs/task/files/image.png",
                    },
                    "mask_asset": {
                        "file_asset_id": "file-2",
                        "key": "assets/users/user/queue-inputs/task/files/mask.png",
                    },
                    "prompt": "replace the icon",
                },
            )

        assert result == {"deleted_file_ids": ["file-1"]}
        create_intent.assert_awaited_once_with(
            user_id="user-1",
            records={
                "queue_inputs": [
                    {
                        "file_asset_id": "file-1",
                        "storage_key": "assets/users/user/queue-inputs/task/files/image.png",
                    },
                    {
                        "file_asset_id": "file-2",
                        "storage_key": "assets/users/user/queue-inputs/task/files/mask.png",
                    },
                ],
            },
            reason="queue-input-consumed",
        )
        process_intent.assert_awaited_once_with("cleanup-1")

    asyncio.run(run())


def test_queue_input_reference_must_stay_in_owning_user_prefix():
    async def run() -> None:
        with patch("services.queue_assets.asset_storage.user_asset_prefix", return_value="assets/users/owner"), patch(
            "services.queue_assets.asset_storage.fetch_asset_key_bytes", new=AsyncMock()
        ) as fetch:
            result = await queue_assets.load_queue_input(
                {"key": "assets/users/owner/queue-inputs/task/files/image.png"}, "owner"
            )
            fetch.assert_awaited_once()
            assert result == fetch.return_value

    asyncio.run(run())
