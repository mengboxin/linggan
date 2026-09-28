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
