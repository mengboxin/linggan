-- Prepaid weekly/monthly memberships fulfilled through the existing payment flow.

ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS product_kind TEXT NOT NULL DEFAULT 'credits',
    ADD COLUMN IF NOT EXISTS product_id TEXT,
    ADD COLUMN IF NOT EXISTS product_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_product_kind_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_product_kind_check
    CHECK (product_kind IN ('credits', 'subscription'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_trade_no_unique
    ON payment_orders (pay_channel, trade_no)
    WHERE trade_no IS NOT NULL AND trade_no <> '';

CREATE TABLE IF NOT EXISTS subscription_plans (
    id              TEXT          PRIMARY KEY,
    name            TEXT          NOT NULL,
    description     TEXT          NOT NULL DEFAULT '',
    badge_label     TEXT          NOT NULL DEFAULT '',
    price_yuan      NUMERIC(10,2) NOT NULL CHECK (price_yuan > 0),
    credits         INTEGER       NOT NULL CHECK (credits > 0),
    duration_days   INTEGER       NOT NULL CHECK (duration_days > 0),
    benefits        JSONB         NOT NULL DEFAULT '[]'::jsonb,
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
    payment_order_id    UUID        NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
    status              TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'revoked')),
    starts_at           TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    credits_granted     INTEGER     NOT NULL CHECK (credits_granted >= 0),
    plan_snapshot       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_subscriptions_period_check CHECK (expires_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_payment_order_unique
    ON user_subscriptions (payment_order_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_expires
    ON user_subscriptions (user_id, expires_at DESC)
    WHERE status = 'active';

ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
    CHECK (type IN (
        'recharge', 'consume', 'refund', 'gift', 'admin_adjust', 'payment', 'subscription'
    ));
