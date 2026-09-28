"""Validation and orchestration for creative gallery reactions."""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal, cast

from repositories import public_gallery_reaction_repo
from services.public_gallery_catalog import is_registered_static_item


Reaction = Literal["like", "favorite"]
VALID_REACTIONS = frozenset({"like", "favorite"})
MAX_QUERY_ITEMS = 200
_ITEM_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")


class GalleryReactionValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_item_key(value: object) -> str:
    item_key = str(value or "").strip()
    if not _ITEM_KEY_PATTERN.fullmatch(item_key):
        raise GalleryReactionValidationError(
            "invalid_item_id",
            "作品 ID 必须为 1 到 160 个 URL 安全字符",
        )
    try:
        return str(uuid.UUID(item_key))
    except ValueError:
        return item_key


def normalize_reaction(value: object) -> Reaction:
    reaction = str(value or "").strip().lower()
    if reaction not in VALID_REACTIONS:
        raise GalleryReactionValidationError(
            "invalid_reaction",
            "互动类型必须是点赞或收藏",
        )
    return cast(Reaction, reaction)


def _is_generation_key(item_key: str) -> bool:
    try:
        uuid.UUID(item_key)
        return True
    except ValueError:
        return False


def _serialize_state(state: dict[str, Any]) -> dict[str, Any]:
    item_key = str(state.get("item_key") or "")
    payload = {
        "id": item_key,
        "item_id": item_key,
        "likes": max(0, int(state.get("likes") or 0)),
        "favorites": max(0, int(state.get("favorites") or 0)),
        "liked": bool(state.get("liked")),
        "favorited": bool(state.get("favorited")),
    }
    if "active" in state:
        payload["active"] = bool(state.get("active"))
    if state.get("reaction") in VALID_REACTIONS:
        payload["reaction"] = state["reaction"]
    return payload


async def _interactable_item_keys(item_keys: list[str]) -> list[str]:
    generation_keys = [item_key for item_key in item_keys if _is_generation_key(item_key)]
    visible_generations = (
        await public_gallery_reaction_repo.list_interactable_generation_keys(generation_keys)
        if generation_keys
        else set()
    )
    return [
        item_key
        for item_key in item_keys
        if (
            item_key in visible_generations
            if _is_generation_key(item_key)
            else is_registered_static_item(item_key)
        )
    ]


async def get_reaction_states(
    *,
    user_id: str,
    item_ids: list[str],
) -> list[dict[str, Any]]:
    if len(item_ids) > MAX_QUERY_ITEMS:
        raise GalleryReactionValidationError(
            "too_many_items",
            f"一次最多查询 {MAX_QUERY_ITEMS} 个创作广场作品",
        )
    normalized = list(dict.fromkeys(normalize_item_key(item_id) for item_id in item_ids))
    interactable = await _interactable_item_keys(normalized)
    if not interactable:
        return []
    states = await public_gallery_reaction_repo.get_reaction_states(
        user_id=user_id,
        item_keys=interactable,
    )
    return [_serialize_state(state) for state in states]


async def toggle_reaction(
    *,
    user_id: str,
    item_id: str,
    reaction: str,
) -> dict[str, Any] | None:
    item_key = normalize_item_key(item_id)
    normalized_reaction = normalize_reaction(reaction)
    generation_id = item_key if _is_generation_key(item_key) else None
    if generation_id is None and not is_registered_static_item(item_key):
        return None
    state = await public_gallery_reaction_repo.toggle_reaction(
        user_id=user_id,
        item_key=item_key,
        reaction=normalized_reaction,
        generation_id=generation_id,
    )
    if state is None:
        return None
    return _serialize_state(state)


async def set_reaction(
    *,
    user_id: str,
    item_id: str,
    reaction: str,
    active: bool,
) -> dict[str, Any] | None:
    item_key = normalize_item_key(item_id)
    normalized_reaction = normalize_reaction(reaction)
    generation_id = item_key if _is_generation_key(item_key) else None
    if generation_id is None and not is_registered_static_item(item_key):
        return None
    state = await public_gallery_reaction_repo.set_reaction(
        user_id=user_id,
        item_key=item_key,
        reaction=normalized_reaction,
        active=bool(active),
        generation_id=generation_id,
    )
    if state is None:
        return None
    return _serialize_state(state)
