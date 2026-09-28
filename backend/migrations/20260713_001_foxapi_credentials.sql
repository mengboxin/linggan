ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password',
    ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'platform_credits';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_provider_check'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_auth_provider_check
            CHECK (auth_provider IN ('password', 'foxapi_key'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_billing_mode_check'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_billing_mode_check
            CHECK (billing_mode IN ('platform_credits', 'external_api_key'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_api_credentials (
    user_id             UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_api_credentials_status
    ON user_api_credentials (status);
CREATE INDEX IF NOT EXISTS idx_user_api_credentials_last_used
    ON user_api_credentials (last_used_at DESC);
