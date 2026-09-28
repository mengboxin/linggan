"""用户数据仓库 —— 使用全局 asyncpg 连接池"""
from collections.abc import Iterable
from typing import Optional
from core.pool import acquire
from repositories import legal_repo
from services.legal_documents import LegalDocument


async def get_by_email(email: str) -> Optional[dict]:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT u.id::text, u.email, u.password_hash, u.display_name, u.role, u.status,
                   u.credits, u.auth_provider, u.billing_mode,
                   u.pet_id, u.pet_custom_name,
                   c.key_fingerprint, c.status AS api_key_status,
                   jsonb_array_length(COALESCE(c.model_catalog, '[]'::jsonb)) AS foxapi_model_count,
                   g.key_fingerprint AS grok_key_fingerprint,
                   g.status AS grok_api_key_status,
                   jsonb_array_length(COALESCE(g.model_catalog, '[]'::jsonb)) AS grok_model_count
            FROM users u
            LEFT JOIN user_api_credentials c ON c.user_id = u.id AND c.provider = 'foxapi'
            LEFT JOIN user_api_credentials g ON g.user_id = u.id AND g.provider = 'grok'
            WHERE u.email = $1
            """,
            email,
        )
        return dict(row) if row else None


async def get_by_id(user_id: str) -> Optional[dict]:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT u.id::text, u.email, u.display_name, u.role, u.status, u.total_tasks,
                   u.credits, u.created_at, u.auth_provider, u.billing_mode,
                   u.pet_id, u.pet_custom_name,
                   c.key_fingerprint, c.status AS api_key_status,
                   c.last_verified_at, c.last_used_at, c.request_count, c.failed_count,
                   c.last_model_id, c.last_error,
                   jsonb_array_length(COALESCE(c.model_catalog, '[]'::jsonb)) AS foxapi_model_count,
                   g.key_fingerprint AS grok_key_fingerprint,
                   g.status AS grok_api_key_status,
                   g.last_verified_at AS grok_last_verified_at,
                   g.last_used_at AS grok_last_used_at,
                   g.request_count AS grok_request_count,
                   g.failed_count AS grok_failed_count,
                   g.last_model_id AS grok_last_model_id,
                   g.last_error AS grok_last_error,
                   jsonb_array_length(COALESCE(g.model_catalog, '[]'::jsonb)) AS grok_model_count
            FROM users u
            LEFT JOIN user_api_credentials c ON c.user_id = u.id AND c.provider = 'foxapi'
            LEFT JOIN user_api_credentials g ON g.user_id = u.id AND g.provider = 'grok'
            WHERE u.id = $1::uuid
            """,
            user_id,
        )
        return dict(row) if row else None


async def create_user(
    email: str,
    password_hash: str,
    display_name: str,
    welcome_credits: float = 30.0,
    conn=None,
    legal_documents: Iterable[LegalDocument] = (),
    legal_source: str = "register",
    legal_client_ip: str = "",
    legal_user_agent: str = "",
) -> dict:
    credits = max(0.0, float(welcome_credits))
    query = """
        INSERT INTO users (email, password_hash, display_name, credits)
        VALUES ($1, $2, $3, $4)
        RETURNING id::text, email, display_name, role, status, credits,
                  auth_provider, billing_mode, pet_id, pet_custom_name
    """
    async def _create(connection) -> dict:
        row = await connection.fetchrow(query, email, password_hash, display_name, credits)
        user = dict(row)
        documents = tuple(legal_documents)
        if documents:
            await legal_repo.record_acceptances(
                user["id"],
                documents,
                source=legal_source,
                client_ip=legal_client_ip,
                user_agent=legal_user_agent,
                conn=connection,
            )
        return user

    if conn is not None:
        return await _create(conn)
    async with acquire() as connection:
        async with connection.transaction():
            return await _create(connection)


async def email_exists(email: str) -> bool:
    async with acquire() as conn:
        return await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)", email
        )


async def update_last_active(user_id: str):
    async with acquire() as conn:
        await conn.execute(
            "UPDATE users SET last_active_at = NOW() WHERE id = $1::uuid", user_id
        )


async def update_password(email: str, new_password_hash: str):
    async with acquire() as conn:
        await conn.execute(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2",
            new_password_hash, email,
        )


async def list_all() -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT u.id::text, u.email, u.display_name, u.role, u.status, u.total_tasks,
                   u.created_at::text, u.auth_provider, u.billing_mode,
                   u.pet_id, u.pet_custom_name,
                   c.key_fingerprint, c.status AS api_key_status,
                   jsonb_array_length(COALESCE(c.model_catalog, '[]'::jsonb)) AS foxapi_model_count,
                   COALESCE(c.request_count, 0) AS request_count,
                   COALESCE(c.failed_count, 0) AS failed_count,
                   c.last_used_at::text, c.last_verified_at::text,
                   c.last_model_id, c.last_error,
                   g.key_fingerprint AS grok_key_fingerprint,
                   g.status AS grok_api_key_status,
                   jsonb_array_length(COALESCE(g.model_catalog, '[]'::jsonb)) AS grok_model_count,
                   COALESCE(g.request_count, 0) AS grok_request_count,
                   COALESCE(g.failed_count, 0) AS grok_failed_count,
                   g.last_used_at::text AS grok_last_used_at,
                   g.last_verified_at::text AS grok_last_verified_at,
                   g.last_model_id AS grok_last_model_id,
                   g.last_error AS grok_last_error
            FROM users u
            LEFT JOIN user_api_credentials c ON c.user_id = u.id AND c.provider = 'foxapi'
            LEFT JOIN user_api_credentials g ON g.user_id = u.id AND g.provider = 'grok'
            ORDER BY u.created_at DESC
            """
        )
        return [dict(r) for r in rows]


async def set_status(user_id: str, status: str):
    async with acquire() as conn:
        await conn.execute(
            "UPDATE users SET status=$1 WHERE id=$2::uuid", status, user_id
        )


async def update_pet_preference(user_id: str, pet_id: Optional[str], pet_custom_name: str) -> Optional[dict]:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE users
            SET pet_id = $1, pet_custom_name = $2, updated_at = NOW()
            WHERE id = $3::uuid
            RETURNING id::text, email, display_name, role, status, total_tasks,
                      credits, created_at, auth_provider, billing_mode,
                      pet_id, pet_custom_name
            """,
            pet_id,
            pet_custom_name,
            user_id,
        )
        return dict(row) if row else None
