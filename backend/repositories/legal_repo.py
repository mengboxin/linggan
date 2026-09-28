"""Persistence for immutable legal-document snapshots and acceptance evidence."""
from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Iterable

from core.pool import acquire
from core.config import settings
from services.legal_documents import CURRENT_LEGAL_DOCUMENTS, LegalDocument


class LegalDocumentVersionConflict(RuntimeError):
    """The database already contains different content under an immutable version."""


def _evidence_hash(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    return hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        normalized.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


async def _ensure_document_snapshots(
    connection,
    documents: Iterable[LegalDocument] | None = None,
) -> None:
    documents = tuple(documents or CURRENT_LEGAL_DOCUMENTS.values())
    for document in documents:
        await connection.execute(
            """
            INSERT INTO legal_document_versions (
                document_type, version, title, summary, content_markdown,
                content_hash, published_on, effective_on,
                requires_reacceptance, required_at_login
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (document_type, version) DO NOTHING
            """,
            document.document_type,
            document.version,
            document.title,
            document.summary,
            document.content_markdown,
            document.content_hash,
            document.published_on,
            document.effective_on,
            document.requires_reacceptance,
            document.required_at_login,
        )

    rows = await connection.fetch(
        """
        SELECT document_type, version, content_hash
        FROM legal_document_versions
        WHERE (document_type, version) IN (
            SELECT * FROM UNNEST($1::text[], $2::text[])
        )
        """,
        [document.document_type for document in documents],
        [document.version for document in documents],
    )
    stored = {
        (str(row["document_type"]), str(row["version"])): str(row["content_hash"]).strip()
        for row in rows
    }
    for document in documents:
        if stored.get((document.document_type, document.version)) != document.content_hash:
            raise LegalDocumentVersionConflict(
                f"Immutable legal document {document.document_type}@{document.version} "
                "does not match the application registry; publish a new version instead."
            )


async def ensure_document_snapshots(
    documents: Iterable[LegalDocument] | None = None,
    *,
    conn=None,
) -> None:
    if conn is not None:
        await _ensure_document_snapshots(conn, documents)
        return
    async with acquire() as connection:
        async with connection.transaction():
            await _ensure_document_snapshots(connection, documents)


async def record_acceptances(
    user_id: str,
    documents: Iterable[LegalDocument],
    *,
    source: str,
    client_ip: str = "",
    user_agent: str = "",
    context_type: str = "",
    context_id: str = "",
    metadata: dict | None = None,
    conn=None,
) -> list[str]:
    unique_documents = {
        (document.document_type, document.version): document for document in documents
    }.values()

    async def _record(connection) -> list[str]:
        await _ensure_document_snapshots(connection, unique_documents)
        acceptance_ids: list[str] = []
        for document in unique_documents:
            acceptance_id = await connection.fetchval(
                """
                INSERT INTO user_legal_acceptances (
                    user_id, document_type, document_version, document_hash,
                    source, ip_hash, user_agent_hash,
                    context_type, context_id, metadata
                )
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                ON CONFLICT (user_id, document_type, document_version, context_type, context_id)
                    WHERE context_type <> '' AND context_id <> ''
                DO UPDATE SET context_id = EXCLUDED.context_id
                RETURNING id::text
                """,
                user_id,
                document.document_type,
                document.version,
                document.content_hash,
                source[:64],
                _evidence_hash(client_ip),
                _evidence_hash(user_agent),
                context_type[:64],
                context_id[:128],
                json.dumps(metadata or {}, ensure_ascii=False, default=str),
            )
            acceptance_ids.append(str(acceptance_id))
        return acceptance_ids

    if conn is not None:
        return await _record(conn)
    async with acquire() as connection:
        async with connection.transaction():
            return await _record(connection)


async def has_current_required_acceptances(user_id: str) -> bool:
    documents = tuple(
        document
        for document in CURRENT_LEGAL_DOCUMENTS.values()
        if document.required_at_login and document.requires_reacceptance
    )
    if not documents:
        return True
    async with acquire() as conn:
        await _ensure_document_snapshots(conn, documents)
        accepted_count = await conn.fetchval(
            """
            SELECT COUNT(DISTINCT (document_type, document_version, document_hash))
            FROM user_legal_acceptances
            WHERE user_id = $1::uuid
              AND (document_type, document_version, document_hash) IN (
                  SELECT * FROM UNNEST($2::text[], $3::text[], $4::bpchar[])
              )
            """,
            user_id,
            [document.document_type for document in documents],
            [document.version for document in documents],
            [document.content_hash for document in documents],
        )
    return int(accepted_count or 0) == len(documents)


async def get_acceptance_status(user_id: str) -> list[dict]:
    documents = tuple(CURRENT_LEGAL_DOCUMENTS.values())
    async with acquire() as conn:
        await _ensure_document_snapshots(conn)
        rows = await conn.fetch(
            """
            SELECT document_type, document_version, document_hash,
                   accepted_at, source
            FROM user_legal_acceptances
            WHERE user_id = $1::uuid
              AND (document_type, document_version) IN (
                  SELECT * FROM UNNEST($2::text[], $3::text[])
              )
            ORDER BY accepted_at DESC
            """,
            user_id,
            [document.document_type for document in documents],
            [document.version for document in documents],
        )
    accepted = {}
    for row in rows:
        accepted.setdefault(
            (str(row["document_type"]), str(row["document_version"])),
            row,
        )
    result = []
    for document in documents:
        row = accepted.get((document.document_type, document.version))
        matches = bool(row and str(row["document_hash"]).strip() == document.content_hash)
        result.append(
            {
                **document.public_payload(),
                "accepted": matches,
                "acceptedAt": row["accepted_at"].isoformat() if matches else None,
                "acceptanceSource": str(row["source"]) if matches else None,
            }
        )
    return result


async def get_document_snapshot(document_type: str, version: str) -> dict | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT document_type, version, title, summary, content_markdown,
                   content_hash, published_on, effective_on,
                   requires_reacceptance, required_at_login
            FROM legal_document_versions
            WHERE document_type = $1 AND version = $2
            """,
            document_type,
            version,
        )
    if row is None:
        return None
    return {
        "documentType": str(row["document_type"]),
        "version": str(row["version"]),
        "title": str(row["title"]),
        "summary": str(row["summary"]),
        "contentMarkdown": str(row["content_markdown"]),
        "contentHash": str(row["content_hash"]).strip(),
        "publishedOn": row["published_on"].isoformat(),
        "effectiveOn": row["effective_on"].isoformat(),
        "requiresReacceptance": bool(row["requires_reacceptance"]),
        "requiredAtLogin": bool(row["required_at_login"]),
    }
