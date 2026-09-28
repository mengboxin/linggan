from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from repositories import storage_repo


class _Acquire:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback):
        return False


def _disable_storage_caches(monkeypatch) -> None:
    monkeypatch.setattr(storage_repo, "ensure_storage_tables", AsyncMock())
    monkeypatch.setattr(storage_repo.ui_cache, "get_global_cache_version", AsyncMock(return_value=0))
    monkeypatch.setattr(storage_repo.ui_cache, "get_json", AsyncMock(return_value=None))
    monkeypatch.setattr(storage_repo.ui_cache, "set_json", AsyncMock())


@pytest.mark.asyncio
async def test_bucket_usage_counts_non_presentation_file_assets(monkeypatch):
    queries: list[str] = []

    class Connection:
        async def fetchval(self, query: str):
            queries.append(query)
            if "FROM image_assets" in query:
                return 100
            if "FROM file_assets" in query:
                return 25
            return 2

        async def fetch(self, query: str):
            queries.append(query)
            return []

    _disable_storage_caches(monkeypatch)
    monkeypatch.setattr(storage_repo, "acquire", lambda: _Acquire(Connection()))

    usage = await storage_repo.bucket_usage_estimate()

    assert usage["used_bytes"] == 125
    assert usage["image_bytes"] == 100
    assert usage["file_bytes"] == 25
    file_query = next(query for query in queries if "FROM file_assets" in query)
    assert "presentation_uploads" in file_query
    assert "category = 'ppt'" not in file_query


@pytest.mark.asyncio
async def test_top_storage_users_includes_files_outside_ppt_categories(monkeypatch):
    queries: list[str] = []
    slide_query_args: list[tuple] = []

    class Connection:
        async def fetch(self, query: str, *_args):
            queries.append(query)
            if "FROM users u" in query:
                return [{
                    "user_id": "user-1",
                    "email": "user@example.com",
                    "display_name": "User",
                    "role": "user",
                    "image_bytes": 100,
                    "image_count": 1,
                    "file_bytes": 25,
                    "file_count": 2,
                    "ppt_file_bytes": 10,
                    "ppt_file_count": 1,
                    "ppt_source_bytes": 50,
                    "ppt_count": 1,
                }]
            if "SELECT user_id::text, slides" in query:
                slide_query_args.append(_args)
            return []

    _disable_storage_caches(monkeypatch)
    monkeypatch.setattr(storage_repo, "acquire", lambda: _Acquire(Connection()))

    users = await storage_repo.top_storage_users(limit=10)

    assert users[0]["used_bytes"] == 175
    assert users[0]["breakdown"]["files"] == {"count": 2, "bytes": 25}
    assert users[0]["breakdown"]["ppt_files"] == {"count": 1, "bytes": 10}
    user_query = next(query for query in queries if "FROM users u" in query)
    assert "presentation_uploads" in user_query
    assert "source_client" not in user_query
    slide_query = next(query for query in queries if "SELECT user_id::text, slides" in query)
    assert "WHERE user_id = ANY($1::uuid[])" in slide_query
    assert slide_query_args == [(["user-1"],)]


@pytest.mark.asyncio
async def test_storage_summary_uses_one_image_asset_aggregate(monkeypatch):
    queries: list[str] = []

    class Connection:
        async def fetch(self, query: str, *_args):
            queries.append(query)
            if "FROM image_assets" in query:
                return [
                    {
                        "asset_scope": "history",
                        "bytes": 10,
                        "asset_count": 2,
                        "asset_expiring_count": 1,
                        "count": 2,
                        "expiring_count": 1,
                    },
                    {
                        "asset_scope": "ppt",
                        "bytes": 3,
                        "asset_count": 1,
                        "asset_expiring_count": 0,
                        "count": 1,
                        "expiring_count": 0,
                    },
                ]
            return []

        async def fetchrow(self, query: str, *_args):
            raise AssertionError(f"storage summary must not rescan image assets: {query}")

    monkeypatch.setattr(storage_repo, "ensure_storage_tables", AsyncMock())
    monkeypatch.setattr(storage_repo, "acquire", lambda: _Acquire(Connection()))

    summary = await storage_repo._storage_summary_uncached("user-1")

    assert summary["used_bytes"] == 13
    assert summary["breakdown"]["images"] == {
        "bytes": 10,
        "count": 2,
        "expiring_count": 1,
    }
    assert summary["breakdown"]["ppt_slides"]["bytes"] == 3
    assert sum("FROM image_assets" in query for query in queries) == 1
