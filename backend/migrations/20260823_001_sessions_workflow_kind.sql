-- Keep workspace list/filter off the huge sessions.meta JSONB snapshot.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS workflow_kind TEXT NOT NULL DEFAULT 'image_edit';

UPDATE sessions
SET workflow_kind = CASE
    WHEN meta->>'workflow_kind' = 'canvas_flow' THEN 'canvas_flow'
    ELSE 'image_edit'
END
WHERE workflow_kind IS DISTINCT FROM CASE
    WHEN meta->>'workflow_kind' = 'canvas_flow' THEN 'canvas_flow'
    ELSE 'image_edit'
END;

ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_workflow_kind_check;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_workflow_kind_check
    CHECK (workflow_kind IN ('image_edit', 'canvas_flow'));

CREATE INDEX IF NOT EXISTS idx_sessions_user_workflow_kind
    ON sessions (user_id, workflow_kind, updated_at DESC)
    WHERE status != 'deleted';
