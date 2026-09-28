-- Add wallet columns in a standalone migration. PostgreSQL must commit these
-- definitions before a later migration can reference them in DML.

ALTER TABLE user_subscriptions
    ADD COLUMN IF NOT EXISTS quota_total NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS quota_remaining NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS exhausted_at TIMESTAMPTZ;

ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS balance_source TEXT NOT NULL DEFAULT 'metered',
    ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS user_billing_preferences (
    user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    funding_source           TEXT NOT NULL DEFAULT 'metered'
                                  CHECK (funding_source IN ('metered', 'subscription')),
    selected_subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

