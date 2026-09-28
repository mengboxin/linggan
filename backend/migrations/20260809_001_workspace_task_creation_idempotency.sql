-- A retried workspace-task creation request must return the original task.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_creation_key_unique
    ON sessions (user_id, (meta->>'creation_key'))
    WHERE status != 'deleted'
      AND NULLIF(meta->>'creation_key', '') IS NOT NULL;
