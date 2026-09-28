import asyncio
import json
from unittest.mock import ANY, AsyncMock, MagicMock

import pytest

from services.ai_client import _call_grok_video


def _response(payload: dict):
    response = MagicMock()
    response.is_success = True
    response.status_code = 200
    response.text = json.dumps(payload)
    response.json = MagicMock(return_value=payload)
    return response


def _client(post_response, get_response):
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(return_value=post_response)
    client.get = AsyncMock(return_value=get_response)
    return client


def test_grok_video_polls_async_request_id_from_create_response():
    async def run():
        client = _client(
            _response({"request_id": "video-request-123"}),
            _response({"status": "completed", "video": {"url": "https://media.example/video.mp4"}}),
        )
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
            )

        assert result == b"video-bytes"
        assert client.post.await_args.args[0] == "https://foxapi.cn/v1/videos/generations"
        assert client.post.await_args.kwargs["json"] == {
            "model": "grok-imagine-video",
            "prompt": "A small red square on a white background",
            "duration": 1,
            "image": {"url": "https://assets.example/reference.png"},
        }
        assert client.get.await_args.args[0] == "https://foxapi.cn/v1/videos/video-request-123"
        download.assert_awaited_once_with("https://media.example/video.mp4", {"Authorization": "Bearer test-key"})

    asyncio.run(run())


def test_grok_video_accepts_nested_completed_result():
    async def run():
        client = _client(
            _response({"request_id": "video-request-123"}),
            _response({
                "data": {
                    "state": "done",
                    "result": {"download_url": "https://media.example/video.mp4"},
                },
            }),
        )
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
            )

        assert result == b"video-bytes"
        download.assert_awaited_once_with("https://media.example/video.mp4", {"Authorization": "Bearer test-key"})

    asyncio.run(run())


def test_grok_video_resumes_saved_request_without_submitting_again():
    async def run():
        client = _client(
            _response({"unexpected": True}),
            _response({"status": "completed", "video": {"url": "https://media.example/video.mp4"}}),
        )
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")
        persist_request_id = AsyncMock()

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
                provider_request_id="video-request-123",
                on_provider_request_id=persist_request_id,
            )

        assert result == b"video-bytes"
        client.post.assert_not_awaited()
        client.get.assert_awaited_once_with(
            "https://foxapi.cn/v1/videos/video-request-123",
            headers={"Authorization": "Bearer test-key"},
            timeout=ANY,
        )
        persist_request_id.assert_not_awaited()

    asyncio.run(run())


def test_grok_video_accepts_url_in_a_nested_string_field():
    async def run():
        client = _client(
            _response({"request_id": "video-request-123"}),
            _response({"data": {"state": "complete", "video": "https://media.example/video.mp4"}}),
        )
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
            )

        assert result == b"video-bytes"
        download.assert_awaited_once_with("https://media.example/video.mp4", {"Authorization": "Bearer test-key"})

    asyncio.run(run())


def test_grok_video_resolves_relative_download_url_against_provider_endpoint():
    async def run():
        client = _client(
            _response({"request_id": "video-request-123"}),
            _response({
                "status": "completed",
                "video": {"url": "/v1/videos/video-request-123/content"},
            }),
        )
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
            )

        assert result == b"video-bytes"
        download.assert_awaited_once_with(
            "https://foxapi.cn/v1/videos/video-request-123/content",
            {"Authorization": "Bearer test-key"},
        )

    asyncio.run(run())


def test_grok_video_keeps_polling_after_an_empty_202_response():
    async def run():
        client = _client(
            _response({"request_id": "video-request-123"}),
            _response({"status": "completed", "video": {"url": "https://media.example/video.mp4"}}),
        )
        empty_response = MagicMock()
        empty_response.is_success = True
        empty_response.status_code = 202
        empty_response.text = ""
        client.get = AsyncMock(side_effect=[empty_response, client.get.return_value])
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "test-key",
            "meta": {"model_name": "grok-imagine-video", "api_mode": "grok_video"},
        }
        download = AsyncMock(return_value=b"video-bytes")

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            patch.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            patch.setattr("services.ai_client._download_bytes", download)
            result = await _call_grok_video(
                model,
                "A small red square on a white background",
                duration=1,
                reference_image_url="https://assets.example/reference.png",
            )

        assert result == b"video-bytes"
        assert client.get.await_count == 2
        download.assert_awaited_once_with("https://media.example/video.mp4", {"Authorization": "Bearer test-key"})

    asyncio.run(run())
