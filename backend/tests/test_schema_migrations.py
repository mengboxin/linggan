import hashlib
import re
from pathlib import Path
from runpy import run_path

import pytest

from core.schema_migrations import (
    MigrationChecksumMismatch,
    migration_checksum,
    run_schema_migrations,
)
from core import schema_migrations


class FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class FakeConnection:
    def __init__(
        self,
        applied: dict[str, str] | None = None,
        *,
        fail_checksum_update: bool = False,
    ):
        self.applied = dict(applied or {})
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self.closed = False
        self.fail_checksum_update = fail_checksum_update

    async def execute(self, sql: str, *args):
        self.executed.append((sql, args))
        if sql.startswith("INSERT INTO schema_migrations"):
            self.applied[str(args[0])] = str(args[1])
            return "INSERT 0 1"
        if sql.startswith("UPDATE schema_migrations SET checksum"):
            version, checksum, previous_checksum = (str(arg) for arg in args)
            if not self.fail_checksum_update and self.applied.get(version) == previous_checksum:
                self.applied[version] = checksum
                return "UPDATE 1"
            return "UPDATE 0"
        return "SELECT 1"

    async def fetchrow(self, sql: str, version: str):
        checksum = self.applied.get(version)
        return {"checksum": checksum} if checksum else None

    def transaction(self):
        return FakeTransaction()

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_rejects_empty_migration_directory_before_connecting(tmp_path: Path):
    connected = False

    async def connect(_dsn: str):
        nonlocal connected
        connected = True
        return FakeConnection()

    with pytest.raises(RuntimeError, match="No schema migrations found"):
        await run_schema_migrations(
            "postgresql://example",
            migrations_dir=tmp_path,
            connect=connect,
        )

    assert connected is False


@pytest.mark.asyncio
async def test_applies_pending_migrations_in_filename_order(tmp_path: Path):
    first = tmp_path / "001_first.sql"
    second = tmp_path / "002_second.sql"
    second.write_text("SELECT 2;", encoding="utf-8")
    first.write_text("SELECT 1;", encoding="utf-8")
    conn = FakeConnection()

    async def connect(_dsn: str):
        return conn

    result = await run_schema_migrations(
        "postgresql://example",
        migrations_dir=tmp_path,
        connect=connect,
    )

    migration_sql = [sql for sql, _args in conn.executed if sql.startswith("SELECT ") and "advisory" not in sql]
    assert migration_sql == ["SELECT 1;", "SELECT 2;"]
    assert result.applied == ("001_first", "002_second")
    assert result.skipped == ()
    assert conn.closed is True


@pytest.mark.asyncio
async def test_skips_applied_migration_with_matching_checksum(tmp_path: Path):
    migration = tmp_path / "001_first.sql"
    migration.write_text("SELECT 1;", encoding="utf-8")
    conn = FakeConnection({migration.stem: migration_checksum(migration)})

    async def connect(_dsn: str):
        return conn

    result = await run_schema_migrations(
        "postgresql://example",
        migrations_dir=tmp_path,
        connect=connect,
    )

    assert result.applied == ()
    assert result.skipped == ("001_first",)
    assert not any(sql == "SELECT 1;" for sql, _args in conn.executed)


@pytest.mark.asyncio
async def test_rejects_changed_applied_migration_and_closes_connection(tmp_path: Path):
    migration = tmp_path / "001_first.sql"
    migration.write_text("SELECT 1;", encoding="utf-8")
    conn = FakeConnection({migration.stem: "0" * 64})

    async def connect(_dsn: str):
        return conn

    with pytest.raises(MigrationChecksumMismatch, match="changed after it was applied"):
        await run_schema_migrations(
            "postgresql://example",
            migrations_dir=tmp_path,
            connect=connect,
        )

    assert not any(
        sql.startswith("UPDATE schema_migrations SET checksum")
        for sql, _args in conn.executed
    )
    assert any(
        sql == "SELECT pg_advisory_unlock($1)" for sql, _args in conn.executed
    )
    assert conn.closed is True


@pytest.mark.asyncio
async def test_accepts_known_replaced_migration_checksum(tmp_path: Path, monkeypatch):
    migration = tmp_path / "001_known_replaced.sql"
    migration.write_text("SELECT 1;", encoding="utf-8")
    current_checksum = migration_checksum(migration)
    previous_checksum = "1" * 64
    conn = FakeConnection({migration.stem: previous_checksum})
    monkeypatch.setattr(
        schema_migrations,
        "KNOWN_REPLACED_MIGRATION_CHECKSUMS",
        {migration.stem: {previous_checksum: current_checksum}},
    )

    async def connect(_dsn: str):
        return conn

    result = await run_schema_migrations(
        "postgresql://example",
        migrations_dir=tmp_path,
        connect=connect,
    )

    assert result.applied == ()
    assert result.skipped == (migration.stem,)
    assert conn.applied[migration.stem] == current_checksum
    assert not any(sql == "SELECT 1;" for sql, _args in conn.executed)
    assert (
        "UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum = $3",
        (migration.stem, current_checksum, previous_checksum),
    ) in conn.executed
    assert conn.closed is True


@pytest.mark.asyncio
async def test_skips_applied_migration_with_equivalent_crlf_checksum(tmp_path: Path):
    migration = tmp_path / "001_first.sql"
    migration.write_bytes(b"SELECT 1;\n")
    crlf_checksum = hashlib.sha256(b"SELECT 1;\r\n").hexdigest()
    conn = FakeConnection({migration.stem: crlf_checksum})

    async def connect(_dsn: str):
        return conn

    result = await run_schema_migrations(
        "postgresql://example",
        migrations_dir=tmp_path,
        connect=connect,
    )

    assert result.applied == ()
    assert result.skipped == (migration.stem,)
    assert conn.applied[migration.stem] == crlf_checksum


def test_migration_checksum_is_line_ending_independent(tmp_path: Path):
    lf = tmp_path / "lf.sql"
    crlf = tmp_path / "crlf.sql"
    lf.write_bytes(b"SELECT 1;\nSELECT 2;\n")
    crlf.write_bytes(b"SELECT 1;\r\nSELECT 2;\r\n")

    assert migration_checksum(lf) == migration_checksum(crlf)


@pytest.mark.asyncio
async def test_rejects_known_replacement_when_checksum_compare_and_swap_fails(
    tmp_path: Path, monkeypatch
):
    migration = tmp_path / "001_known_replaced.sql"
    migration.write_text("SELECT 1;", encoding="utf-8")
    current_checksum = migration_checksum(migration)
    previous_checksum = "1" * 64
    conn = FakeConnection(
        {migration.stem: previous_checksum}, fail_checksum_update=True
    )
    monkeypatch.setattr(
        schema_migrations,
        "KNOWN_REPLACED_MIGRATION_CHECKSUMS",
        {migration.stem: {previous_checksum: current_checksum}},
    )

    async def connect(_dsn: str):
        return conn

    with pytest.raises(MigrationChecksumMismatch, match="could not be applied safely"):
        await run_schema_migrations(
            "postgresql://example",
            migrations_dir=tmp_path,
            connect=connect,
        )

    assert conn.applied[migration.stem] == previous_checksum
    assert conn.closed is True


def test_current_reconciliation_contains_storage_and_history_fields():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "20260712_001_reconcile_schema.sql"
    sql = migration.read_text(encoding="utf-8")

    for required in (
        "history_key",
        "asset_scope",
        "expires_notice_sent_at",
        "user_storage_quotas",
        "file_assets",
        "backup_records",
        "pet_chat_history",
        "idx_pet_chat_user_time",
        "ai_models_category_check",
        "value_jsonb",
        "ALTER COLUMN credits SET DEFAULT 30.00",
    ):
        assert required in sql


def test_current_reconciliation_contains_required_setting_seeds():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "20260712_001_reconcile_schema.sql"
    sql = migration.read_text(encoding="utf-8")

    for key in (
        "feature.touch_edit.enabled",
        "feature.touch_edit.allowlist",
        "feature.agent_orchestrator.enabled",
        "feature.agent_orchestrator.allowlist",
        "feature.ppt_canvas.enabled",
        "feature.ppt_canvas.allowlist",
        "registration_welcome_credits",
    ):
        assert key in sql


def test_foxapi_credentials_migration_is_versioned_and_extension_free():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "20260713_001_foxapi_credentials.sql"
    sql = migration.read_text(encoding="utf-8")

    for required in (
        "auth_provider",
        "billing_mode",
        "user_api_credentials",
        "encrypted_api_key",
        "key_fingerprint",
        "model_catalog",
        "request_count",
        "failed_count",
        "last_verified_at",
        "last_used_at",
        "last_model_id",
        "last_error",
    ):
        assert required in sql

    assert "CREATE EXTENSION" not in sql


def test_pet_preferences_migration_is_versioned_and_idempotent():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "20260717_001_user_pet_preferences.sql"
    sql = migration.read_text(encoding="utf-8")

    for required in (
        "ADD COLUMN IF NOT EXISTS pet_id",
        "ADD COLUMN IF NOT EXISTS pet_custom_name",
        "idx_users_pet_id",
    ):
        assert required in sql


def test_legal_documents_migration_preserves_immutable_versions_and_evidence():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260813_001_legal_documents.sql"
    )
    sql = migration.read_text(encoding="utf-8")

    for required in (
        "legal_document_versions",
        "user_legal_acceptances",
        "content_hash",
        "document_hash",
        "prevent_legal_document_version_mutation",
        "trg_legal_document_versions_immutable",
        "user_legal_acceptances_document_fk",
        "idx_user_legal_acceptances_user_time",
        "context_type",
        "context_id",
        "metadata",
        "idx_user_legal_acceptances_context",
    ):
        assert required in sql


def test_schema_index_hardening_is_excluded_from_application_startup():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260731_002_schema_index_hardening.sql"
    )
    sql = migration.read_text(encoding="utf-8")
    maintenance = (
        Path(__file__).resolve().parents[1]
        / "scripts"
        / "maintenance"
        / "schema_index_hardening.sql"
    ).read_text(encoding="utf-8")

    assert "SELECT 1;" in sql
    assert re.search(r"(?mi)^\s*(?:CREATE|DROP)\s+INDEX", sql) is None
    assert "schema_index_hardening.sql" in sql

    for required in (
        "idx_sessions_project",
        "idx_sessions_user",
        "idx_image_assets_conversation",
        "idx_image_assets_message",
        "idx_edit_history_session",
        "idx_user_sessions_user_id",
        "idx_user_sessions_token",
        "idx_credit_tx_user_id",
        "idx_credit_tx_created_at",
        "idx_credit_tx_user_idempotency",
        "idx_conversation_messages_conv",
        "idx_conversation_messages_conv_role_created",
        "pg_index",
        "pg_constraint",
        "index_meta.indisvalid",
        "index_meta.indisready",
        "constraint_meta.conindid = index_meta.indexrelid",
        "CREATE INDEX CONCURRENTLY",
        "DROP INDEX CONCURRENTLY",
        "\\gexec",
    ):
        assert required in maintenance

    assert "DO $$" not in maintenance
    assert "BEGIN;" not in maintenance
    assert (
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS "
        "idx_conversation_messages_conv_role_created"
    ) in maintenance
    assert "ON conversation_messages (conversation_id, role, created_at DESC)" in maintenance


def test_credit_transaction_idempotency_index_is_excluded_from_startup():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260731_001_credit_transaction_idempotency.sql"
    )
    sql = migration.read_text(encoding="utf-8")
    maintenance = (
        Path(__file__).resolve().parents[1]
        / "scripts"
        / "maintenance"
        / "schema_index_hardening.sql"
    ).read_text(encoding="utf-8")

    assert "ADD COLUMN IF NOT EXISTS idempotency_key TEXT" in sql
    assert "SELECT 1;" in sql
    assert re.search(r"(?mi)^\s*CREATE\s+UNIQUE\s+INDEX", sql) is None
    assert "schema_index_hardening.sql" in sql
    assert (
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_tx_user_idempotency"
        in maintenance
    )


def test_unlimited_user_asset_retention_is_batched_outside_startup():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260731_003_unlimited_user_asset_retention.sql"
    )
    sql = migration.read_text(encoding="utf-8")
    maintenance = (
        Path(__file__).resolve().parents[1]
        / "scripts"
        / "maintenance"
        / "clear_web_history_expiry.py"
    ).read_text(encoding="utf-8")

    assert "SELECT 1;" in sql
    assert re.search(r"(?mi)^\s*UPDATE\s+", sql) is None
    assert "clear_web_history_expiry.py" in sql

    for table in (
        "image_assets",
        "file_assets",
        "ppt_presentation_uploads",
    ):
        assert f"FROM {table}" in maintenance

    assert maintenance.count("SET expires_at = NULL") == 3
    assert maintenance.count("FOR UPDATE SKIP LOCKED") == 3
    assert maintenance.count("LIMIT $1") == 3
    assert maintenance.count("user_id IS NOT NULL") == 6
    assert maintenance.count("retention_class = 'web_history'") == 4
    assert "COALESCE(NULLIF(source_client, ''), 'web') = 'web'" in maintenance
    assert maintenance.count("expires_at IS NOT NULL") == 6
    assert "conn.transaction" not in maintenance


def test_startup_safe_replacements_are_approved_for_already_applied_migrations():
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    for version in (
        "20260731_001_credit_transaction_idempotency",
        "20260731_002_schema_index_hardening",
        "20260731_003_unlimited_user_asset_retention",
    ):
        checksum = migration_checksum(migrations_dir / f"{version}.sql")
        assert checksum in schema_migrations.KNOWN_REPLACED_MIGRATION_CHECKSUMS[version].values()


def test_schema_audit_groups_only_exact_non_constraint_duplicate_indexes():
    audit_path = Path(__file__).resolve().parents[1] / "scripts" / "audit_db_schema.py"
    audit_globals = run_path(str(audit_path))
    find_duplicates = audit_globals["find_exact_duplicate_non_constraint_indexes"]

    def index_row(
        name: str,
        *,
        predicate: str = "",
        is_constraint: bool = False,
    ) -> dict[str, object]:
        return {
            "schema_name": "public",
            "table_name": "image_assets",
            "index_name": name,
            "definition": f"CREATE INDEX {name} ON image_assets (conversation_id)",
            "access_method": "btree",
            "is_unique": False,
            "is_valid": True,
            "is_ready": True,
            "nulls_not_distinct": False,
            "key_attribute_count": 1,
            "attribute_count": 1,
            "indkey": "3",
            "indcollation": "100",
            "indclass": "3126",
            "indoption": "0",
            "expressions": "",
            "predicate": predicate,
            "reloptions": "",
            "tablespace": "",
            "is_constraint": is_constraint,
        }

    duplicates = find_duplicates(
        [
            index_row("idx_image_assets_conversation"),
            index_row("idx_image_assets_conversation_legacy"),
            index_row(
                "idx_image_assets_conversation_filtered",
                predicate="conversation_id IS NOT NULL",
            ),
            index_row("image_assets_conversation_key", is_constraint=True),
            {**index_row("idx_image_assets_conversation_invalid"), "is_valid": False},
        ]
    )

    assert len(duplicates) == 1
    assert duplicates[0].table_name == "image_assets"
    assert duplicates[0].index_names == (
        "idx_image_assets_conversation",
        "idx_image_assets_conversation_legacy",
    )


def test_init_schema_contains_post_baseline_tables_and_fields():
    init_sql = Path(__file__).resolve().parents[1] / "scripts" / "init_db.sql"
    sql = init_sql.read_text(encoding="utf-8")

    for required in (
        "asset_scope",
        "expires_notice_sent_at",
        "user_storage_quotas",
        "storage_cleanup_runs",
        "asset_object_deletion_queue",
        "storage_admin_notifications",
        "file_assets",
        "pet_chat_history",
        "backup_records",
        "schema_migrations",
    ):
        assert required in sql


def test_init_schema_covers_every_audited_table_column_and_index():
    init_sql = Path(__file__).resolve().parents[1] / "scripts" / "init_db.sql"
    audit_path = Path(__file__).resolve().parents[1] / "scripts" / "audit_db_schema.py"
    audit_globals = run_path(str(audit_path))
    expected_table_columns = audit_globals["EXPECTED_TABLE_COLUMNS"]
    expected_indexes = audit_globals["EXPECTED_INDEXES"]
    sql = init_sql.read_text(encoding="utf-8")
    tables: dict[str, set[str]] = {}
    current_table: str | None = None

    for raw_line in sql.splitlines():
        line = raw_line.strip()
        create_match = re.match(r"CREATE TABLE IF NOT EXISTS ([a-z_]+) \(", line)
        if create_match:
            current_table = create_match.group(1)
            tables[current_table] = set()
            continue
        if current_table is None:
            continue
        if line == ");":
            current_table = None
            continue
        column_match = re.match(r"([a-z_][a-z0-9_]*)\s+", line)
        if column_match and column_match.group(1).upper() not in {
            "CHECK",
            "CONSTRAINT",
            "FOREIGN",
            "PRIMARY",
            "UNIQUE",
        }:
            tables[current_table].add(column_match.group(1))

    for table, expected_columns in expected_table_columns.items():
        assert table in tables, f"init_db.sql is missing table {table}"
        missing = set(expected_columns) - tables[table]
        assert not missing, f"init_db.sql is missing {table} columns: {sorted(missing)}"

    for index in expected_indexes:
        assert index in sql, f"init_db.sql is missing audited index {index}"
