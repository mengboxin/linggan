-- ============================================================
-- PixelScribe PostgreSQL Schema
-- 执行：psql -U postgres -d layergenius -f scripts/init_db.sql
-- 可重复执行（全部使用 IF NOT EXISTS / IF EXISTS）
-- 仅创作广场兼容同步使用触发器；updated_at 由后端负责更新
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'gen_random_uuid'
          AND n.nspname IN ('pg_catalog', 'public')
    ) THEN
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    END IF;
END
$$;
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- 文本模糊搜索

-- ══════════════════════════════════════════════════════════════
-- 1. 用户
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    email             TEXT          NOT NULL UNIQUE,
    password_hash     TEXT          NOT NULL,
    display_name      TEXT,
    avatar_url        TEXT,
    role              TEXT          NOT NULL DEFAULT 'user'
                                    CHECK (role IN ('user', 'vip', 'admin')),
    status            TEXT          NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'banned', 'pending')),
    quota_tasks_day   INTEGER       NOT NULL DEFAULT 20,
    quota_tasks_month INTEGER       NOT NULL DEFAULT 200,
    total_tasks       INTEGER       NOT NULL DEFAULT 0,
    total_layers      INTEGER       NOT NULL DEFAULT 0,
    credits           NUMERIC(10,2) NOT NULL DEFAULT 30.00,
    auth_provider     TEXT          NOT NULL DEFAULT 'password'
                                    CHECK (auth_provider IN ('password', 'foxapi_key')),
    billing_mode      TEXT          NOT NULL DEFAULT 'platform_credits'
                                    CHECK (billing_mode IN ('platform_credits', 'external_api_key', 'grok_api_key')),
    pet_id            TEXT,
    pet_custom_name   TEXT          NOT NULL DEFAULT '',
    last_active_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

CREATE TABLE IF NOT EXISTS user_api_credentials (
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            TEXT        NOT NULL DEFAULT 'foxapi',
    api_base            TEXT        NOT NULL,
    encrypted_api_key   TEXT        NOT NULL,
    key_fingerprint     CHAR(64)    NOT NULL UNIQUE,
    model_catalog       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status              TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'invalid', 'disabled')),
    last_verified_at    TIMESTAMPTZ,
    last_used_at        TIMESTAMPTZ,
    request_count       BIGINT      NOT NULL DEFAULT 0,
    failed_count        BIGINT      NOT NULL DEFAULT 0,
    last_model_id       TEXT,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_api_credentials_status ON user_api_credentials (status);
CREATE INDEX IF NOT EXISTS idx_user_api_credentials_last_used ON user_api_credentials (last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_api_credentials_user_provider ON user_api_credentials (user_id, provider);

CREATE TABLE IF NOT EXISTS legal_document_versions (
    document_type TEXT NOT NULL CHECK (document_type IN ('terms', 'privacy', 'ai', 'payment')),
    version TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_markdown TEXT NOT NULL,
    content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    published_on DATE NOT NULL,
    effective_on DATE NOT NULL,
    requires_reacceptance BOOLEAN NOT NULL DEFAULT TRUE,
    required_at_login BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (document_type, version),
    UNIQUE (document_type, version, content_hash)
);

CREATE OR REPLACE FUNCTION prevent_legal_document_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'legal document versions are immutable; publish a new version';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_document_versions_immutable ON legal_document_versions;
CREATE TRIGGER trg_legal_document_versions_immutable
    BEFORE UPDATE OR DELETE ON legal_document_versions
    FOR EACH ROW EXECUTE FUNCTION prevent_legal_document_version_mutation();

CREATE TABLE IF NOT EXISTS user_legal_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    document_type TEXT NOT NULL,
    document_version TEXT NOT NULL,
    document_hash CHAR(64) NOT NULL,
    source TEXT NOT NULL,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    user_agent_hash CHAR(64) NOT NULL DEFAULT '',
    context_type TEXT NOT NULL DEFAULT '',
    context_id TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_legal_acceptances_document_fk
        FOREIGN KEY (document_type, document_version, document_hash)
        REFERENCES legal_document_versions (document_type, version, content_hash),
    CHECK ((context_type = '' AND context_id = '') OR (context_type <> '' AND context_id <> ''))
);

CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_user_time
    ON user_legal_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_document
    ON user_legal_acceptances (document_type, document_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_legal_acceptances_context
    ON user_legal_acceptances (
        user_id, document_type, document_version, context_type, context_id
    )
    WHERE context_type <> '' AND context_id <> '';

-- ══════════════════════════════════════════════════════════════
-- 2. 用户会话（JWT refresh token）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_sessions (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT        NOT NULL UNIQUE,
    user_agent    TEXT,
    ip_address    INET,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token   ON user_sessions (refresh_token);

-- ══════════════════════════════════════════════════════════════
-- 3. 任务
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID          REFERENCES users(id) ON DELETE SET NULL,
    type         TEXT          NOT NULL
                               CHECK (type IN ('segmentation', 'inpainting', 'layer-edit', 'compose', 'enhance', 'generate-video')),
    status       TEXT          NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    progress     SMALLINT      NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    model_id     TEXT,
    error        TEXT,
    duration_ms  INTEGER,
    cost_credits NUMERIC(10,4) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id    ON tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_type       ON tasks (type);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 4. AI 模型
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_models (
    id              TEXT          PRIMARY KEY,
    name            TEXT          NOT NULL,
    category        TEXT          NOT NULL
                                  CHECK (category IN (
                                      'segmentation', 'generate', 'llm', 'vision', 'video', 'other'
                                  )),
    tags            TEXT[]        NOT NULL DEFAULT '{}',
    description     TEXT          NOT NULL DEFAULT '',
    cover_url       TEXT          NOT NULL DEFAULT '',
    endpoint        TEXT          NOT NULL DEFAULT '',
    api_key         TEXT          NOT NULL DEFAULT '',
    provider        TEXT          NOT NULL DEFAULT '',
    provider_logo   TEXT          NOT NULL DEFAULT '',
    price_type      TEXT          NOT NULL DEFAULT 'free'
                                  CHECK (price_type IN ('free', 'credits', 'subscription')),
    price_credits   NUMERIC(10,4) NOT NULL DEFAULT 0,
    enabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    is_featured     BOOLEAN       NOT NULL DEFAULT FALSE,
    sort_order      INTEGER       NOT NULL DEFAULT 0,
    total_calls     INTEGER       NOT NULL DEFAULT 0,
    avg_duration_ms INTEGER       NOT NULL DEFAULT 0,
    meta            JSONB         NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_models_category ON ai_models (category);
CREATE INDEX IF NOT EXISTS idx_ai_models_enabled  ON ai_models (enabled);

INSERT INTO ai_models (
    id, name, category, tags, description, endpoint, provider,
    price_type, price_credits, enabled, is_featured, sort_order, meta
) VALUES
    (
        'grok-4.3',
        'Grok 4.3',
        'llm',
        ARRAY['Grok', '文本'],
        'xAI Grok 文本模型，用于对话、规划和质检',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        FALSE,
        40,
        '{"model_name":"grok-4.3","api_mode":"grok_chat","chat_completions_fallback":true}'::jsonb
    ),
    (
        'grok-imagine-image-2.0',
        'Grok Imagine Image',
        'generate',
        ARRAY['Grok', '生图'],
        'xAI Grok 生图模型，按 aspect_ratio 与 1K/2K 分辨率出图',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        TRUE,
        20,
        '{"model_name":"grok-imagine-image","api_mode":"grok_images"}'::jsonb
    ),
    (
        'grok-imagine-video-1.5',
        'Grok Imagine Video',
        'video',
        ARRAY['Grok', '生视频'],
        'xAI Grok 生视频模型，支持文生视频和参考图生视频',
        'https://foxapi.cn/v1',
        'Grok',
        'credits',
        0,
        TRUE,
        TRUE,
        30,
        '{"model_name":"grok-imagine-video-1.5","api_mode":"grok_video"}'::jsonb
    )
ON CONFLICT (id) DO NOTHING;

-- Model-call monitoring. Payloads, endpoints, and credentials are never stored.
CREATE TABLE IF NOT EXISTS model_call_logs (
    id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    billing_mode   TEXT NOT NULL DEFAULT 'platform_credits',
    model_id       TEXT NOT NULL,
    model_name     TEXT NOT NULL DEFAULT '',
    model_category TEXT NOT NULL DEFAULT 'other',
    provider       TEXT NOT NULL DEFAULT '',
    success        BOOLEAN NOT NULL,
    duration_ms    INTEGER,
    error_message  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_call_logs_created_at
    ON model_call_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_call_logs_user_created_at
    ON model_call_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_call_logs_billing_created_at
    ON model_call_logs (billing_mode, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 5. 积分交易记录
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_transactions (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          NUMERIC(10,2) NOT NULL,
    balance_after   NUMERIC(10,2) NOT NULL,
    type            TEXT          NOT NULL
                                  CHECK (type IN ('recharge', 'consume', 'refund', 'gift', 'admin_adjust', 'payment', 'subscription')),
    related_task_id UUID          REFERENCES tasks(id) ON DELETE SET NULL,
    description     TEXT,
    idempotency_key TEXT,
    balance_source  TEXT          NOT NULL DEFAULT 'metered'
                                  CHECK (balance_source IN ('metered', 'subscription')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user_id    ON credit_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_created_at ON credit_transactions (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_user_idempotency
    ON credit_transactions (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 5.1 生图广场公开作品
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public_generations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    source_task_id TEXT NOT NULL DEFAULT '',
    variant_index INTEGER NOT NULL DEFAULT 0,
    asset_id TEXT NOT NULL DEFAULT '',
    asset_fingerprint TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    preview_url TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    final_prompt TEXT NOT NULL DEFAULT '',
    prompt_hash TEXT NOT NULL DEFAULT '',
    module TEXT NOT NULL DEFAULT 'TEXT_TO_IMAGE'
           CHECK (module IN ('TEXT_TO_IMAGE', 'POSTER_GEN', 'IMAGE_EDIT', 'SCI_FIG', 'PPT_GEN')),
    source TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    meta JSONB NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'public'
           CHECK (visibility IN ('public', 'hidden')),
    moderation_status TEXT NOT NULL DEFAULT 'pending'
           CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    reward_granted BOOLEAN NOT NULL DEFAULT FALSE,
    reward_credits NUMERIC(10,2) NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    favorites INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (task_id, variant_index)
);

CREATE INDEX IF NOT EXISTS idx_public_generations_feed
    ON public_generations (visibility, moderation_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_generations_user
    ON public_generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_generations_task
    ON public_generations (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_source_task_variant
    ON public_generations (source_task_id, variant_index)
    WHERE source_task_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_asset_fingerprint
    ON public_generations (user_id, asset_fingerprint)
    WHERE asset_fingerprint <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_generations_prompt_asset
    ON public_generations (user_id, prompt_hash, asset_fingerprint)
    WHERE prompt_hash <> '' AND asset_fingerprint <> '';

CREATE TABLE IF NOT EXISTS public_generation_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_id UUID NOT NULL REFERENCES public_generations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL CHECK (reaction IN ('like', 'favorite')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (generation_id, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_public_generation_reactions_generation
    ON public_generation_reactions (generation_id);
CREATE INDEX IF NOT EXISTS idx_public_generation_reactions_user
    ON public_generation_reactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public_gallery_item_reactions (
    item_key TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT public_gallery_item_reactions_item_key_check
        CHECK (
            char_length(item_key) BETWEEN 1 AND 160
            AND item_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        ),
    CONSTRAINT public_gallery_item_reactions_reaction_check
        CHECK (reaction IN ('like', 'favorite')),
    CONSTRAINT public_gallery_item_reactions_pkey
        PRIMARY KEY (item_key, user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_public_gallery_item_reactions_item
    ON public_gallery_item_reactions (item_key, reaction);
CREATE INDEX IF NOT EXISTS idx_public_gallery_item_reactions_user
    ON public_gallery_item_reactions (user_id, reaction, created_at DESC, item_key);

CREATE OR REPLACE FUNCTION sync_legacy_public_gallery_reaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public_gallery_item_reactions (
            item_key, user_id, reaction, created_at
        )
        VALUES (
            NEW.generation_id::text, NEW.user_id, NEW.reaction, NEW.created_at
        )
        ON CONFLICT (item_key, user_id, reaction) DO NOTHING;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public_gallery_item_reactions
        WHERE item_key = OLD.generation_id::text
          AND user_id = OLD.user_id
          AND reaction = OLD.reaction;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_legacy_public_gallery_reaction
    ON public_generation_reactions;
CREATE TRIGGER trg_sync_legacy_public_gallery_reaction
AFTER INSERT OR DELETE ON public_generation_reactions
FOR EACH ROW
EXECUTE FUNCTION sync_legacy_public_gallery_reaction();

CREATE OR REPLACE FUNCTION delete_public_generation_gallery_reactions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public_gallery_item_reactions
    WHERE item_key = OLD.id::text;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_public_generation_gallery_reactions
    ON public_generations;
CREATE TRIGGER trg_delete_public_generation_gallery_reactions
AFTER DELETE ON public_generations
FOR EACH ROW
EXECUTE FUNCTION delete_public_generation_gallery_reactions();

-- ══════════════════════════════════════════════════════════════
-- 6. Prompt 资产
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'system',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    action_url TEXT NOT NULL DEFAULT '',
    meta JSONB NOT NULL DEFAULT '{}',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
    ON user_notifications (user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
    ON user_notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_history (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT        NOT NULL,
    model_id   VARCHAR(64),
    mode       VARCHAR(32) CHECK (mode IN ('IMAGE_EDIT', 'LAYER_EDIT', NULL)),
    tags       TEXT[]      NOT NULL DEFAULT '{}',
    note       TEXT,
    use_count  INTEGER     NOT NULL DEFAULT 1,
    is_starred BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_history_user
    ON prompt_history (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_history_starred
    ON prompt_history (user_id, is_starred, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_history_content_trgm
    ON prompt_history USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prompt_history_use_count
    ON prompt_history (user_id, use_count DESC);

-- ══════════════════════════════════════════════════════════════
-- 7. 项目管理（支持 PPT 和图像两种类型）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS projects (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    type         TEXT        NOT NULL DEFAULT 'image'
                             CHECK (type IN ('image', 'ppt')),
    description  TEXT,
    thumbnail    TEXT,
    is_archived  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects (user_id, type, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_type_name_unique
    ON projects (user_id, type, lower(btrim(name)));

-- ══════════════════════════════════════════════════════════════
-- 8. 项目任务（关联到项目）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project_tasks (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id      UUID        REFERENCES tasks(id) ON DELETE SET NULL,
    name         TEXT        NOT NULL,
    snapshot     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks (project_id, updated_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 9. PPT 生成记录
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ppt_generations (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id        UUID          REFERENCES projects(id) ON DELETE SET NULL,
    topic             TEXT          NOT NULL,
    style_requirement TEXT,
    page_count        INTEGER       NOT NULL DEFAULT 10,
    optimize_prompt   BOOLEAN       NOT NULL DEFAULT TRUE,
    optimized_topic   TEXT,
    status            TEXT          NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'optimizing', 'generating', 'completed', 'failed')),
    progress          SMALLINT      NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    error             TEXT,
    outline           JSONB,
    images            JSONB,
    pptx_url          TEXT,
    cost_credits      NUMERIC(10,4) NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ppt_gen_user_id ON ppt_generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_gen_project_id ON ppt_generations (project_id);
CREATE INDEX IF NOT EXISTS idx_ppt_gen_status ON ppt_generations (status);

-- ══════════════════════════════════════════════════════════════
-- 10. 对话历史记录（PPT 和图像编辑）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversations (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         TEXT        NOT NULL CHECK (type IN ('ppt', 'image', 'sci-fig', 'poster', 'paper', 'image-prompt')),
    title        TEXT        NOT NULL,
    creation_key TEXT,
    storage_workspace TEXT   NOT NULL DEFAULT 'cloud' CHECK (storage_workspace IN ('local', 'cloud')),
    is_archived  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_type ON conversations (user_id, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_user_workspace_creation_key_unique
    ON conversations (user_id, storage_workspace, creation_key)
    WHERE creation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_user_workspace_type_updated
    ON conversations (user_id, storage_workspace, type, updated_at DESC)
    WHERE is_archived = FALSE;

-- ══════════════════════════════════════════════════════════════
-- 11. 对话消息（用户输入 + AI 响应）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT        NOT NULL,
    meta            JSONB       NOT NULL DEFAULT '{}',
    history_key     TEXT,
    history_summary JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv_role_created
    ON conversation_messages (conversation_id, role, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_history_key_unique
    ON conversation_messages (conversation_id, role, history_key)
    WHERE history_key IS NOT NULL;

-- 图片资产索引：原图/预览/缩略图存对象存储，数据库只保存元数据
CREATE TABLE IF NOT EXISTS image_assets (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID        REFERENCES conversations(id) ON DELETE SET NULL,
    message_id      UUID        REFERENCES conversation_messages(id) ON DELETE SET NULL,
    task_id         TEXT,
    prompt          TEXT        NOT NULL DEFAULT '',
    model_id        TEXT        NOT NULL DEFAULT '',
    mime_type       TEXT        NOT NULL DEFAULT 'image/png',
    width           INTEGER,
    height          INTEGER,
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    sha256          TEXT,
    original_key    TEXT,
    original_url    TEXT,
    preview_key     TEXT,
    preview_url     TEXT,
    thumb_key       TEXT,
    thumb_url       TEXT,
    asset_scope     TEXT        NOT NULL DEFAULT 'history',
    retention_class TEXT        NOT NULL DEFAULT 'web_history',
    source_client   TEXT        NOT NULL DEFAULT 'web',
    expires_at      TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    storage_provider TEXT       NOT NULL DEFAULT 's3',
    object_count    INTEGER     NOT NULL DEFAULT 3,
    is_pinned       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_assets_user_created ON image_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_assets_task ON image_assets (task_id);
CREATE INDEX IF NOT EXISTS idx_image_assets_user_expires ON image_assets (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_user_size ON image_assets (user_id, size_bytes DESC);
CREATE INDEX IF NOT EXISTS idx_image_assets_retention ON image_assets (retention_class, expires_at);
CREATE INDEX IF NOT EXISTS idx_image_assets_conversation ON image_assets (conversation_id);
CREATE INDEX IF NOT EXISTS idx_image_assets_message ON image_assets (message_id);

-- User-uploaded PPT presentation records
CREATE TABLE IF NOT EXISTS ppt_presentation_uploads (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT        NOT NULL,
    filename        TEXT        NOT NULL DEFAULT '',
    source_key      TEXT        NOT NULL DEFAULT '',
    source_url      TEXT        NOT NULL DEFAULT '',
    source_mime     TEXT        NOT NULL DEFAULT '',
    source_size     BIGINT      NOT NULL DEFAULT 0,
    source_sha256   TEXT        NOT NULL DEFAULT '',
    slide_count     INTEGER     NOT NULL DEFAULT 0,
    slides          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    expires_at      TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    source_client   TEXT        NOT NULL DEFAULT 'web',
    storage_provider TEXT       NOT NULL DEFAULT 's3',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ppt_uploads_user_updated
    ON ppt_presentation_uploads (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_uploads_user_expires
    ON ppt_presentation_uploads (user_id, expires_at);

-- Storage quotas, cleanup records, and exported files
CREATE TABLE IF NOT EXISTS user_storage_quotas (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    quota_bytes     BIGINT      NOT NULL DEFAULT 524288000,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage_cleanup_runs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    mode            TEXT        NOT NULL DEFAULT 'scheduled',
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
    candidate_count INTEGER     NOT NULL DEFAULT 0,
    object_count    INTEGER     NOT NULL DEFAULT 0,
    object_deleted  INTEGER     NOT NULL DEFAULT 0,
    bytes_estimated BIGINT      NOT NULL DEFAULT 0,
    status          TEXT        NOT NULL DEFAULT 'completed',
    details         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asset_object_deletion_queue (
    object_key      TEXT        PRIMARY KEY,
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
    reason          TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'pending',
    attempts        INTEGER     NOT NULL DEFAULT 0,
    last_error      TEXT        NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_deletion_queue_pending
    ON asset_object_deletion_queue (next_attempt_at, updated_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_asset_deletion_queue_user
    ON asset_object_deletion_queue (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_object_mirror_queue (
    target_provider TEXT NOT NULL,
    target_endpoint TEXT NOT NULL,
    target_bucket TEXT NOT NULL,
    target_region TEXT NOT NULL,
    object_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('copy', 'delete')),
    revision BIGINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (target_provider, target_bucket, object_key)
);

CREATE INDEX IF NOT EXISTS idx_asset_mirror_queue_pending
    ON asset_object_mirror_queue (next_attempt_at, updated_at)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS asset_record_cleanup_intents (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          TEXT        NOT NULL DEFAULT '',
    records         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'processing')),
    attempts        INTEGER     NOT NULL DEFAULT 0,
    last_error      TEXT        NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_record_cleanup_intents_due
    ON asset_record_cleanup_intents (next_attempt_at, updated_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_asset_record_cleanup_intents_user
    ON asset_record_cleanup_intents (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_admin_notifications (
    kind            TEXT        PRIMARY KEY,
    last_sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload         JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS file_assets (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id         TEXT        NOT NULL DEFAULT '',
    category        TEXT        NOT NULL DEFAULT 'files',
    filename        TEXT        NOT NULL DEFAULT '',
    mime_type       TEXT        NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    sha256          TEXT        NOT NULL DEFAULT '',
    storage_key     TEXT        NOT NULL DEFAULT '',
    storage_url     TEXT        NOT NULL DEFAULT '',
    retention_class TEXT        NOT NULL DEFAULT 'web_history',
    source_client   TEXT        NOT NULL DEFAULT 'web',
    expires_at      TIMESTAMPTZ,
    expires_notice_sent_at TIMESTAMPTZ,
    storage_provider TEXT       NOT NULL DEFAULT 's3',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_assets_user_expires ON file_assets (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_file_assets_user_size ON file_assets (user_id, size_bytes DESC);
CREATE INDEX IF NOT EXISTS idx_file_assets_category ON file_assets (category, retention_class, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_storage_key_unique
    ON file_assets (storage_key)
    WHERE storage_key <> '';

INSERT INTO user_storage_quotas (user_id, quota_bytes)
SELECT id, 524288000
FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- 12. 系统配置
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_config (
    key         TEXT        PRIMARY KEY,
    value       TEXT        NOT NULL,
    value_type  TEXT        NOT NULL DEFAULT 'string'
                            CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    is_secret   BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- 13. 支付订单
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_orders (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_no        TEXT          NOT NULL UNIQUE,
    trade_no        TEXT,
    amount_yuan     NUMERIC(10,2) NOT NULL,
    credits         INTEGER       NOT NULL,
    bonus_credits   INTEGER       NOT NULL DEFAULT 0,
    product_kind    TEXT          NOT NULL DEFAULT 'credits'
                                  CHECK (product_kind IN ('credits', 'subscription')),
    product_id      TEXT,
    product_name    TEXT          NOT NULL DEFAULT '',
    product_snapshot JSONB        NOT NULL DEFAULT '{}',
    pay_channel     TEXT          NOT NULL
                                  CHECK (pay_channel IN ('zpay')),
    status          TEXT          NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'paid', 'completed', 'failed', 'cancelled', 'expired', 'refunded')),
    notify_url      TEXT          NOT NULL DEFAULT '',
    return_url      TEXT          NOT NULL DEFAULT '',
    expires_at      TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    credited_at     TIMESTAMPTZ,
    credit_transaction_id UUID    REFERENCES credit_transactions(id) ON DELETE SET NULL,
    provider_payload JSONB        NOT NULL DEFAULT '{}',
    client_ip       TEXT          NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders (status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_order_no ON payment_orders (order_no);
CREATE INDEX IF NOT EXISTS idx_payment_orders_pending_expires ON payment_orders (expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_credit_tx ON payment_orders (credit_transaction_id) WHERE credit_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_trade_no_unique
    ON payment_orders (pay_channel, trade_no)
    WHERE trade_no IS NOT NULL AND trade_no <> '';

-- ══════════════════════════════════════════════════════════════
-- 14. 支付渠道配置
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_channels (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_code    TEXT          NOT NULL UNIQUE
                                  CHECK (channel_code IN ('zpay')),
    channel_name    TEXT          NOT NULL,
    merchant_id     TEXT          NOT NULL DEFAULT '',
    merchant_key    TEXT          NOT NULL DEFAULT '',
    api_url         TEXT          NOT NULL DEFAULT '',
    notify_url      TEXT          NOT NULL DEFAULT '',
    return_url      TEXT          NOT NULL DEFAULT '',
    enabled         BOOLEAN       NOT NULL DEFAULT FALSE,
    config_json     JSONB         NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 插入默认支付渠道
INSERT INTO payment_channels (channel_code, channel_name, api_url, config_json) VALUES
    ('zpay', 'Z-Pay 在线支付', 'https://zpayz.cn', '{"type":"alipay"}'::jsonb)
ON CONFLICT (channel_code) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- 15. 充值套餐
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS recharge_packages (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    amount_yuan     INTEGER       NOT NULL,
    base_credits    INTEGER       NOT NULL,
    bonus_credits   INTEGER       NOT NULL DEFAULT 0,
    discount_label  TEXT,
    sort_order      INTEGER       NOT NULL DEFAULT 0,
    enabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_packages_amount_unique
    ON recharge_packages (amount_yuan);

-- 插入默认充值套餐（含折扣）
INSERT INTO recharge_packages (
    amount_yuan, base_credits, bonus_credits, discount_label, sort_order, enabled
) VALUES
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

-- ══════════════════════════════════════════════════════════════
-- 15.1 预付费会员套餐与会员周期
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscription_plans (
    id              TEXT          PRIMARY KEY,
    name            TEXT          NOT NULL,
    description     TEXT          NOT NULL DEFAULT '',
    badge_label     TEXT          NOT NULL DEFAULT '',
    price_yuan      NUMERIC(10,2) NOT NULL CHECK (price_yuan > 0),
    credits         INTEGER       NOT NULL CHECK (credits > 0),
    duration_days   INTEGER       NOT NULL CHECK (duration_days > 0),
    benefits        JSONB         NOT NULL DEFAULT '[]',
    enabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    sort_order      INTEGER       NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT subscription_plans_id_check
        CHECK (id ~ '^[a-z][a-z0-9_]{1,63}$')
);

INSERT INTO subscription_plans (
    id, name, description, badge_label, price_yuan, credits,
    duration_days, benefits, sort_order, enabled
) VALUES
    (
        'weekly', '灵感周卡', '7 天会员身份与 120 永久积分', 'WEEKLY',
        9.90, 120, 7,
        '["120 积分永久有效", "7 天 VIP 身份展示", "续费有效期自动顺延"]'::jsonb,
        10, TRUE
    ),
    (
        'monthly', '创作月卡', '30 天会员身份与 380 永久积分', 'MONTHLY',
        29.90, 380, 30,
        '["380 积分永久有效", "30 天 VIP 身份展示", "续费有效期自动顺延"]'::jsonb,
        20, TRUE
    ),
    (
        'pro_monthly', '专业创作月卡', '30 天专业会员身份与 800 永久积分', 'PRO',
        59.90, 800, 30,
        '["800 积分永久有效", "30 天专业 VIP 身份展示", "续费有效期自动顺延"]'::jsonb,
        30, TRUE
    )
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    badge_label = EXCLUDED.badge_label,
    price_yuan = EXCLUDED.price_yuan,
    credits = EXCLUDED.credits,
    duration_days = EXCLUDED.duration_days,
    benefits = EXCLUDED.benefits,
    sort_order = EXCLUDED.sort_order,
    enabled = EXCLUDED.enabled,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS user_subscriptions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id             TEXT        NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
    payment_order_id    UUID        REFERENCES payment_orders(id) ON DELETE RESTRICT,
    status              TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'queued', 'exhausted', 'expired', 'revoked')),
    starts_at           TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    activated_at        TIMESTAMPTZ,
    exhausted_at        TIMESTAMPTZ,
    credits_granted     INTEGER     NOT NULL CHECK (credits_granted >= 0),
    quota_total         NUMERIC(14,2) NOT NULL CHECK (quota_total >= 0),
    quota_remaining     NUMERIC(14,2) NOT NULL CHECK (quota_remaining >= 0 AND quota_remaining <= quota_total),
    plan_snapshot       JSONB       NOT NULL DEFAULT '{}',
    source              TEXT        NOT NULL DEFAULT 'payment'
                                    CHECK (source IN ('payment', 'admin')),
    assigned_by         TEXT,
    note                TEXT        NOT NULL DEFAULT '',
    revoked_at          TIMESTAMPTZ,
    revoked_by          TEXT,
    revoke_reason       TEXT        NOT NULL DEFAULT '',
    quota_reset_count   INTEGER     NOT NULL DEFAULT 0 CHECK (quota_reset_count >= 0),
    last_quota_reset_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_subscriptions_period_check CHECK (
        (status = 'queued' AND starts_at IS NULL AND expires_at IS NULL)
        OR (status <> 'queued' AND starts_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > starts_at)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_payment_order_unique
    ON user_subscriptions (payment_order_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_expires
    ON user_subscriptions (user_id, expires_at DESC)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_admin_status
    ON user_subscriptions (status, expires_at DESC, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_one_active_plan
    ON user_subscriptions (user_id, plan_id)
    WHERE status = 'active';

ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS user_billing_preferences (
    user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    funding_source           TEXT NOT NULL DEFAULT 'metered'
                                  CHECK (funding_source IN ('metered', 'subscription')),
    selected_subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_admin_audit (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id     UUID        REFERENCES user_subscriptions(id) ON DELETE SET NULL,
    user_id             UUID        REFERENCES users(id) ON DELETE SET NULL,
    plan_id             TEXT        REFERENCES subscription_plans(id) ON DELETE SET NULL,
    action              TEXT        NOT NULL
                                    CHECK (action IN ('assigned', 'revoked', 'quota_reset', 'plan_saved')),
    actor               TEXT        NOT NULL DEFAULT 'admin',
    reason              TEXT        NOT NULL DEFAULT '',
    operation_key       TEXT,
    metadata            JSONB       NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_admin_audit_operation_unique
    ON subscription_admin_audit (operation_key)
    WHERE operation_key IS NOT NULL AND operation_key <> '';
CREATE INDEX IF NOT EXISTS idx_subscription_admin_audit_created
    ON subscription_admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_admin_audit_user
    ON subscription_admin_audit (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- 支付和会员积分分别保留可审计的账本类型。
ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
    CHECK (type IN ('recharge', 'consume', 'refund', 'gift', 'admin_adjust', 'payment', 'subscription'));


-- ══════════════════════════════════════════════════════════════
-- 16. 分割结果跨设备共享缓存 (R12)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS segmentation_cache (
    content_hash     CHAR(64)    PRIMARY KEY,
    user_id          UUID,
    masks_jsonb      JSONB       NOT NULL,
    width            INT         NOT NULL,
    height           INT         NOT NULL,
    storage_url      TEXT,
    created_at       TIMESTAMP   DEFAULT NOW(),
    last_accessed_at TIMESTAMP   DEFAULT NOW(),
    access_count     INT         DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_segmentation_cache_last_accessed
    ON segmentation_cache (last_accessed_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 17. Agent 任务计划 (R7)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_plans (
    id            UUID         PRIMARY KEY,
    user_id       UUID         NOT NULL,
    instruction   TEXT         NOT NULL,
    sub_tasks     JSONB        NOT NULL,
    status        VARCHAR(20)  NOT NULL,
    created_at    TIMESTAMP    DEFAULT NOW(),
    updated_at    TIMESTAMP    DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- 18. PPT slide 元素持久化 (R5)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ppt_canvas_slides (
    job_id         UUID         NOT NULL,
    index          INT          NOT NULL,
    elements_json  JSONB        NOT NULL,
    background     JSONB,
    PRIMARY KEY (job_id, index)
);

-- ══════════════════════════════════════════════════════════════
-- 19. Sessions（编辑会话，workspace 路由使用）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id      UUID        REFERENCES projects(id) ON DELETE SET NULL,
    name            TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'deleted')),
    source_width    INTEGER,
    source_height   INTEGER,
    preview_key     TEXT,
    snapshot_key    TEXT,
    workflow_kind   TEXT        NOT NULL DEFAULT 'image_edit'
                                CHECK (workflow_kind IN ('image_edit', 'canvas_flow')),
    meta            JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_active_name_unique
    ON sessions (user_id, lower(btrim(name)))
    WHERE status != 'deleted' AND project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_creation_key_unique
    ON sessions (user_id, (meta->>'creation_key'))
    WHERE status != 'deleted'
      AND NULLIF(meta->>'creation_key', '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user_workflow_kind
    ON sessions (user_id, workflow_kind, updated_at DESC)
    WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_sessions_snapshot_key
    ON sessions (snapshot_key)
    WHERE NULLIF(snapshot_key, '') IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 20. System Settings（系统配置，feature flags 路由使用）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT        PRIMARY KEY,
    value       JSONB       NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
VALUES
    ('feature.touch_edit.enabled', 'false'::jsonb),
    ('feature.touch_edit.allowlist', '[]'::jsonb),
    ('feature.agent_orchestrator.enabled', 'false'::jsonb),
    ('feature.agent_orchestrator.allowlist', '[]'::jsonb),
    ('feature.ppt_canvas.enabled', 'false'::jsonb),
    ('feature.ppt_canvas.allowlist', '[]'::jsonb),
    ('registration_welcome_credits', '{"amount": 30}'::jsonb),
    ('global_announcement', '{
        "enabled": false,
        "show_popup": true,
        "title": "平台公告",
        "body_markdown": "",
        "version": "",
        "updated_at": ""
    }'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value)
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
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- 21. Edit History（操作历史，workspace 路由使用）
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS edit_history (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action          TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    is_undoable     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edit_history_session ON edit_history (session_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 22. Pet chat history
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pet_chat_history (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT        NOT NULL,
    pet_name        TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pet_chat_user_time
    ON pet_chat_history (user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 23. Disaster-recovery backup history
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS backup_records (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    status           TEXT        NOT NULL DEFAULT 'running',
    filename         TEXT        NOT NULL,
    storage_provider TEXT        NOT NULL DEFAULT 'local',
    storage_endpoint TEXT        NOT NULL DEFAULT '',
    storage_bucket   TEXT        NOT NULL DEFAULT '',
    storage_region   TEXT        NOT NULL DEFAULT '',
    storage_key      TEXT        NOT NULL DEFAULT '',
    local_path       TEXT        NOT NULL DEFAULT '',
    size_bytes       BIGINT      NOT NULL DEFAULT 0,
    sha256           TEXT        NOT NULL DEFAULT '',
    trigger_type     TEXT        NOT NULL DEFAULT 'manual',
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,
    error            TEXT        NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_records_created_at
    ON backup_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_records_status
    ON backup_records (status);

-- Created here as well as by the runner so a freshly initialized schema is complete.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version          TEXT        PRIMARY KEY,
    checksum         CHAR(64)    NOT NULL,
    applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
