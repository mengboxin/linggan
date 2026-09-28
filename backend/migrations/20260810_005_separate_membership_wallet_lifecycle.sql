-- Backfill and enforce the independent membership-card wallet lifecycle.

UPDATE user_subscriptions
SET quota_total = COALESCE(quota_total, credits_granted),
    quota_remaining = COALESCE(quota_remaining, credits_granted),
    activated_at = COALESCE(activated_at, starts_at);

ALTER TABLE user_subscriptions
    ALTER COLUMN quota_total SET NOT NULL,
    ALTER COLUMN quota_remaining SET NOT NULL,
    ALTER COLUMN starts_at DROP NOT NULL,
    ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_status_check
    CHECK (status IN ('active', 'queued', 'exhausted', 'expired', 'revoked'));
ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_period_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_period_check
    CHECK (
        (status = 'queued' AND starts_at IS NULL AND expires_at IS NULL)
        OR (status <> 'queued' AND starts_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > starts_at)
    );
ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_quota_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_quota_check
    CHECK (quota_total >= 0 AND quota_remaining >= 0 AND quota_remaining <= quota_total);

-- Approximate legacy pooled consumption with FIFO allocation from membership
-- grants. The remaining membership quota is removed from the permanent wallet
-- once so it cannot be spent twice.
WITH membership_users AS (
    SELECT user_id, MIN(created_at) AS first_grant_at
    FROM user_subscriptions
    WHERE status <> 'revoked'
    GROUP BY user_id
), consumed AS (
    SELECT mu.user_id,
           COALESCE(SUM(ABS(ct.amount)) FILTER (WHERE ct.type = 'consume'), 0)::numeric AS consumed_after_grant
    FROM membership_users mu
    LEFT JOIN credit_transactions ct
      ON ct.user_id = mu.user_id AND ct.created_at >= mu.first_grant_at
    GROUP BY mu.user_id
), allocation AS (
    SELECT us.id, us.quota_total,
           GREATEST(
               0::numeric,
               us.quota_total - GREATEST(
                   0::numeric,
                   c.consumed_after_grant - COALESCE(
                       SUM(us.quota_total) OVER (
                           PARTITION BY us.user_id
                           ORDER BY us.created_at, us.id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ),
                       0::numeric
                   )
               )
           ) AS remaining
    FROM user_subscriptions us
    JOIN consumed c ON c.user_id = us.user_id
    WHERE us.status <> 'revoked'
), normalized AS (
    SELECT id, LEAST(quota_total, remaining) AS remaining
    FROM allocation
)
UPDATE user_subscriptions us
SET quota_remaining = n.remaining
FROM normalized n
WHERE n.id = us.id;

WITH remaining_by_user AS (
    SELECT user_id, COALESCE(SUM(quota_remaining), 0) AS amount
    FROM user_subscriptions
    WHERE status <> 'revoked'
    GROUP BY user_id
)
UPDATE users u
SET credits = GREATEST(0, u.credits - r.amount), updated_at = NOW()
FROM remaining_by_user r
WHERE r.user_id = u.id AND r.amount > 0;

UPDATE user_subscriptions
SET status = 'revoked', quota_remaining = 0
WHERE revoked_at IS NOT NULL OR status = 'revoked';

UPDATE user_subscriptions
SET status = 'expired', quota_remaining = 0
WHERE status <> 'revoked' AND expires_at IS NOT NULL AND expires_at <= NOW();

UPDATE user_subscriptions
SET status = 'exhausted', exhausted_at = COALESCE(exhausted_at, NOW())
WHERE status NOT IN ('revoked', 'expired') AND quota_remaining <= 0;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, plan_id ORDER BY created_at, id) AS queue_rank
    FROM user_subscriptions
    WHERE status NOT IN ('revoked', 'expired', 'exhausted') AND quota_remaining > 0
)
UPDATE user_subscriptions us
SET status = CASE WHEN ranked.queue_rank = 1 THEN 'active' ELSE 'queued' END,
    starts_at = CASE WHEN ranked.queue_rank = 1 THEN NOW() ELSE NULL END,
    activated_at = CASE WHEN ranked.queue_rank = 1 THEN NOW() ELSE NULL END,
    expires_at = CASE
        WHEN ranked.queue_rank = 1 THEN
            NOW() + make_interval(days => COALESCE(
                CASE WHEN COALESCE(us.plan_snapshot->>'duration_days', '') ~ '^[0-9]+$'
                     THEN (us.plan_snapshot->>'duration_days')::int END,
                30
            ))
        ELSE NULL
    END
FROM ranked
WHERE ranked.id = us.id;

INSERT INTO user_billing_preferences (user_id, funding_source, selected_subscription_id)
SELECT u.id,
       CASE WHEN active.id IS NULL THEN 'metered' ELSE 'subscription' END,
       active.id
FROM users u
LEFT JOIN LATERAL (
    SELECT us.id
    FROM user_subscriptions us
    WHERE us.user_id = u.id AND us.status = 'active' AND us.quota_remaining > 0
    ORDER BY us.created_at
    LIMIT 1
) active ON TRUE
WHERE EXISTS (SELECT 1 FROM user_subscriptions owned WHERE owned.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_balance_source_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_balance_source_check
    CHECK (balance_source IN ('metered', 'subscription'));

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_wallet
    ON user_subscriptions (user_id, status, plan_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_one_active_plan
    ON user_subscriptions (user_id, plan_id)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_credit_transactions_subscription
    ON credit_transactions (subscription_id, created_at DESC)
    WHERE subscription_id IS NOT NULL;

-- Legacy membership ledger rows represented grants into the pooled wallet.
UPDATE credit_transactions
SET balance_source = 'subscription'
WHERE type = 'subscription';

UPDATE subscription_plans
SET description = CASE id
        WHEN 'weekly' THEN '7 天会员身份与限时会员卡额度'
        WHEN 'monthly' THEN '30 天会员身份与限时会员卡额度'
        WHEN 'pro_monthly' THEN '30 天专业会员身份与限时会员卡额度'
        ELSE description
    END,
    benefits = CASE id
        WHEN 'weekly' THEN '["120 会员卡额度（7 天有效）", "会员身份与专属标识", "可与按量积分自由切换"]'::jsonb
        WHEN 'monthly' THEN '["380 会员卡额度（30 天有效）", "会员身份与专属标识", "可与按量积分自由切换"]'::jsonb
        WHEN 'pro_monthly' THEN '["800 会员卡额度（30 天有效）", "专业会员身份与专属标识", "可与按量积分自由切换"]'::jsonb
        ELSE benefits
    END,
    updated_at = NOW();
