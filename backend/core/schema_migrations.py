"""Versioned PostgreSQL schema migrations with cross-process locking."""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from core.config import settings

logger = logging.getLogger(__name__)


MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_LOCK_ID = 7_301_204_527
KNOWN_REPLACED_MIGRATION_CHECKSUMS: dict[str, dict[str, str]] = {
    "20260712_001_reconcile_schema": {
        "672af42df66126991484d4b1c98aa71c9368589950ff092c70fdb26afa03e012": (
            "c7258e521196793ce3cd5e74f9f78bcc34e9167f44b835320372975dbf9a4b83"
        ),
    },
    "20260712_002_backup_record_ids": {
        "81afe4cd8932a8af91d3accb940c63127d2a7d6b93050488813218c0c596bd3d": (
            "4f36490a8dcccb339bad8e32819c0f5ced66a4277e2494db1824d9e37dfde375"
        ),
    },
    "20260713_001_foxapi_credentials": {
        "3d6b379a58b006d78517e3f65376b7dd43a9cfca99a4268a2ed8d78f48a5345c": (
            "0e80bf89f59dcc535295947e36787de2d02d2082b0f62212f5381732a5bbbde0"
        ),
    },
    "20260731_001_credit_transaction_idempotency": {
        "540b7affff7eb0b75d79008ab7f9dfc7a99c9332c1e6e8fff6fe7a8e2262271b": (
            "a87d7d6bf9479f460601742b08d085ba77e28eabaf7bab2715649ceec73a0042"
        ),
    },
    "20260731_002_schema_index_hardening": {
        "143f0fcc913c901aead06c7e518efbd743fb59513a0a06cc8b97337792a3b601": (
            "3fc24632e4637925f655455b435622f81c9695260ddb330b3f3fabfc611da0b6"
        ),
    },
    "20260731_003_unlimited_user_asset_retention": {
        "c583067db4b12b046a489807aff4b5c44ddb15cc83b6e6a77dfad84f61b2a76d": (
            "8adb207ecadd433460b7de23e29f7e12d542b5a85793c927ea0eed4240f7a2db"
        ),
    },
    "20260821_001_grok_credentials": {
        "2b8365a05a576206aa052cae83c6d532cfe408004ff70fca67b8294b215a1df8": (
            "f0f18472d76d926752abe5cbe5c8b3b96a3a8c1cb28c37097d2ad3815a3d7278"
        ),
    },
}


class MigrationChecksumMismatch(RuntimeError):
    pass


@dataclass(frozen=True)
class MigrationRunResult:
    applied: tuple[str, ...]
    skipped: tuple[str, ...]


def discover_migrations(migrations_dir: Path = MIGRATIONS_DIR) -> list[Path]:
    return sorted(path for path in migrations_dir.glob("*.sql") if path.is_file())


def migration_checksum(path: Path) -> str:
    return hashlib.sha256(_normalized_migration_bytes(path.read_bytes())).hexdigest()


def _normalized_migration_bytes(content: bytes) -> bytes:
    return content.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _compatible_migration_checksums(path: Path) -> frozenset[str]:
    normalized = _normalized_migration_bytes(path.read_bytes())
    crlf = normalized.replace(b"\n", b"\r\n")
    return frozenset({
        hashlib.sha256(normalized).hexdigest(),
        hashlib.sha256(crlf).hexdigest(),
    })


def _database_dsn() -> str:
    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://", 1)


async def run_schema_migrations(
    dsn: str | None = None,
    *,
    migrations_dir: Path = MIGRATIONS_DIR,
    connect: Callable[[str], Awaitable[object]] | None = None,
) -> MigrationRunResult:
    migration_paths = discover_migrations(migrations_dir)
    if not migration_paths:
        raise RuntimeError(f"No schema migrations found in {migrations_dir}")

    if connect is None:
        import asyncpg

        connect = asyncpg.connect

    conn = await connect(dsn or _database_dsn())
    lock_acquired = False
    applied: list[str] = []
    skipped: list[str] = []
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK_ID)
        lock_acquired = True
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                checksum CHAR(64) NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )

        for migration_path in migration_paths:
            version = migration_path.stem
            checksum = migration_checksum(migration_path)
            compatible_checksums = _compatible_migration_checksums(migration_path)
            existing = await conn.fetchrow(
                "SELECT checksum FROM schema_migrations WHERE version = $1",
                version,
            )
            if existing:
                recorded_checksum = str(existing["checksum"]).strip()
                if recorded_checksum not in compatible_checksums:
                    approved_checksum = KNOWN_REPLACED_MIGRATION_CHECKSUMS.get(
                        version, {}
                    ).get(recorded_checksum)
                    if approved_checksum not in compatible_checksums:
                        raise MigrationChecksumMismatch(
                            f"Migration {version} checksum changed after it was applied. "
                            "Refusing to update it without an explicit approved replacement."
                        )

                    update_status = await conn.execute(
                        "UPDATE schema_migrations SET checksum = $2 "
                        "WHERE version = $1 AND checksum = $3",
                        version,
                        checksum,
                        recorded_checksum,
                    )
                    if update_status != "UPDATE 1":
                        raise MigrationChecksumMismatch(
                            f"Migration {version} checksum changed after it was applied, "
                            "but its approved replacement could not be applied safely."
                        )
                    logger.info("migration %s checksum updated (approved replacement)", version)
                skipped.append(version)
                continue

            sql = migration_path.read_text(encoding="utf-8")
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
                    version,
                    checksum,
                )
            applied.append(version)

        return MigrationRunResult(tuple(applied), tuple(skipped))
    finally:
        if lock_acquired:
            try:
                await conn.execute("SELECT pg_advisory_unlock($1)", MIGRATION_LOCK_ID)
            except Exception:
                pass
        await conn.close()
