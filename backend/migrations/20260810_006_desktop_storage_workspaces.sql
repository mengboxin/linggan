ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS storage_workspace TEXT NOT NULL DEFAULT 'cloud';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversations_storage_workspace_check'
          AND conrelid = 'conversations'::regclass
    ) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT conversations_storage_workspace_check
            CHECK (storage_workspace IN ('local', 'cloud'));
    END IF;
END $$;

DROP INDEX IF EXISTS idx_conversations_user_creation_key_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_user_workspace_creation_key_unique
    ON conversations (user_id, storage_workspace, creation_key)
    WHERE creation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_user_workspace_type_updated
    ON conversations (user_id, storage_workspace, type, updated_at DESC)
    WHERE is_archived = FALSE;
