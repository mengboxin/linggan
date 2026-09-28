-- Backup records use application-generated UUIDs so the scheduler does not
-- depend on PostgreSQL contrib extensions at API startup.
ALTER TABLE backup_records
    ALTER COLUMN id DROP DEFAULT;
