ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pet_id TEXT,
    ADD COLUMN IF NOT EXISTS pet_custom_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_users_pet_id
    ON users (pet_id)
    WHERE pet_id IS NOT NULL;
