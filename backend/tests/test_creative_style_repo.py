from pathlib import Path

import pytest

from repositories import creative_style_repo
from repositories.creative_style_repo import (
    deduplicate_style_catalog,
    normalize_style_module,
    normalize_style_payload,
    personal_recipe_fingerprint,
)
from services.creative_skill_resolver import CreativeSkillResolutionError


def test_style_payload_normalizes_module_tags_and_order():
    payload = normalize_style_payload({
        "name": "  电影叙事分镜  ",
        "module": "text_to_image",
        "prompt_template": "  先设计空间压力。  ",
        "tags": ["电影感", "分镜", "电影感", ""],
        "sort_order": 12,
    }, creating=True)

    assert payload["name"] == "电影叙事分镜"
    assert payload["module"] == "TEXT_TO_IMAGE"
    assert payload["prompt_template"] == "先设计空间压力。"
    assert payload["tags"] == ["电影感", "分镜"]
    assert payload["sort_order"] == 12


def test_style_payload_rejects_unsupported_module():
    with pytest.raises(ValueError, match="不支持的风格适用模块"):
        normalize_style_module("PPT_GEN")


def test_legacy_style_payload_gets_backward_compatible_protocol_defaults():
    payload = normalize_style_payload({
        "name": "旧风格",
        "module": "TEXT_TO_IMAGE",
        "prompt_template": "保留原有提示词。",
    }, creating=True)

    assert payload["schema_version"] == 1
    assert payload["execution_adapter"] == "prompt_append"
    assert payload["execution_instructions"] == ""
    assert payload["input_contract"] == {
        "prompt": {"required": True, "max_length": 4000},
        "images": {"min": 0, "max": 8, "roles": ["reference"]},
    }
    assert payload["constraints"] == {}
    assert payload["default_params"] == {}
    assert payload["show_in_gallery"] is False


def test_executable_style_payload_normalizes_json_protocol():
    payload = normalize_style_payload({
        "name": "参考图重绘",
        "module": "IMAGE_EDIT",
        "prompt_template": "",
        "schema_version": 2,
        "execution_adapter": "image_edit",
        "execution_instructions": "保留主体结构并改变材质。",
        "input_contract": '{"prompt":{"required":false},"images":{"min":1,"max":2,"roles":["source"]}}',
        "constraints": '{"user_overrides":["output_resolution"]}',
        "default_params": '{"output_resolution":"2k"}',
        "show_in_gallery": True,
    }, creating=True)

    assert payload["input_contract"]["prompt"] == {"required": False, "max_length": 4000}
    assert payload["input_contract"]["images"] == {"min": 1, "max": 2, "roles": ["source"]}
    assert payload["constraints"] == {"user_overrides": ["output_resolution"]}
    assert payload["default_params"] == {"output_resolution": "2k"}
    assert payload["show_in_gallery"] is True


def test_style_payload_rejects_unapproved_execution_adapter():
    with pytest.raises(CreativeSkillResolutionError) as caught:
        normalize_style_payload({
            "name": "危险执行器",
            "module": "TEXT_TO_IMAGE",
            "execution_adapter": "python",
            "execution_instructions": "执行任意代码。",
        }, creating=True)

    assert caught.value.code == "invalid_adapter"


def test_personal_recipe_fingerprint_ignores_name_preview_and_source_but_keeps_rules():
    base = {
        "module": "TEXT_TO_IMAGE",
        "prompt_template": "前景遮挡，中景行动，远景结果。",
        "style_hint": "避免霓虹",
        "execution_adapter": "prompt_append",
        "execution_instructions": "使用单一真实光源。",
        "input_contract": {"prompt": {"required": True}},
        "constraints": {},
        "default_params": {},
    }

    first = personal_recipe_fingerprint({
        **base, "name": "电影配方 A", "preview_url": "/a.webp", "source_url": "https://a.example",
    })
    renamed = personal_recipe_fingerprint({
        **base, "name": "电影配方 B", "preview_url": "/b.webp", "source_url": "https://b.example",
    })
    changed = personal_recipe_fingerprint({**base, "prompt_template": "居中对称构图。"})

    assert first == renamed
    assert first != changed


def test_catalog_deduplication_prefers_personal_recipe_for_equivalent_rules():
    shared = {
        "module": "TEXT_TO_IMAGE",
        "prompt_template": "单一窗光与前中后景。",
        "style_hint": "避免水印",
        "execution_adapter": "prompt_append",
        "execution_instructions": "",
        "input_contract": {},
        "constraints": {},
        "default_params": {},
    }
    items = deduplicate_style_catalog([
        {"id": "platform-1", "name": "平台电影风格", **shared},
        {"id": "personal-1", "name": "我的电影风格", "is_personal": True, **shared},
        {"id": "platform-2", "name": "纸艺拼贴", **shared, "prompt_template": "撕纸纤维与留白。"},
    ])

    assert [item["id"] for item in items] == ["personal-1", "platform-2"]


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _ExistingPersonalRecipeConnection:
    def __init__(self, existing):
        self.existing = existing
        self.lock_key = ""
        self.updated_name = ""

    def transaction(self):
        return _Transaction()

    async def fetchval(self, _sql, value):
        self.lock_key = value
        return None

    async def fetch(self, _sql, _user_id):
        return [self.existing]

    async def fetchrow(self, sql, *args):
        if sql.lstrip().startswith("UPDATE"):
            self.updated_name = str(args[2])
            return {**self.existing, "name": self.updated_name, "enabled": True}
        raise AssertionError("equivalent recipe must not insert a second row")


@pytest.mark.asyncio
async def test_personal_recipe_create_is_idempotent_under_user_advisory_lock(monkeypatch):
    analysis = {
        "name": "新的电影配方名",
        "visual_summary": "低饱和电影叙事。",
        "style_tags": ["电影感"],
        "composition": "前中后景。",
        "lighting": "单一窗光。",
        "palette": ["灰蓝"],
        "materials": "旧木。",
        "camera": "50mm。",
        "negative_prompt": "水印",
    }
    payload = creative_style_repo._personal_recipe_payload(analysis)
    existing = {
        "id": "personal-existing",
        "user_id": "user-1",
        **payload,
        "revision": 1,
        "is_personal": True,
        "created_at": "2026-08-10",
        "updated_at": "2026-08-10",
    }
    conn = _ExistingPersonalRecipeConnection(existing)
    monkeypatch.setattr(creative_style_repo, "acquire", lambda: _FakeAcquire(conn))

    item, created = await creative_style_repo.create_personal_style_recipe_idempotent(
        user_id="user-1",
        analysis=analysis,
    )

    assert created is False
    assert item["id"] == "personal-existing"
    assert item["name"] == "新的电影配方名"
    assert conn.lock_key == "personal-style:user-1"


def test_executable_creative_styles_migration_contains_protocol_and_backfill():
    migration = Path(__file__).resolve().parents[1] / "migrations" / "20260808_001_executable_creative_styles.sql"
    sql = migration.read_text(encoding="utf-8")

    for field in (
        "schema_version",
        "revision",
        "execution_adapter",
        "execution_instructions",
        "input_contract",
        "constraints",
        "default_params",
        "show_in_gallery",
    ):
        assert f"ADD COLUMN IF NOT EXISTS {field}" in sql

    assert "SET execution_instructions = prompt_template" in sql
    assert "idx_creative_style_presets_gallery" in sql


class _FakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _FakeStyleConnection:
    def __init__(self):
        self.sql = ""
        self.args = ()

    async def fetchrow(self, sql, *args):
        self.sql = sql
        self.args = args
        return {
            "id": str(args[0]),
            "input_contract": args[15] if len(args) > 15 else "{}",
            "constraints": args[16] if len(args) > 16 else args[1],
            "default_params": args[17] if len(args) > 17 else "{}",
            "revision": 2 if sql.lstrip().startswith("UPDATE") else 1,
        }


@pytest.mark.asyncio
async def test_create_style_serializes_protocol_json_for_postgres(monkeypatch):
    conn = _FakeStyleConnection()
    monkeypatch.setattr(creative_style_repo, "acquire", lambda: _FakeAcquire(conn))

    item = await creative_style_repo.create_style_preset({
        "name": "可执行技能",
        "module": "TEXT_TO_IMAGE",
        "prompt_template": "追加画面质感。",
        "default_params": {"output_resolution": "2k"},
    })

    assert "$16::jsonb,$17::jsonb,$18::jsonb" in conn.sql
    assert item["input_contract"]["prompt"]["required"] is True
    assert item["default_params"] == {"output_resolution": "2k"}


@pytest.mark.asyncio
async def test_update_style_serializes_json_and_increments_revision(monkeypatch):
    conn = _FakeStyleConnection()
    monkeypatch.setattr(creative_style_repo, "acquire", lambda: _FakeAcquire(conn))

    item = await creative_style_repo.update_style_preset(
        "style-1",
        {"constraints": {"user_overrides": ["size"]}},
    )

    assert "constraints = $2::jsonb" in conn.sql
    assert "revision = revision + 1" in conn.sql
    assert item is not None
    assert item["constraints"] == {"user_overrides": ["size"]}
