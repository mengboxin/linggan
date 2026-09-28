from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from repositories import asset_mirror_repo, file_asset_repo


class FakeTransaction:
    def __init__(self, events: list[str]):
        self.events = events

    async def __aenter__(self):
        self.events.append("transaction-enter")
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        self.events.append("transaction-exit")
        return False


class FakeConnection:
    def __init__(self):
        self.events: list[str] = []
        self.fetch_calls: list[tuple[str, tuple[object, ...]]] = []
        self.execute_calls: list[tuple[str, tuple[object, ...]]] = []

    def transaction(self):
        return FakeTransaction(self.events)

    async def fetchval(self, sql: str, *args):
        self.events.append("advisory-lock")
        return True

    async def fetchrow(self, sql: str, *args):
        self.events.append("metadata-write")
        return {
            "id": "file-1",
            "storage_key": str(args[7]),
            "storage_provider": str(args[12]),
        }

    async def fetch(self, sql: str, *args):
        self.fetch_calls.append((sql, args))
        self.events.append("mirror-enqueue")
        return [{
            "target_provider": str(args[2]),
            "target_endpoint": str(args[3]),
            "target_bucket": str(args[4]),
            "target_region": str(args[5]),
            "object_key": str(args[0][0]),
            "operation": str(args[1]),
            "revision": 1,
            "status": "pending",
        }]

    async def execute(self, sql: str, *args):
        self.execute_calls.append((sql, args))
        return "UPDATE 0"


@pytest.mark.asyncio
async def test_file_metadata_and_mirror_job_share_one_transaction(monkeypatch):
    conn = FakeConnection()

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(file_asset_repo, "acquire", acquire)
    monkeypatch.setattr(file_asset_repo, "ensure_table", lambda: _noop())
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_PROVIDER", "cos")
    monkeypatch.setattr(
        asset_mirror_repo.settings,
        "STORAGE_MIRROR_ENDPOINT",
        "https://cos.ap-guangzhou.myqcloud.com",
    )
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_BUCKET", "mirror-bucket")
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_REGION", "ap-guangzhou")

    row = await file_asset_repo.create_file_asset(
        user_id="00000000-0000-0000-0000-000000000001",
        storage_key="assets/users/u/file.bin",
        storage_provider="r2",
        mirror_keys=["assets/users/u/file.bin"],
    )

    assert row["id"] == "file-1"
    assert conn.events == [
        "transaction-enter",
        "metadata-write",
        "mirror-enqueue",
        "transaction-exit",
    ]
    _sql, args = conn.fetch_calls[0]
    assert args == (
        ["assets/users/u/file.bin"],
        "copy",
        "cos",
        "https://cos.ap-guangzhou.myqcloud.com",
        "mirror-bucket",
        "ap-guangzhou",
    )


@pytest.mark.asyncio
async def test_task_file_replacement_serializes_and_stages_old_object_deletion(monkeypatch):
    conn = FakeConnection()
    old_key = "assets/users/u/old-file.bin"
    new_key = "assets/users/u/new-file.bin"

    async def fetch(sql: str, *args):
        conn.fetch_calls.append((sql, args))
        if "SELECT storage_key" in sql:
            conn.events.append("old-keys-read")
            return [{"storage_key": old_key}]
        if "asset_object_mirror_queue" in sql:
            conn.events.append("mirror-copy-enqueue")
            return [{
                "target_provider": "cos",
                "target_endpoint": "https://cos.ap-guangzhou.myqcloud.com",
                "target_bucket": "mirror-bucket",
                "target_region": "ap-guangzhou",
                "object_key": new_key,
                "operation": "copy",
                "revision": 1,
                "status": "pending",
            }]
        if "asset_object_deletion_queue" in sql:
            conn.events.append("deletion-enqueue")
            return [{"object_key": old_key}]
        raise AssertionError(sql)

    async def fetchval(sql: str, *args):
        assert "pg_advisory_xact_lock" in sql
        conn.events.append("replacement-lock")
        return None

    async def fetchrow(sql: str, *args):
        conn.events.append("metadata-write")
        return {"id": "file-1", "storage_key": new_key, "storage_provider": "r2"}

    async def execute(sql: str, *args):
        conn.execute_calls.append((sql, args))
        conn.events.append("old-metadata-delete")
        return "DELETE 1"

    conn.fetch = fetch
    conn.fetchval = fetchval
    conn.fetchrow = fetchrow
    conn.execute = execute

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(file_asset_repo, "acquire", acquire)
    monkeypatch.setattr(file_asset_repo, "ensure_table", lambda: _noop())
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_PROVIDER", "cos")
    monkeypatch.setattr(
        asset_mirror_repo.settings,
        "STORAGE_MIRROR_ENDPOINT",
        "https://cos.ap-guangzhou.myqcloud.com",
    )
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_BUCKET", "mirror-bucket")
    monkeypatch.setattr(asset_mirror_repo.settings, "STORAGE_MIRROR_REGION", "ap-guangzhou")

    row, old_keys = await file_asset_repo.replace_task_file_asset(
        user_id="00000000-0000-0000-0000-000000000001",
        task_id="task-1",
        category="ppt",
        filename="presentation.pptx",
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size_bytes=10,
        sha256="a" * 64,
        storage_key=new_key,
        storage_url="/api/assets/files/by-key",
        storage_provider="r2",
        mirror_keys=[new_key],
    )

    assert row["storage_key"] == new_key
    assert old_keys == [old_key]
    assert conn.events == [
        "transaction-enter",
        "replacement-lock",
        "old-keys-read",
        "metadata-write",
        "mirror-copy-enqueue",
        "deletion-enqueue",
        "old-metadata-delete",
        "transaction-exit",
    ]


@pytest.mark.asyncio
async def test_stale_worker_completion_cannot_overwrite_new_revision():
    conn = FakeConnection()

    job = {
        "target_provider": "cos",
        "target_bucket": "mirror-bucket",
        "object_key": "assets/users/u/file.bin",
        "operation": "copy",
        "revision": 3,
    }

    completed = await asset_mirror_repo.complete_claimed_job(conn, job)

    assert completed is False
    sql, args = conn.execute_calls[0]
    assert "revision = $4" in sql
    assert args == ("cos", "mirror-bucket", "assets/users/u/file.bin", 3)


@pytest.mark.asyncio
async def test_mirror_delete_completion_removes_ready_state():
    conn = FakeConnection()
    conn.execute = _recording_execute(conn, "DELETE 1")

    job = {
        "target_provider": "cos",
        "target_bucket": "mirror-bucket",
        "object_key": "assets/users/u/file.bin",
        "operation": "delete",
        "revision": 4,
    }

    completed = await asset_mirror_repo.complete_claimed_job(conn, job)

    assert completed is True
    sql, args = conn.execute_calls[0]
    assert "DELETE FROM asset_object_mirror_queue" in sql
    assert args == ("cos", "mirror-bucket", "assets/users/u/file.bin", 4)


@pytest.mark.asyncio
async def test_claimed_job_holds_cluster_lock_and_transaction(monkeypatch):
    conn = FakeConnection()
    conn.fetchrow = _recording_fetchrow(conn, {
        "target_provider": "cos",
        "target_endpoint": "https://cos.ap-guangzhou.myqcloud.com",
        "target_bucket": "mirror-bucket",
        "target_region": "ap-guangzhou",
        "object_key": "assets/users/u/file.bin",
        "operation": "copy",
        "revision": 1,
        "attempts": 0,
    })

    @asynccontextmanager
    async def acquire():
        yield conn

    monkeypatch.setattr(asset_mirror_repo, "acquire", acquire)

    async with asset_mirror_repo.claim_pending_job(include_copies=False) as (claimed_conn, job):
        assert claimed_conn is conn
        assert job["object_key"] == "assets/users/u/file.bin"
        assert conn.events == ["transaction-enter", "advisory-lock", "mirror-claim"]

    assert conn.events[-1] == "transaction-exit"
    assert conn.fetch_calls == []
    assert conn.execute_calls == []


def test_mirror_queue_migration_is_versioned_and_self_contained():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260813_002_asset_mirror_queue.sql"
    )
    sql = migration.read_text(encoding="utf-8")

    for required in (
        "asset_object_mirror_queue",
        "target_endpoint",
        "target_bucket",
        "operation IN ('copy', 'delete')",
        "revision BIGINT",
        "idx_asset_mirror_queue_pending",
        "status = 'pending'",
    ):
        assert required in sql
    assert "pgcrypto" not in sql.lower()


async def _noop():
    return None


def _recording_execute(conn: FakeConnection, result: str):
    async def execute(sql: str, *args):
        conn.execute_calls.append((sql, args))
        return result

    return execute


def _recording_fetchrow(conn: FakeConnection, row: dict):
    async def fetchrow(sql: str, *args):
        conn.events.append("mirror-claim")
        return row

    return fetchrow
