"""Persistence for reactions on database and curated gallery items."""
from __future__ import annotations

from typing import Any, Literal

from core.pool import acquire


Reaction = Literal["like", "favorite"]


async def _fetch_reaction_states(
    conn,
    *,
    user_id: str,
    item_keys: list[str],
) -> list[dict[str, Any]]:
    if not item_keys:
        return []
    rows = await conn.fetch(
        """
        WITH requested AS (
            SELECT item_key, ordinal
            FROM unnest($1::text[]) WITH ORDINALITY AS input(item_key, ordinal)
        )
        SELECT
            requested.item_key,
            (COUNT(reactions.item_key) FILTER (
                WHERE reactions.reaction = 'like'
            ))::int AS likes,
            (COUNT(reactions.item_key) FILTER (
                WHERE reactions.reaction = 'favorite'
            ))::int AS favorites,
            COALESCE(BOOL_OR(
                reactions.user_id = $2::uuid AND reactions.reaction = 'like'
            ), FALSE) AS liked,
            COALESCE(BOOL_OR(
                reactions.user_id = $2::uuid AND reactions.reaction = 'favorite'
            ), FALSE) AS favorited
        FROM requested
        LEFT JOIN public_gallery_item_reactions reactions
          ON reactions.item_key = requested.item_key
        GROUP BY requested.item_key
        ORDER BY MIN(requested.ordinal)
        """,
        item_keys,
        user_id,
    )
    return [dict(row) for row in rows]


async def get_reaction_states(
    *,
    user_id: str,
    item_keys: list[str],
) -> list[dict[str, Any]]:
    async with acquire() as conn:
        return await _fetch_reaction_states(
            conn,
            user_id=user_id,
            item_keys=item_keys,
        )


async def _lock_interactable_generation(conn, generation_id: str) -> bool:
    row = await conn.fetchval(
        """
        SELECT id::text
        FROM public_generations
        WHERE id = $1::uuid
          AND visibility = 'public'
          AND moderation_status = 'approved'
        FOR SHARE
        """,
        generation_id,
    )
    return bool(row)


async def list_interactable_generation_keys(generation_ids: list[str]) -> set[str]:
    if not generation_ids:
        return set()
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text
            FROM public_generations
            WHERE id = ANY($1::uuid[])
              AND visibility = 'public'
              AND moderation_status = 'approved'
            """,
            generation_ids,
        )
    return {str(row["id"]) for row in rows}


def _advisory_lock_key(*, user_id: str, item_key: str, reaction: Reaction) -> str:
    return f"public-gallery-reaction:{user_id}:{item_key}:{reaction}"


async def toggle_reaction(
    *,
    user_id: str,
    item_key: str,
    reaction: Reaction,
    generation_id: str | None = None,
) -> dict[str, Any] | None:
    """Toggle one relation while serializing concurrent requests for that relation."""
    async with acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                _advisory_lock_key(
                    user_id=user_id,
                    item_key=item_key,
                    reaction=reaction,
                ),
            )
            if generation_id and not await _lock_interactable_generation(conn, generation_id):
                return None
            deleted = await conn.fetchrow(
                """
                DELETE FROM public_gallery_item_reactions
                WHERE item_key = $1 AND user_id = $2::uuid AND reaction = $3
                RETURNING item_key
                """,
                item_key,
                user_id,
                reaction,
            )
            if not deleted:
                await conn.fetchrow(
                    """
                    INSERT INTO public_gallery_item_reactions (item_key, user_id, reaction)
                    VALUES ($1, $2::uuid, $3)
                    ON CONFLICT (item_key, user_id, reaction) DO NOTHING
                    RETURNING item_key
                    """,
                    item_key,
                    user_id,
                    reaction,
                )
            states = await _fetch_reaction_states(
                conn,
                user_id=user_id,
                item_keys=[item_key],
            )
    state = states[0] if states else {
        "item_key": item_key,
        "likes": 0,
        "favorites": 0,
        "liked": False,
        "favorited": False,
    }
    active = bool(state["liked"] if reaction == "like" else state["favorited"])
    return {**state, "active": active, "reaction": reaction}


async def set_reaction(
    *,
    user_id: str,
    item_key: str,
    reaction: Reaction,
    active: bool,
    generation_id: str | None = None,
) -> dict[str, Any] | None:
    """Idempotently set one reaction to the requested state."""
    async with acquire() as conn:
        async with conn.transaction():
            await conn.fetchval(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                _advisory_lock_key(
                    user_id=user_id,
                    item_key=item_key,
                    reaction=reaction,
                ),
            )
            if generation_id and not await _lock_interactable_generation(conn, generation_id):
                return None
            if active:
                await conn.execute(
                    """
                    INSERT INTO public_gallery_item_reactions (item_key, user_id, reaction)
                    VALUES ($1, $2::uuid, $3)
                    ON CONFLICT (item_key, user_id, reaction) DO NOTHING
                    """,
                    item_key,
                    user_id,
                    reaction,
                )
            else:
                await conn.execute(
                    """
                    DELETE FROM public_gallery_item_reactions
                    WHERE item_key = $1 AND user_id = $2::uuid AND reaction = $3
                    """,
                    item_key,
                    user_id,
                    reaction,
                )
            states = await _fetch_reaction_states(
                conn,
                user_id=user_id,
                item_keys=[item_key],
            )
    state = states[0] if states else {
        "item_key": item_key,
        "likes": 0,
        "favorites": 0,
        "liked": False,
        "favorited": False,
    }
    persisted_active = bool(state["liked"] if reaction == "like" else state["favorited"])
    return {**state, "active": persisted_active, "reaction": reaction}
