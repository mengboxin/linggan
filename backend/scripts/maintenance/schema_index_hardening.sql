\set ON_ERROR_STOP on

-- This file is deliberately not a versioned application migration. Run it with
-- psql connected directly to PostgreSQL as the table owner or an administrator.
-- Do not use psql --single-transaction: CONCURRENTLY is invalid in a transaction.
-- A short lock timeout makes a busy deployment fail safely for a later retry.
SET lock_timeout TO '5s';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_project
    ON sessions (project_id, updated_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_user
    ON sessions (user_id, updated_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_image_assets_conversation
    ON image_assets (conversation_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_image_assets_message
    ON image_assets (message_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_edit_history_session
    ON edit_history (session_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_sessions_user_id
    ON user_sessions (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_sessions_token
    ON user_sessions (refresh_token);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_tx_user_id
    ON credit_transactions (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_tx_created_at
    ON credit_transactions (created_at DESC);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_tx_user_idempotency
    ON credit_transactions (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_conv
    ON conversation_messages (conversation_id, created_at ASC);
-- The existing conversation/time index serves full transcript reads. This one
-- serves per-conversation "latest user/assistant message" lookups used by
-- history summaries without scanning messages of the other role.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_conv_role_created
    ON conversation_messages (conversation_id, role, created_at DESC);

-- Keep canonical indexes and remove only exact ordinary duplicates. \gexec sends
-- every generated DROP as a separate top-level command, so it remains compatible
-- with DROP INDEX CONCURRENTLY. Constraint-backed indexes are never selected.
WITH candidate_indexes AS (
    SELECT
        table_class.oid AS table_oid,
        table_namespace.nspname AS schema_name,
        index_class.relname AS index_name,
        access_method.amname AS access_method,
        index_meta.indisunique AS is_unique,
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
        index_class.relname = ANY (
            ARRAY[
                'idx_sessions_project',
                'idx_sessions_user',
                'idx_image_assets_conversation',
                'idx_image_assets_message',
                'idx_edit_history_session',
                'idx_user_sessions_user_id',
                'idx_user_sessions_token',
                'idx_credit_tx_user_id',
                'idx_credit_tx_created_at',
                'idx_credit_tx_user_idempotency',
                'idx_conversation_messages_conv',
                'idx_conversation_messages_conv_role_created'
            ]::text[]
        ) AS is_canonical
    FROM pg_index AS index_meta
    JOIN pg_class AS index_class ON index_class.oid = index_meta.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = index_meta.indrelid
    JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_class.relam
    LEFT JOIN pg_tablespace AS tablespace
        ON tablespace.oid = index_class.reltablespace
    WHERE table_namespace.nspname = 'public'
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint AS constraint_meta
          WHERE constraint_meta.conindid = index_meta.indexrelid
      )
),
ranked_indexes AS (
    SELECT
        candidate_indexes.*,
        ROW_NUMBER() OVER (
            PARTITION BY
                table_oid,
                access_method,
                is_unique,
                nulls_not_distinct,
                key_attribute_count,
                attribute_count,
                indkey,
                indcollation,
                indclass,
                indoption,
                expressions,
                predicate,
                reloptions,
                tablespace
            ORDER BY is_canonical DESC, index_name
        ) AS duplicate_rank,
        MAX(is_canonical::int) OVER (
            PARTITION BY
                table_oid,
                access_method,
                is_unique,
                nulls_not_distinct,
                key_attribute_count,
                attribute_count,
                indkey,
                indcollation,
                indclass,
                indoption,
                expressions,
                predicate,
                reloptions,
                tablespace
        ) AS has_canonical_duplicate
    FROM candidate_indexes
)
SELECT format(
    'DROP INDEX CONCURRENTLY IF EXISTS %I.%I;',
    schema_name,
    index_name
)
FROM ranked_indexes
WHERE has_canonical_duplicate = 1
  AND duplicate_rank > 1
ORDER BY schema_name, index_name
\gexec
