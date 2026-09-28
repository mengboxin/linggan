import sys
import types

import pytest

try:
    import redis.asyncio  # noqa: F401
except ModuleNotFoundError:
    fake_asyncio = types.ModuleType('redis.asyncio')
    fake_asyncio.Redis = object
    fake_asyncio.from_url = lambda *_args, **_kwargs: object()
    fake_redis = types.ModuleType('redis')
    fake_redis.asyncio = fake_asyncio
    sys.modules['redis'] = fake_redis
    sys.modules['redis.asyncio'] = fake_asyncio

from services import backup_service


class FakeConnection:
    def __init__(self):
        self.sql: list[str] = []

    async def execute(self, sql: str, *_args):
        self.sql.append(sql)


class FakeAcquire:
    def __init__(self, conn: FakeConnection):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, traceback):
        return False


@pytest.mark.asyncio
async def test_backup_table_initialization_has_no_pgcrypto_dependency(monkeypatch):
    conn = FakeConnection()
    monkeypatch.setattr(backup_service, 'acquire', lambda: FakeAcquire(conn))

    await backup_service.ensure_backup_tables()

    combined = '\n'.join(conn.sql).lower()
    assert 'create extension' not in combined
    assert 'gen_random_uuid' not in combined
