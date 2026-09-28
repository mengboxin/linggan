ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS creation_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_user_creation_key_unique
    ON conversations (user_id, creation_key)
    WHERE creation_key IS NOT NULL;
