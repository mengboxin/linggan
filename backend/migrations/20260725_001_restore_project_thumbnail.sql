-- Keep versioned migrations aligned with scripts/init_db.sql for existing
-- project tables that predate the thumbnail column.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS thumbnail TEXT;
