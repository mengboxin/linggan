"""Read-only database schema audit for the current PixelScribe backend.

Run from the production server:
    cd /www/wwwroot/pixelscribe/backend
    python scripts/audit_db_schema.py

The script only reads information_schema / pg_catalog metadata. It does not
create, alter, update, or delete anything.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - production dependency should exist
    load_dotenv = None

if load_dotenv is not None:
    load_dotenv(BACKEND_DIR / ".env")


EXPECTED_TABLE_COLUMNS: dict[str, list[str]] = {
    "users": [
        "id",
        "email",
        "password_hash",
        "display_name",
        "avatar_url",
        "role",
        "status",
        "quota_tasks_day",
        "quota_tasks_month",
        "total_tasks",
        "total_layers",
        "credits",
        "auth_provider",
        "billing_mode",
        "pet_id",
        "pet_custom_name",
        "last_active_at",
        "created_at",
        "updated_at",
    ],
    "user_api_credentials": [
        "user_id",
        "provider",
        "api_base",
        "encrypted_api_key",
        "key_fingerprint",
        "model_catalog",
        "status",
        "last_verified_at",
        "last_used_at",
        "request_count",
        "failed_count",
        "last_model_id",
        "last_error",
        "created_at",
        "updated_at",
    ],
    "user_sessions": [
        "id",
        "user_id",
        "refresh_token",
        "user_agent",
        "ip_address",
        "expires_at",
        "revoked",
        "created_at",
    ],
    "tasks": [
        "id",
        "user_id",
        "type",
        "status",
        "progress",
        "model_id",
        "error",
        "duration_ms",
        "cost_credits",
        "created_at",
        "completed_at",
    ],
    "ai_models": [
        "id",
        "name",
        "category",
        "tags",
        "description",
        "cover_url",
        "endpoint",
        "api_key",
        "provider",
        "provider_logo",
        "price_type",
        "price_credits",
        "enabled",
        "is_featured",
        "sort_order",
        "total_calls",
        "avg_duration_ms",
        "meta",
        "created_at",
        "updated_at",
    ],
    "credit_transactions": [
        "id",
        "user_id",
        "amount",
        "balance_after",
        "type",
        "related_task_id",
        "description",
        "idempotency_key",
        "balance_source",
        "subscription_id",
        "created_at",
    ],
    "prompt_history": [
        "id",
        "user_id",
        "content",
        "model_id",
        "mode",
        "tags",
        "note",
        "use_count",
        "is_starred",
        "created_at",
        "updated_at",
    ],
    "projects": [
        "id",
        "user_id",
        "name",
        "type",
        "description",
        "thumbnail",
        "is_archived",
        "created_at",
        "updated_at",
    ],
    "project_tasks": [
        "id",
        "project_id",
        "task_id",
        "name",
        "snapshot",
        "created_at",
        "updated_at",
    ],
    "ppt_generations": [
        "id",
        "user_id",
        "project_id",
        "topic",
        "style_requirement",
        "page_count",
        "optimize_prompt",
        "optimized_topic",
        "status",
        "progress",
        "error",
        "outline",
        "images",
        "pptx_url",
        "cost_credits",
        "created_at",
        "completed_at",
    ],
    "conversations": [
        "id",
        "user_id",
        "type",
        "title",
        "creation_key",
        "storage_workspace",
        "is_archived",
        "created_at",
        "updated_at",
    ],
    "conversation_messages": [
        "id",
        "conversation_id",
        "role",
        "content",
        "meta",
        "history_key",
        "history_summary",
        "created_at",
    ],
    "image_assets": [
        "id",
        "user_id",
        "conversation_id",
        "message_id",
        "task_id",
        "prompt",
        "model_id",
        "mime_type",
        "width",
        "height",
        "size_bytes",
        "sha256",
        "original_key",
        "original_url",
        "preview_key",
        "preview_url",
        "thumb_key",
        "thumb_url",
        "asset_scope",
        "retention_class",
        "source_client",
        "expires_at",
        "expires_notice_sent_at",
        "storage_provider",
        "object_count",
        "is_pinned",
        "created_at",
        "updated_at",
    ],
    "ppt_presentation_uploads": [
        "id",
        "user_id",
        "title",
        "filename",
        "source_key",
        "source_url",
        "source_mime",
        "source_size",
        "source_sha256",
        "slide_count",
        "slides",
        "expires_at",
        "expires_notice_sent_at",
        "source_client",
        "storage_provider",
        "created_at",
        "updated_at",
    ],
    "system_config": [
        "key",
        "value",
        "value_type",
        "description",
        "is_secret",
        "updated_by",
        "updated_at",
    ],
    "payment_orders": [
        "id",
        "user_id",
        "order_no",
        "trade_no",
        "amount_yuan",
        "credits",
        "bonus_credits",
        "product_kind",
        "product_id",
        "product_name",
        "product_snapshot",
        "pay_channel",
        "status",
        "notify_url",
        "return_url",
        "expires_at",
        "paid_at",
        "completed_at",
        "cancelled_at",
        "credited_at",
        "credit_transaction_id",
        "provider_payload",
        "client_ip",
        "created_at",
        "updated_at",
    ],
    "payment_channels": [
        "id",
        "channel_code",
        "channel_name",
        "merchant_id",
        "merchant_key",
        "api_url",
        "notify_url",
        "return_url",
        "enabled",
        "config_json",
        "updated_at",
    ],
    "recharge_packages": [
        "id",
        "amount_yuan",
        "base_credits",
        "bonus_credits",
        "discount_label",
        "sort_order",
        "enabled",
        "created_at",
    ],
    "segmentation_cache": [
        "content_hash",
        "user_id",
        "masks_jsonb",
        "width",
        "height",
        "storage_url",
        "created_at",
        "last_accessed_at",
        "access_count",
    ],
    "agent_plans": [
        "id",
        "user_id",
        "instruction",
        "sub_tasks",
        "status",
        "created_at",
        "updated_at",
    ],
    "ppt_canvas_slides": [
        "job_id",
        "index",
        "elements_json",
        "background",
    ],
    "sessions": [
        "id",
        "user_id",
        "project_id",
        "name",
        "status",
        "source_width",
        "source_height",
        "preview_key",
        "snapshot_key",
        "workflow_kind",
        "meta",
        "created_at",
        "updated_at",
    ],
    "system_settings": ["key", "value", "updated_at"],
    "user_notifications": [
        "id",
        "user_id",
        "type",
        "title",
        "body",
        "action_url",
        "meta",
        "read_at",
        "created_at",
    ],
    "edit_history": [
        "id",
        "session_id",
        "user_id",
        "action",
        "description",
        "is_undoable",
        "created_at",
    ],
    "storage_cleanup_runs": [
        "id",
        "mode",
        "user_id",
        "candidate_count",
        "object_count",
        "object_deleted",
        "bytes_estimated",
        "status",
        "details",
        "created_at",
    ],
    "asset_object_deletion_queue": [
        "object_key",
        "user_id",
        "reason",
        "status",
        "attempts",
        "last_error",
        "next_attempt_at",
        "created_at",
        "updated_at",
    ],
    "asset_object_mirror_queue": [
        "target_provider",
        "target_endpoint",
        "target_bucket",
        "target_region",
        "object_key",
        "operation",
        "revision",
        "status",
        "attempts",
        "last_error",
        "next_attempt_at",
        "created_at",
        "updated_at",
    ],
    "asset_record_cleanup_intents": [
        "id",
        "user_id",
        "reason",
        "records",
        "status",
        "attempts",
        "last_error",
        "next_attempt_at",
        "created_at",
        "updated_at",
    ],
    "storage_admin_notifications": ["kind", "last_sent_at", "payload"],
    "file_assets": [
        "id",
        "user_id",
        "task_id",
        "category",
        "filename",
        "mime_type",
        "size_bytes",
        "sha256",
        "storage_key",
        "storage_url",
        "retention_class",
        "source_client",
        "expires_at",
        "expires_notice_sent_at",
        "storage_provider",
        "created_at",
        "updated_at",
    ],
    "pet_chat_history": [
        "id",
        "user_id",
        "role",
        "content",
        "pet_name",
        "created_at",
    ],
    "backup_records": [
        "id",
        "status",
        "filename",
        "storage_provider",
        "storage_endpoint",
        "storage_bucket",
        "storage_region",
        "storage_key",
        "local_path",
        "size_bytes",
        "sha256",
        "trigger_type",
        "started_at",
        "completed_at",
        "expires_at",
        "error",
        "created_at",
        "updated_at",
    ],
    "public_gallery_item_reactions": [
        "item_key",
        "user_id",
        "reaction",
        "created_at",
    ],
    "legal_document_versions": [
        "document_type",
        "version",
        "title",
        "summary",
        "content_markdown",
        "content_hash",
        "published_on",
        "effective_on",
        "requires_reacceptance",
        "required_at_login",
        "created_at",
    ],
    "user_legal_acceptances": [
        "id",
        "user_id",
        "document_type",
        "document_version",
        "document_hash",
        "source",
        "ip_hash",
        "user_agent_hash",
        "context_type",
        "context_id",
        "metadata",
        "accepted_at",
    ],
    "subscription_plans": [
        "id",
        "name",
        "description",
        "badge_label",
        "price_yuan",
        "credits",
        "duration_days",
        "benefits",
        "enabled",
        "sort_order",
        "created_at",
        "updated_at",
    ],
    "user_subscriptions": [
        "id",
        "user_id",
        "plan_id",
        "payment_order_id",
        "status",
        "starts_at",
        "expires_at",
        "activated_at",
        "exhausted_at",
        "credits_granted",
        "quota_total",
        "quota_remaining",
        "plan_snapshot",
        "source",
        "assigned_by",
        "note",
        "revoked_at",
        "revoked_by",
        "revoke_reason",
        "quota_reset_count",
        "last_quota_reset_at",
        "created_at",
        "updated_at",
    ],
    "subscription_admin_audit": [
        "id",
        "subscription_id",
        "user_id",
        "plan_id",
        "action",
        "actor",
        "reason",
        "operation_key",
        "metadata",
        "created_at",
    ],
    "user_billing_preferences": [
        "user_id",
        "funding_source",
        "selected_subscription_id",
        "created_at",
        "updated_at",
    ],
    "schema_migrations": ["version", "checksum", "applied_at"],
}


EXPECTED_COLUMN_TYPES: dict[tuple[str, str], set[str]] = {
    ("conversation_messages", "meta"): {"jsonb"},
    ("conversation_messages", "history_summary"): {"jsonb"},
    ("image_assets", "message_id"): {"uuid"},
    ("image_assets", "asset_scope"): {"text"},
    ("image_assets", "retention_class"): {"text"},
    ("image_assets", "source_client"): {"text"},
    ("image_assets", "expires_at"): {"timestamptz"},
    ("image_assets", "expires_notice_sent_at"): {"timestamptz"},
    ("image_assets", "storage_provider"): {"text"},
    ("image_assets", "object_count"): {"int4"},
    ("ppt_presentation_uploads", "slides"): {"jsonb"},
    ("ppt_presentation_uploads", "expires_at"): {"timestamptz"},
    ("ppt_presentation_uploads", "expires_notice_sent_at"): {"timestamptz"},
    ("ppt_presentation_uploads", "source_client"): {"text"},
    ("ppt_presentation_uploads", "storage_provider"): {"text"},
    ("project_tasks", "snapshot"): {"jsonb"},
    ("sessions", "meta"): {"jsonb"},
    ("sessions", "snapshot_key"): {"text"},
    ("sessions", "workflow_kind"): {"text"},
    ("system_settings", "value"): {"jsonb"},
    ("user_notifications", "id"): {"uuid"},
    ("user_notifications", "user_id"): {"uuid"},
    ("user_notifications", "meta"): {"jsonb"},
    ("user_notifications", "read_at"): {"timestamptz"},
    ("user_notifications", "created_at"): {"timestamptz"},
    ("payment_orders", "provider_payload"): {"jsonb"},
    ("payment_orders", "product_snapshot"): {"jsonb"},
    ("payment_orders", "credit_transaction_id"): {"uuid"},
    ("credit_transactions", "subscription_id"): {"uuid"},
    ("payment_channels", "config_json"): {"jsonb"},
    ("subscription_plans", "benefits"): {"jsonb"},
    ("user_subscriptions", "id"): {"uuid"},
    ("user_subscriptions", "user_id"): {"uuid"},
    ("user_subscriptions", "payment_order_id"): {"uuid"},
    ("user_subscriptions", "plan_snapshot"): {"jsonb"},
    ("user_subscriptions", "starts_at"): {"timestamptz"},
    ("user_subscriptions", "expires_at"): {"timestamptz"},
    ("user_subscriptions", "activated_at"): {"timestamptz"},
    ("user_subscriptions", "exhausted_at"): {"timestamptz"},
    ("user_subscriptions", "revoked_at"): {"timestamptz"},
    ("user_subscriptions", "last_quota_reset_at"): {"timestamptz"},
    ("subscription_admin_audit", "id"): {"uuid"},
    ("subscription_admin_audit", "subscription_id"): {"uuid"},
    ("subscription_admin_audit", "user_id"): {"uuid"},
    ("subscription_admin_audit", "metadata"): {"jsonb"},
    ("subscription_admin_audit", "created_at"): {"timestamptz"},
    ("user_billing_preferences", "user_id"): {"uuid"},
    ("user_billing_preferences", "selected_subscription_id"): {"uuid"},
    ("storage_cleanup_runs", "details"): {"jsonb"},
    ("storage_admin_notifications", "payload"): {"jsonb"},
    ("backup_records", "id"): {"uuid"},
    ("backup_records", "size_bytes"): {"int8"},
    ("backup_records", "started_at"): {"timestamptz"},
    ("backup_records", "completed_at"): {"timestamptz"},
    ("backup_records", "expires_at"): {"timestamptz"},
    ("public_gallery_item_reactions", "item_key"): {"text"},
    ("public_gallery_item_reactions", "user_id"): {"uuid"},
    ("public_gallery_item_reactions", "reaction"): {"text"},
    ("public_gallery_item_reactions", "created_at"): {"timestamptz"},
    ("schema_migrations", "checksum"): {"bpchar"},
    ("schema_migrations", "applied_at"): {"timestamptz"},
}


EXPECTED_CHECK_TOKENS: dict[str, dict[str, list[str]]] = {
    "conversations": {
        "conversations_type_check": ["ppt", "image", "sci-fig", "poster"],
        "conversations_storage_workspace_check": ["local", "cloud"],
    },
    "conversation_messages": {
        "conversation_messages_role_check": ["user", "assistant"],
    },
    "credit_transactions": {
        "credit_transactions_type_check": [
            "recharge",
            "consume",
            "refund",
            "gift",
            "admin_adjust",
            "payment",
            "subscription",
        ],
    },
    "ai_models": {
        "ai_models_category_check": [
            "segmentation",
            "generate",
            "llm",
            "vision",
            "video",
            "other",
        ],
        "ai_models_price_type_check": ["free", "credits", "subscription"],
    },
    "payment_orders": {
        "payment_orders_pay_channel_check": ["zpay"],
        "payment_orders_product_kind_check": ["credits", "subscription"],
        "payment_orders_status_check": [
            "pending",
            "paid",
            "completed",
            "failed",
            "cancelled",
            "expired",
            "refunded",
        ],
    },
    "payment_channels": {
        "payment_channels_channel_code_check": ["zpay"],
    },
    "subscription_plans": {
        "subscription_plans_id_check": ["a-z", "a-z0-9_", "63"],
    },
    "user_subscriptions": {
        "user_subscriptions_status_check": ["active", "queued", "exhausted", "expired", "revoked"],
        "user_subscriptions_period_check": ["expires_at", "starts_at"],
        "user_subscriptions_source_check": ["payment", "admin"],
        "user_subscriptions_quota_reset_count_check": ["quota_reset_count"],
    },
    "subscription_admin_audit": {
        "subscription_admin_audit_action_check": [
            "assigned",
            "revoked",
            "quota_reset",
            "plan_saved",
        ],
    },
    "tasks": {
        "tasks_type_check": [
            "segmentation",
            "inpainting",
            "layer-edit",
            "compose",
            "enhance",
            "generate-video",
        ],
        "tasks_status_check": [
            "pending",
            "processing",
            "completed",
            "failed",
            "cancelled",
        ],
    },
    "projects": {"projects_type_check": ["image", "ppt"]},
    "sessions": {"sessions_status_check": ["active", "deleted"]},
    "users": {
        "users_role_check": ["user", "vip", "admin"],
        "users_status_check": ["active", "banned", "pending"],
    },
    "pet_chat_history": {
        "pet_chat_history_role_check": ["user", "assistant"],
    },
    "public_gallery_item_reactions": {
        "public_gallery_item_reactions_item_key_check": [
            "char_length(item_key)",
            "160",
            "A-Za-z0-9",
        ],
        "public_gallery_item_reactions_reaction_check": ["like", "favorite"],
    },
}


EXPECTED_INDEXES = {
    "idx_user_legal_acceptances_user_time",
    "idx_user_legal_acceptances_document",
    "idx_user_legal_acceptances_context",
    "idx_conversations_user_type",
    "idx_conversations_updated",
    "idx_conversations_user_workspace_creation_key_unique",
    "idx_conversations_user_workspace_type_updated",
    "idx_conversation_messages_conv",
    "idx_conversation_messages_conv_role_created",
    "idx_conversation_messages_history_key_unique",
    "idx_user_sessions_user_id",
    "idx_user_sessions_token",
    "idx_credit_tx_user_id",
    "idx_credit_tx_created_at",
    "idx_image_assets_user_created",
    "idx_image_assets_task",
    "idx_image_assets_user_expires",
    "idx_image_assets_user_size",
    "idx_image_assets_retention",
    "idx_image_assets_conversation",
    "idx_image_assets_message",
    "idx_ppt_uploads_user_updated",
    "idx_ppt_uploads_user_expires",
    "idx_file_assets_user_expires",
    "idx_file_assets_user_size",
    "idx_file_assets_category",
    "idx_file_assets_storage_key_unique",
    "idx_asset_deletion_queue_pending",
    "idx_asset_deletion_queue_user",
    "idx_asset_mirror_queue_pending",
    "idx_asset_record_cleanup_intents_due",
    "idx_asset_record_cleanup_intents_user",
    "idx_payment_orders_pending_expires",
    "idx_payment_orders_credit_tx",
    "idx_payment_orders_trade_no_unique",
    "idx_recharge_packages_amount_unique",
    "idx_user_subscriptions_payment_order_unique",
    "idx_user_subscriptions_user_expires",
    "idx_user_subscriptions_admin_status",
    "idx_subscription_admin_audit_operation_unique",
    "idx_subscription_admin_audit_created",
    "idx_subscription_admin_audit_user",
    "idx_projects_user_type_name_unique",
    "idx_sessions_project",
    "idx_sessions_user",
    "idx_sessions_user_active_name_unique",
    "idx_sessions_user_creation_key_unique",
    "idx_edit_history_session",
    "idx_user_notifications_user_unread",
    "idx_user_notifications_user_created",
    "idx_pet_chat_user_time",
    "idx_backup_records_created_at",
    "idx_backup_records_status",
    "idx_user_api_credentials_status",
    "idx_user_api_credentials_last_used",
    "idx_user_api_credentials_user_provider",
    "idx_public_gallery_item_reactions_item",
    "idx_public_gallery_item_reactions_user",
    "public_gallery_item_reactions_pkey",
}
EXPECTED_REQUIRED_INDEXES = {"public_gallery_item_reactions_pkey"}


EXPECTED_EXTENSIONS = {"pgcrypto", "pg_trgm"}
EXPECTED_FUNCTIONS = {
    "delete_public_generation_gallery_reactions",
    "gen_random_uuid",
    "prevent_legal_document_version_mutation",
    "sync_legacy_public_gallery_reaction",
}
EXPECTED_TRIGGERS = {
    ("legal_document_versions", "trg_legal_document_versions_immutable"),
    ("public_generation_reactions", "trg_sync_legacy_public_gallery_reaction"),
    ("public_generations", "trg_delete_public_generation_gallery_reactions"),
}


@dataclass(frozen=True)
class Issue:
    level: str
    kind: str
    target: str
    detail: str
    fix_hint: str = ""


@dataclass(frozen=True)
class DuplicateIndexGroup:
    table_name: str
    index_names: tuple[str, ...]
    definition: str


_INDEX_SIGNATURE_FIELDS = (
    "schema_name",
    "table_name",
    "access_method",
    "is_unique",
    "nulls_not_distinct",
    "key_attribute_count",
    "attribute_count",
    "indkey",
    "indcollation",
    "indclass",
    "indoption",
    "expressions",
    "predicate",
    "reloptions",
    "tablespace",
)


def find_exact_duplicate_non_constraint_indexes(
    index_rows: Iterable[Mapping[str, object]],
) -> list[DuplicateIndexGroup]:
    grouped: dict[tuple[str, ...], list[Mapping[str, object]]] = {}
    for row in index_rows:
        if row["is_constraint"] or not row["is_valid"] or not row["is_ready"]:
            continue
        signature = tuple(
            "" if row[field] is None else str(row[field])
            for field in _INDEX_SIGNATURE_FIELDS
        )
        grouped.setdefault(signature, []).append(row)

    duplicates: list[DuplicateIndexGroup] = []
    for rows in grouped.values():
        if len(rows) < 2:
            continue
        duplicates.append(
            DuplicateIndexGroup(
                table_name=str(rows[0]["table_name"]),
                index_names=tuple(sorted(str(row["index_name"]) for row in rows)),
                definition=str(rows[0]["definition"]),
            )
        )

    return sorted(duplicates, key=lambda group: (group.table_name, group.index_names))


def _database_url() -> str:
    from core.config import settings

    return settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


def _redacted_dsn(dsn: str) -> str:
    parts = urlsplit(dsn)
    if not parts.scheme:
        return "<configured>"
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    user = parts.username or ""
    path = parts.path or ""
    auth = f"{user}:***@" if user else ""
    return f"{parts.scheme}://{auth}{host}{port}{path}"


def _constraint_def_for(
    constraints: dict[tuple[str, str], str], table: str, constraint_name: str
) -> str | None:
    direct = constraints.get((table, constraint_name))
    if direct:
        return direct
    prefix = f"{table}_{constraint_name}"
    for (constraint_table, actual_name), definition in constraints.items():
        if constraint_table == table and actual_name.endswith(prefix):
            return definition
    return None


async def audit(json_output: bool = False) -> int:
    import asyncpg

    dsn = _database_url()
    issues: list[Issue] = []
    conn = await asyncpg.connect(dsn, timeout=10)
    try:
        db_info = await conn.fetchrow(
            """
            SELECT
                current_database() AS database_name,
                current_user AS current_user,
                inet_server_addr()::text AS server_addr,
                inet_server_port() AS server_port
            """
        )

        columns_rows = await conn.fetch(
            """
            SELECT table_name, column_name, udt_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
            """
        )
        actual_columns: dict[str, dict[str, str]] = {}
        for row in columns_rows:
            actual_columns.setdefault(row["table_name"], {})[row["column_name"]] = row[
                "udt_name"
            ]

        table_owner_rows = await conn.fetch(
            """
            SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            """
        )
        table_owners = {
            row["table_name"]: row["owner"]
            for row in table_owner_rows
        }

        constraint_rows = await conn.fetch(
            """
            SELECT
                conrelid::regclass::text AS table_name,
                conname,
                pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace
            """
        )
        constraints = {
            (row["table_name"].split(".")[-1], row["conname"]): row["definition"]
            for row in constraint_rows
        }

        index_rows = await conn.fetch(
            """
            SELECT
                table_namespace.nspname AS schema_name,
                table_class.relname AS table_name,
                index_class.relname AS index_name,
                pg_get_indexdef(index_meta.indexrelid) AS definition,
                access_method.amname AS access_method,
                index_meta.indisunique AS is_unique,
                index_meta.indisvalid AS is_valid,
                index_meta.indisready AS is_ready,
                index_meta.indnullsnotdistinct AS nulls_not_distinct,
                index_meta.indnkeyatts AS key_attribute_count,
                index_meta.indnatts AS attribute_count,
                index_meta.indkey::text AS indkey,
                index_meta.indcollation::text AS indcollation,
                index_meta.indclass::text AS indclass,
                index_meta.indoption::text AS indoption,
                COALESCE(pg_get_expr(index_meta.indexprs, index_meta.indrelid), '')
                    AS expressions,
                COALESCE(pg_get_expr(index_meta.indpred, index_meta.indrelid), '')
                    AS predicate,
                COALESCE(array_to_string(index_class.reloptions, ','), '') AS reloptions,
                COALESCE(tablespace.spcname, '') AS tablespace,
                EXISTS (
                    SELECT 1
                    FROM pg_constraint AS constraint_meta
                    WHERE constraint_meta.conindid = index_meta.indexrelid
                ) AS is_constraint
            FROM pg_index AS index_meta
            JOIN pg_class AS index_class ON index_class.oid = index_meta.indexrelid
            JOIN pg_class AS table_class ON table_class.oid = index_meta.indrelid
            JOIN pg_namespace AS table_namespace
                ON table_namespace.oid = table_class.relnamespace
            JOIN pg_am AS access_method ON access_method.oid = index_class.relam
            LEFT JOIN pg_tablespace AS tablespace
                ON tablespace.oid = index_class.reltablespace
            WHERE table_namespace.nspname = 'public'
            """
        )
        indexes = {
            row["index_name"]
            for row in index_rows
            if row["is_valid"] and row["is_ready"]
        }

        extension_rows = await conn.fetch("SELECT extname FROM pg_extension")
        extensions = {row["extname"] for row in extension_rows}

        function_rows = await conn.fetch(
            """
            SELECT p.proname
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('pg_catalog', 'public')
              AND p.proname = ANY($1::text[])
            """,
            sorted(EXPECTED_FUNCTIONS),
        )
        functions = {row["proname"] for row in function_rows}

        trigger_rows = await conn.fetch(
            """
            SELECT table_class.relname AS table_name, trigger_meta.tgname AS trigger_name
            FROM pg_trigger trigger_meta
            JOIN pg_class table_class ON table_class.oid = trigger_meta.tgrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
            WHERE table_namespace.nspname = 'public'
              AND NOT trigger_meta.tgisinternal
            """
        )
        triggers = {
            (row["table_name"], row["trigger_name"])
            for row in trigger_rows
        }

        current_user = db_info["current_user"]

        for extension in sorted(EXPECTED_EXTENSIONS):
            if extension not in extensions:
                issues.append(
                    Issue(
                        "ERROR",
                        "missing_extension",
                        extension,
                        "Extension is required by init_db.sql.",
                        f'CREATE EXTENSION IF NOT EXISTS "{extension}";',
                    )
                )

        for function in sorted(EXPECTED_FUNCTIONS):
            if function not in functions:
                issues.append(
                    Issue(
                        "ERROR",
                        "missing_function",
                        function,
                        "Required database function does not exist.",
                        'Install PostgreSQL contrib/pgcrypto or use PostgreSQL with built-in gen_random_uuid().',
                    )
                )

        for table, expected_columns in EXPECTED_TABLE_COLUMNS.items():
            if table not in actual_columns:
                issues.append(
                    Issue(
                        "ERROR",
                        "missing_table",
                        table,
                        "Expected table does not exist.",
                    )
                )
                continue

            owner = table_owners.get(table)
            if owner and owner != current_user:
                issues.append(
                    Issue(
                        "WARN",
                        "owner_mismatch",
                        table,
                        f"Table owner is {owner!r}, current DB user is {current_user!r}. "
                        "Future ALTER migrations may fail.",
                        f'ALTER TABLE {table} OWNER TO "{current_user}";',
                    )
                )

            actual_table_columns = actual_columns[table]
            for column in expected_columns:
                if column not in actual_table_columns:
                    issues.append(
                        Issue(
                            "ERROR",
                            "missing_column",
                            f"{table}.{column}",
                            "Expected column does not exist.",
                        )
                    )

        for (table, column), expected_types in EXPECTED_COLUMN_TYPES.items():
            actual_type = actual_columns.get(table, {}).get(column)
            if actual_type is None:
                continue
            if actual_type not in expected_types:
                expected = ", ".join(sorted(expected_types))
                issues.append(
                    Issue(
                        "ERROR",
                        "type_mismatch",
                        f"{table}.{column}",
                        f"Column type is {actual_type!r}; expected {expected}.",
                    )
                )

        for table, table_constraints in EXPECTED_CHECK_TOKENS.items():
            if table not in actual_columns:
                continue
            for constraint_name, tokens in table_constraints.items():
                definition = _constraint_def_for(constraints, table, constraint_name)
                if not definition:
                    issues.append(
                        Issue(
                            "ERROR",
                            "missing_check",
                            f"{table}.{constraint_name}",
                            "Expected CHECK constraint does not exist.",
                        )
                    )
                    continue
                missing_tokens = [token for token in tokens if token not in definition]
                if missing_tokens:
                    issues.append(
                        Issue(
                            "ERROR",
                            "check_missing_value",
                            f"{table}.{constraint_name}",
                            "CHECK constraint is missing values: "
                            + ", ".join(missing_tokens),
                            f"Current definition: {definition}",
                        )
                    )

        for index in sorted(EXPECTED_INDEXES):
            if index not in indexes:
                required = index in EXPECTED_REQUIRED_INDEXES
                issues.append(
                    Issue(
                        "ERROR" if required else "WARN",
                        "missing_index",
                        index,
                        (
                            "Required uniqueness index does not exist."
                            if required
                            else "Expected index does not exist. This is usually a performance risk."
                        ),
                    )
                )

        for table, trigger in sorted(EXPECTED_TRIGGERS):
            if (table, trigger) not in triggers:
                issues.append(
                    Issue(
                        "ERROR",
                        "missing_trigger",
                        f"{table}.{trigger}",
                        "Required database synchronization trigger does not exist.",
                    )
                )

        for duplicate in find_exact_duplicate_non_constraint_indexes(index_rows):
            issues.append(
                Issue(
                    "WARN",
                    "duplicate_index",
                    ", ".join(duplicate.index_names),
                    "Indexes have an identical non-constraint definition on "
                    f"{duplicate.table_name}: {duplicate.definition}",
                    "Review dependencies, retain one index, then remove redundant copies "
                    "during a maintenance window.",
                )
            )

        errors = [issue for issue in issues if issue.level == "ERROR"]
        warnings = [issue for issue in issues if issue.level == "WARN"]

        if json_output:
            payload = {
                "connection": {
                    "database": db_info["database_name"],
                    "user": db_info["current_user"],
                    "server": db_info["server_addr"],
                    "port": db_info["server_port"],
                    "dsn": _redacted_dsn(dsn),
                },
                "summary": {
                    "errors": len(errors),
                    "warnings": len(warnings),
                    "issues": len(issues),
                },
                "issues": [asdict(issue) for issue in issues],
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print("PixelScribe DB schema audit")
            print(f"DSN: {_redacted_dsn(dsn)}")
            print(
                "Connected: "
                f"db={db_info['database_name']} user={db_info['current_user']} "
                f"server={db_info['server_addr']}:{db_info['server_port']}"
            )
            print(
                f"Result: {len(errors)} error(s), {len(warnings)} warning(s), "
                f"{len(issues)} total issue(s)."
            )
            if not issues:
                print("OK: no missing expected tables, columns, checks, or indexes.")
                return 0

            print("")
            for issue in issues:
                print(f"[{issue.level}] {issue.kind}: {issue.target}")
                print(f"  {issue.detail}")
                if issue.fix_hint:
                    print(f"  Hint: {issue.fix_hint}")

        return 1 if errors else 0
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit production DB schema.")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON output.",
    )
    args = parser.parse_args()

    try:
        return asyncio.run(audit(json_output=args.json))
    except Exception as exc:
        print("Schema audit failed before completion.")
        print(f"DSN: {_redacted_dsn(_database_url())}")
        print(f"Error: {type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
