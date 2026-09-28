CREATE TABLE IF NOT EXISTS legal_document_versions (
    document_type       TEXT        NOT NULL
                                    CHECK (document_type IN ('terms', 'privacy', 'ai', 'payment')),
    version             TEXT        NOT NULL,
    title               TEXT        NOT NULL,
    summary             TEXT        NOT NULL DEFAULT '',
    content_markdown    TEXT        NOT NULL,
    content_hash        CHAR(64)    NOT NULL
                                    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    published_on        DATE        NOT NULL,
    effective_on        DATE        NOT NULL,
    requires_reacceptance BOOLEAN   NOT NULL DEFAULT TRUE,
    required_at_login   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (document_type, version),
    UNIQUE (document_type, version, content_hash)
);

CREATE OR REPLACE FUNCTION prevent_legal_document_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'legal document versions are immutable; publish a new version';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_document_versions_immutable ON legal_document_versions;
CREATE TRIGGER trg_legal_document_versions_immutable
    BEFORE UPDATE OR DELETE ON legal_document_versions
    FOR EACH ROW EXECUTE FUNCTION prevent_legal_document_version_mutation();

CREATE TABLE IF NOT EXISTS user_legal_acceptances (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    document_type       TEXT        NOT NULL,
    document_version    TEXT        NOT NULL,
    document_hash       CHAR(64)    NOT NULL,
    source              TEXT        NOT NULL,
    ip_hash             CHAR(64)    NOT NULL DEFAULT '',
    user_agent_hash     CHAR(64)    NOT NULL DEFAULT '',
    context_type        TEXT        NOT NULL DEFAULT '',
    context_id          TEXT        NOT NULL DEFAULT '',
    metadata            JSONB       NOT NULL DEFAULT '{}',
    accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_legal_acceptances_document_fk
        FOREIGN KEY (document_type, document_version, document_hash)
        REFERENCES legal_document_versions (document_type, version, content_hash),
    CHECK ((context_type = '' AND context_id = '') OR (context_type <> '' AND context_id <> ''))
);

CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_user_time
    ON user_legal_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_legal_acceptances_document
    ON user_legal_acceptances (document_type, document_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_legal_acceptances_context
    ON user_legal_acceptances (
        user_id, document_type, document_version, context_type, context_id
    )
    WHERE context_type <> '' AND context_id <> '';
