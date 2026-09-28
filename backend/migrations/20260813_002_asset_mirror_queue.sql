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
