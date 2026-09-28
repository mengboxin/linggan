-- Admin subscription operations: manual assignment, revocation, quota resets and audit.

ALTER TABLE user_subscriptions
    ALTER COLUMN payment_order_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payment',
    ADD COLUMN IF NOT EXISTS assigned_by TEXT,
    ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revoked_by TEXT,
    ADD COLUMN IF NOT EXISTS revoke_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quota_reset_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_quota_reset_at TIMESTAMPTZ;

UPDATE user_subscriptions
SET source = CASE WHEN payment_order_id IS NULL THEN 'admin' ELSE 'payment' END
WHERE source NOT IN ('payment', 'admin') OR source IS NULL;

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_source_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_source_check
    CHECK (source IN ('payment', 'admin'));

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_quota_reset_count_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_quota_reset_count_check
    CHECK (quota_reset_count >= 0);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_admin_status
    ON user_subscriptions (status, expires_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_admin_audit (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id     UUID        REFERENCES user_subscriptions(id) ON DELETE SET NULL,
    user_id             UUID        REFERENCES users(id) ON DELETE SET NULL,
    plan_id             TEXT        REFERENCES subscription_plans(id) ON DELETE SET NULL,
    action              TEXT        NOT NULL,
    actor               TEXT        NOT NULL DEFAULT 'admin',
    reason              TEXT        NOT NULL DEFAULT '',
    operation_key       TEXT,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE subscription_admin_audit DROP CONSTRAINT IF EXISTS subscription_admin_audit_action_check;
ALTER TABLE subscription_admin_audit ADD CONSTRAINT subscription_admin_audit_action_check
    CHECK (action IN ('assigned', 'revoked', 'quota_reset', 'plan_saved'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_admin_audit_operation_unique
    ON subscription_admin_audit (operation_key)
    WHERE operation_key IS NOT NULL AND operation_key <> '';
CREATE INDEX IF NOT EXISTS idx_subscription_admin_audit_created
    ON subscription_admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_admin_audit_user
    ON subscription_admin_audit (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
