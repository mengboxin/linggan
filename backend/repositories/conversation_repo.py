"""
对话历史记录数据仓库
使用全局 asyncpg 连接池，高并发下连接复用，无短连接开销。
"""
import json
import logging
from typing import Optional, List

from core import cache as ui_cache
from core import history_artifacts
from core.pool import acquire
from core.user_context import get_current_storage_workspace
from repositories import image_asset_repo
from services import asset_lifecycle

logger = logging.getLogger(__name__)

# 缓存表结构检查结果，避免每次查 information_schema
_has_meta_col: Optional[bool] = None
_has_metadata_col: Optional[bool] = None
_has_history_key_col: Optional[bool] = None
_has_history_key_unique_index: Optional[bool] = None
_has_history_summary_col: Optional[bool] = None
IDEMPOTENT_MESSAGE_TYPES = {
    "image_request",
    "image_result",
    "poster_request",
    "poster_artifact",
    "poster_error",
    "sci_fig_request",
    "sci_fig_artifact",
    "sci_fig_error",
    "ppt_request",
    "selected_slides",
    "slides_preview",
    "pptx_done",
}
LIGHT_META_DROP_KEYS = (
    "preview_b64",
    "preview_b64_list",
    "image_b64",
    "image_b64s",
    "images",
    "svg_b64",
    "versions",
    "slide_decks",
    "direct_slide_decks",
    "slides",
)


def _message_meta_expression(
    has_meta: bool,
    has_metadata: bool,
    *,
    alias: str = "",
    light: bool = False,
) -> str:
    columns = []
    if has_meta:
        columns.append(f"{alias}meta")
    if has_metadata:
        columns.append(f"{alias}metadata")
    expression = "COALESCE(" + ", ".join([*columns, "'{}'::jsonb"]) + ")"
    if light:
        keys = ", ".join(f"'{key}'" for key in LIGHT_META_DROP_KEYS)
        expression = f"({expression} - ARRAY[{keys}]::text[])"
    return expression


def _history_key_part(value) -> str:
    return str(value or "").strip().replace("|", "/")[:160]


def _build_message_history_key(role: str, meta: Optional[dict]) -> str:
    if not isinstance(meta, dict):
        return ""
    explicit = _history_key_part(meta.get("history_key") or meta.get("idempotency_key"))
    if explicit:
        return explicit

    meta_type = _history_key_part(meta.get("type"))
    task_key = _history_key_part(meta.get("job_id") or meta.get("task_id"))
    if not meta_type or not task_key or meta_type not in IDEMPOTENT_MESSAGE_TYPES:
        return ""

    parts = ["conversation-message", _history_key_part(role), meta_type, task_key]
    for extra_key in ("version", "slide_index"):
        extra = _history_key_part(meta.get(extra_key))
        if extra:
            parts.append(f"{extra_key}:{extra}")
    return "|".join(parts)


def _normalize_message_row(row, fallback_meta: Optional[dict] = None) -> dict:
    d = dict(row)
    raw_meta = d.get("meta")
    if isinstance(raw_meta, str):
        try:
            d["meta"] = json.loads(raw_meta)
        except Exception:
            d["meta"] = {}
    elif raw_meta is None:
        d["meta"] = fallback_meta or {}
    return d


async def invalidate_user_history_cache(user_id: str, *extra_scopes: str) -> None:
    scopes = ["history", *extra_scopes]
    await ui_cache.bump_user_cache_version(user_id, *scopes)


async def _check_cols() -> tuple[bool, bool]:
    """返回 (has_meta, has_metadata)"""
    global _has_meta_col, _has_metadata_col
    if _has_meta_col is None or _has_metadata_col is None:
        async with acquire() as conn:
            cols = await conn.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='conversation_messages' AND column_name IN ('meta','metadata')"
            )
            names = {r['column_name'] for r in cols}
            _has_meta_col = 'meta' in names
            _has_metadata_col = 'metadata' in names
    return _has_meta_col, _has_metadata_col


async def _check_meta_col() -> bool:
    has_meta, _ = await _check_cols()
    return has_meta


async def _check_history_key_col() -> bool:
    global _has_history_key_col
    if _has_history_key_col is None:
        async with acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'conversation_messages'
                      AND column_name = 'history_key'
                ) AS exists
                """
            )
            _has_history_key_col = bool(row and row["exists"])
    return _has_history_key_col


async def _check_history_key_unique_index() -> bool:
    global _has_history_key_unique_index
    if _has_history_key_unique_index is None:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT to_regclass('public.idx_conversation_messages_history_key_unique') IS NOT NULL AS exists"
            )
            _has_history_key_unique_index = bool(row and row["exists"])
    return _has_history_key_unique_index


async def _check_history_summary_col() -> bool:
    global _has_history_summary_col
    if _has_history_summary_col is None:
        async with acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'conversation_messages'
                      AND column_name = 'history_summary'
                ) AS exists
                """
            )
            _has_history_summary_col = bool(row and row["exists"])
    return _has_history_summary_col


def _history_summary_sql(alias: str, *, has_meta: bool, has_history_summary: bool) -> str:
    """Prefer the list-card projection; only touch toasted meta when the card is empty."""
    if has_history_summary and has_meta:
        return (
            f"CASE WHEN COALESCE({alias}history_summary, '{{}}'::jsonb) <> '{{}}'::jsonb "
            f"THEN {alias}history_summary "
            f"ELSE jsonb_strip_nulls(jsonb_build_object("
            f"'type', {alias}meta->>'type', "
            f"'source', {alias}meta->>'source', "
            f"'status', {alias}meta->>'status', "
            f"'error', {alias}meta->>'error', "
            f"'job_id', COALESCE(NULLIF({alias}meta->>'job_id', ''), NULLIF({alias}meta->>'task_id', '')), "
            f"'task_id', {alias}meta->>'task_id', "
            f"'asset_id', {alias}meta->>'asset_id', "
            f"'image_url', {alias}meta->>'image_url', "
            f"'preview_url', {alias}meta->>'preview_url', "
            f"'thumbnail_url', COALESCE(NULLIF({alias}meta->>'thumbnail_url', ''), NULLIF({alias}meta->>'thumb_url', '')), "
            f"'local_file_path', {alias}meta->>'local_file_path', "
            f"'local_image_url', {alias}meta->>'local_image_url', "
            f"'poster_count', CASE WHEN jsonb_typeof({alias}meta->'posters') = 'array' "
            f"THEN to_jsonb(jsonb_array_length({alias}meta->'posters')) ELSE NULL END, "
            f"'has_artifact', CASE "
            f"WHEN jsonb_typeof({alias}meta->'posters') = 'array' AND jsonb_array_length({alias}meta->'posters') > 0 THEN to_jsonb(true) "
            f"WHEN jsonb_typeof({alias}meta->'artifact_versions') = 'array' AND jsonb_array_length({alias}meta->'artifact_versions') > 0 THEN to_jsonb(true) "
            f"WHEN COALESCE({alias}meta#>>'{{rendered_asset,asset_id}}', '') <> '' THEN to_jsonb(true) "
            f"ELSE NULL END, "
            f"'gen_mode', {alias}meta->>'gen_mode', "
            f"'category', {alias}meta->>'category', "
            f"'style_preset', {alias}meta->>'style_preset', "
            f"'output_format', {alias}meta->>'output_format'"
            f")) END"
        )
    if has_history_summary:
        return f"COALESCE({alias}history_summary, '{{}}'::jsonb)"
    if has_meta:
        return f"COALESCE({alias}meta, '{{}}'::jsonb)"
    return "'{}'::jsonb"


async def create_conversation(
    user_id: str,
    conv_type: str,
    title: str,
    creation_key: Optional[str] = None,
) -> dict:
    """创建新对话"""
    normalized_key = (creation_key or "").strip() or None
    storage_workspace = get_current_storage_workspace()
    async with acquire() as conn:
        if normalized_key:
            existing = await conn.fetchrow(
                """
                SELECT id::text, user_id::text, type, title, is_archived,
                       created_at::text, updated_at::text
                FROM conversations
                WHERE user_id = $1::uuid
                  AND creation_key = $2
                  AND storage_workspace = $3
                LIMIT 1
                """,
                user_id,
                normalized_key,
                storage_workspace,
            )
            if existing:
                conversation = dict(existing)
                await invalidate_user_history_cache(user_id)
                return conversation
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO conversations (user_id, type, title, creation_key, storage_workspace)
                VALUES ($1::uuid, $2, $3, $4, $5)
                RETURNING id::text, user_id::text, type, title, is_archived,
                          created_at::text, updated_at::text
                """,
                user_id, conv_type, title, normalized_key, storage_workspace,
            )
        except Exception as exc:
            if not normalized_key or getattr(exc, "sqlstate", "") != "23505":
                raise
            row = await conn.fetchrow(
                """
                SELECT id::text, user_id::text, type, title, is_archived,
                       created_at::text, updated_at::text
                FROM conversations
                WHERE user_id = $1::uuid
                  AND creation_key = $2
                  AND storage_workspace = $3
                LIMIT 1
                """,
                user_id,
                normalized_key,
                storage_workspace,
            )
            if not row:
                raise exc
        conversation = dict(row)
    await invalidate_user_history_cache(user_id)
    return conversation


async def add_message(
    conversation_id: str,
    role: str,
    content: str,
    meta: Optional[dict] = None,
) -> dict:
    """添加消息到对话，同时更新对话的 updated_at"""
    meta_payload = dict(meta or {})
    history_key = _build_message_history_key(role, meta_payload)
    if history_key:
        meta_payload["history_key"] = history_key
    # Schema probes acquire from the shared pool. Resolve them before holding
    # the write connection so a saturated pool cannot self-deadlock.
    has_meta, has_metadata = await _check_cols()
    has_history_key = await _check_history_key_col()
    has_history_key_index = has_history_key and await _check_history_key_unique_index()
    has_history_summary = has_meta and await _check_history_summary_col()
    summary_payload = history_artifacts.message_history_summary(meta_payload) if has_history_summary else {}
    owner_user_id = ""
    async with acquire() as conn:
        async with conn.transaction():
            if history_key and has_history_key and not has_history_key_index:
                existing = await conn.fetchrow(
                    """
                    SELECT id::text
                    FROM conversation_messages
                    WHERE conversation_id = $1::uuid
                      AND role = $2
                      AND history_key = $3
                    ORDER BY created_at ASC
                    LIMIT 1
                    """,
                    conversation_id, role, history_key,
                )
                if existing:
                    if has_meta:
                        if has_history_summary:
                            row = await conn.fetchrow(
                                """
                                UPDATE conversation_messages
                                SET content = $2, meta = $3::jsonb, history_summary = $4::jsonb
                                WHERE id = $1::uuid
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                existing["id"], content, json.dumps(meta_payload), json.dumps(summary_payload),
                            )
                        else:
                            row = await conn.fetchrow(
                                """
                                UPDATE conversation_messages
                                SET content = $2, meta = $3::jsonb
                                WHERE id = $1::uuid
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                existing["id"], content, json.dumps(meta_payload),
                            )
                    else:
                        row = await conn.fetchrow(
                            """
                            UPDATE conversation_messages
                            SET content = $2
                            WHERE id = $1::uuid
                            RETURNING id::text, conversation_id::text, role, content, created_at::text
                            """,
                            existing["id"], content,
                        )
                    await conn.execute(
                        "UPDATE conversations SET updated_at = NOW() WHERE id = $1::uuid",
                        conversation_id,
                    )
                    return _normalize_message_row(row, meta_payload)

            if history_key and not has_history_key and (has_meta or has_metadata):
                meta_checks = []
                if has_meta:
                    meta_checks.append("m.meta->>'history_key' = $3")
                if has_metadata:
                    meta_checks.append("m.metadata->>'history_key' = $3")
                existing = await conn.fetchrow(
                    f"""
                    SELECT m.id::text
                    FROM conversation_messages m
                    WHERE m.conversation_id = $1::uuid
                      AND m.role = $2
                      AND ({' OR '.join(meta_checks)})
                    ORDER BY m.created_at ASC
                    LIMIT 1
                    """,
                    conversation_id, role, history_key,
                )
                if existing:
                    if has_meta:
                        if has_history_summary:
                            row = await conn.fetchrow(
                                """
                                UPDATE conversation_messages
                                SET content = $2, meta = $3::jsonb, history_summary = $4::jsonb
                                WHERE id = $1::uuid
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                existing["id"], content, json.dumps(meta_payload), json.dumps(summary_payload),
                            )
                        else:
                            row = await conn.fetchrow(
                                """
                                UPDATE conversation_messages
                                SET content = $2, meta = $3::jsonb
                                WHERE id = $1::uuid
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                existing["id"], content, json.dumps(meta_payload),
                            )
                    else:
                        row = await conn.fetchrow(
                            """
                            UPDATE conversation_messages
                            SET content = $2
                            WHERE id = $1::uuid
                            RETURNING id::text, conversation_id::text, role, content, created_at::text
                            """,
                            existing["id"], content,
                        )
                    await conn.execute(
                        "UPDATE conversations SET updated_at = NOW() WHERE id = $1::uuid",
                        conversation_id,
                    )
                    return _normalize_message_row(row, meta_payload)

            if has_meta:
                if has_history_key:
                    if has_history_key_index:
                        if has_history_summary:
                            row = await conn.fetchrow(
                                """
                                INSERT INTO conversation_messages (conversation_id, role, content, meta, history_key, history_summary)
                                VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, ''), $6::jsonb)
                                ON CONFLICT (conversation_id, role, history_key) WHERE history_key IS NOT NULL
                                DO UPDATE SET content = EXCLUDED.content, meta = EXCLUDED.meta, history_summary = EXCLUDED.history_summary
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                conversation_id, role, content, json.dumps(meta_payload), history_key, json.dumps(summary_payload),
                            )
                        else:
                            row = await conn.fetchrow(
                                """
                                INSERT INTO conversation_messages (conversation_id, role, content, meta, history_key)
                                VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, ''))
                                ON CONFLICT (conversation_id, role, history_key) WHERE history_key IS NOT NULL
                                DO UPDATE SET content = EXCLUDED.content, meta = EXCLUDED.meta
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                conversation_id, role, content, json.dumps(meta_payload), history_key,
                            )
                    else:
                        if has_history_summary:
                            row = await conn.fetchrow(
                                """
                                INSERT INTO conversation_messages (conversation_id, role, content, meta, history_key, history_summary)
                                VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, ''), $6::jsonb)
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                conversation_id, role, content, json.dumps(meta_payload), history_key, json.dumps(summary_payload),
                            )
                        else:
                            row = await conn.fetchrow(
                                """
                                INSERT INTO conversation_messages (conversation_id, role, content, meta, history_key)
                                VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, ''))
                                RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                                """,
                                conversation_id, role, content, json.dumps(meta_payload), history_key,
                            )
                else:
                    if has_history_summary:
                        row = await conn.fetchrow(
                            """
                            INSERT INTO conversation_messages (conversation_id, role, content, meta, history_summary)
                            VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
                            RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                            """,
                            conversation_id, role, content, json.dumps(meta_payload), json.dumps(summary_payload),
                        )
                    else:
                        row = await conn.fetchrow(
                            """
                            INSERT INTO conversation_messages (conversation_id, role, content, meta)
                            VALUES ($1::uuid, $2, $3, $4::jsonb)
                            RETURNING id::text, conversation_id::text, role, content, meta, created_at::text
                            """,
                            conversation_id, role, content, json.dumps(meta_payload),
                        )
            else:
                if has_history_key:
                    if has_history_key_index:
                        row = await conn.fetchrow(
                            """
                            INSERT INTO conversation_messages (conversation_id, role, content, history_key)
                            VALUES ($1::uuid, $2, $3, NULLIF($4, ''))
                            ON CONFLICT (conversation_id, role, history_key) WHERE history_key IS NOT NULL
                            DO UPDATE SET content = EXCLUDED.content
                            RETURNING id::text, conversation_id::text, role, content, created_at::text
                            """,
                            conversation_id, role, content, history_key,
                        )
                    else:
                        row = await conn.fetchrow(
                            """
                            INSERT INTO conversation_messages (conversation_id, role, content, history_key)
                            VALUES ($1::uuid, $2, $3, NULLIF($4, ''))
                            RETURNING id::text, conversation_id::text, role, content, created_at::text
                            """,
                            conversation_id, role, content, history_key,
                        )
                else:
                    row = await conn.fetchrow(
                        """
                        INSERT INTO conversation_messages (conversation_id, role, content)
                        VALUES ($1::uuid, $2, $3)
                        RETURNING id::text, conversation_id::text, role, content, created_at::text
                        """,
                        conversation_id, role, content,
                    )
            owner_row = await conn.fetchrow(
                """
                UPDATE conversations
                SET updated_at = NOW()
                WHERE id = $1::uuid
                RETURNING user_id::text AS user_id
                """,
                conversation_id,
            )
            owner_user_id = str(owner_row["user_id"] if owner_row else "")
        d = _normalize_message_row(row, meta_payload)
    if owner_user_id:
        await invalidate_user_history_cache(owner_user_id)
    return d


async def conversation_belongs_to_user(
    conversation_id: str,
    user_id: str,
) -> bool:
    """Check whether a conversation belongs to a user."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
            conversation_id, user_id,
        )
        return row is not None


async def conversation_belongs_to_user_of_type(
    conversation_id: str,
    user_id: str,
    conversation_type: str,
) -> bool:
    """Check both ownership and module type for server-owned workflows."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid AND type = $3",
            conversation_id,
            user_id,
            conversation_type,
        )
        return row is not None


async def list_conversations(
    user_id: str,
    conv_type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    **kwargs,
) -> List[dict]:
    """获取用户的对话列表（按最近更新排序）"""
    legacy_type = kwargs.get("type")
    if conv_type is None and isinstance(legacy_type, str) and legacy_type.strip():
        conv_type = legacy_type.strip()
    storage_workspace = get_current_storage_workspace()
    params: list[object] = [user_id, storage_workspace]
    type_clause = ""
    if conv_type:
        params.append(conv_type)
        type_clause = f" AND type = ${len(params)}"
    limit_position = len(params) + 1
    offset_position = len(params) + 2
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            WITH page AS (
                SELECT id, user_id, type, title, is_archived, created_at, updated_at
                FROM conversations
                WHERE user_id = $1::uuid
                  AND storage_workspace = $2
                  AND is_archived = FALSE{type_clause}
                ORDER BY updated_at DESC
                LIMIT ${limit_position} OFFSET ${offset_position}
            )
            SELECT c.id::text, c.user_id::text, c.type, c.title, c.is_archived,
                   c.created_at::text, c.updated_at::text,
                   COALESCE(m.message_count, 0)::int AS message_count
            FROM page c
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS message_count
                FROM conversation_messages m
                WHERE m.conversation_id = c.id
            ) m ON TRUE
            ORDER BY c.updated_at DESC
            """,
            *params,
            limit,
            offset,
        )
        return [dict(row) for row in rows]


async def count_conversations_by_type(user_id: str) -> dict[str, int]:
    """Return exact visible conversation counts grouped by module type."""
    storage_workspace = get_current_storage_workspace()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.type, COUNT(*)::int AS count
            FROM conversations c
            WHERE c.user_id = $1::uuid
              AND c.storage_workspace = $2
              AND c.is_archived = FALSE
              AND c.type IN ('ppt', 'sci-fig', 'poster', 'paper', 'image', 'image-prompt')
            GROUP BY c.type
            """,
            user_id,
            storage_workspace,
        )
    return {str(row["type"]): int(row["count"] or 0) for row in rows}


async def get_conversation_messages(
    conversation_id: str,
    user_id: str,
    light: bool = False,
) -> List[dict]:
    """获取对话的所有消息（验证归属权）"""
    has_meta, has_metadata = await _check_cols()
    async with acquire() as conn:
        conv = await conn.fetchrow(
            "SELECT id FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
            conversation_id, user_id,
        )
        if not conv:
            raise ValueError("对话不存在或无权访问")

        meta_cols = _message_meta_expression(has_meta, has_metadata, light=light) + " AS meta"

        rows = await conn.fetch(
            f"""
            SELECT id::text, conversation_id::text, role, content,
                   {meta_cols}, created_at::text
            FROM conversation_messages
            WHERE conversation_id = $1::uuid
            ORDER BY created_at ASC
            """,
            conversation_id,
        )
        result = []
        for row in rows:
            d = dict(row)
            # 优先 meta，其次 metadata，最后兜底
            raw = d.pop('meta', None) or d.pop('metadata', None)
            if isinstance(raw, str):
                try:
                    d['meta'] = json.loads(raw)
                except Exception:
                    d['meta'] = {}
            elif isinstance(raw, dict):
                d['meta'] = raw
            else:
                d['meta'] = {}
            d.pop('metadata', None)  # 清理多余字段
            if light:
                d['meta'] = history_artifacts.lightweight_meta(d.get('meta') or {})
            result.append(d)
        return result


async def list_messages_for_conversations(
    conversation_ids: List[str],
    user_id: str,
    light: bool = False,
) -> dict[str, List[dict]]:
    """Return messages for a user's conversations in one query."""
    ids = [str(item) for item in conversation_ids if str(item or "").strip()]
    if not ids:
        return {}

    has_meta, has_metadata = await _check_cols()
    meta_expr = _message_meta_expression(
        has_meta,
        has_metadata,
        alias="m.",
        light=light,
    ) + " AS meta"

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT m.id::text, m.conversation_id::text, m.role, m.content,
                   {meta_expr}, m.created_at::text
            FROM conversation_messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = $1::uuid
              AND m.conversation_id = ANY($2::uuid[])
            ORDER BY m.conversation_id, m.created_at ASC
            """,
            user_id,
            ids,
        )

    grouped: dict[str, List[dict]] = {conv_id: [] for conv_id in ids}
    for row in rows:
        d = dict(row)
        raw = d.get("meta")
        if isinstance(raw, str):
            try:
                d["meta"] = json.loads(raw)
            except Exception:
                d["meta"] = {}
        elif not isinstance(raw, dict):
            d["meta"] = {}
        if light:
            d["meta"] = history_artifacts.lightweight_meta(d.get("meta") or {})
        grouped.setdefault(d["conversation_id"], []).append(d)
    return grouped


async def list_image_message_summaries(user_id: str, limit: int = 50) -> List[dict]:
    """Return recent image conversation messages in one query for history lists."""
    storage_workspace = get_current_storage_workspace()
    has_meta, _has_metadata = await _check_cols()
    has_history_summary = await _check_history_summary_col()
    meta_expr = _history_summary_sql("m.", has_meta=has_meta, has_history_summary=has_history_summary) + " AS meta"
    user_meta_expr = _history_summary_sql("um.", has_meta=has_meta, has_history_summary=has_history_summary)

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            WITH recent_assistant AS (
                SELECT
                    c.id::text AS conversation_id,
                    c.title AS conversation_title,
                    m.id::text AS message_id,
                    {meta_expr},
                    (
                        SELECT {user_meta_expr}
                        FROM conversation_messages um
                        WHERE um.conversation_id = m.conversation_id
                          AND um.role = 'user'
                          AND um.created_at <= m.created_at
                        ORDER BY um.created_at DESC
                        LIMIT 1
                    ) AS request_meta,
                    m.created_at::text AS created_at,
                    COALESCE(
                        NULLIF((
                            SELECT um.content
                            FROM conversation_messages um
                            WHERE um.conversation_id = m.conversation_id
                              AND um.role = 'user'
                              AND um.created_at <= m.created_at
                              AND NULLIF(BTRIM(um.content), '') IS NOT NULL
                            ORDER BY um.created_at DESC
                            LIMIT 1
                        ), ''),
                        c.title,
                        ''
                    ) AS prompt
                FROM conversation_messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = $1::uuid
                  AND c.storage_workspace = $2
                  AND c.type = 'image'
                  AND c.is_archived = FALSE
                  AND m.role = 'assistant'
                ORDER BY m.created_at DESC
                LIMIT $3
            )
            SELECT conversation_id, conversation_title, message_id, meta, request_meta, created_at, prompt
            FROM recent_assistant
            """,
            user_id,
            storage_workspace,
            limit,
        )
    result = []
    for row in rows:
        d = dict(row)
        raw_meta = d.get("meta")
        if isinstance(raw_meta, str):
            try:
                d["meta"] = json.loads(raw_meta)
            except Exception:
                d["meta"] = {}
        elif not isinstance(raw_meta, dict):
            d["meta"] = {}
        raw_request_meta = d.get("request_meta")
        if isinstance(raw_request_meta, str):
            try:
                d["request_meta"] = json.loads(raw_request_meta)
            except Exception:
                d["request_meta"] = {}
        elif not isinstance(raw_request_meta, dict):
            d["request_meta"] = {}
        result.append(d)
    return result


async def list_poster_history_summaries(
    user_id: str,
    limit: int = 50,
    offset: int = 0,
) -> List[dict]:
    """Return durable poster conversations with their latest artifact metadata.

    Poster jobs keep short-lived Redis state for live progress, but history must
    come from the database so it stays visible across refreshes and devices.
    """
    requested_limit = max(1, min(int(limit or 50), 200))
    requested_offset = max(0, int(offset or 0))
    storage_workspace = get_current_storage_workspace()
    has_meta, _has_metadata = await _check_cols()
    has_history_summary = await _check_history_summary_col()
    poster_meta_expr = _history_summary_sql("pm.", has_meta=has_meta, has_history_summary=has_history_summary)
    request_meta_expr = _history_summary_sql("rm.", has_meta=has_meta, has_history_summary=has_history_summary)

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                c.id::text AS id,
                c.user_id::text AS user_id,
                c.type,
                c.title,
                c.is_archived,
                c.created_at::text AS created_at,
                c.updated_at::text AS updated_at,
                COALESCE(message_counts.message_count, 0)::int AS message_count,
                artifact.message_id,
                artifact.meta,
                artifact.created_at AS artifact_created_at,
                request.message_id AS request_message_id,
                request.meta AS request_meta,
                request.created_at AS request_created_at
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS message_count
                FROM conversation_messages cm
                WHERE cm.conversation_id = c.id
            ) message_counts ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    pm.id::text AS message_id,
                    {poster_meta_expr} AS meta,
                    pm.created_at AS created_at_sort,
                    pm.created_at::text AS created_at
                FROM conversation_messages pm
                WHERE pm.conversation_id = c.id
                  AND pm.role = 'assistant'
                  AND ({poster_meta_expr}->>'type' = 'poster_artifact')
                ORDER BY pm.created_at DESC
                LIMIT 1
            ) artifact ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    rm.id::text AS message_id,
                    {request_meta_expr} AS meta,
                    rm.created_at::text AS created_at
                FROM conversation_messages rm
                WHERE rm.conversation_id = c.id
                  AND rm.role = 'user'
                  AND ({request_meta_expr}->>'type' = 'poster_request')
                ORDER BY rm.created_at DESC
                LIMIT 1
            ) request ON TRUE
            WHERE c.user_id = $1::uuid
              AND c.storage_workspace = $2
              AND c.type = 'poster'
              AND c.is_archived = FALSE
            ORDER BY COALESCE(artifact.created_at_sort, c.updated_at) DESC
            LIMIT $3 OFFSET $4
            """,
            user_id,
            storage_workspace,
            requested_limit,
            requested_offset,
        )

    result = []
    for row in rows:
        item = dict(row)
        item["meta"] = history_artifacts.normalize_meta_value(item.get("meta"))
        item["request_meta"] = history_artifacts.normalize_meta_value(item.get("request_meta"))
        result.append(item)
    return result


async def list_sci_fig_history_summaries(
    user_id: str,
    limit: int = 50,
    offset: int = 0,
) -> List[dict]:
    """Return durable scientific-figure conversations and latest artifact/request metadata."""
    requested_limit = max(1, min(int(limit or 50), 200))
    requested_offset = max(0, int(offset or 0))
    storage_workspace = get_current_storage_workspace()
    has_meta, _has_metadata = await _check_cols()
    has_history_summary = await _check_history_summary_col()
    artifact_meta_expr = _history_summary_sql("am.", has_meta=has_meta, has_history_summary=has_history_summary)
    request_meta_expr = _history_summary_sql("rm.", has_meta=has_meta, has_history_summary=has_history_summary)

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                c.id::text AS id,
                c.user_id::text AS user_id,
                c.type,
                c.title,
                c.is_archived,
                c.created_at::text AS created_at,
                c.updated_at::text AS updated_at,
                COALESCE(message_counts.message_count, 0)::int AS message_count,
                artifact.message_id,
                artifact.meta,
                artifact.created_at AS artifact_created_at,
                request.message_id AS request_message_id,
                request.meta AS request_meta,
                request.created_at AS request_created_at
            FROM conversations c
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS message_count
                FROM conversation_messages cm
                WHERE cm.conversation_id = c.id
            ) message_counts ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    am.id::text AS message_id,
                    {artifact_meta_expr} AS meta,
                    am.created_at AS created_at_sort,
                    am.created_at::text AS created_at
                FROM conversation_messages am
                WHERE am.conversation_id = c.id
                  AND am.role = 'assistant'
                  AND ({artifact_meta_expr}->>'type' = 'sci_fig_artifact')
                ORDER BY am.created_at DESC
                LIMIT 1
            ) artifact ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    rm.id::text AS message_id,
                    {request_meta_expr} AS meta,
                    rm.created_at::text AS created_at
                FROM conversation_messages rm
                WHERE rm.conversation_id = c.id
                  AND rm.role = 'user'
                  AND ({request_meta_expr}->>'type' = 'sci_fig_request')
                ORDER BY rm.created_at DESC
                LIMIT 1
            ) request ON TRUE
            WHERE c.user_id = $1::uuid
              AND c.storage_workspace = $2
              AND c.type = 'sci-fig'
              AND c.is_archived = FALSE
            ORDER BY COALESCE(artifact.created_at_sort, c.updated_at) DESC
            LIMIT $3 OFFSET $4
            """,
            user_id,
            storage_workspace,
            requested_limit,
            requested_offset,
        )

    result = []
    for row in rows:
        item = dict(row)
        item["meta"] = history_artifacts.normalize_meta_value(item.get("meta"))
        item["request_meta"] = history_artifacts.normalize_meta_value(item.get("request_meta"))
        result.append(item)
    return result


async def find_messages_by_job_id(
    job_id: str,
    user_id: str,
    conv_type: Optional[str] = None,
) -> List[dict]:
    """Find messages for a user's task by metadata job_id."""
    has_meta, has_metadata = await _check_cols()
    async with acquire() as conn:
        clauses = []
        meta_select = []
        if has_meta:
            meta_select.append("m.meta")
            clauses.append(
                """
                (
                  m.meta->>'job_id' = $2 OR
                  EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(m.meta->'artifacts') = 'array' THEN m.meta->'artifacts'
                        ELSE '[]'::jsonb
                      END
                    ) artifact
                    WHERE artifact->>'job_id' = $2
                  )
                )
                """
            )
        if has_metadata:
            meta_select.append("m.metadata")
            clauses.append(
                """
                (
                  m.metadata->>'job_id' = $2 OR
                  EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(m.metadata->'artifacts') = 'array' THEN m.metadata->'artifacts'
                        ELSE '[]'::jsonb
                      END
                    ) artifact
                    WHERE artifact->>'job_id' = $2
                  )
                )
                """
            )
        if not clauses:
            return []

        meta_expr = "COALESCE(" + ", ".join(meta_select + ["'{}'::jsonb"]) + ") AS meta"
        type_clause = "AND c.type = $3" if conv_type else ""
        params = [user_id, job_id]
        if conv_type:
            params.append(conv_type)

        rows = await conn.fetch(
            f"""
            SELECT m.id::text, m.conversation_id::text, m.role, m.content,
                   {meta_expr}, m.created_at::text
            FROM conversation_messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = $1::uuid
              {type_clause}
              AND ({' OR '.join(clauses)})
            ORDER BY m.created_at ASC
            """,
            *params,
        )

        result = []
        for row in rows:
            d = dict(row)
            raw_meta = d.get("meta")
            if isinstance(raw_meta, str):
                try:
                    d["meta"] = json.loads(raw_meta)
                except Exception:
                    d["meta"] = {}
            elif not isinstance(raw_meta, dict):
                d["meta"] = {}
            result.append(d)
    return result


async def update_conversation_title(
    conversation_id: str,
    user_id: str,
    title: str,
) -> bool:
    """更新对话标题"""
    async with acquire() as conn:
        result = await conn.execute(
            """
            UPDATE conversations
            SET title = $1, updated_at = NOW()
            WHERE id = $2::uuid AND user_id = $3::uuid
            """,
            title, conversation_id, user_id,
        )
        success = result == "UPDATE 1"
    if success:
        await invalidate_user_history_cache(user_id)
    return success


def _asset_row_keys(asset: dict) -> set[str]:
    return {
        str(asset.get(field) or "").strip().lstrip("/")
        for field in ("original_key", "preview_key", "thumb_key")
        if str(asset.get(field) or "").strip()
    }


async def _load_message_asset_scope(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str | None = None,
) -> dict:
    has_meta, has_metadata = await _check_cols()
    meta_select = []
    if has_meta:
        meta_select.append("m.meta")
    if has_metadata:
        meta_select.append("m.metadata")
    meta_expr = "COALESCE(" + ", ".join(meta_select + ["'{}'::jsonb"]) + ") AS meta"
    message_clause = "AND m.id = $3::uuid" if message_id else ""
    params = [conversation_id, user_id]
    if message_id:
        params.append(message_id)

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT m.id::text, {meta_expr}
            FROM conversation_messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = $1::uuid
              AND c.user_id = $2::uuid
              {message_clause}
            """,
            *params,
        )

    message_ids: list[str] = []
    keys: set[str] = set()
    asset_ids: set[str] = set()
    file_asset_ids: set[str] = set()
    task_ids: set[str] = set()
    for row in rows:
        message_ids.append(row["id"])
        row_data = dict(row)
        refs = asset_lifecycle.collect_asset_references(
            history_artifacts.normalize_meta_value(row_data.get("meta"))
        )
        keys.update(refs.object_keys)
        asset_ids.update(refs.image_asset_ids)
        file_asset_ids.update(refs.file_asset_ids)
        task_ids.update(refs.task_ids)

    by_message = await image_asset_repo.list_assets_by_message_ids(message_ids, user_id)
    by_id = await image_asset_repo.list_assets_by_ids(sorted(asset_ids), user_id)
    by_task = await image_asset_repo.list_assets_by_task_ids(sorted(task_ids), user_id)
    by_conversation = (
        []
        if message_id
        else await image_asset_repo.list_assets_by_conversation_id(conversation_id, user_id)
    )
    assets_by_id = {
        asset["id"]: asset
        for asset in by_message + by_id + by_task + by_conversation
    }
    for asset in assets_by_id.values():
        keys.update(_asset_row_keys(asset))

    return {
        "message_ids": message_ids,
        "keys": keys,
        "asset_ids": set(assets_by_id.keys()),
        "direct_message_asset_ids": {str(asset["id"]) for asset in by_message},
        "file_asset_ids": file_asset_ids,
        "task_ids": task_ids,
    }


async def _cleanup_deleted_message_assets(
    scope: dict,
    user_id: str,
    cleanup_intent_id: str = "",
) -> dict:
    if cleanup_intent_id:
        return await asset_lifecycle.process_record_cleanup_intent(cleanup_intent_id)
    return await asset_lifecycle.release_record_assets(
        user_id=user_id,
        records=scope,
        reason="conversation-record-delete",
        ignore_conversation_links_for_image_ids=set(scope.get("direct_message_asset_ids") or []),
    )


async def delete_message(
    conversation_id: str,
    message_id: str,
    user_id: str,
) -> dict:
    """Delete a single message after verifying the parent conversation owner."""
    scope = await _load_message_asset_scope(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
    )
    cleanup_intent_id = ""
    async with acquire() as conn:
        async with conn.transaction():
            result = await conn.execute(
                """
                DELETE FROM conversation_messages m
                USING conversations c
                WHERE m.id = $1::uuid
                  AND m.conversation_id = $2::uuid
                  AND c.id = m.conversation_id
                  AND c.user_id = $3::uuid
                """,
                message_id,
                conversation_id,
                user_id,
            )
            if result == "DELETE 1":
                await conn.execute(
                    "UPDATE conversations SET updated_at = NOW() WHERE id = $1::uuid",
                    conversation_id,
                )
                cleanup_intent_id = await asset_lifecycle.stage_record_cleanup_intent(
                    conn,
                    user_id=user_id,
                    records=scope,
                    reason="conversation-record-delete",
                )
                deleted = True
            else:
                deleted = False
    if deleted:
        cleanup = await _cleanup_deleted_message_assets(scope, user_id, cleanup_intent_id)
        await ui_cache.bump_user_cache_version(user_id, "history", "storage")
        return {"success": True, "cleanup": cleanup}
    return {"success": False, "cleanup": {}}


async def delete_conversation(
    conversation_id: str,
    user_id: str,
) -> dict:
    """删除对话（级联删除消息）"""
    scope = await _load_message_asset_scope(
        user_id=user_id,
        conversation_id=conversation_id,
    )
    cleanup_intent_id = ""
    async with acquire() as conn:
        async with conn.transaction():
            result = await conn.execute(
                "DELETE FROM conversations WHERE id = $1::uuid AND user_id = $2::uuid",
                conversation_id, user_id,
            )
            if result == "DELETE 1":
                cleanup_intent_id = await asset_lifecycle.stage_record_cleanup_intent(
                    conn,
                    user_id=user_id,
                    records=scope,
                    reason="conversation-record-delete",
                )
    if result == "DELETE 1":
        cleanup = await _cleanup_deleted_message_assets(scope, user_id, cleanup_intent_id)
        await ui_cache.bump_user_cache_version(user_id, "history", "storage")
        return {"success": True, "cleanup": cleanup}
    return {"success": False, "cleanup": {}}
