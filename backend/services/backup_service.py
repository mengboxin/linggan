"""Database backup helpers for admin disaster recovery."""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from core.config import settings
from core.pool import acquire
from core.redis import get_redis

logger = logging.getLogger(__name__)

SETTINGS_KEY = "database_backup_settings"
DEFAULT_CRON = "0 2 * * *"
RUNNING_BACKUP_TIMEOUT = timedelta(hours=6)

_scheduler_task: asyncio.Task | None = None
_local_scheduler_claims: set[str] = set()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _local_now() -> datetime:
    return datetime.now().astimezone()


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _clean_key_part(value: str, fallback: str = "backup") -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_./" else "_" for ch in (value or "").strip())
    cleaned = cleaned.strip("/._ ")
    return cleaned or fallback


def _backup_local_dir() -> Path:
    raw = getattr(settings, "BACKUP_LOCAL_DIR", "") or os.getenv("BACKUP_LOCAL_DIR", "backups")
    return Path(raw).expanduser().resolve()


def _default_settings() -> dict[str, Any]:
    return {
        "enabled": False,
        "cron": DEFAULT_CRON,
        "retention_days": 30,
        "max_backup_count": 30,
        "storage": {
            "endpoint": settings.S3_ENDPOINT,
            "region": settings.S3_REGION or "auto",
            "bucket": settings.S3_BUCKET,
            "key_prefix": "database-backups",
            "access_key_id": settings.S3_ACCESS_KEY_ID,
            "secret_access_key": settings.S3_SECRET_ACCESS_KEY,
        },
    }


def _merge_settings(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = _default_settings()
    merged.update({k: v for k, v in base.items() if k != "storage"})
    merged["storage"].update(_json_dict(base.get("storage")))

    override = _json_dict(override)
    merged.update({k: v for k, v in override.items() if k != "storage"})
    merged["storage"].update(_json_dict(override.get("storage")))

    merged["enabled"] = bool(merged.get("enabled"))
    merged["cron"] = str(merged.get("cron") or DEFAULT_CRON).strip()[:64] or DEFAULT_CRON
    merged["retention_days"] = max(1, min(3650, int(merged.get("retention_days") or 30)))
    merged["max_backup_count"] = max(1, min(500, int(merged.get("max_backup_count") or 30)))

    storage = merged["storage"]
    storage["endpoint"] = str(storage.get("endpoint") or "").strip()
    storage["region"] = str(storage.get("region") or "auto").strip() or "auto"
    storage["bucket"] = str(storage.get("bucket") or "").strip()
    storage["key_prefix"] = _clean_key_part(str(storage.get("key_prefix") or "database-backups"), "database-backups")
    storage["access_key_id"] = str(storage.get("access_key_id") or "").strip()
    storage["secret_access_key"] = str(storage.get("secret_access_key") or "").strip()
    return merged


def _public_settings(data: dict[str, Any]) -> dict[str, Any]:
    public = json.loads(json.dumps(data))
    storage = public.setdefault("storage", {})
    secret = str(storage.get("secret_access_key") or "")
    storage["secret_access_key"] = ""
    storage["has_secret_access_key"] = bool(secret)
    public["local_dir"] = str(_backup_local_dir())
    return public


async def ensure_backup_tables() -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS backup_records (
                id UUID PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'running',
                filename TEXT NOT NULL,
                storage_provider TEXT NOT NULL DEFAULT 'local',
                storage_endpoint TEXT NOT NULL DEFAULT '',
                storage_bucket TEXT NOT NULL DEFAULT '',
                storage_region TEXT NOT NULL DEFAULT '',
                storage_key TEXT NOT NULL DEFAULT '',
                local_path TEXT NOT NULL DEFAULT '',
                size_bytes BIGINT NOT NULL DEFAULT 0,
                sha256 TEXT NOT NULL DEFAULT '',
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                error TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_backup_records_created_at ON backup_records (created_at DESC)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_backup_records_status ON backup_records (status)"
        )


async def _load_stored_settings() -> dict[str, Any]:
    await ensure_backup_tables()
    async with acquire() as conn:
        row = await conn.fetchrow("SELECT value FROM system_settings WHERE key = $1", SETTINGS_KEY)
    return _json_dict(row["value"]) if row else {}


async def load_backup_settings(*, public: bool = False) -> dict[str, Any]:
    data = _merge_settings(_default_settings(), await _load_stored_settings())
    return _public_settings(data) if public else data


async def save_backup_settings(data: dict[str, Any]) -> dict[str, Any]:
    current = await load_backup_settings(public=False)
    incoming = _json_dict(data)
    incoming_storage = _json_dict(incoming.get("storage"))
    if not str(incoming_storage.get("secret_access_key") or "").strip():
        incoming_storage["secret_access_key"] = current["storage"].get("secret_access_key", "")
    incoming["storage"] = incoming_storage
    merged = _merge_settings(current, incoming)
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            SETTINGS_KEY,
            json.dumps(merged),
        )
    return _public_settings(merged)


def _record_from_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "status": row["status"],
        "filename": row["filename"],
        "storage_provider": row["storage_provider"],
        "storage_endpoint": row["storage_endpoint"],
        "storage_bucket": row["storage_bucket"],
        "storage_region": row["storage_region"],
        "storage_key": row["storage_key"],
        "local_path": row["local_path"],
        "size_bytes": int(row["size_bytes"] or 0),
        "sha256": row["sha256"],
        "trigger_type": row["trigger_type"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
        "expires_at": row["expires_at"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def list_backup_records(limit: int = 50) -> list[dict[str, Any]]:
    await ensure_backup_tables()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM backup_records
            WHERE status <> 'deleted'
            ORDER BY created_at DESC
            LIMIT $1
            """,
            max(1, min(200, int(limit))),
        )
    return [_record_from_row(row) for row in rows]


async def get_backup_record(record_id: str) -> dict[str, Any] | None:
    await ensure_backup_tables()
    async with acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM backup_records WHERE id = $1::uuid", record_id)
    return _record_from_row(row) if row else None


async def _recent_running_backup_exists() -> bool:
    await ensure_backup_tables()
    cutoff = _now() - RUNNING_BACKUP_TIMEOUT
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id FROM backup_records
            WHERE status = 'running' AND started_at >= $1
            LIMIT 1
            """,
            cutoff,
        )
    return bool(row)


async def _insert_running_record(trigger_type: str) -> dict[str, Any]:
    config = await load_backup_settings(public=False)
    record_id = str(uuid.uuid4())
    filename = f"pixelscribe-db-{_now().strftime('%Y%m%d-%H%M%S')}.sql.gz"
    expires_at = _now() + timedelta(days=int(config.get("retention_days") or 30))
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO backup_records (id, filename, status, trigger_type, expires_at)
            VALUES ($1::uuid, $2, 'running', $3, $4)
            RETURNING *
            """,
            record_id,
            filename,
            trigger_type,
            expires_at,
        )
    return _record_from_row(row)


async def start_backup(trigger_type: str = "manual") -> dict[str, Any]:
    if await _recent_running_backup_exists():
        raise RuntimeError("A database backup is already running")
    record = await _insert_running_record(trigger_type)
    asyncio.create_task(_run_backup_record(record["id"]))
    return record


async def create_backup_now(trigger_type: str = "manual") -> dict[str, Any]:
    if await _recent_running_backup_exists():
        raise RuntimeError("A database backup is already running")
    record = await _insert_running_record(trigger_type)
    await _run_backup_record(record["id"], raise_errors=True)
    refreshed = await get_backup_record(record["id"])
    return refreshed or record


def _database_args() -> tuple[list[str], dict[str, str]]:
    dsn = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlparse(dsn)
    env: dict[str, str] = {}
    if not parsed.scheme.startswith("postgres"):
        return ["--dbname", dsn], env

    args: list[str] = []
    if parsed.hostname:
        args.extend(["--host", parsed.hostname])
    if parsed.port:
        args.extend(["--port", str(parsed.port)])
    if parsed.username:
        args.extend(["--username", unquote(parsed.username)])
    if parsed.password:
        env["PGPASSWORD"] = unquote(parsed.password)
    database = unquote(parsed.path.lstrip("/"))
    if database:
        args.extend(["--dbname", database])
    else:
        args.extend(["--dbname", dsn])
    return args, env


def _require_executable(name: str, env_name: str) -> str:
    configured = os.getenv(env_name, name)
    if os.path.sep in configured or (os.path.altsep and os.path.altsep in configured):
        if Path(configured).exists():
            return configured
    elif shutil.which(configured):
        return configured
    raise RuntimeError(f"{configured} is not available; install PostgreSQL client tools")


def _dump_database_to_file(path: Path) -> None:
    pg_dump = _require_executable("pg_dump", "PG_DUMP_BIN")
    conn_args, extra_env = _database_args()
    args = [
        pg_dump,
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        *conn_args,
    ]
    env = {**os.environ, **extra_env}
    with gzip.open(path, "wb") as gz:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        if proc.stdout is None:
            raise RuntimeError("pg_dump did not provide stdout")
        shutil.copyfileobj(proc.stdout, gz)
        _stdout, stderr = proc.communicate()
    if proc.returncode != 0:
        path.unlink(missing_ok=True)
        detail = stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"pg_dump failed with exit code {proc.returncode}")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _has_s3_config(storage: dict[str, Any]) -> bool:
    return bool(
        storage.get("endpoint")
        and storage.get("bucket")
        and storage.get("access_key_id")
        and storage.get("secret_access_key")
    )


def _s3_client(storage: dict[str, Any]):
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=storage["endpoint"],
        aws_access_key_id=storage["access_key_id"],
        aws_secret_access_key=storage["secret_access_key"],
        region_name=storage.get("region") or "auto",
    )


def _upload_file_to_s3(path: Path, storage: dict[str, Any], key: str) -> None:
    _s3_client(storage).upload_file(
        str(path),
        storage["bucket"],
        key,
        ExtraArgs={"ContentType": "application/gzip"},
    )


async def _run_backup_record(record_id: str, *, raise_errors: bool = False) -> None:
    config = await load_backup_settings(public=False)
    storage = config["storage"]
    backup_dir = _backup_local_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    record = await get_backup_record(record_id)
    if not record:
        return
    local_path = backup_dir / record["filename"]

    try:
        await asyncio.to_thread(_dump_database_to_file, local_path)
        size_bytes = local_path.stat().st_size
        sha256 = await asyncio.to_thread(_file_sha256, local_path)

        provider = "local"
        storage_key = ""
        storage_endpoint = ""
        storage_bucket = ""
        storage_region = ""
        if _has_s3_config(storage):
            prefix = _clean_key_part(storage.get("key_prefix") or "database-backups", "database-backups")
            storage_key = f"{prefix}/{record['filename']}"
            await asyncio.to_thread(_upload_file_to_s3, local_path, storage, storage_key)
            provider = "s3"
            storage_endpoint = storage.get("endpoint") or ""
            storage_bucket = storage.get("bucket") or ""
            storage_region = storage.get("region") or "auto"

        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE backup_records
                SET status = 'completed',
                    storage_provider = $2,
                    storage_endpoint = $3,
                    storage_bucket = $4,
                    storage_region = $5,
                    storage_key = $6,
                    local_path = $7,
                    size_bytes = $8,
                    sha256 = $9,
                    completed_at = NOW(),
                    error = '',
                    updated_at = NOW()
                WHERE id = $1::uuid
                """,
                record_id,
                provider,
                storage_endpoint,
                storage_bucket,
                storage_region,
                storage_key,
                str(local_path),
                size_bytes,
                sha256,
            )
        await enforce_backup_retention()
    except Exception as exc:
        logger.exception("database backup failed record_id=%s", record_id)
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE backup_records
                SET status = 'failed', error = $2, completed_at = NOW(), updated_at = NOW()
                WHERE id = $1::uuid
                """,
                record_id,
                str(exc)[:2000],
            )
        if raise_errors:
            raise


def _storage_for_record(record: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    storage = dict(config["storage"])
    if record.get("storage_endpoint"):
        storage["endpoint"] = record["storage_endpoint"]
    if record.get("storage_bucket"):
        storage["bucket"] = record["storage_bucket"]
    if record.get("storage_region"):
        storage["region"] = record["storage_region"]
    return storage


def _download_s3_bytes(storage: dict[str, Any], key: str) -> bytes:
    obj = _s3_client(storage).get_object(Bucket=storage["bucket"], Key=key)
    body = obj["Body"]
    try:
        return body.read()
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()


async def read_backup_bytes(record_id: str) -> tuple[dict[str, Any], bytes]:
    record = await get_backup_record(record_id)
    if not record or record["status"] == "deleted":
        raise RuntimeError("Backup record not found")
    if record["status"] != "completed":
        raise RuntimeError("Backup is not completed")

    if record.get("storage_provider") == "s3" and record.get("storage_key"):
        config = await load_backup_settings(public=False)
        storage = _storage_for_record(record, config)
        if not _has_s3_config(storage):
            raise RuntimeError("S3 backup storage is not configured")
        data = await asyncio.to_thread(_download_s3_bytes, storage, record["storage_key"])
        return record, data

    path = Path(record.get("local_path") or "")
    if not path.exists() or not path.is_file():
        raise RuntimeError("Local backup file is missing")
    return record, await asyncio.to_thread(path.read_bytes)


def _delete_s3_object(storage: dict[str, Any], key: str) -> None:
    _s3_client(storage).delete_object(Bucket=storage["bucket"], Key=key)


async def delete_backup_record(record_id: str) -> None:
    record = await get_backup_record(record_id)
    if not record:
        return
    try:
        if record.get("storage_provider") == "s3" and record.get("storage_key"):
            config = await load_backup_settings(public=False)
            storage = _storage_for_record(record, config)
            if _has_s3_config(storage):
                await asyncio.to_thread(_delete_s3_object, storage, record["storage_key"])
        path = Path(record.get("local_path") or "")
        if path.exists() and path.is_file():
            await asyncio.to_thread(path.unlink)
    finally:
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE backup_records
                SET status = 'deleted', updated_at = NOW()
                WHERE id = $1::uuid
                """,
                record_id,
            )


async def enforce_backup_retention() -> None:
    config = await load_backup_settings(public=False)
    max_count = int(config.get("max_backup_count") or 30)
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            WITH ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
                FROM backup_records
                WHERE status = 'completed'
            )
            SELECT b.id
            FROM backup_records b
            LEFT JOIN ranked r ON r.id = b.id
            WHERE b.status = 'completed'
              AND (b.expires_at < NOW() OR COALESCE(r.rn, 0) > $1)
            """,
            max_count,
        )
    for row in rows:
        try:
            await delete_backup_record(str(row["id"]))
        except Exception:
            logger.exception("failed to prune backup record id=%s", row["id"])


async def test_backup_storage() -> dict[str, Any]:
    config = await load_backup_settings(public=False)
    storage = config["storage"]
    if not _has_s3_config(storage):
        backup_dir = _backup_local_dir()
        backup_dir.mkdir(parents=True, exist_ok=True)
        probe = backup_dir / ".write-test"
        await asyncio.to_thread(probe.write_text, "ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return {"ok": True, "mode": "local", "message": "Local backup directory is writable"}

    def probe_s3() -> None:
        client = _s3_client(storage)
        client.list_objects_v2(
            Bucket=storage["bucket"],
            Prefix=_clean_key_part(storage.get("key_prefix") or "database-backups"),
            MaxKeys=1,
        )

    await asyncio.to_thread(probe_s3)
    return {"ok": True, "mode": "s3", "message": "S3-compatible backup storage is reachable"}


def _field_matches(expr: str, value: int, minimum: int, maximum: int) -> bool:
    expr = (expr or "*").strip()
    if expr == "*":
        return True
    for part in expr.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("*/"):
            step = int(part[2:] or "0")
            if step > 0 and (value - minimum) % step == 0:
                return True
            continue
        if "-" in part:
            start_raw, end_raw = part.split("-", 1)
            start = max(minimum, int(start_raw))
            end = min(maximum, int(end_raw))
            if start <= value <= end:
                return True
            continue
        if int(part) == value:
            return True
    return False


def cron_matches(cron: str, now: datetime | None = None) -> bool:
    now = now or _local_now()
    parts = (cron or DEFAULT_CRON).split()
    if len(parts) != 5:
        return False
    minute, hour, day, month, weekday = parts
    cron_weekday = now.isoweekday() % 7
    try:
        return (
            _field_matches(minute, now.minute, 0, 59)
            and _field_matches(hour, now.hour, 0, 23)
            and _field_matches(day, now.day, 1, 31)
            and _field_matches(month, now.month, 1, 12)
            and _field_matches(weekday, cron_weekday, 0, 6)
        )
    except Exception:
        return False


async def _claim_schedule_minute(minute_key: str) -> bool:
    redis_key = f"backup:schedule:{minute_key}"
    try:
        result = await get_redis().set(redis_key, "1", ex=86400, nx=True)
        return bool(result)
    except Exception:
        if minute_key in _local_scheduler_claims:
            return False
        _local_scheduler_claims.add(minute_key)
        if len(_local_scheduler_claims) > 2048:
            _local_scheduler_claims.clear()
        return True


async def _scheduler_tick() -> None:
    config = await load_backup_settings(public=False)
    if not config.get("enabled"):
        return
    now = _local_now()
    if not cron_matches(str(config.get("cron") or DEFAULT_CRON), now):
        return
    minute_key = now.strftime("%Y%m%d%H%M")
    if not await _claim_schedule_minute(minute_key):
        return
    if await _recent_running_backup_exists():
        logger.info("skip scheduled backup because another backup is running")
        return
    await create_backup_now("scheduled")


async def _scheduler_loop() -> None:
    logger.info("database backup scheduler started")
    try:
        while True:
            try:
                await _scheduler_tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("database backup scheduler tick failed")
            await asyncio.sleep(30)
    finally:
        logger.info("database backup scheduler stopped")


async def start_backup_scheduler() -> None:
    global _scheduler_task
    await ensure_backup_tables()
    if _scheduler_task and not _scheduler_task.done():
        return
    _scheduler_task = asyncio.create_task(_scheduler_loop())


async def stop_backup_scheduler() -> None:
    global _scheduler_task
    if not _scheduler_task:
        return
    _scheduler_task.cancel()
    try:
        await _scheduler_task
    except asyncio.CancelledError:
        pass
    _scheduler_task = None


def _restore_database_from_file(path: Path) -> None:
    psql = _require_executable("psql", "PSQL_BIN")
    conn_args, extra_env = _database_args()
    args = [psql, "--set", "ON_ERROR_STOP=on", *conn_args]
    env = {**os.environ, **extra_env}
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if proc.stdin is None:
        raise RuntimeError("psql did not provide stdin")
    with gzip.open(path, "rb") as gz:
        shutil.copyfileobj(gz, proc.stdin)
    proc.stdin.close()
    stdout = proc.stdout.read() if proc.stdout else b""
    stderr = proc.stderr.read() if proc.stderr else b""
    return_code = proc.wait()
    if return_code != 0:
        detail = (stderr or stdout).decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"psql failed with exit code {return_code}")


async def restore_backup(record_id: str, confirm: str) -> dict[str, Any]:
    if not getattr(settings, "BACKUP_RESTORE_ENABLED", False):
        raise RuntimeError("Database restore is disabled. Set BACKUP_RESTORE_ENABLED=true to enable it.")
    if confirm != "RESTORE":
        raise RuntimeError("Restore confirmation is invalid")

    record, data = await read_backup_bytes(record_id)
    restore_dir = _backup_local_dir()
    restore_dir.mkdir(parents=True, exist_ok=True)
    temp_path = restore_dir / f".restore-{record['id']}.sql.gz"
    try:
        await asyncio.to_thread(temp_path.write_bytes, data)
        await asyncio.to_thread(_restore_database_from_file, temp_path)
        return {"ok": True, "record_id": record["id"]}
    finally:
        temp_path.unlink(missing_ok=True)
