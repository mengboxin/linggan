import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
import services.ai_client as ai_client

from services.ai_client import (
    ExternalBillingError,
    ImageSafetyBlockedError,
    _ResponsesGatewayError,
    _call_openai_responses_text,
    _call_openai_responses_image_generation,
    call_chat,
    call_image,
    call_text_messages,
    call_vision,
    get_default_model_id,
)


# ─── 流式 mock 辅助 ───

def _make_stream_response(*, is_success=True, status_code=200, content_type="text/event-stream", body=b"", headers=None):
    """构造 httpx stream() 返回的响应 mock。"""
    resp = MagicMock()
    resp.is_success = is_success
    resp.status_code = status_code
    resp.headers = headers or {"content-type": content_type}
    async def _aread():
        return body

    resp.aread = _aread

    # aiter_lines: 逐行返回 body 内容
    async def _aiter_lines():
        for raw_line in body.split(b"\n"):
            yield raw_line.decode(errors="replace")

    resp.aiter_lines = _aiter_lines
    return resp


def _make_stream_ctx(response):
    """构造 client.stream() 的 async context manager mock。"""
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=response)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return ctx


def _make_json_response(*, is_success=True, status_code=200, body=None, headers=None):
    resp = MagicMock()
    resp.is_success = is_success
    resp.status_code = status_code
    resp.headers = headers or {"content-type": "application/json"}
    payload = body if body is not None else {}
    import json
    resp.text = json.dumps(payload)
    resp.json = MagicMock(return_value=payload)
    return resp


def _make_client(*, stream_response=None, get_response=None, post_response=None):
    """构造 httpx.AsyncClient mock，支持 stream / post / get。"""
    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    if stream_response is not None:
        client.stream = MagicMock(return_value=_make_stream_ctx(stream_response))

    if get_response is not None:
        client.get = AsyncMock(return_value=get_response)

    if post_response is not None:
        client.post = AsyncMock(return_value=post_response)

    return client


def _sse_bytes(events: list[dict]) -> bytes:
    """把多个 JSON 事件编码为 SSE 格式 bytes。"""
    import json
    parts = []
    for event in events:
        parts.append(f"data: {json.dumps(event)}")
    parts.append("data: [DONE]")
    return "\n".join(parts).encode()


# ─── 测试 ───

def test_responses_image_generation_streaming_success():
    """流式调用成功返回图像。"""
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        stream_resp = _make_stream_response(body=_sse_bytes([completed]))
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"
        # 验证 payload 包含 stream: True
        call_kwargs = client.stream.call_args
        assert call_kwargs.kwargs["json"]["stream"] is True
        assert call_kwargs.kwargs["json"]["tools"] == [{"type": "image_generation", "action": "generate"}]
        assert call_kwargs.kwargs["json"]["tool_choice"] == {"type": "image_generation"}

    asyncio.run(_run())


def test_responses_image_generation_streaming_with_reasoning_ignores_background():
    """流式 + reasoning；图片路径不再启用 background 轮询。"""
    async def _run():
        created = {"id": "resp_123", "status": "in_progress"}
        completed = {
            "id": "resp_123",
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        # The stream stays open from in_progress through completed.
        stream_resp = _make_stream_response(body=_sse_bytes([created, completed]))
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {
                "use_openai_responses_image_generation": True,
                "responses_model": "gpt-5.5",
                "responses_reasoning_effort": "medium",
                "responses_background": True,
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            mp.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"
        payload = client.stream.call_args.kwargs["json"]
        assert "background" not in payload
        assert payload["stream"] is True
        assert payload["tools"] == [{"type": "image_generation", "action": "generate"}]
        assert payload["reasoning"] == {"effort": "medium"}
        client.get.assert_not_called()

    asyncio.run(_run())


def test_responses_image_generation_streaming_html_gateway_error():
    """流式调用遇到 HTML 错误页。"""
    async def _run():
        error_body = b"<!DOCTYPE html><html><body>Bad Gateway</body></html>"
        stream_resp = _make_stream_response(
            is_success=False, status_code=502, body=error_body,
            headers={"content-type": "text/html"},
        )
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(_ResponsesGatewayError, match="HTML error page"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

    asyncio.run(_run())


def test_responses_image_generation_billing_403_has_clear_error():
    async def _run():
        stream_resp = _make_stream_response(
            is_success=False,
            status_code=403,
            headers={"content-type": "application/json"},
            body=b'{"error":{"message":"insufficient balance","type":"billing_error"}}',
        )
        client = _make_client(stream_response=stream_resp)
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(ExternalBillingError, match="算力 API 余额不足"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

    asyncio.run(_run())


def test_responses_image_generation_rejects_non_streaming_response():
    """Responses image generation must remain SSE end to end."""
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        import json
        stream_resp = _make_stream_response(
            content_type="application/json",
            body=json.dumps(completed).encode(),
        )
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://old-proxy.example/v1/images/generations",
            "api_key": "sk-test",
            "meta": {
                "use_openai_responses_image_generation": True,
                "responses_model": "gpt-5.5",
                "responses_endpoint": "https://responses-proxy.example/v1/responses",
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="requires an SSE response"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert client.stream.call_args.args[1] == "https://responses-proxy.example/v1/responses"

    asyncio.run(_run())


def test_responses_text_retries_a_temporary_503_before_succeeding():
    async def _run():
        unavailable = _make_stream_response(
            is_success=False,
            status_code=503,
            headers={"content-type": "application/json"},
            body=b'{"error":{"message":"Service temporarily unavailable"}}',
        )
        completed = _make_stream_response(body=_sse_bytes([{
            "status": "completed",
            "output_text": "planned prompt",
        }]))
        client = _make_client()
        client.stream = MagicMock(side_effect=[
            _make_stream_ctx(unavailable),
            _make_stream_ctx(completed),
        ])
        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            mp.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            result = await _call_openai_responses_text(model, [{"role": "user", "content": "plan"}])

        assert result == "planned prompt"
        assert client.stream.call_count == 2

    asyncio.run(_run())


def test_external_image_model_uses_responses_stream_and_tracks_usage():
    async def _run():
        from services.foxapi_credentials import build_runtime_model

        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        client = _make_client(stream_response=_make_stream_response(body=_sse_bytes([completed])))
        model = build_runtime_model(
            [{"id": "gpt-image-2", "display_name": "GPT Image 2"}],
            runtime_model_id="foxapi:generate:gpt-image-2",
            api_base="https://foxapi.cn/v1",
            key_fingerprint="a" * 64,
            api_key="user-key",
            user_id="user-1",
        )
        assert model is not None
        record_usage = AsyncMock()

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            mp.setattr("services.ai_client.foxapi_credentials.record_usage", record_usage)
            result = await call_image(
                model["id"],
                "draw a poster",
                None,
                "1536x1024",
                quality="high",
            )

        assert result == b"png-bytes"
        assert client.stream.call_args.args[:2] == ("POST", "https://foxapi.cn/v1/responses")
        assert client.stream.call_args.kwargs["headers"]["Authorization"] == "Bearer user-key"
        assert client.stream.call_args.kwargs["json"] == {
            "model": "gpt-5.5",
            "input": "draw a poster",
            "tools": [{
                "type": "image_generation",
                "action": "generate",
                "size": "1536x1024",
                "quality": "high",
            }],
            "tool_choice": {"type": "image_generation"},
            "stream": True,
        }
        client.post.assert_not_awaited()
        record_usage.assert_awaited_once_with(
            "user-1",
            "gpt-image-2",
            success=True,
            error="",
            api_key="user-key",
        )

    asyncio.run(_run())


def test_call_image_ignores_legacy_images_mode_and_uses_responses_sse():
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        client = _make_client(stream_response=_make_stream_response(body=_sse_bytes([completed])))
        model = {
            "id": "foxapi:generate:gpt-image-2",
            "category": "generate",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "user-key",
            "meta": {
                "model_name": "gpt-image-2",
                "responses_model": "gpt-5.5",
                "api_mode": "images",
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_image(model["id"], "draw a poster", None, "1024x1024")

        assert result == b"png-bytes"
        assert client.stream.call_args.args[1] == "https://foxapi.cn/v1/responses"
        assert client.stream.call_args.kwargs["json"]["stream"] is True
        client.post.assert_not_awaited()

    asyncio.run(_run())


def test_responses_image_generation_forwards_requested_size_and_quality():
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        stream_resp = _make_stream_response(body=_sse_bytes([completed]))
        client = _make_client(stream_response=stream_resp)
        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.6", "responses_image_size": "1024x1024"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(
                model,
                "draw",
                [],
                "3840x2160",
                quality="high",
                force_size=True,
            )

        assert result == b"png-bytes"
        assert client.stream.call_args.kwargs["json"]["tools"] == [{
            "type": "image_generation",
            "action": "generate",
            "size": "3840x2160",
            "quality": "high",
        }]

    asyncio.run(_run())


def test_call_image_applies_prompt_resolution_and_ratio_at_the_provider_boundary():
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        client = _make_client(stream_response=_make_stream_response(body=_sse_bytes([completed])))
        model = {
            "id": "image-model",
            "category": "generate",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "provider": "FoxAPI",
            "meta": {
                "model_name": "gpt-image-2",
                "responses_model": "gpt-5.5",
                "external_api_key": True,
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_image(
                "image-model",
                "按 5：4 比例输出 4K 图片",
                None,
                "1024x1024",
                force_size=True,
            )

        assert result == b"png-bytes"
        assert "exactly 5:4 aspect ratio" in client.stream.call_args.kwargs["json"]["input"]
        assert "Target output clarity: 4K" in client.stream.call_args.kwargs["json"]["input"]
        assert client.stream.call_args.kwargs["json"]["tools"] == [{
            "type": "image_generation",
            "action": "generate",
            "size": "1536x1024",
            "quality": "high",
        }]

    asyncio.run(_run())


def test_foxapi_responses_maps_selected_square_4k_to_native_tool_size():
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        client = _make_client(stream_response=_make_stream_response(body=_sse_bytes([completed])))
        model = {
            "id": "foxapi:generate:gpt-image-2",
            "category": "generate",
            "endpoint": "https://foxapi.cn/v1",
            "provider": "FoxAPI",
            "api_key": "sk-test",
            "meta": {
                "model_name": "gpt-image-2",
                "responses_model": "gpt-5.5",
                "external_api_key": True,
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_image(
                model["id"],
                "生成一张正方形图片",
                None,
                "2880x2880",
                force_size=True,
            )

        assert result == b"png-bytes"
        assert "exactly 1:1 aspect ratio" in client.stream.call_args.kwargs["json"]["input"]
        assert "Target output clarity: 4K" in client.stream.call_args.kwargs["json"]["input"]
        assert client.stream.call_args.kwargs["json"]["tools"] == [{
            "type": "image_generation",
            "action": "generate",
            "size": "1024x1024",
            "quality": "high",
        }]

    asyncio.run(_run())


def test_responses_image_generation_normalizes_image_model_to_text_responses_model():
    """Sub2API image generation must use a text Responses model plus the tool."""
    async def _run():
        completed = {
            "status": "completed",
            "output": [{"type": "image_generation_call", "result": "cG5nLWJ5dGVz"}],
        }
        stream_resp = _make_stream_response(body=_sse_bytes([completed]))
        client = _make_client(stream_response=stream_resp)

        model = {
            "id": "chat-gpt-image2",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"model_name": "gpt-image-2", "responses_model": "gpt-image-2"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"
        payload = client.stream.call_args.kwargs["json"]
        assert payload["model"] == "gpt-5.5"
        assert payload["tools"] == [{"type": "image_generation", "action": "generate"}]
        assert payload["stream"] is True
        assert client.stream.call_args.args[1] == "https://foxapi.cn/v1/responses"

    asyncio.run(_run())


def test_responses_image_generation_stream_incomplete_raises():
    """流式响应没有 completed 事件，抛出错误。"""
    async def _run():
        # 只有 in_progress 事件，没有 completed
        stream_resp = _make_stream_response(body=_sse_bytes([{"status": "in_progress"}]))
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="status=in_progress"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

    asyncio.run(_run())


def test_responses_image_generation_stream_recovers_image_from_output_item_done():
    """某些代理只在 output_item.done 事件里给出图片结果，也要能正确取到。"""
    async def _run():
        events = [
            {"type": "response.created", "response": {"id": "resp_123", "status": "in_progress"}},
            {
                "type": "response.output_item.done",
                "item": {"type": "image_generation_call", "result": "cG5nLWJ5dGVz"},
            },
            {"type": "response.completed", "response": {"id": "resp_123", "status": "completed"}},
        ]
        stream_resp = _make_stream_response(body=_sse_bytes(events))
        client = _make_client(stream_response=stream_resp)

        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"

    asyncio.run(_run())


def test_responses_image_generation_result_is_not_blocked_by_revised_prompt_text():
    result = ai_client._extract_responses_image_bytes({
        "id": "resp_with_image",
        "status": "completed",
        "output": [
            {
                "type": "image_generation_call",
                "status": "completed",
                "result": "cG5nLWJ5dGVz",
                "revised_prompt": "A cinematic scene with violence mentioned in the descriptive metadata",
            },
        ],
    })

    assert result == b"png-bytes"


def test_responses_image_generation_result_is_not_blocked_by_output_text():
    result = ai_client._extract_responses_image_bytes({
        "id": "resp_with_image_text_echo",
        "status": "completed",
        "output_text": "The request includes a constraint to avoid violence.",
        "output": [
            {
                "type": "image_generation_call",
                "status": "completed",
                "result": "cG5nLWJ5dGVz",
            },
        ],
    })

    assert result == b"png-bytes"


def test_responses_image_generation_stream_recovers_gateway_partial_image_without_final_result():
    """Some gateways only emit image bytes in the partial-image SSE event."""
    async def _run():
        events = [
            {"type": "response.created", "response": {"id": "resp_partial", "status": "in_progress"}},
            {
                "type": "response.output_item.added",
                "item": {"id": "img_call_1", "type": "image_generation_call", "status": "in_progress"},
            },
            {
                "type": "response.image_generation_call.partial_image",
                "item_id": "img_call_1",
                "partial_image_b64": "cG5nLWJ5dGVz",
            },
            {
                "type": "response.output_item.done",
                "item": {"id": "img_call_1", "type": "image_generation_call", "status": "completed"},
            },
            {"type": "response.completed", "response": {"id": "resp_partial", "status": "completed", "output": [{"type": "message"}]}},
        ]
        stream_resp = _make_stream_response(body=_sse_bytes(events))
        client = _make_client(stream_response=stream_resp)
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"

    asyncio.run(_run())



def test_responses_image_generation_failed_call_without_safety_marker_is_not_misclassified():
    async def _run():
        events = [
            {"type": "response.output_text.delta", "delta": "??????????????"},
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_blocked",
                    "status": "completed",
                    "output": [
                        {"type": "message"},
                        {"type": "image_generation_call", "status": "failed"},
                        {"type": "message"},
                    ],
                },
            },
        ]
        stream_resp = _make_stream_response(body=_sse_bytes(events))
        get_resp = _make_stream_response(
            is_success=False,
            status_code=404,
            headers={"content-type": "text/plain"},
            body=b"404 page not found",
        )
        client = _make_client(stream_response=stream_resp, get_response=get_resp)
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="未返回可用图片数据"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        client.get.assert_not_called()

    asyncio.run(_run())


def test_responses_text_only_safety_phrase_is_not_reclassified_as_a_safety_block():
    """A completed upstream response without image data is not a local moderation verdict."""
    data = {
        "status": "completed",
        "output": [
            {"type": "image_generation_call", "status": "completed"},
            {"type": "message"},
        ],
        "_stream_text": "The service could not return an image after a safety-related internal error.",
    }

    with pytest.raises(RuntimeError, match="did not return image data") as error:
        ai_client._extract_responses_image_bytes(data)

    assert not isinstance(error.value, ImageSafetyBlockedError)


def test_safety_classification_requires_an_explicit_provider_policy_code():
    assert not ai_client._is_image_safety_block({"message": "safety-related internal error"})
    assert ai_client._is_image_safety_block({"error": {"code": "content_policy_violation"}})


def test_responses_stream_message_does_not_create_a_local_safety_block():
    async def _run():
        events = [
            {"type": "response.output_text.delta", "delta": "抱歉，这个请求被图像安全系统拦截了，原因是城市毁灭。"},
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_blocked",
                    "status": "completed",
                    "output": [
                        {"type": "message"},
                        {"type": "image_generation_call", "status": "failed"},
                        {"type": "message"},
                    ],
                },
            },
        ]
        stream_resp = _make_stream_response(body=_sse_bytes(events))
        client = _make_client(stream_response=stream_resp)
        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="未返回可用图片数据") as error:
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert not isinstance(error.value, ImageSafetyBlockedError)

    asyncio.run(_run())


def test_responses_image_generation_failed_status_preserves_safety_block():
    with pytest.raises(ImageSafetyBlockedError, match="提示词被图像安全系统拦截"):
        ai_client._extract_responses_image_bytes({
            "id": "resp_failed",
            "status": "failed",
            "error": {
                "code": "content_policy_violation",
                "message": "Your request was blocked by the safety system.",
            },
            "output": [],
        })


def test_responses_image_generation_http_safety_error_has_clear_error():
    async def _run():
        stream_resp = _make_stream_response(
            is_success=False,
            status_code=400,
            headers={"content-type": "application/json"},
            body=b'{"error":{"code":"content_policy_violation","message":"Request blocked by safety policy"}}',
        )
        client = _make_client(stream_response=stream_resp)
        model = {
            "endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "meta": {"responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(ImageSafetyBlockedError, match="提示词被图像安全系统拦截"):
                await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

    asyncio.run(_run())


def test_responses_image_generation_merges_accumulated_image_with_completed_message_output():
    async def _run():
        events = [
            {"type": "response.created", "response": {"id": "resp_merge", "status": "in_progress"}},
            {
                "type": "response.output_item.done",
                "item": {"type": "image_generation_call", "result": "cG5nLWJ5dGVz"},
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_merge",
                    "status": "completed",
                    "output": [{"type": "message"}],
                },
            },
        ]
        stream_resp = _make_stream_response(body=_sse_bytes(events))
        get_resp = _make_stream_response(
            is_success=False,
            status_code=404,
            headers={"content-type": "text/plain"},
            body=b'404 page not found',
        )
        client = _make_client(stream_response=stream_resp, get_response=get_resp)

        model = {
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"use_openai_responses_image_generation": True, "responses_model": "gpt-5.5"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await _call_openai_responses_image_generation(model, "draw", [], "1024x1024")

        assert result == b"png-bytes"

    asyncio.run(_run())


def test_call_image_does_not_fall_back_when_responses_proxy_returns_html_by_default():
    async def _run():
        model = {
            "id": "chat-gpt-image2",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {
                "use_openai_responses_image_generation": True,
                "responses_model": "gpt-5.5",
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr(
                "services.ai_client._call_openai_responses_image_generation",
                AsyncMock(side_effect=_ResponsesGatewayError("Responses proxy failed")),
            )
            with pytest.raises(_ResponsesGatewayError):
                await call_image("chat-gpt-image2", "draw", None, "1024x1024")

        assert not hasattr(ai_client, "_call_openai_generations")

    asyncio.run(_run())


def test_call_image_ignores_legacy_fallback_flag():
    async def _run():
        model = {
            "id": "chat-gpt-image2",
            "category": "generate",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {
                "use_openai_responses_image_generation": True,
                "responses_model": "gpt-5.5",
                "allow_responses_legacy_fallback": True,
            },
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr(
                "services.ai_client._call_openai_responses_image_generation",
                AsyncMock(side_effect=_ResponsesGatewayError("Responses proxy failed")),
            )
            with pytest.raises(_ResponsesGatewayError):
                await call_image("chat-gpt-image2", "draw", None, "1024x1024")

        assert not hasattr(ai_client, "_call_openai_generations")

    asyncio.run(_run())



def test_call_chat_uses_responses_api():
    async def _run():
        stream_resp = _make_stream_response(body=_sse_bytes([
            {"type": "response.output_text.delta", "delta": "hel"},
            {"type": "response.output_text.delta", "delta": "lo"},
            {"type": "response.completed", "response": {"status": "completed", "output": []}},
        ]))
        client = _make_client(stream_response=stream_resp)
        model = {
            "id": "gpt-text",
            "category": "llm",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"model_name": "gpt-5.4-mini"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_chat("gpt-text", "hello", system="sys", max_tokens=64, temperature=0.2)

        assert result == "hello"
        payload = client.stream.call_args.kwargs["json"]
        assert payload["stream"] is True
        assert payload["model"] == "gpt-5.4-mini"
        assert payload["instructions"] == "sys"
        assert payload["input"] == [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]
        assert client.stream.call_args.args[1] == "https://foxapi.cn/v1/responses"

    asyncio.run(_run())


def test_call_text_messages_can_fallback_to_chat_completions_for_pet_gateway_error():
    async def _run():
        gateway = _make_stream_response(
            is_success=False,
            status_code=502,
            headers={"content-type": "text/html"},
            body=b"<!DOCTYPE html><html><body>Bad Gateway</body></html>",
        )
        completed = _make_json_response(body={
            "choices": [{"message": {"content": "在呢，刚才通道有点抖，现在我接上了。"}}],
        })

        client = _make_client(stream_response=gateway, post_response=completed)
        model = {
            "id": "foxapi:llm:gpt-5.5",
            "category": "llm",
            "endpoint": "https://foxapi.cn/v1",
            "provider": "FoxAPI",
            "api_key": "user-key",
            "meta": {"model_name": "gpt-5.5", "external_api_key": True},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            mp.setattr("services.ai_client.asyncio.sleep", AsyncMock())
            result = await call_text_messages(
                model["id"],
                [{"role": "user", "content": "你在吗"}],
                max_tokens=64,
                temperature=0.2,
                allow_chat_completions_fallback=True,
            )

        assert result == "在呢，刚才通道有点抖，现在我接上了。"
        assert client.stream.call_count == 3
        assert client.post.call_args.args[0] == "https://foxapi.cn/v1/chat/completions"
        assert client.post.call_args.kwargs["json"]["model"] == "gpt-5.5"
        assert client.post.call_args.kwargs["json"]["messages"] == [{"role": "user", "content": "你在吗"}]

    asyncio.run(_run())


def test_call_text_messages_can_use_chat_completions_directly():
    async def _run():
        completed = _make_json_response(body={
            "choices": [{"message": {"content": "direct chat reply"}}],
        })
        client = _make_client(post_response=completed)
        model = {
            "id": "foxapi:llm:gpt-5.5",
            "category": "llm",
            "endpoint": "https://foxapi.cn/v1",
            "provider": "FoxAPI",
            "api_key": "user-key",
            "meta": {"model_name": "gpt-5.5", "external_api_key": True},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_text_messages(
                model["id"],
                [{"role": "user", "content": "hello"}],
                max_tokens=64,
                temperature=0.2,
                prefer_chat_completions=True,
            )

        assert result == "direct chat reply"
        assert client.stream.call_count == 0
        assert client.post.call_args.args[0] == "https://foxapi.cn/v1/chat/completions"
        assert client.post.call_args.kwargs["json"]["messages"] == [{"role": "user", "content": "hello"}]

    asyncio.run(_run())


def test_call_vision_uses_responses_api():
    async def _run():
        stream_resp = _make_stream_response(body=_sse_bytes([
            {"type": "response.output_text.delta", "delta": "vision"},
            {"type": "response.completed", "response": {"status": "completed", "output": []}},
        ]))
        client = _make_client(stream_response=stream_resp)
        model = {
            "id": "gpt-vision",
            "category": "vision",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"model_name": "gpt-vision"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            result = await call_vision("gpt-vision", "describe", b"png", system="sys", max_tokens=64)

        assert result == "vision"
        payload = client.stream.call_args.kwargs["json"]
        assert payload["instructions"] == "sys"
        assert payload["input"][0]["content"][0]["type"] == "input_image"
        assert payload["input"][0]["content"][0]["image_url"].startswith("data:image/png;base64,")
        assert payload["input"][0]["content"][1] == {"type": "input_text", "text": "describe"}
        assert client.stream.call_args.args[1] == "https://foxapi.cn/v1/responses"

    asyncio.run(_run())


def test_responses_text_rejects_non_streaming_response():
    async def _run():
        import json

        data = {"status": "completed", "output_text": "pong"}
        stream_resp = _make_stream_response(
            content_type="application/json",
            body=json.dumps(data).encode(),
        )
        client = _make_client(stream_response=stream_resp)
        model = {
            "id": "gpt-text",
            "category": "llm",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"model_name": "gpt-5.4-mini"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="requires an SSE response"):
                await call_chat("gpt-text", "Reply with pong", max_tokens=64, temperature=0.1)

        assert client.stream.call_args.args[1] == "https://foxapi.cn/v1/responses"

    asyncio.run(_run())


def test_responses_text_empty_stream_raises():
    async def _run():
        stream_resp = _make_stream_response(body=_sse_bytes([
            {"type": "response.completed", "response": {"status": "completed", "output": []}},
        ]))
        client = _make_client(stream_response=stream_resp)
        model = {
            "id": "gpt-text",
            "category": "llm",
            "endpoint": "https://foxapi.cn/v1",
            "api_key": "sk-test",
            "meta": {"model_name": "gpt-5.4-mini"},
        }

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.get_model_internal", AsyncMock(return_value=model))
            mp.setattr("services.ai_client.httpx.AsyncClient", MagicMock(return_value=client))
            with pytest.raises(RuntimeError, match="empty content"):
                await call_chat("gpt-text", "Reply with hello", max_tokens=64, temperature=0.1)

    asyncio.run(_run())


def test_get_default_generate_model_prefers_gpt_image_2():
    async def _run():
        models = [
            {"id": "grok-imagine-image", "name": "Grok Image", "category": "generate"},
            {"id": "foxapi:generate:gpt-image-2", "name": "GPT Image 2", "category": "generate"},
            {"id": "gpt-5.5", "name": "GPT 5.5", "category": "llm"},
        ]
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("services.ai_client.list_models", AsyncMock(return_value=models))
            assert await get_default_model_id("generate") == "foxapi:generate:gpt-image-2"
            assert await get_default_model_id("llm") == "gpt-5.5"

    asyncio.run(_run())
