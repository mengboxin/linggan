\set ON_ERROR_STOP on

\if :{?app_user}
\else
\echo 'Missing app_user. Pass -v app_user=YOUR_DATABASE_USER.'
\quit
\endif

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

SELECT format(
    'ALTER TABLE %I.%I OWNER TO %I;',
    schemaname,
    tablename,
    :'app_user'
)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec

SELECT format(
    'ALTER SEQUENCE %I.%I OWNER TO %I;',
    sequence_schema,
    sequence_name,
    :'app_user'
)
FROM information_schema.sequences
WHERE sequence_schema = 'public'
ORDER BY sequence_name
\gexec

SELECT format('ALTER SCHEMA public OWNER TO %I;', :'app_user')
\gexec
