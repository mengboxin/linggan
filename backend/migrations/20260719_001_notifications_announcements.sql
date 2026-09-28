-- User notification center and global announcement configuration.

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

ALTER TABLE user_notifications
    ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS action_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
    ON user_notifications (user_id, read_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
    ON user_notifications (user_id, created_at DESC);

INSERT INTO system_settings (key, value, updated_at)
VALUES (
    'global_announcement',
    '{
        "enabled": false,
        "show_popup": true,
        "title": "平台公告",
        "body_markdown": "",
        "version": "",
        "updated_at": ""
    }'::jsonb,
    NOW()
)
ON CONFLICT (key) DO NOTHING;
