ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Creating the uniqueness index can scan a large ledger table. Keep startup to
-- the metadata-only column addition and apply the online index separately:
--
--   psql "$POSTGRES_MAINTENANCE_URL" -v ON_ERROR_STOP=1 \
--     -f backend/scripts/maintenance/schema_index_hardening.sql
--
-- Do not run that script with psql --single-transaction. It creates this index
-- with CONCURRENTLY so normal ledger writes are not blocked during deployment.
SELECT 1;
