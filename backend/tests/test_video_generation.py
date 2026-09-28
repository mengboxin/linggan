from unittest.mock import AsyncMock

import pytest

import services.video_generation as video_generation


def _payload():
    return {
        "model_id": "grok-imagine-video",
        "prompt": "A quiet red square on a white background",
        "params": {"user_id": "user-1", "duration": 6, "source": "canvas_flow"},
        "image_assets": [{
            "role": "reference",
            "key": "assets/users/user1/input.png",
        }],
    }


def _patch_storage(monkeypatch):
    monkeypatch.setattr(video_generation.asset_storage, "asset_delivery_url", lambda key: f"https://assets.example/{key}")
    monkeypatch.setattr(
        video_generation.asset_storage,
        "store_file_bytes",
        AsyncMock(return_value={"url": "https://assets.example/video.mp4", "id": "asset-1"}),
    )


@pytest.mark.asyncio
async def test_run_video_generation_resumes_saved_provider_request(monkeypatch):
    monkeypatch.setattr(video_generation.task_repo, "get", AsyncMock(return_value={
        "status": "processing",
        "_provider_request_id": "provider-request-1",
    }))
    monkeypatch.setattr(video_generation.task_repo, "set_processing", AsyncMock())
    monkeypatch.setattr(video_generation.task_repo, "set_progress", AsyncMock())
    monkeypatch.setattr(video_generation.task_repo, "set_completed", AsyncMock())
    _patch_storage(monkeypatch)
    call_video = AsyncMock(return_value=b"video-bytes")
    monkeypatch.setattr(video_generation, "call_video", call_video)

    await video_generation.run_video_generation("task-1", _payload())

    assert call_video.await_args.kwargs["provider_request_id"] == "provider-request-1"


@pytest.mark.asyncio
async def test_run_video_generation_persists_provider_request_before_polling(monkeypatch):
    monkeypatch.setattr(video_generation.task_repo, "get", AsyncMock(return_value={
        "status": "processing",
        "_provider_request_id": "",
    }))
    monkeypatch.setattr(video_generation.task_repo, "set_processing", AsyncMock())
    monkeypatch.setattr(video_generation.task_repo, "set_progress", AsyncMock())
    monkeypatch.setattr(video_generation.task_repo, "set_completed", AsyncMock())
    persist_request_id = AsyncMock(return_value=True)
    monkeypatch.setattr(video_generation.task_repo, "set_provider_request_id", persist_request_id)
    _patch_storage(monkeypatch)

    async def fake_call_video(*_args, on_provider_request_id, **_kwargs):
        await on_provider_request_id("provider-request-2")
        return b"video-bytes"

    monkeypatch.setattr(video_generation, "call_video", fake_call_video)

    await video_generation.run_video_generation("task-1", _payload())

    persist_request_id.assert_awaited_once_with("task-1", "provider-request-2")
