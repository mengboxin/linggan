"""Repository for user-uploaded presentation slideshow records."""
from __future__ import annotations

import json
from typing import Any, Optional

from core.pool import acquire

_ensured = False
_REQUIRED_COLUMNS = {
    "id",
    "user_id",
    "title",
    "filename",
    "source_key",
    "source_url",
    "source_mime",
    "source_size",
    "source_sha256",
    "slide_count",
    "slides",
    "expires_at",
    "expires_notice_sent_at",
    "source_client",
    "storage_provider",
    "created_at",
    "updated_at",
}


async def _assert_required_columns(conn, table_name: str, required_columns: set[str]) -> None:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        """,
        table_name,
    )
    existing = {str(row["column_name"]) for row in rows}
    if not existing:
        raise RuntimeError(
            f"{table_name} table is missing; run python backend/scripts/run_migrate.py"
        )
    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            f"{table_name} is missing columns: {', '.join(missing)}; "
            "run python backend/scripts/run_migrate.py"
        )


async def ensure_table() -> None:
    global _ensured
    if _ensured:
        return
    async with acquire() as conn:
        await _assert_required_columns(conn, "ppt_presentation_uploads", _REQUIRED_COLUMNS)
    _ensured = True


async def create_upload(
    *,
    upload_id: str,
    user_id: str,
    title: str,
    filename: str,
    source_asset: dict[str, Any],
    slides: list[dict[str, Any]],
    expires_at: str = "",
    source_client: str = "web",
    storage_provider: str = "s3",
) -> dict[str, Any]:
    await ensure_table()
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ppt_presentation_uploads (
                id, user_id, title, filename, source_key, source_url, source_mime,
                source_size, source_sha256, slide_count, slides, expires_at,
                source_client, storage_provider
            )
            VALUES (
                $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                NULLIF($12, '')::timestamptz, $13, $14
            )
            RETURNING id::text, user_id::text, title, filename, source_key, source_url,
                      source_mime, source_size, source_sha256, slide_count, slides,
                      expires_at::text, source_client, storage_provider, created_at::text, updated_at::text
            """,
            upload_id,
            user_id,
            title,
            filename,
            str(source_asset.get("key") or ""),
            str(source_asset.get("url") or ""),
            str(source_asset.get("mime_type") or ""),
            int(source_asset.get("size_bytes") or 0),
            str(source_asset.get("sha256") or ""),
            len(slides),
            json.dumps(slides, ensure_ascii=False),
            expires_at or "",
            source_client,
            storage_provider,
        )
        return _row_to_dict(row)


async def list_uploads(user_id: str, limit: int = 30, offset: int = 0) -> list[dict[str, Any]]:
    await ensure_table()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, user_id::text, title, filename, source_key, source_url,
                   source_mime, source_size, source_sha256, slide_count,
                   expires_at::text, source_client, storage_provider, created_at::text, updated_at::text
            FROM ppt_presentation_uploads
            WHERE user_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT $2 OFFSET $3
            """,
            user_id,
            limit,
            offset,
        )
        return [dict(row) for row in rows]


async def get_upload(upload_id: str, user_id: str) -> Optional[dict[str, Any]]:
    await ensure_table()
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id::text, user_id::text, title, filename, source_key, source_url,
                   source_mime, source_size, source_sha256, slide_count, slides,
                   expires_at::text, source_client, storage_provider, created_at::text, updated_at::text
            FROM ppt_presentation_uploads
            WHERE id = $1::uuid AND user_id = $2::uuid
            """,
            upload_id,
            user_id,
        )
        return _row_to_dict(row) if row else None


async def _delete_upload_with_conn(conn, upload_id: str, user_id: str) -> Optional[dict[str, Any]]:
    row = await conn.fetchrow(
        """
        DELETE FROM ppt_presentation_uploads
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING id::text, user_id::text, title, filename, source_key, source_url,
                  source_mime, source_size, source_sha256, slide_count, slides,
                  expires_at::text, source_client, storage_provider, created_at::text, updated_at::text
        """,
        upload_id,
        user_id,
    )
    return _row_to_dict(row) if row else None


async def delete_upload(upload_id: str, user_id: str, *, conn=None) -> Optional[dict[str, Any]]:
    await ensure_table()
    if conn is not None:
        return await _delete_upload_with_conn(conn, upload_id, user_id)
    async with acquire() as conn:
        return await _delete_upload_with_conn(conn, upload_id, user_id)


def _row_to_dict(row) -> dict[str, Any]:
    data = dict(row)
    raw_slides = data.get("slides")
    if isinstance(raw_slides, str):
        try:
            data["slides"] = json.loads(raw_slides)
        except Exception:
            data["slides"] = []
    elif raw_slides is None:
        data["slides"] = []
    return data
