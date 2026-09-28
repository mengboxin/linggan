import pytest

from routers import conversation_router


@pytest.mark.asyncio
async def test_image_history_keeps_multiple_jobs_from_one_conversation(monkeypatch):
    rows = [
        {
            "conversation_id": "conv-1",
            "conversation_title": "Images",
            "message_id": "msg-2",
            "prompt": "second",
            "created_at": "2026-07-01T10:05:00.000Z",
            "request_meta": {"type": "image_request", "source": "mobile"},
            "meta": {
                "type": "image_result",
                "task_id": "job-2",
                "source": "mobile",
                "image_url": "/api/assets/asset-2/original",
            },
        },
        {
            "conversation_id": "conv-1",
            "conversation_title": "Images",
            "message_id": "msg-1",
            "prompt": "first",
            "created_at": "2026-07-01T10:00:00.000Z",
            "request_meta": {"type": "image_request", "source": "mobile"},
            "meta": {
                "type": "image_result",
                "task_id": "job-1",
                "source": "mobile",
                "image_url": "/api/assets/asset-1/original",
            },
        },
    ]

    async def get_version(*_args, **_kwargs):
        return 1

    async def get_cached(*_args, **_kwargs):
        return None

    async def set_cached(*_args, **_kwargs):
        return None

    async def list_rows(*_args, **_kwargs):
        return rows

    monkeypatch.setattr(conversation_router.ui_cache, "get_user_cache_version", get_version)
    monkeypatch.setattr(conversation_router.ui_cache, "get_json", get_cached)
    monkeypatch.setattr(conversation_router.ui_cache, "set_json", set_cached)
    monkeypatch.setattr(conversation_router.conversation_repo, "list_image_message_summaries", list_rows)

    result = await conversation_router.list_image_messages(limit=50, user={"id": "user-1"})

    assert [item["job_id"] for item in result] == ["job-2", "job-1"]
    assert [item["conversation_id"] for item in result] == ["conv-1", "conv-1"]
