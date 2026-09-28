-- Reconcile every schema change required by the current application.
-- This migration assumes the original init_db.sql baseline has been applied.

DO $$
DECLARE
    missing_tables TEXT[];
BEGIN
    SELECT array_agg(required_table ORDER BY required_table)
    INTO missing_tables
    FROM unnest(ARRAY[
        'users',
        'ai_models',
        'credit_transactions',
        'payment_orders',
        'payment_channels',
        'recharge_packages',
        'projects',
        'sessions'
    ]) AS required(required_table)
    WHERE to_regclass('public.' || required_table) IS NULL;

    IF missing_tables IS NOT NULL THEN
        RAISE EXCEPTION
            'Base schema is missing required tables: %. Apply backend/scripts/init_db.sql first.',
            array_to_string(missing_tables, ', ');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
    setting RECORD;
    parsed_value JSONB;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'system_settings'
          AND column_name = 'value'
          AND udt_name <> 'jsonb'
    ) THEN
        ALTER TABLE system_settings ADD COLUMN value_jsonb JSONB;

        FOR setting IN SELECT key, value::text AS raw_value FROM system_settings LOOP
            BEGIN
                parsed_value := setting.raw_value::jsonb;
            EXCEPTION WHEN OTHERS THEN
                parsed_value := to_jsonb(setting.raw_value);
            END;

            UPDATE system_settings
            SET value_jsonb = parsed_value
            WHERE key = setting.key;
        END LOOP;

        ALTER TABLE system_settings DROP COLUMN value;
        ALTER TABLE system_settings RENAME COLUMN value_jsonb TO value;
        ALTER TABLE system_settings ALTER COLUMN value SET DEFAULT '{}'::jsonb;
        ALTER TABLE system_settings ALTER COLUMN value SET NOT NULL;
    END IF;
END
$$;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS credits NUMERIC(10,2) NOT NULL DEFAULT 30.00;
ALTER TABLE users
    ALTER COLUMN credits SET DEFAULT 30.00;

-- Model categories were consolidated after the original schema shipped.
DELETE FROM ai_models
WHERE category IN ('inpainting', 'style', 'enhance');

DO $$
DECLARE
    category_constraint RECORD;
BEGIN
    FOR category_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'ai_models'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%category%'
    LOOP
        EXECUTE format(
            'ALTER TABLE ai_models DROP CONSTRAINT %I',
            category_constraint.conname
        );
    END LOOP;
END
$$;

ALTER TABLE ai_models ADD CONSTRAINT ai_models_category_check
    CHECK (category IN ('segmentation', 'generate', 'llm', 'vision', 'other'));

-- Conversation and generated-history schema.
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check
    CHECK (type IN ('ppt', 'image', 'sci-fig', 'poster'));

CREATE INDEX IF NOT EXISTS idx_conversations_user_type
    ON conversations (user_id, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    history_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversation_messages
    ADD COLUMN IF NOT EXISTS history_key TEXT;

WITH candidates AS (
    SELECT
        id,
        conversation_id,
        role,
        created_at,
        concat_ws(
            '|',
            'conversation-message',
            role,
            meta->>'type',
            COALESCE(NULLIF(meta->>'job_id', ''), NULLIF(meta->>'task_id', '')),
            CASE
                WHEN NULLIF(meta->>'version', '') IS NULL THEN NULL
                ELSE 'version:' || (meta->>'version')
            END,
            CASE
                WHEN NULLIF(meta->>'slide_index', '') IS NULL THEN NULL
                ELSE 'slide_index:' || (meta->>'slide_index')
            END
        ) AS next_history_key
    FROM conversation_messages
    WHERE history_key IS NULL
      AND meta->>'type' IN (
        'image_request', 'image_result', 'poster_request', 'poster_artifact',
        'poster_error', 'sci_fig_request', 'sci_fig_artifact', 'sci_fig_error',
        'ppt_request', 'selected_slides', 'slides_preview', 'pptx_done'
      )
      AND COALESCE(NULLIF(meta->>'job_id', ''), NULLIF(meta->>'task_id', '')) IS NOT NULL
),
ranked_candidates AS (
    SELECT
        id,
        conversation_id,
        role,
        next_history_key,
        ROW_NUMBER() OVER (
            PARTITION BY conversation_id, role, next_history_key
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM candidates
)
UPDATE conversation_messages AS message
SET history_key = candidate.next_history_key
FROM ranked_candidates AS candidate
WHERE message.id = candidate.id
  AND candidate.rn = 1
  AND NOT EXISTS (
      SELECT 1
      FROM conversation_messages AS existing
      WHERE existing.conversation_id = candidate.conversation_id
        AND existing.role = candidate.role
        AND existing.history_key = candidate.next_history_key
  );

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY conversation_id, role, history_key
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM conversation_messages
    WHERE history_key IS NOT NULL
)
UPDATE conversation_messages AS message
SET history_key = NULL
FROM ranked
WHERE message.id = ranked.id
  AND ranked.rn > 1;

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv
    ON conversation_messages (conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_history_key_unique
    ON conversation_messages (conversation_id, role, history_key)
    WHERE history_key IS NOT NULL;

-- Image and uploaded presentation assets.
CREATE TABLE IF NOT EXISTS image_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    task_id TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'image/png',
    width INTEGER,
    height INTEGER,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT,
    original_key TEXT,
    original_url TEXT,
    preview_key TEXT,
    preview_url TEXT,
    thumb_key TEXT,
    thumb_url TEXT,
    asset_scope TEXT NOT NULL DEFAULT 'history',
    retention_class TEXT NOT NULL DEFAULT 'web_history',
    source_client TEXT NOT NULL DEFAULT 'web',
    expires_at TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    storage_provider TEXT NOT NULL DEFAULT 's3',
    object_count INTEGER NOT NULL DEFAULT 3,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE image_assets
    ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS asset_scope TEXT NOT NULL DEFAULT 'history',
    ADD COLUMN IF NOT EXISTS retention_class TEXT NOT NULL DEFAULT 'web_history',
    ADD COLUMN IF NOT EXISTS source_client TEXT NOT NULL DEFAULT 'web',
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expires_notice_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 's3',
    ADD COLUMN IF NOT EXISTS object_count INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_image_assets_user_created
    ON image_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_assets_task
    ON image_assets (task_id);
CREATE INDEX IF NOT EXISTS idx_image_assets_user_expires
    ON image_assets (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_user_size
    ON image_assets (user_id, size_bytes DESC);
CREATE INDEX IF NOT EXISTS idx_image_assets_retention
    ON image_assets (retention_class, expires_at);

CREATE TABLE IF NOT EXISTS ppt_presentation_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    source_mime TEXT NOT NULL DEFAULT '',
    source_size BIGINT NOT NULL DEFAULT 0,
    source_sha256 TEXT NOT NULL DEFAULT '',
    slide_count INTEGER NOT NULL DEFAULT 0,
    slides JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    source_client TEXT NOT NULL DEFAULT 'web',
    storage_provider TEXT NOT NULL DEFAULT 's3',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ppt_presentation_uploads
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expires_notice_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_client TEXT NOT NULL DEFAULT 'web',
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 's3';

CREATE INDEX IF NOT EXISTS idx_ppt_uploads_user_updated
    ON ppt_presentation_uploads (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_uploads_user_expires
    ON ppt_presentation_uploads (user_id, expires_at);

-- Storage quotas, cleanup records, and exported files.
CREATE TABLE IF NOT EXISTS user_storage_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    quota_bytes BIGINT NOT NULL DEFAULT 524288000,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_storage_quotas
    ALTER COLUMN quota_bytes SET DEFAULT 524288000;

CREATE TABLE IF NOT EXISTS storage_cleanup_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode TEXT NOT NULL DEFAULT 'scheduled',
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    object_count INTEGER NOT NULL DEFAULT 0,
    object_deleted INTEGER NOT NULL DEFAULT 0,
    bytes_estimated BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage_admin_notifications (
    kind TEXT PRIMARY KEY,
    last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS file_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'files',
    filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    storage_key TEXT NOT NULL DEFAULT '',
    storage_url TEXT NOT NULL DEFAULT '',
    retention_class TEXT NOT NULL DEFAULT 'web_history',
    source_client TEXT NOT NULL DEFAULT 'web',
    expires_at TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    storage_provider TEXT NOT NULL DEFAULT 's3',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_assets_user_expires
    ON file_assets (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_file_assets_user_size
    ON file_assets (user_id, size_bytes DESC);
CREATE INDEX IF NOT EXISTS idx_file_assets_category
    ON file_assets (category, retention_class, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_storage_key_unique
    ON file_assets (storage_key)
    WHERE storage_key <> '';

UPDATE image_assets
SET retention_class = CASE
        WHEN COALESCE(task_id, '') ILIKE '%temp%' THEN 'temporary'
        WHEN COALESCE(model_id, '') ILIKE '%ppt%'
          OR COALESCE(task_id, '') ILIKE '%ppt%' THEN 'web_history'
        ELSE retention_class
    END,
    source_client = COALESCE(NULLIF(source_client, ''), 'web'),
    storage_provider = COALESCE(NULLIF(storage_provider, ''), 's3'),
    expires_at = COALESCE(
        expires_at,
        CASE
            WHEN COALESCE(is_pinned, FALSE) THEN NULL
            WHEN retention_class = 'temporary' THEN created_at + INTERVAL '3 days'
            ELSE created_at + INTERVAL '60 days'
        END
    )
WHERE source_client = 'web';

UPDATE ppt_presentation_uploads
SET source_client = COALESCE(NULLIF(source_client, ''), 'web'),
    storage_provider = COALESCE(NULLIF(storage_provider, ''), 's3'),
    expires_at = COALESCE(expires_at, created_at + INTERVAL '60 days')
WHERE source_client = 'web';

INSERT INTO user_storage_quotas (user_id, quota_bytes)
SELECT id, 524288000
FROM users
ON CONFLICT (user_id) DO NOTHING;

UPDATE user_storage_quotas
SET quota_bytes = 524288000,
    updated_at = NOW()
WHERE quota_bytes = 209715200;

-- Payment fields and constraints introduced after the original schema.
ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS notify_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS return_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS credit_transaction_id UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS client_ip TEXT NOT NULL DEFAULT '';

ALTER TABLE payment_channels
    ADD COLUMN IF NOT EXISTS merchant_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS merchant_key TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS api_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS notify_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS return_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE payment_orders
SET pay_channel = 'zpay'
WHERE pay_channel IN ('alipay', 'wechat');

UPDATE payment_orders
SET status = 'completed'
WHERE status = 'paid'
  AND credit_transaction_id IS NOT NULL;

ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_pay_channel_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_pay_channel_check
    CHECK (pay_channel IN ('zpay'));
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check
    CHECK (status IN ('pending', 'paid', 'completed', 'failed', 'cancelled', 'expired', 'refunded'));

ALTER TABLE payment_channels DROP CONSTRAINT IF EXISTS payment_channels_channel_code_check;
DELETE FROM payment_channels WHERE channel_code IN ('alipay', 'wechat');
ALTER TABLE payment_channels ADD CONSTRAINT payment_channels_channel_code_check
    CHECK (channel_code IN ('zpay'));

CREATE INDEX IF NOT EXISTS idx_payment_orders_pending_expires
    ON payment_orders (expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_credit_tx
    ON payment_orders (credit_transaction_id)
    WHERE credit_transaction_id IS NOT NULL;

INSERT INTO payment_channels (channel_code, channel_name, api_url, config_json)
VALUES ('zpay', 'Z-Pay 在线支付', 'https://zpayz.cn', '{"type":"alipay"}'::jsonb)
ON CONFLICT (channel_code) DO NOTHING;

WITH ranked_packages AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY amount_yuan
            ORDER BY enabled DESC, created_at DESC, id DESC
        ) AS rn
    FROM recharge_packages
)
DELETE FROM recharge_packages AS package
USING ranked_packages AS ranked
WHERE package.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_packages_amount_unique
    ON recharge_packages (amount_yuan);

INSERT INTO recharge_packages (
    amount_yuan, base_credits, bonus_credits, discount_label, sort_order, enabled
)
VALUES
    (1, 10, 0, NULL, 1, TRUE),
    (10, 100, 0, NULL, 2, TRUE),
    (30, 300, 15, '95折', 3, TRUE),
    (50, 500, 30, '94折', 4, TRUE),
    (100, 1000, 80, '93折', 5, TRUE),
    (200, 2000, 180, '92折', 6, TRUE)
ON CONFLICT (amount_yuan) DO UPDATE SET
    base_credits = EXCLUDED.base_credits,
    bonus_credits = EXCLUDED.bonus_credits,
    discount_label = EXCLUDED.discount_label,
    sort_order = EXCLUDED.sort_order,
    enabled = TRUE;

UPDATE recharge_packages SET enabled = FALSE WHERE amount_yuan = 500;

ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
    CHECK (type IN ('recharge', 'consume', 'refund', 'gift', 'admin_adjust', 'payment'));

INSERT INTO system_settings (key, value, updated_at)
VALUES ('payment_settings', '{
    "credits_ratio": 10,
    "min_amount_yuan": 1,
    "max_amount_yuan": 200,
    "order_timeout_minutes": 20,
    "max_pending_orders": 2,
    "daily_amount_limit_yuan": 1000,
    "cancel_cooldown_seconds": 30,
    "cancel_window_minutes": 60,
    "max_cancellations_per_window": 6
}'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

-- Normalize names before adding uniqueness constraints.
WITH duplicate_projects AS (
    SELECT
        id,
        name,
        ROW_NUMBER() OVER (
            PARTITION BY user_id, type, lower(btrim(name))
            ORDER BY created_at, id
        ) AS duplicate_index
    FROM projects
)
UPDATE projects AS project
SET name = duplicate_projects.name
        || ' (' || duplicate_projects.duplicate_index
        || '-' || left(project.id::text, 4) || ')',
    updated_at = NOW()
FROM duplicate_projects
WHERE project.id = duplicate_projects.id
  AND duplicate_projects.duplicate_index > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_type_name_unique
    ON projects (user_id, type, lower(btrim(name)));

DO $$
DECLARE
    rec RECORD;
    current_user_id UUID := NULL;
    base_name TEXT;
    candidate TEXT;
    suffix INTEGER;
    used_names TEXT[] := ARRAY[]::TEXT[];
BEGIN
    FOR rec IN
        SELECT id, user_id, name
        FROM sessions
        WHERE status != 'deleted'
          AND project_id IS NOT NULL
        ORDER BY user_id, lower(btrim(name)), created_at ASC, id ASC
    LOOP
        IF current_user_id IS DISTINCT FROM rec.user_id THEN
            current_user_id := rec.user_id;
            used_names := ARRAY[]::TEXT[];
        END IF;

        base_name := COALESCE(NULLIF(btrim(rec.name), ''), 'Untitled workflow');
        candidate := base_name;
        suffix := 2;

        WHILE lower(candidate) = ANY(used_names) LOOP
            candidate := base_name || ' (' || suffix || ')';
            suffix := suffix + 1;
        END LOOP;

        used_names := array_append(used_names, lower(candidate));
        IF rec.name IS DISTINCT FROM candidate THEN
            UPDATE sessions
            SET name = candidate,
                updated_at = NOW()
            WHERE id = rec.id;
        END IF;
    END LOOP;
END
$$;

DROP INDEX IF EXISTS idx_sessions_user_project_active_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_active_name_unique
    ON sessions (user_id, lower(btrim(name)))
    WHERE status != 'deleted' AND project_id IS NOT NULL;

-- Feature, pet, and disaster-recovery tables.
CREATE TABLE IF NOT EXISTS segmentation_cache (
    content_hash CHAR(64) PRIMARY KEY,
    user_id UUID,
    masks_jsonb JSONB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    storage_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    last_accessed_at TIMESTAMP DEFAULT NOW(),
    access_count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_segmentation_cache_last_accessed
    ON segmentation_cache (last_accessed_at DESC);

CREATE TABLE IF NOT EXISTS agent_plans (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    instruction TEXT NOT NULL,
    sub_tasks JSONB NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_canvas_slides (
    job_id UUID NOT NULL,
    index INTEGER NOT NULL,
    elements_json JSONB NOT NULL,
    background JSONB,
    PRIMARY KEY (job_id, index)
);

INSERT INTO system_settings (key, value)
VALUES
    ('feature.touch_edit.enabled', 'false'::jsonb),
    ('feature.touch_edit.allowlist', '[]'::jsonb),
    ('feature.agent_orchestrator.enabled', 'false'::jsonb),
    ('feature.agent_orchestrator.allowlist', '[]'::jsonb),
    ('feature.ppt_canvas.enabled', 'false'::jsonb),
    ('feature.ppt_canvas.allowlist', '[]'::jsonb),
    ('registration_welcome_credits', '{"amount": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS pet_chat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    pet_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pet_chat_user_time
    ON pet_chat_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
);
CREATE INDEX IF NOT EXISTS idx_backup_records_created_at
    ON backup_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_records_status
    ON backup_records (status);
