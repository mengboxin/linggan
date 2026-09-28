"""管理员配置的创作模块可复用风格配方。"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from uuid import uuid4

from core.pool import acquire
from services.creative_skill_resolver import normalize_skill_protocol_payload

STYLE_MODULES = frozenset({"TEXT_TO_IMAGE", "IMAGE_EDIT", "POSTER_GEN", "SCI_FIG"})
_STYLE_FIELDS = (
    "id, name, module, description, prompt_template, style_hint, tags, preview_url, "
    "source_name, source_url, enabled, sort_order, schema_version, revision, "
    "execution_adapter, execution_instructions, input_contract, constraints, "
    "default_params, show_in_gallery, created_at::text, updated_at::text"
)
_PERSONAL_STYLE_FIELDS = (
    "id, name, module, description, prompt_template, style_hint, tags, preview_url, "
    "source_name, source_url, enabled, sort_order, schema_version, revision, "
    "execution_adapter, execution_instructions, input_contract, constraints, "
    "default_params, show_in_gallery, TRUE AS is_personal, created_at::text, updated_at::text"
)
_MUTABLE_FIELDS = (
    "name", "module", "description", "prompt_template", "style_hint", "tags",
    "preview_url", "source_name", "source_url", "enabled", "sort_order",
    "schema_version", "execution_adapter", "execution_instructions", "input_contract",
    "constraints", "default_params", "show_in_gallery",
)
_JSON_FIELDS = frozenset({"input_contract", "constraints", "default_params"})


def normalize_style_module(module: str) -> str:
    normalized = str(module or "").strip().upper()
    if normalized not in STYLE_MODULES:
        raise ValueError("不支持的风格适用模块")
    return normalized


def _normalize_tags(value: object) -> list[str]:
    raw = value if isinstance(value, list) else str(value or "").split(",")
    return list(dict.fromkeys(str(tag).strip()[:40] for tag in raw if str(tag).strip()))[:8]


def normalize_style_payload(data: dict, *, creating: bool) -> dict:
    normalized = dict(data)
    if "module" in normalized:
        normalized["module"] = normalize_style_module(str(normalized["module"]))
    if "tags" in normalized:
        normalized["tags"] = _normalize_tags(normalized["tags"])
    for field in ("name", "description", "prompt_template", "style_hint", "preview_url", "source_name", "source_url"):
        if field in normalized and normalized[field] is not None:
            normalized[field] = str(normalized[field]).strip()
    if "sort_order" in normalized and normalized["sort_order"] is not None:
        normalized["sort_order"] = max(-9999, min(9999, int(normalized["sort_order"])))
    normalized.update(normalize_skill_protocol_payload(normalized, creating=creating))
    if creating:
        if not normalized.get("name"):
            raise ValueError("风格名称不能为空")
        if not normalized.get("prompt_template") and not normalized.get("execution_instructions"):
            raise ValueError("提示词骨架或执行说明至少填写一项")
        normalized["module"] = normalize_style_module(str(normalized.get("module") or ""))
    return normalized


def _row_to_style(row: object) -> dict:
    item = dict(row)  # type: ignore[arg-type]
    for field in _JSON_FIELDS:
        value = item.get(field)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = {}
        item[field] = dict(value) if isinstance(value, dict) else {}
    return item


def _database_value(field: str, value: object) -> object:
    if field in _JSON_FIELDS:
        return json.dumps(value or {}, ensure_ascii=False)
    return value


def _canonical_fingerprint_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            str(key): _canonical_fingerprint_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, list):
        normalized = [_canonical_fingerprint_value(item) for item in value]
        return sorted(normalized, key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True))
    if isinstance(value, str):
        return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip().casefold()
    return value


def personal_recipe_fingerprint(recipe: dict) -> str:
    """Fingerprint transferable rules, excluding display/source metadata."""
    protocol = {
        "module": recipe.get("module") or "TEXT_TO_IMAGE",
        "prompt_template": recipe.get("prompt_template") or "",
        "style_hint": recipe.get("style_hint") or "",
        "execution_adapter": recipe.get("execution_adapter") or "prompt_append",
        "execution_instructions": recipe.get("execution_instructions") or "",
        "input_contract": recipe.get("input_contract") or {},
        "constraints": recipe.get("constraints") or {},
        "default_params": recipe.get("default_params") or {},
    }
    encoded = json.dumps(
        _canonical_fingerprint_value(protocol),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def deduplicate_style_catalog(items: list[dict]) -> list[dict]:
    """Collapse equivalent visual systems while preferring a user's copy."""
    output: list[dict] = []
    positions: dict[str, int] = {}
    seen_ids: set[str] = set()
    for raw in items:
        item = dict(raw)
        item_id = str(item.get("id") or "")
        if item_id and item_id in seen_ids:
            continue
        if item_id:
            seen_ids.add(item_id)
        fingerprint = personal_recipe_fingerprint(item)
        position = positions.get(fingerprint)
        if position is None:
            positions[fingerprint] = len(output)
            output.append(item)
            continue
        if item.get("is_personal") and not output[position].get("is_personal"):
            output[position] = item
    return output


def _personal_recipe_payload(analysis: dict) -> dict:
    def text(field: str, limit: int) -> str:
        return str(analysis.get(field) or "").strip()[:limit]

    def values(field: str, limit: int) -> list[str]:
        raw = analysis.get(field)
        source = raw if isinstance(raw, list) else str(raw or "").split(",")
        return list(dict.fromkeys(str(value).strip()[:80] for value in source if str(value).strip()))[:limit]

    name = text("name", 80) or "我的灵感配方"
    visual_summary = text("visual_summary", 600)
    composition = text("composition", 500)
    lighting = text("lighting", 300)
    palette = values("palette", 8)
    materials = text("materials", 300)
    camera = text("camera", 300)
    negative_prompt = text("negative_prompt", 1200)
    execution_instructions = text("execution_instructions", 3000)
    tags = values("style_tags", 8)
    preview_url = text("preview_url", 500)
    if not (
        re.fullmatch(r"/api/assets/[A-Za-z0-9_-]{1,160}/preview", preview_url)
        or re.fullmatch(r"/creative-library/[A-Za-z0-9._/-]{1,300}", preview_url)
    ):
        preview_url = ""

    instruction_parts = [
        visual_summary,
        f"构图与视线：{composition}" if composition else "",
        f"光线：{lighting}" if lighting else "",
        f"色彩：{'、'.join(palette)}" if palette else "",
        f"材质与纹理：{materials}" if materials else "",
        f"镜头：{camera}" if camera else "",
    ]
    prompt_template = "\n".join(part for part in instruction_parts if part)
    if not prompt_template:
        raise ValueError("灵感配方内容不能为空")

    protocol = normalize_skill_protocol_payload({
        "schema_version": 1,
        "execution_adapter": "prompt_append",
        "execution_instructions": execution_instructions,
        "input_contract": {
            "prompt": {"required": True, "max_length": 4000},
            "images": {"min": 0, "max": 8, "roles": ["reference"]},
        },
        "constraints": {
            "user_overrides": ["output_resolution", "image_quality", "aspect_ratio"],
        },
        "default_params": {},
        "show_in_gallery": True,
    }, creating=True)
    return {
        "name": name,
        "module": "TEXT_TO_IMAGE",
        "description": visual_summary,
        "prompt_template": prompt_template,
        "style_hint": f"避免：{negative_prompt}" if negative_prompt else "",
        "tags": tags,
        "preview_url": preview_url,
        "source_name": text("source_name", 160) or "灵感反推",
        "source_url": text("source_url", 500),
        "enabled": True,
        "sort_order": 0,
        **protocol,
    }


async def list_style_presets(
    *,
    module: str | None = None,
    enabled_only: bool = False,
    gallery_only: bool = False,
) -> list[dict]:
    conditions: list[str] = []
    args: list[object] = []
    if module:
        args.append(normalize_style_module(module))
        conditions.append(f"module = ${len(args)}")
    if enabled_only:
        conditions.append("enabled = TRUE")
    if gallery_only:
        conditions.append("show_in_gallery = TRUE")
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    async with acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_STYLE_FIELDS} FROM creative_style_presets {where} "
            "ORDER BY sort_order ASC, created_at ASC",
            *args,
        )
    return [_row_to_style(row) for row in rows]


async def create_style_preset(data: dict) -> dict:
    payload = normalize_style_payload(data, creating=True)
    style_id = str(payload.get("id") or f"style-{uuid4()}")
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"""
            INSERT INTO creative_style_presets (
                id, name, module, description, prompt_template, style_hint, tags,
                preview_url, source_name, source_url, enabled, sort_order,
                schema_version, execution_adapter, execution_instructions,
                input_contract, constraints, default_params, show_in_gallery
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                $16::jsonb,$17::jsonb,$18::jsonb,$19
            )
            RETURNING {_STYLE_FIELDS}
            """,
            style_id, payload["name"], payload["module"], payload.get("description", ""),
            payload.get("prompt_template", ""), payload.get("style_hint", ""), payload.get("tags", []),
            payload.get("preview_url", ""), payload.get("source_name", ""), payload.get("source_url", ""),
            bool(payload.get("enabled", True)), payload.get("sort_order", 0),
            payload["schema_version"], payload["execution_adapter"], payload["execution_instructions"],
            _database_value("input_contract", payload["input_contract"]),
            _database_value("constraints", payload["constraints"]),
            _database_value("default_params", payload["default_params"]),
            payload["show_in_gallery"],
        )
    return _row_to_style(row)


async def update_style_preset(style_id: str, data: dict) -> dict | None:
    payload = normalize_style_payload({key: value for key, value in data.items() if key in _MUTABLE_FIELDS}, creating=False)
    if not payload:
        return await get_style_preset(style_id)
    assignments: list[str] = []
    args: list[object] = [style_id]
    for field in _MUTABLE_FIELDS:
        if field not in payload:
            continue
        args.append(_database_value(field, payload[field]))
        cast = "::jsonb" if field in _JSON_FIELDS else ""
        assignments.append(f"{field} = ${len(args)}{cast}")
    assignments.append("revision = revision + 1")
    assignments.append("updated_at = NOW()")
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE creative_style_presets SET {', '.join(assignments)} WHERE id = $1 "
            f"RETURNING {_STYLE_FIELDS}",
            *args,
        )
    return _row_to_style(row) if row else None


async def get_style_preset(style_id: str) -> dict | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_STYLE_FIELDS} FROM creative_style_presets WHERE id = $1",
            style_id,
        )
    return _row_to_style(row) if row else None


async def delete_style_preset(style_id: str) -> bool:
    async with acquire() as conn:
        result = await conn.execute("DELETE FROM creative_style_presets WHERE id = $1", style_id)
    return result == "DELETE 1"


async def create_personal_style_recipe_idempotent(*, user_id: str, analysis: dict) -> tuple[dict, bool]:
    payload = _personal_recipe_payload(analysis)
    fingerprint = personal_recipe_fingerprint(payload)
    async with acquire() as conn:
        async with conn.transaction():
            await conn.fetchval(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                f"personal-style:{user_id}",
            )
            rows = await conn.fetch(
                f"SELECT {_PERSONAL_STYLE_FIELDS} FROM user_creative_style_recipes WHERE user_id = $1",
                user_id,
            )
            for raw in rows:
                existing = _row_to_style(raw)
                if personal_recipe_fingerprint(existing) != fingerprint:
                    continue
                row = await conn.fetchrow(
                    f"""
                    UPDATE user_creative_style_recipes
                    SET name = $3,
                        preview_url = CASE WHEN $4 <> '' THEN $4 ELSE preview_url END,
                        source_name = CASE WHEN $5 <> '' THEN $5 ELSE source_name END,
                        source_url = CASE WHEN $6 <> '' THEN $6 ELSE source_url END,
                        enabled = TRUE,
                        updated_at = NOW()
                    WHERE id = $1 AND user_id = $2
                    RETURNING {_PERSONAL_STYLE_FIELDS}
                    """,
                    existing["id"], user_id, payload["name"], payload["preview_url"],
                    payload["source_name"], payload["source_url"],
                )
                return _row_to_style(row), False

            style_id = f"personal-{uuid4()}"
            row = await conn.fetchrow(
                f"""
                INSERT INTO user_creative_style_recipes (
                    id, user_id, name, module, description, prompt_template, style_hint, tags,
                    preview_url, source_name, source_url, enabled, sort_order,
                    schema_version, execution_adapter, execution_instructions,
                    input_contract, constraints, default_params, show_in_gallery
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                    $17::jsonb,$18::jsonb,$19::jsonb,$20
                )
                RETURNING {_PERSONAL_STYLE_FIELDS}
                """,
                style_id, user_id, payload["name"], payload["module"], payload["description"],
                payload["prompt_template"], payload["style_hint"], payload["tags"],
                payload["preview_url"], payload["source_name"], payload["source_url"],
                payload["enabled"], payload["sort_order"], payload["schema_version"],
                payload["execution_adapter"], payload["execution_instructions"],
                _database_value("input_contract", payload["input_contract"]),
                _database_value("constraints", payload["constraints"]),
                _database_value("default_params", payload["default_params"]),
                payload["show_in_gallery"],
            )
    return _row_to_style(row), True


async def create_personal_style_recipe(*, user_id: str, analysis: dict) -> dict:
    item, _created = await create_personal_style_recipe_idempotent(
        user_id=user_id,
        analysis=analysis,
    )
    return item


async def list_personal_style_recipes(*, user_id: str, module: str | None = None) -> list[dict]:
    conditions = ["user_id = $1", "enabled = TRUE"]
    args: list[object] = [user_id]
    if module:
        args.append(normalize_style_module(module))
        conditions.append(f"module = ${len(args)}")
    async with acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_PERSONAL_STYLE_FIELDS} FROM user_creative_style_recipes "
            f"WHERE {' AND '.join(conditions)} ORDER BY created_at DESC",
            *args,
        )
    return [_row_to_style(row) for row in rows]


async def get_personal_style_recipe(*, user_id: str, style_id: str) -> dict | None:
    async with acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_PERSONAL_STYLE_FIELDS} FROM user_creative_style_recipes "
            "WHERE user_id = $1 AND id = $2 AND enabled = TRUE",
            user_id,
            style_id,
        )
    return _row_to_style(row) if row else None
