"""Public image gallery repository.

Public generation is a two-step flow:
1. A user opts in while generating; completed images are submitted as pending.
2. An admin approves/rejects; only approved public items enter the gallery and
   only approval can grant reward credits.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Literal

from core.pool import acquire
from repositories import notification_repo, public_gallery_reaction_repo

Reaction = Literal["like", "favorite"]

PUBLIC_REWARD_CREDITS_PER_ITEM = 1.0
PUBLIC_REWARD_CREDITS_PER_IMAGE = PUBLIC_REWARD_CREDITS_PER_ITEM
PUBLIC_REWARD_DAILY_CAP = 30.0
PUBLIC_REWARD_SETTINGS_KEY = "public_gallery_reward"
VALID_PUBLIC_MODULES = {"TEXT_TO_IMAGE", "POSTER_GEN", "IMAGE_EDIT", "SCI_FIG", "PPT_GEN"}
VISIBLE_PUBLIC_GALLERY_MODULES = {"TEXT_TO_IMAGE", "POSTER_GEN", "SCI_FIG", "PPT_GEN"}
VALID_PUBLIC_VISIBILITIES = {"public", "hidden"}
VALID_PUBLIC_MODERATION_STATUSES = {"pending", "approved", "rejected"}


ADMIN_PUBLIC_GENERATION_COLUMNS = """
    pg.id::text,
    pg.user_id::text,
    pg.task_id::text,
    pg.source_task_id,
    pg.variant_index,
    pg.asset_id,
    pg.asset_fingerprint,
    pg.image_url,
    pg.preview_url,
    pg.thumbnail_url,
    pg.title,
    pg.subtitle,
    pg.prompt,
    pg.final_prompt,
    pg.prompt_hash,
    pg.module,
    pg.source,
    pg.tags,
    pg.meta,
    pg.visibility,
    pg.moderation_status,
    pg.reviewed_at::text,
    pg.reviewed_by,
    pg.rejection_reason,
    pg.reward_granted,
    pg.reward_credits::float8,
    (
        SELECT COUNT(*)::int
        FROM public_gallery_item_reactions reaction_counts
        WHERE reaction_counts.item_key = pg.id::text
          AND reaction_counts.reaction = 'like'
    ) AS likes,
    (
        SELECT COUNT(*)::int
        FROM public_gallery_item_reactions reaction_counts
        WHERE reaction_counts.item_key = pg.id::text
          AND reaction_counts.reaction = 'favorite'
    ) AS favorites,
    pg.created_at::text,
    pg.updated_at::text,
    u.email AS user_email,
    COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1), '公开用户') AS author
"""


def _coerce_non_negative_float(value: Any, fallback: float) -> float:
    try:
        return max(0.0, round(float(value), 2))
    except Exception:
        return max(0.0, round(float(fallback), 2))


def _normalize_public_reward_settings(value: Any) -> dict[str, float | str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = {}
    if not isinstance(value, dict):
        value = {}
    per_item = value.get("per_item", value.get("per_image", PUBLIC_REWARD_CREDITS_PER_ITEM))
    daily_cap = value.get("daily_cap", PUBLIC_REWARD_DAILY_CAP)
    return {
        "per_item": _coerce_non_negative_float(per_item, PUBLIC_REWARD_CREDITS_PER_ITEM),
        "daily_cap": _coerce_non_negative_float(daily_cap, PUBLIC_REWARD_DAILY_CAP),
        "unit": "platform_credits",
    }


async def _ensure_system_settings(conn) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )


async def _get_public_reward_settings_with_conn(conn) -> dict[str, float | str]:
    await _ensure_system_settings(conn)
    row = await conn.fetchrow(
        "SELECT value FROM system_settings WHERE key = $1",
        PUBLIC_REWARD_SETTINGS_KEY,
    )
    return _normalize_public_reward_settings(row["value"] if row else None)


async def get_public_reward_settings() -> dict[str, float | str]:
    async with acquire() as conn:
        return await _get_public_reward_settings_with_conn(conn)


async def update_public_reward_settings(*, per_item: float, daily_cap: float) -> dict[str, float | str]:
    settings = _normalize_public_reward_settings({"per_item": per_item, "daily_cap": daily_cap})
    async with acquire() as conn:
        await _ensure_system_settings(conn)
        value_type = await conn.fetchval(
            """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_name = 'system_settings' AND column_name = 'value'
            """
        )
        value_json = json.dumps(settings, ensure_ascii=False)
        value_expr = "$2::jsonb" if value_type == "jsonb" else "$2"
        await conn.execute(
            f"""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, {value_expr}, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            PUBLIC_REWARD_SETTINGS_KEY,
            value_json,
        )
    return settings


def _first_string(value: dict[str, Any], *keys: str) -> str:
    for key in keys:
        raw = value.get(key)
        if raw:
            return str(raw)
    return ""


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = str(value or "").strip()
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


def _asset_variant_url(asset_id: str | None, variant: str = "original") -> str:
    clean = str(asset_id or "").strip()
    return f"/api/assets/{clean}/{variant}" if clean else ""


def _strings_from_gallery_items(value: Any, *, prefer_original: bool = True) -> list[str]:
    if not isinstance(value, list):
        return []
    images: list[str] = []
    image_keys = (
        (
            "image_url",
            "imageUrl",
            "image",
            "url",
            "src",
            "preview_url",
            "previewUrl",
            "thumbnail_url",
            "thumbnailUrl",
            "preview_b64",
            "image_b64",
            "svg_b64",
        )
        if prefer_original else
        (
            "image",
            "url",
            "src",
            "thumbnail_url",
            "thumbnailUrl",
            "preview_url",
            "previewUrl",
            "image_url",
            "imageUrl",
            "preview_b64",
            "image_b64",
            "svg_b64",
        )
    )
    for item in value:
        if isinstance(item, str):
            images.append(item)
        elif isinstance(item, dict):
            images.append(_first_string(item, *image_keys))
    return _unique_strings(images)


def _slides_from_gallery_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    slides: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if isinstance(item, str):
            image = item
            slide: dict[str, Any] = {}
        elif isinstance(item, dict):
            image = _first_string(
                item,
                "image",
                "url",
                "src",
                "image_url",
                "preview_url",
                "thumbnail_url",
                "imageUrl",
                "previewUrl",
                "thumbnailUrl",
                "preview_b64",
                "image_b64",
                "svg_b64",
            )
            slide = dict(item)
        else:
            continue
        if not image:
            continue
        slide["image"] = image
        slide["page_index"] = int(slide.get("page_index") or slide.get("page") or index + 1)
        slides.append(slide)
    return slides


def _gallery_page_count(meta: dict[str, Any], images: list[str], fallback: int = 1) -> int:
    for key in ("page_count", "pageCount", "slide_count", "slideCount", "slide_total", "slideTotal"):
        try:
            count = int(meta.get(key) or 0)
            if count > 0:
                return count
        except Exception:
            continue
    return max(fallback, len(images), 1)


def _normalize_public_generation_payload(row: Any) -> dict[str, Any]:
    payload = dict(row)
    meta = _coerce_meta(payload.get("meta"))
    payload["meta"] = meta
    meta_slides = _slides_from_gallery_items(meta.get("slides"))
    module = str(payload.get("module") or "")
    asset_original = _asset_variant_url(payload.get("asset_id"), "original")
    asset_preview = _asset_variant_url(payload.get("asset_id"), "preview")
    asset_thumb = _asset_variant_url(payload.get("asset_id"), "thumb")
    if module == "PPT_GEN":
        images = _unique_strings([
            *[str(slide.get("image") or "") for slide in meta_slides],
            *_strings_from_gallery_items(meta.get("images"), prefer_original=True),
            *_strings_from_gallery_items(meta.get("preview_images"), prefer_original=True),
            *_strings_from_gallery_items(meta.get("previewImages"), prefer_original=True),
            str(payload.get("image_url") or ""),
            str(payload.get("preview_url") or ""),
            str(payload.get("thumbnail_url") or ""),
            asset_original,
            asset_preview,
            asset_thumb,
        ])
    else:
        gallery_candidates = _unique_strings([
            str(payload.get("image_url") or ""),
            *_strings_from_gallery_items(meta.get("images"), prefer_original=True),
            *_strings_from_gallery_items(meta.get("preview_images"), prefer_original=True),
            *_strings_from_gallery_items(meta.get("previewImages"), prefer_original=True),
            *[str(slide.get("image") or "") for slide in meta_slides[:1]],
        ])
        asset_variants = {asset_original, asset_preview, asset_thumb}
        non_asset_candidates = [src for src in gallery_candidates if src and src not in asset_variants]
        images = _unique_strings([
            *non_asset_candidates,
            asset_original,
            str(payload.get("preview_url") or ""),
            asset_preview,
            str(payload.get("thumbnail_url") or ""),
            asset_thumb,
        ])[:1]
    slides = meta_slides
    if not slides and module == "PPT_GEN":
        slides = [{"image": image, "page_index": index + 1} for index, image in enumerate(images)]
    if images:
        payload["images"] = images
    if slides:
        payload["slides"] = slides
    if module == "PPT_GEN":
        payload["page_count"] = _gallery_page_count(meta, images)
    else:
        payload["page_count"] = 1
    return payload


def _image_items(result: dict[str, Any]) -> list[dict[str, Any]]:
    raw_images = result.get("images")
    if isinstance(raw_images, list) and raw_images:
        return [item for item in raw_images if isinstance(item, dict)]
    return [result] if result else []


def _normalize_prompt(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_module(value: str) -> str:
    return value if value in VALID_PUBLIC_MODULES else "TEXT_TO_IMAGE"


def _normalize_visibility(value: str) -> str:
    return value if value in VALID_PUBLIC_VISIBILITIES else "public"


def _normalize_moderation_status(value: str) -> str:
    return value if value in VALID_PUBLIC_MODERATION_STATUSES else "pending"


def _normalize_tags(value: list[str] | tuple[str, ...] | None) -> list[str]:
    if not value:
        return []
    tags: list[str] = []
    for item in value:
        tag = str(item or "").strip()
        if tag and tag not in tags:
            tags.append(tag[:30])
    return tags[:12]


def _coerce_meta(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return dict(parsed) if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _is_uuid(value: str | None) -> bool:
    if not value:
        return False
    try:
        uuid.UUID(str(value))
        return True
    except Exception:
        return False


async def _resolve_existing_task_uuid(conn, task_id: str | None) -> str | None:
    """Return task_id only when it is a real tasks.id foreign-key target."""
    if not _is_uuid(task_id):
        return None
    row = await conn.fetchval(
        "SELECT id::text FROM tasks WHERE id = $1::uuid",
        str(task_id),
    )
    return str(row) if row else None


def _asset_fingerprint(item: dict[str, Any], result: dict[str, Any]) -> str:
    asset_id = _first_string(item, "assetId", "asset_id") or _first_string(result, "assetId", "asset_id")
    if asset_id:
        return f"asset:{asset_id}"
    image_source = (
        _first_string(item, "imageUrl", "image_url", "previewUrl", "preview_url", "thumbnailUrl", "thumbnail_url", "renderedUrl", "renderedB64")
        or _first_string(result, "imageUrl", "image_url", "previewUrl", "preview_url", "thumbnailUrl", "thumbnail_url", "renderedUrl", "renderedB64")
    )
    if image_source:
        return f"image:{_sha256(image_source)}"
    return ""


def _title_from_prompt(prompt: str) -> str:
    normalized = " ".join((prompt or "").split())
    return normalized[:36] or "公开作品"


def _public_tags(module: str) -> list[str]:
    if module == "POSTER_GEN":
        module_label = "海报"
    elif module == "PPT_GEN":
        module_label = "PPT"
    elif module == "IMAGE_EDIT":
        module_label = "工作流"
    elif module == "SCI_FIG":
        module_label = "科研"
    else:
        module_label = "文生图"
    return ["公开作品", "同款提示词", module_label]


async def _clear_balance_cache(user_id: str):
    try:
        from core.redis import get_redis

        await get_redis().delete(f"balance:{user_id}")
    except Exception:
        pass


async def publish_generation_result(
    *,
    user_id: str,
    task_id: str | None = None,
    source_task_id: str = "",
    prompt: str,
    module: str,
    source: str,
    result: dict[str, Any],
    reward_per_image: float = PUBLIC_REWARD_CREDITS_PER_IMAGE,
) -> dict[str, float | int]:
    """Submit completed public image results for moderation.

    This function intentionally does not approve or reward. Rewards are granted
    only by ``review_public_generation(..., action="approve")``.
    """
    images = _image_items(result)
    if not images:
        return {"submitted_count": 0, "published_count": 0, "skipped_count": 0, "reward_credits": 0.0}

    final_prompt = str(result.get("final_prompt") or prompt or "")
    canonical_prompt = prompt or final_prompt
    title = _title_from_prompt(canonical_prompt)
    output_resolution = str(result.get("output_resolution") or "")
    image_quality = str(result.get("image_quality") or "")
    model_id = str(result.get("model_id") or "")
    size = str(result.get("output_size") or result.get("size") or "")
    normalized_module = _normalize_module(module)
    tags = _public_tags(normalized_module)
    prompt_hash = _sha256(_normalize_prompt(final_prompt or canonical_prompt)) if (final_prompt or canonical_prompt) else ""
    source_task_key = (source_task_id or task_id or "").strip()
    meta = {
        "source": source,
        "size": size,
        "model_id": model_id,
        "final_prompt": final_prompt,
        "image_quality": image_quality,
        "output_resolution": output_resolution,
        "reward_per_image": max(0.0, float(reward_per_image or PUBLIC_REWARD_CREDITS_PER_IMAGE)),
    }

    inserted_count = 0
    skipped_count = 0
    async with acquire() as conn:
        task_uuid = await _resolve_existing_task_uuid(conn, task_id)
        async with conn.transaction():
            for index, item in enumerate(images):
                try:
                    variant_index = int(item.get("variantIndex") if item.get("variantIndex") is not None else item.get("variant_index"))
                except Exception:
                    variant_index = index
                asset_id = _first_string(item, "assetId", "asset_id") or _first_string(result, "assetId", "asset_id")
                image_url = _first_string(item, "imageUrl", "image_url", "renderedUrl") or _first_string(result, "imageUrl", "image_url", "renderedUrl")
                preview_url = _first_string(item, "previewUrl", "preview_url") or _first_string(result, "previewUrl", "preview_url")
                thumbnail_url = _first_string(item, "thumbnailUrl", "thumbnail_url") or _first_string(result, "thumbnailUrl", "thumbnail_url")
                item_prompt = _first_string(item, "final_prompt", "prompt", "userPrompt") or final_prompt or canonical_prompt
                fingerprint = _asset_fingerprint(item, result)
                item_prompt_hash = _sha256(_normalize_prompt(item_prompt)) if item_prompt else prompt_hash
                if not (asset_id or image_url or preview_url or thumbnail_url):
                    skipped_count += 1
                    continue

                inserted_id = await conn.fetchval(
                    """
                    INSERT INTO public_generations (
                        user_id, task_id, source_task_id, variant_index,
                        asset_id, asset_fingerprint,
                        image_url, preview_url, thumbnail_url,
                        title, subtitle, prompt, final_prompt, prompt_hash,
                        module, source, tags, meta,
                        visibility, moderation_status, reward_granted, reward_credits
                    )
                    VALUES (
                        $1::uuid, $2::uuid, $3, $4,
                        $5, $6,
                        $7, $8, $9,
                        $10, $11, $12, $13, $14,
                        $15, $16, $17::text[], $18::jsonb,
                        'public', 'pending', FALSE, 0
                    )
                    ON CONFLICT DO NOTHING
                    RETURNING id::text
                    """,
                    user_id,
                    task_uuid,
                    source_task_key,
                    variant_index,
                    asset_id,
                    fingerprint,
                    image_url,
                    preview_url,
                    thumbnail_url,
                    title,
                    "公开创作作品",
                    canonical_prompt or item_prompt,
                    item_prompt,
                    item_prompt_hash,
                    normalized_module,
                    source,
                    tags,
                    json.dumps(meta, ensure_ascii=False),
                )
                if inserted_id:
                    inserted_count += 1
                else:
                    skipped_count += 1

    return {
        "submitted_count": inserted_count,
        "published_count": inserted_count,
        "skipped_count": skipped_count,
        "reward_credits": 0.0,
    }


async def submit_existing_generation(
    *,
    user_id: str,
    prompt: str,
    module: str = "TEXT_TO_IMAGE",
    source: str = "history_manual",
    task_id: str | None = None,
    source_task_id: str = "",
    variant_index: int = 0,
    asset_id: str = "",
    image_url: str = "",
    preview_url: str = "",
    thumbnail_url: str = "",
    final_prompt: str = "",
    title: str = "",
    subtitle: str = "",
    tags: list[str] | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Submit an already-generated history asset for moderation."""
    canonical_prompt = (prompt or final_prompt or "").strip()
    if not canonical_prompt:
        return None
    normalized_module = _normalize_module(module)
    clean_asset_id = (asset_id or "").strip()
    clean_image_url = (image_url or "").strip()
    clean_preview_url = (preview_url or "").strip()
    clean_thumbnail_url = (thumbnail_url or "").strip()
    if clean_asset_id:
        clean_image_url = clean_image_url or f"/api/assets/{clean_asset_id}/original"
        clean_preview_url = clean_preview_url or f"/api/assets/{clean_asset_id}/preview"
        clean_thumbnail_url = clean_thumbnail_url or f"/api/assets/{clean_asset_id}/thumb"
    if not (clean_asset_id or clean_image_url or clean_preview_url or clean_thumbnail_url):
        return None

    source_task_key = (source_task_id or task_id or "").strip()
    item = {
        "assetId": clean_asset_id,
        "imageUrl": clean_image_url,
        "previewUrl": clean_preview_url,
        "thumbnailUrl": clean_thumbnail_url,
    }
    result = {
        "assetId": clean_asset_id,
        "imageUrl": clean_image_url,
        "previewUrl": clean_preview_url,
        "thumbnailUrl": clean_thumbnail_url,
    }
    asset_fingerprint = _asset_fingerprint(item, result)
    prompt_hash = _sha256(_normalize_prompt(final_prompt or canonical_prompt))
    public_tags = (_normalize_tags(tags) or _public_tags(normalized_module))[:8]
    safe_meta = {
        **(meta or {}),
        "source": source,
        "manual_submit": True,
        "final_prompt": final_prompt or canonical_prompt,
    }

    async with acquire() as conn:
        task_uuid = await _resolve_existing_task_uuid(conn, task_id)
        row = await conn.fetchrow(
            """
            INSERT INTO public_generations (
                user_id, task_id, source_task_id, variant_index,
                asset_id, asset_fingerprint,
                image_url, preview_url, thumbnail_url,
                title, subtitle, prompt, final_prompt, prompt_hash,
                module, source, tags, meta,
                visibility, moderation_status, reward_granted, reward_credits
            )
            VALUES (
                $1::uuid, $2::uuid, $3, $4,
                $5, $6,
                $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17::text[], $18::jsonb,
                'public', 'pending', FALSE, 0
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text, visibility, moderation_status, created_at::text
            """,
            user_id,
            task_uuid,
            source_task_key,
            int(variant_index or 0),
            clean_asset_id,
            asset_fingerprint,
            clean_image_url,
            clean_preview_url,
            clean_thumbnail_url,
            title.strip() or _title_from_prompt(canonical_prompt),
            subtitle.strip() or "公开创作作品",
            canonical_prompt,
            final_prompt or canonical_prompt,
            prompt_hash,
            normalized_module,
            source,
            public_tags,
            json.dumps(safe_meta, ensure_ascii=False),
        )
        if row:
            payload = dict(row)
            payload["duplicate"] = False
            return payload

        existing = await conn.fetchrow(
            """
            SELECT id::text, visibility, moderation_status, created_at::text
            FROM public_generations
            WHERE user_id = $1::uuid
              AND (
                ($2 <> '' AND asset_fingerprint = $2)
                OR ($3 <> '' AND source_task_id = $3)
                OR ($4 <> '' AND prompt_hash = $4 AND asset_fingerprint = $2)
              )
            ORDER BY created_at DESC
            LIMIT 1
            """,
            user_id,
            asset_fingerprint,
            source_task_key,
            prompt_hash,
        )
    if not existing:
        return None
    payload = dict(existing)
    payload["duplicate"] = True
    return payload


async def list_public_generations(
    *,
    limit: int = 80,
    offset: int = 0,
    user_id: str | None = None,
    module: str = "all",
    reaction: str = "all",
    owner_only: bool = False,
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 80), 120))
    safe_offset = max(0, int(offset or 0))
    if module != "all" and module not in VISIBLE_PUBLIC_GALLERY_MODULES:
        return []
    safe_module = module if module in VISIBLE_PUBLIC_GALLERY_MODULES else "all"
    safe_reaction = reaction if reaction in {"like", "favorite"} else "all"
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                pg.id::text,
                pg.user_id::text,
                pg.task_id::text,
                pg.source_task_id,
                pg.asset_id,
                pg.image_url,
                pg.preview_url,
                pg.thumbnail_url,
                pg.title,
                pg.subtitle,
                pg.prompt,
                pg.final_prompt,
                pg.module,
                pg.source,
                pg.tags,
                pg.meta,
                (
                    SELECT COUNT(*)::int
                    FROM public_gallery_item_reactions reaction_counts
                    WHERE reaction_counts.item_key = pg.id::text
                      AND reaction_counts.reaction = 'like'
                ) AS likes,
                (
                    SELECT COUNT(*)::int
                    FROM public_gallery_item_reactions reaction_counts
                    WHERE reaction_counts.item_key = pg.id::text
                      AND reaction_counts.reaction = 'favorite'
                ) AS favorites,
                pg.created_at::text,
                COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1), '公开用户') AS author,
                ($3::uuid IS NOT NULL AND pg.user_id = $3::uuid) AS is_owner,
                EXISTS (
                    SELECT 1 FROM public_gallery_item_reactions r
                    WHERE r.item_key = pg.id::text AND r.user_id = $3::uuid AND r.reaction = 'like'
                ) AS liked,
                EXISTS (
                    SELECT 1 FROM public_gallery_item_reactions r
                    WHERE r.item_key = pg.id::text AND r.user_id = $3::uuid AND r.reaction = 'favorite'
                ) AS favorited
            FROM public_generations pg
            LEFT JOIN users u ON u.id = pg.user_id
            WHERE pg.visibility = 'public'
              AND pg.moderation_status = 'approved'
              AND pg.module = ANY($6::text[])
              AND ($4 = 'all' OR pg.module = $4)
              AND ($7::bool = FALSE OR ($3::uuid IS NOT NULL AND pg.user_id = $3::uuid))
              AND (
                $5 = 'all'
                OR EXISTS (
                    SELECT 1 FROM public_gallery_item_reactions rf
                    WHERE rf.item_key = pg.id::text
                      AND rf.user_id = $3::uuid
                      AND rf.reaction = $5
                )
              )
            ORDER BY pg.created_at DESC, pg.id DESC
            LIMIT $1 OFFSET $2
            """,
            safe_limit,
            safe_offset,
            user_id,
            safe_module,
            safe_reaction,
            sorted(VISIBLE_PUBLIC_GALLERY_MODULES),
            bool(owner_only),
        )
    return [_normalize_public_generation_payload(row) for row in rows]


async def withdraw_public_generation(*, user_id: str, generation_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE public_generations
            SET visibility = 'hidden', updated_at = NOW()
            WHERE id = $1::uuid AND user_id = $2::uuid
            RETURNING id::text, visibility, moderation_status
            """,
            generation_id,
            user_id,
        )
    return dict(row) if row else None


async def toggle_reaction(*, user_id: str, generation_id: str, reaction: Reaction) -> dict[str, Any] | None:
    """Backward-compatible reaction entry point for database-backed works."""
    if reaction not in {"like", "favorite"}:
        raise ValueError("reaction must be like or favorite")
    state = await public_gallery_reaction_repo.toggle_reaction(
        user_id=user_id,
        item_key=generation_id,
        reaction=reaction,
        generation_id=generation_id,
    )
    if state is None:
        return None
    payload = dict(state)
    payload["id"] = payload.pop("item_key", generation_id)
    return payload


async def list_admin_review_items(
    *,
    status: str = "pending",
    module: str = "all",
    visibility: str = "all",
    q: str = "",
    limit: int = 80,
    offset: int = 0,
) -> list[dict[str, Any]]:
    safe_status = status if status in {"pending", "approved", "rejected", "all"} else "pending"
    safe_module = module if module in VALID_PUBLIC_MODULES else "all"
    safe_visibility = visibility if visibility in VALID_PUBLIC_VISIBILITIES else "all"
    safe_q = (q or "").strip()[:120]
    safe_limit = max(1, min(int(limit or 80), 200))
    safe_offset = max(0, int(offset or 0))
    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                {ADMIN_PUBLIC_GENERATION_COLUMNS}
            FROM public_generations pg
            LEFT JOIN users u ON u.id = pg.user_id
            WHERE ($3 = 'all' OR pg.moderation_status = $3)
              AND ($4 = 'all' OR pg.module = $4)
              AND ($5 = 'all' OR pg.visibility = $5)
              AND (
                $6 = ''
                OR pg.title ILIKE '%' || $6 || '%'
                OR pg.subtitle ILIKE '%' || $6 || '%'
                OR pg.prompt ILIKE '%' || $6 || '%'
                OR pg.final_prompt ILIKE '%' || $6 || '%'
                OR pg.source_task_id ILIKE '%' || $6 || '%'
                OR pg.asset_id ILIKE '%' || $6 || '%'
                OR u.email ILIKE '%' || $6 || '%'
              )
            ORDER BY pg.created_at DESC, pg.id DESC
            LIMIT $1 OFFSET $2
            """,
            safe_limit,
            safe_offset,
            safe_status,
            safe_module,
            safe_visibility,
            safe_q,
        )
    return [_normalize_public_generation_payload(row) for row in rows]


async def _get_admin_public_generation_with_conn(conn, generation_id: str) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        f"""
        SELECT
            {ADMIN_PUBLIC_GENERATION_COLUMNS}
        FROM public_generations pg
        LEFT JOIN users u ON u.id = pg.user_id
        WHERE pg.id = $1::uuid
        """,
        generation_id,
    )
    return dict(row) if row else None


async def _resolve_gallery_owner_user_id(conn, *, user_id: str = "", user_email: str = "") -> str | None:
    clean_user_id = (user_id or "").strip()
    if _is_uuid(clean_user_id):
        row = await conn.fetchval("SELECT id::text FROM users WHERE id = $1::uuid", clean_user_id)
        if row:
            return str(row)
    clean_email = (user_email or "").strip()
    if clean_email:
        row = await conn.fetchval(
            """
            SELECT id::text
            FROM users
            WHERE LOWER(email) = LOWER($1)
            ORDER BY created_at DESC
            LIMIT 1
            """,
            clean_email,
        )
        if row:
            return str(row)
    return None


async def admin_create_public_generation(
    *,
    user_id: str = "",
    user_email: str = "",
    task_id: str | None = None,
    source_task_id: str = "",
    variant_index: int = 0,
    asset_id: str = "",
    image_url: str = "",
    preview_url: str = "",
    thumbnail_url: str = "",
    title: str = "",
    subtitle: str = "",
    prompt: str = "",
    final_prompt: str = "",
    module: str = "TEXT_TO_IMAGE",
    source: str = "admin_manual",
    tags: list[str] | None = None,
    meta: dict[str, Any] | None = None,
    visibility: str = "public",
    moderation_status: str = "approved",
) -> dict[str, Any] | None:
    canonical_prompt = (prompt or final_prompt or "").strip()
    if not canonical_prompt:
        raise ValueError("prompt_required")

    clean_asset_id = (asset_id or "").strip()
    clean_image_url = (image_url or "").strip()
    clean_preview_url = (preview_url or "").strip()
    clean_thumbnail_url = (thumbnail_url or "").strip()
    if clean_asset_id:
        clean_image_url = clean_image_url or f"/api/assets/{clean_asset_id}/original"
        clean_preview_url = clean_preview_url or f"/api/assets/{clean_asset_id}/preview"
        clean_thumbnail_url = clean_thumbnail_url or f"/api/assets/{clean_asset_id}/thumb"
    if not (clean_asset_id or clean_image_url or clean_preview_url or clean_thumbnail_url):
        raise ValueError("image_required")

    normalized_module = _normalize_module(module)
    normalized_visibility = _normalize_visibility(visibility)
    normalized_status = _normalize_moderation_status(moderation_status)
    public_tags = (_normalize_tags(tags) or _public_tags(normalized_module))[:8]
    safe_meta = {
        **_coerce_meta(meta),
        "source": source or "admin_manual",
        "admin_manual": True,
    }
    item = {
        "assetId": clean_asset_id,
        "imageUrl": clean_image_url,
        "previewUrl": clean_preview_url,
        "thumbnailUrl": clean_thumbnail_url,
    }
    result = dict(item)
    asset_fingerprint = _asset_fingerprint(item, result)
    prompt_hash = _sha256(_normalize_prompt(final_prompt or canonical_prompt))
    source_task_key = (source_task_id or task_id or "").strip()

    async with acquire() as conn:
        owner_user_id = await _resolve_gallery_owner_user_id(conn, user_id=user_id, user_email=user_email)
        if not owner_user_id:
            raise ValueError("owner_required")
        task_uuid = await _resolve_existing_task_uuid(conn, task_id)
        inserted_id = await conn.fetchval(
            """
            INSERT INTO public_generations (
                user_id, task_id, source_task_id, variant_index,
                asset_id, asset_fingerprint,
                image_url, preview_url, thumbnail_url,
                title, subtitle, prompt, final_prompt, prompt_hash,
                module, source, tags, meta,
                visibility, moderation_status, reviewed_at, reviewed_by,
                rejection_reason, reward_granted, reward_credits
            )
            VALUES (
                $1::uuid, $2::uuid, $3, $4,
                $5, $6,
                $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17::text[], $18::jsonb,
                $19, $20,
                CASE WHEN $20 = 'approved' OR $20 = 'rejected' THEN NOW() ELSE NULL END,
                CASE WHEN $20 = 'approved' OR $20 = 'rejected' THEN 'admin' ELSE '' END,
                '',
                FALSE, 0
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text
            """,
            owner_user_id,
            task_uuid,
            source_task_key,
            int(variant_index or 0),
            clean_asset_id,
            asset_fingerprint,
            clean_image_url,
            clean_preview_url,
            clean_thumbnail_url,
            title.strip() or _title_from_prompt(canonical_prompt),
            subtitle.strip() or "管理员精选作品",
            canonical_prompt,
            final_prompt or canonical_prompt,
            prompt_hash,
            normalized_module,
            source or "admin_manual",
            public_tags,
            json.dumps(safe_meta, ensure_ascii=False),
            normalized_visibility,
            normalized_status,
        )
        if not inserted_id:
            return None
        return await _get_admin_public_generation_with_conn(conn, inserted_id)


async def admin_update_public_generation(
    *,
    generation_id: str,
    title: str | None = None,
    subtitle: str | None = None,
    prompt: str | None = None,
    final_prompt: str | None = None,
    module: str | None = None,
    source: str | None = None,
    tags: list[str] | None = None,
    asset_id: str | None = None,
    image_url: str | None = None,
    preview_url: str | None = None,
    thumbnail_url: str | None = None,
    visibility: str | None = None,
    moderation_status: str | None = None,
    rejection_reason: str | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    async with acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchrow(
                """
                SELECT *
                FROM public_generations
                WHERE id = $1::uuid
                FOR UPDATE
                """,
                generation_id,
            )
            if not existing:
                return None

            next_prompt = (prompt if prompt is not None else existing["prompt"]) or ""
            next_final_prompt = (final_prompt if final_prompt is not None else existing["final_prompt"]) or ""
            canonical_prompt = (next_prompt or next_final_prompt or "").strip()
            if not canonical_prompt:
                raise ValueError("prompt_required")

            next_asset_id = ((asset_id if asset_id is not None else existing["asset_id"]) or "").strip()
            next_image_url = ((image_url if image_url is not None else existing["image_url"]) or "").strip()
            next_preview_url = ((preview_url if preview_url is not None else existing["preview_url"]) or "").strip()
            next_thumbnail_url = ((thumbnail_url if thumbnail_url is not None else existing["thumbnail_url"]) or "").strip()
            if next_asset_id:
                next_image_url = next_image_url or f"/api/assets/{next_asset_id}/original"
                next_preview_url = next_preview_url or f"/api/assets/{next_asset_id}/preview"
                next_thumbnail_url = next_thumbnail_url or f"/api/assets/{next_asset_id}/thumb"
            if not (next_asset_id or next_image_url or next_preview_url or next_thumbnail_url):
                raise ValueError("image_required")

            normalized_module = _normalize_module(module if module is not None else existing["module"])
            normalized_visibility = _normalize_visibility(visibility if visibility is not None else existing["visibility"])
            normalized_status = _normalize_moderation_status(
                moderation_status if moderation_status is not None else existing["moderation_status"]
            )
            next_tags = _normalize_tags(tags) if tags is not None else list(existing["tags"] or [])
            next_meta = _coerce_meta(meta) if meta is not None else _coerce_meta(existing["meta"])
            next_meta["admin_edited"] = True
            item = {
                "assetId": next_asset_id,
                "imageUrl": next_image_url,
                "previewUrl": next_preview_url,
                "thumbnailUrl": next_thumbnail_url,
            }
            result = dict(item)
            next_asset_fingerprint = _asset_fingerprint(item, result)
            next_prompt_hash = _sha256(_normalize_prompt(next_final_prompt or canonical_prompt))

            await conn.execute(
                """
                UPDATE public_generations
                SET
                    asset_id = $2,
                    asset_fingerprint = $3,
                    image_url = $4,
                    preview_url = $5,
                    thumbnail_url = $6,
                    title = $7,
                    subtitle = $8,
                    prompt = $9,
                    final_prompt = $10,
                    prompt_hash = $11,
                    module = $12,
                    source = $13,
                    tags = $14::text[],
                    meta = $15::jsonb,
                    visibility = $16,
                    moderation_status = $17,
                    rejection_reason = $18,
                    updated_at = NOW()
                WHERE id = $1::uuid
                """,
                generation_id,
                next_asset_id,
                next_asset_fingerprint,
                next_image_url,
                next_preview_url,
                next_thumbnail_url,
                (title if title is not None else existing["title"] or "").strip() or _title_from_prompt(canonical_prompt),
                (subtitle if subtitle is not None else existing["subtitle"] or "").strip(),
                canonical_prompt,
                next_final_prompt or canonical_prompt,
                next_prompt_hash,
                normalized_module,
                (source if source is not None else existing["source"] or "").strip(),
                next_tags,
                json.dumps(next_meta, ensure_ascii=False),
                normalized_visibility,
                normalized_status,
                (rejection_reason if rejection_reason is not None else existing["rejection_reason"] or "").strip(),
            )
            return await _get_admin_public_generation_with_conn(conn, generation_id)


async def admin_set_public_generation_visibility(
    *,
    generation_id: str,
    visibility: Literal["public", "hidden"],
) -> dict[str, Any] | None:
    normalized_visibility = _normalize_visibility(visibility)
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE public_generations
            SET visibility = $2, updated_at = NOW()
            WHERE id = $1::uuid
            """,
            generation_id,
            normalized_visibility,
        )
        return await _get_admin_public_generation_with_conn(conn, generation_id)


async def admin_soft_delete_public_generation(*, generation_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE public_generations
            SET visibility = 'hidden',
                rejection_reason = COALESCE(NULLIF(rejection_reason, ''), '管理员已从创作广场移除'),
                updated_at = NOW()
            WHERE id = $1::uuid
            """,
            generation_id,
        )
        return await _get_admin_public_generation_with_conn(conn, generation_id)


async def admin_reset_public_generation_review(*, generation_id: str) -> dict[str, Any] | None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE public_generations
            SET moderation_status = 'pending',
                reviewed_at = NULL,
                reviewed_by = '',
                rejection_reason = '',
                updated_at = NOW()
            WHERE id = $1::uuid
            """,
            generation_id,
        )
        return await _get_admin_public_generation_with_conn(conn, generation_id)


async def review_public_generation(
    *,
    generation_id: str,
    action: Literal["approve", "reject"],
    reviewer: str = "admin",
    reason: str = "",
    reward_credits_override: float | None = None,
) -> dict[str, Any] | None:
    if action not in {"approve", "reject"}:
        raise ValueError("action must be approve or reject")

    should_clear_user_id = ""
    notification_payload: dict[str, Any] | None = None
    row = None
    async with acquire() as conn:
        async with conn.transaction():
            item = await conn.fetchrow(
                """
                SELECT id, user_id::text, task_id::text, moderation_status, title,
                       reward_granted, reward_credits::float8
                FROM public_generations
                WHERE id = $1::uuid
                FOR UPDATE
                """,
                generation_id,
            )
            if not item:
                return None

            user_id = item["user_id"]
            previous_status = str(item["moderation_status"] or "")
            display_title = str(item["title"] or "公开作品")
            reward_granted = bool(item["reward_granted"])
            reward_credits = float(item["reward_credits"] or 0)
            granted_now = 0.0
            reward_settings = await _get_public_reward_settings_with_conn(conn)
            reward_per_item = (
                _coerce_non_negative_float(reward_credits_override, 0.0)
                if reward_credits_override is not None
                else float(reward_settings["per_item"] or 0)
            )
            daily_cap = float(reward_settings["daily_cap"] or 0)

            if action == "reject":
                row = await conn.fetchrow(
                    """
                    UPDATE public_generations
                    SET moderation_status = 'rejected',
                        visibility = 'hidden',
                        reviewed_at = NOW(),
                        reviewed_by = $2,
                        rejection_reason = $3,
                        updated_at = NOW()
                    WHERE id = $1::uuid
                    RETURNING id::text, moderation_status, visibility, reviewed_at::text,
                              reviewed_by, rejection_reason, reward_granted,
                              reward_credits::float8,
                              (
                                  SELECT COUNT(*)::int
                                  FROM public_gallery_item_reactions reaction_counts
                                  WHERE reaction_counts.item_key = public_generations.id::text
                                    AND reaction_counts.reaction = 'like'
                              ) AS likes,
                              (
                                  SELECT COUNT(*)::int
                                  FROM public_gallery_item_reactions reaction_counts
                                  WHERE reaction_counts.item_key = public_generations.id::text
                                    AND reaction_counts.reaction = 'favorite'
                              ) AS favorites
                    """,
                    generation_id,
                    reviewer,
                    reason.strip(),
                )
                if row and previous_status != "rejected":
                    notification_payload = {
                        "user_id": user_id,
                        "type": "gallery_review",
                        "title": "作品审核未通过",
                        "body": reason.strip() or "你的作品未通过创作广场审核，可调整内容质量或提示词后重新提交。",
                        "action_url": "/gallery",
                        "meta": {
                            "generation_id": generation_id,
                            "moderation_status": "rejected",
                            "reward_credits": 0,
                        },
                    }
            else:
                if not reward_granted:
                    used_today = await conn.fetchval(
                        """
                        SELECT COALESCE(SUM(reward_credits), 0)::float8
                        FROM public_generations
                        WHERE user_id = $1::uuid
                          AND reward_granted = TRUE
                          AND reviewed_at IS NOT NULL
                          AND (reviewed_at AT TIME ZONE 'Asia/Shanghai')::date =
                              (NOW() AT TIME ZONE 'Asia/Shanghai')::date
                        """,
                        user_id,
                    )
                    remaining = max(0.0, daily_cap - float(used_today or 0))
                    granted_now = round(min(reward_per_item, remaining), 2)
                    reward_credits = granted_now

                    if granted_now > 0:
                        balance_row = await conn.fetchrow(
                            """
                            UPDATE users SET credits = credits + $1, updated_at = NOW()
                            WHERE id = $2::uuid
                            RETURNING credits
                            """,
                            granted_now,
                            user_id,
                        )
                        balance_after = float(balance_row["credits"]) if balance_row else 0.0
                        await conn.execute(
                            """
                            INSERT INTO credit_transactions
                                (user_id, amount, balance_after, type, related_task_id, description)
                            VALUES ($1::uuid, $2, $3, 'gift', $4::uuid, $5)
                            """,
                            user_id,
                            granted_now,
                            balance_after,
                            item["task_id"],
                            "公开作品审核通过奖励（平台积分）",
                        )
                        should_clear_user_id = user_id

                row = await conn.fetchrow(
                    """
                    UPDATE public_generations
                    SET moderation_status = 'approved',
                        visibility = 'public',
                        reviewed_at = NOW(),
                        reviewed_by = $2,
                        rejection_reason = '',
                        reward_granted = TRUE,
                        reward_credits = $3,
                        updated_at = NOW()
                    WHERE id = $1::uuid
                    RETURNING id::text, moderation_status, visibility, reviewed_at::text,
                              reviewed_by, rejection_reason, reward_granted,
                              reward_credits::float8,
                              (
                                  SELECT COUNT(*)::int
                                  FROM public_gallery_item_reactions reaction_counts
                                  WHERE reaction_counts.item_key = public_generations.id::text
                                    AND reaction_counts.reaction = 'like'
                              ) AS likes,
                              (
                                  SELECT COUNT(*)::int
                                  FROM public_gallery_item_reactions reaction_counts
                                  WHERE reaction_counts.item_key = public_generations.id::text
                                    AND reaction_counts.reaction = 'favorite'
                              ) AS favorites
                    """,
                    generation_id,
                    reviewer,
                    reward_credits,
                )
                if row and previous_status != "approved":
                    if granted_now > 0:
                        body = f"你的作品「{display_title}」已通过审核，{granted_now:g} 平台生图积分已到账。"
                    elif not reward_granted and daily_cap > 0 and reward_per_item > 0:
                        body = f"你的作品「{display_title}」已通过审核；今日公开奖励已达上限，本次不再额外发放积分。"
                    else:
                        body = f"你的作品「{display_title}」已通过审核，已展示到创作广场。"
                    notification_payload = {
                        "user_id": user_id,
                        "type": "gallery_review",
                        "title": "作品审核通过",
                        "body": body,
                        "action_url": "/gallery",
                        "meta": {
                            "generation_id": generation_id,
                            "moderation_status": "approved",
                            "reward_credits": granted_now,
                            "reward_total": reward_credits,
                        },
                    }

    if should_clear_user_id:
        await _clear_balance_cache(should_clear_user_id)
    if notification_payload:
        try:
            await notification_repo.create_notification(**notification_payload)
        except Exception:
            pass
    return dict(row) if row else None
