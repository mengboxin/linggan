# Database maintenance

These scripts require a PostgreSQL administrator account and are not part of
normal application startup.

## Online index hardening

The index-hardening maintenance file creates and removes indexes with
`CONCURRENTLY`, so it must run through a direct PostgreSQL connection as the
table owner or an administrator. It also creates the credit-transaction
idempotency index after its startup-safe column migration. Do not use
`psql --single-transaction`.

```bash
psql "$POSTGRES_MAINTENANCE_URL" -v ON_ERROR_STOP=1 \
  -f backend/scripts/maintenance/schema_index_hardening.sql
```

It uses a five-second `lock_timeout`. A timeout leaves the existing indexes
intact; rerun the command in a quieter maintenance window.

## Permanent web-history retention

New web-history records have no expiry. Clear the legacy expiry values before
running any scheduled storage-expiry cleanup job:

```bash
python backend/scripts/maintenance/clear_web_history_expiry.py --dry-run
python backend/scripts/maintenance/clear_web_history_expiry.py --batch-size 500
```

Each update is an independent auto-commit statement with `FOR UPDATE SKIP
LOCKED`. Use `--max-batches` to cap work per table during a short maintenance
window; the command can be rerun safely until it reports zero updates.

To repair ownership before running application migrations:

```bash
psql "$ADMIN_DATABASE_URL" \
  -v app_user=pixelscribeDB \
  -f backend/scripts/maintenance/fix_schema_owner.sql
```

Then run the normal migration and audit commands with the application account:

```bash
python backend/scripts/run_migrate.py
python backend/scripts/audit_db_schema.py
```
