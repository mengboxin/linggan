from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from repositories import conversation_repo
from core.user_context import bind_user_context


def test_image_history_summary_query_prefers_projection_column():
    expression = conversation_repo._history_summary_sql(
        "m.",
        has_meta=True,
        has_history_summary=True,
    )

    assert "m.history_summary" in expression
    assert "m.meta->>'asset_id'" in expression
    assert "m.meta," not in expression + ","


def test_light_message_query_strips_large_fields_in_postgres():
    expression = conversation_repo._message_meta_expression(
        True,
        False,
        alias="m.",
        light=True,
    )

    assert "m.meta" in expression
    assert "preview_b64" in expression
    assert "::text[]" in expression


@pytest.mark.asyncio
async def test_message_schema_probe_runs_before_business_connection(monkeypatch):
    connection_held = False

    class Connection:
        async def fetchrow(self, _query, *_args):
            return {"id": "conversation-1"}

        async def fetch(self, _query, *_args):
            return []

    @asynccontextmanager
    async def acquire():
        nonlocal connection_held
        assert connection_held is False
        connection_held = True
        try:
            yield Connection()
        finally:
            connection_held = False

    async def check_cols():
        assert connection_held is False
        return True, False

    monkeypatch.setattr(conversation_repo, "acquire", acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", check_cols)

    messages = await conversation_repo.get_conversation_messages(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
    )

    assert messages == []
    assert connection_held is False


@pytest.mark.asyncio
async def test_add_message_does_not_acquire_a_second_connection_while_writing(monkeypatch):
    """A one-connection pool must still be able to persist a normal message."""
    connection_held = False

    class Transaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    class Connection:
        def transaction(self):
            return Transaction()

        async def fetchrow(self, query, *_args):
            if "INSERT INTO conversation_messages" in query:
                return {
                    "id": "message-1",
                    "conversation_id": "conversation-1",
                    "role": "user",
                    "content": "hello",
                    "meta": {},
                    "created_at": "2026-08-01T00:00:00+00:00",
                }
            assert "UPDATE conversations" in query
            assert "SET updated_at = NOW()" in query
            assert "RETURNING user_id::text AS user_id" in query
            return {"user_id": "user-1"}

        async def fetchval(self, query, *_args):
            raise AssertionError(f"message write should not issue a separate owner lookup: {query}")

        async def execute(self, query, *_args):
            raise AssertionError(f"message write should update and return the owner in one query: {query}")

    @asynccontextmanager
    async def acquire():
        nonlocal connection_held
        assert connection_held is False, "add_message tried to acquire a nested pool connection"
        connection_held = True
        try:
            yield Connection()
        finally:
            connection_held = False

    async def invalidate_history(user_id: str):
        assert connection_held is False, "cache invalidation held a database pool connection"
        assert user_id == "user-1"

    invalidate = AsyncMock(side_effect=invalidate_history)
    monkeypatch.setattr(conversation_repo, "acquire", acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", AsyncMock(return_value=(True, False)))
    monkeypatch.setattr(conversation_repo, "_check_history_key_col", AsyncMock(return_value=False))
    monkeypatch.setattr(conversation_repo, "_check_history_summary_col", AsyncMock(return_value=False))
    monkeypatch.setattr(conversation_repo, "invalidate_user_history_cache", invalidate)

    message = await conversation_repo.add_message(
        "conversation-1",
        "user",
        "hello",
    )

    assert message["id"] == "message-1"
    assert connection_held is False
    invalidate.assert_awaited_once_with("user-1")


@pytest.mark.asyncio
async def test_conversation_list_pages_before_counting_messages(monkeypatch):
    calls: list[tuple[str, tuple[object, ...]]] = []

    class Connection:
        async def fetch(self, query, *args):
            calls.append((query, args))
            return [
                {
                    "id": "conversation-1",
                    "user_id": "user-1",
                    "type": "image",
                    "title": "Images",
                    "is_archived": False,
                    "created_at": "2026-08-01T00:00:00+00:00",
                    "updated_at": "2026-08-01T00:01:00+00:00",
                    "message_count": 2,
                }
            ]

    @asynccontextmanager
    async def acquire():
        yield Connection()

    monkeypatch.setattr(conversation_repo, "acquire", acquire)

    with bind_user_context("user-1", storage_workspace="local"):
        conversations = await conversation_repo.list_conversations("user-1", limit=50, offset=100)

    assert conversations[0]["message_count"] == 2
    query, args = calls[0]
    assert "WITH page AS" in query
    assert "storage_workspace = $2" in query
    assert "LEFT JOIN LATERAL" in query
    assert "WHERE m.conversation_id = c.id" in query
    assert "GROUP BY c.id" not in query
    assert args == ("user-1", "local", 50, 100)


@pytest.mark.asyncio
async def test_image_history_list_reads_projection_not_full_message_meta(monkeypatch):
    queries: list[str] = []

    class Connection:
        async def fetch(self, query, *_args):
            queries.append(query)
            return []

    @asynccontextmanager
    async def acquire():
        yield Connection()

    monkeypatch.setattr(conversation_repo, "acquire", acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", AsyncMock(return_value=(True, False)))
    monkeypatch.setattr(conversation_repo, "_check_history_summary_col", AsyncMock(return_value=True))

    with bind_user_context("user-1", storage_workspace="cloud"):
        assert await conversation_repo.list_image_message_summaries("user-1") == []

    query = queries[0]
    assert "m.history_summary" in query
    assert "um.history_summary" in query
    assert "m.meta," not in query
    assert "um.meta," not in query


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "history_loader",
    [
        conversation_repo.list_poster_history_summaries,
        conversation_repo.list_sci_fig_history_summaries,
    ],
)
async def test_artifact_history_counts_messages_per_conversation(monkeypatch, history_loader):
    queries: list[str] = []

    class Connection:
        async def fetch(self, query, *_args):
            queries.append(query)
            return []

    @asynccontextmanager
    async def acquire():
        yield Connection()

    monkeypatch.setattr(conversation_repo, "acquire", acquire)
    monkeypatch.setattr(conversation_repo, "_check_cols", AsyncMock(return_value=(True, False)))
    monkeypatch.setattr(conversation_repo, "_check_history_summary_col", AsyncMock(return_value=True))

    assert await history_loader("user-1") == []
    query = queries[0]
    assert "LEFT JOIN LATERAL" in query
    assert "COUNT(*)::int AS message_count" in query
    assert "WHERE cm.conversation_id = c.id" in query
    assert "LEFT JOIN conversation_messages m ON" not in query
    assert "GROUP BY c.id" not in query
    assert "history_summary" in query
    assert "pm.meta," not in query
    assert "am.meta," not in query
    assert "rm.meta," not in query
