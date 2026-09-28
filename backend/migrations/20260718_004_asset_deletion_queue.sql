CREATE TABLE IF NOT EXISTS asset_object_deletion_queue (
    object_key TEXT PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_deletion_queue_pending
    ON asset_object_deletion_queue (next_attempt_at, updated_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_asset_deletion_queue_user
    ON asset_object_deletion_queue (user_id, updated_at DESC);
