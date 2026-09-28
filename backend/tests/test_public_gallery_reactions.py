from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from repositories import public_gallery_reaction_repo
from repositories import public_gallery_repo
from routers import public_gallery
from routers.auth import get_current_user
from services import public_gallery_catalog
from services import public_gallery_reactions
from services.ppt_template_catalog import list_ppt_templates


USER_ID = "e2871beb-bcd3-47ad-ab77-1a3c0a145c84"
GENERATION_ID = "71dc77db-7400-4655-8b17-a254897fec66"


class _FakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


def _state(item_id: str, *, liked: bool = False, favorited: bool = False):
    return {
        "item_key": item_id,
        "likes": 1 if liked else 0,
        "favorites": 1 if favorited else 0,
        "liked": liked,
        "favorited": favorited,
    }


def test_normalize_item_key_accepts_curated_and_template_ids():
    assert public_gallery_reactions.normalize_item_key("gallery-canghe-501") == "gallery-canghe-501"
    assert public_gallery_reactions.normalize_item_key("ppt-template:corporate_modern") == "ppt-template:corporate_modern"
    assert public_gallery_reactions.normalize_item_key("meigen-hosted-001") == "meigen-hosted-001"


def test_server_registry_accepts_only_current_hosted_meigen_range():
    assert public_gallery_catalog.is_registered_static_item("meigen-hosted-001")
    assert public_gallery_catalog.is_registered_static_item("meigen-hosted-300")
    assert not public_gallery_catalog.is_registered_static_item("meigen-hosted-000")
    assert not public_gallery_catalog.is_registered_static_item("meigen-hosted-301")


@pytest.mark.asyncio
async def test_hosted_gallery_asset_serves_reviewed_artwork_without_worker_signing(monkeypatch):
    fetch_asset = AsyncMock(return_value=b"webp-bytes")
    monkeypatch.setattr(public_gallery.asset_storage, "fetch_asset_key_bytes", fetch_asset)

    response = await public_gallery.public_gallery_asset("meigen-001.webp")

    assert response.status_code == 200
    assert response.body == b"webp-bytes"
    assert response.media_type == "image/webp"
    assert response.headers["cache-control"] == "public, max-age=86400, stale-while-revalidate=604800"
    fetch_asset.assert_awaited_once_with("gallery/meigen-hosted/meigen-001.webp")


@pytest.mark.asyncio
async def test_hosted_gallery_asset_rejects_unknown_paths():
    with pytest.raises(HTTPException, match="公开素材不存在"):
        await public_gallery.public_gallery_asset("../private.webp")


@pytest.mark.parametrize(
    "item_id",
    ["", "../private", "item/with/slash", "contains space", "a" * 161],
)
def test_normalize_item_key_rejects_unsafe_values(item_id: str):
    with pytest.raises(public_gallery_reactions.GalleryReactionValidationError):
        public_gallery_reactions.normalize_item_key(item_id)


def test_server_registry_covers_every_frontend_curated_item():
    repo_root = Path(__file__).resolve().parents[2]
    expanded = (repo_root / "frontend/src/lib/public-gallery-expanded.ts").read_text(encoding="utf-8")
    presets = (repo_root / "frontend/src/lib/public-gallery-presets.ts").read_text(encoding="utf-8")
    hosted = (repo_root / "frontend/src/lib/public-gallery-meigen-hosted.ts").read_text(encoding="utf-8")
    item_ids = {
        *re.findall(r'"id":\s*"([^"]+)"', expanded),
        *re.findall(r'"id":\s*"([^"]+)"', hosted),
        *re.findall(r"\bid:\s*'([^']+)'", presets),
    }

    assert len(item_ids) >= 450
    assert not sorted(
        item_id
        for item_id in item_ids
        if not public_gallery_catalog.is_registered_static_item(item_id)
    )


def test_server_registry_accepts_current_ppt_template_catalog():
    template_ids = [template["id"] for template in list_ppt_templates()]

    assert template_ids
    assert all(
        public_gallery_catalog.is_registered_static_item(f"ppt-template:{template_id}")
        for template_id in template_ids
    )


@pytest.mark.asyncio
async def test_query_states_filters_hidden_uuid_but_keeps_curated_ids(monkeypatch):
    list_visible = AsyncMock(return_value=set())
    get_states = AsyncMock(return_value=[_state("gallery-canghe-501", favorited=True)])
    monkeypatch.setattr(public_gallery_reaction_repo, "list_interactable_generation_keys", list_visible)
    monkeypatch.setattr(public_gallery_reaction_repo, "get_reaction_states", get_states)

    items = await public_gallery_reactions.get_reaction_states(
        user_id=USER_ID,
        item_ids=["gallery-canghe-501", GENERATION_ID, "gallery-canghe-501"],
    )

    assert items == [{
        "id": "gallery-canghe-501",
        "item_id": "gallery-canghe-501",
        "likes": 0,
        "favorites": 1,
        "liked": False,
        "favorited": True,
    }]
    list_visible.assert_awaited_once_with([GENERATION_ID])
    get_states.assert_awaited_once_with(
        user_id=USER_ID,
        item_keys=["gallery-canghe-501"],
    )


@pytest.mark.asyncio
async def test_toggle_static_reaction_returns_aggregate_state(monkeypatch):
    toggle = AsyncMock(return_value={
        **_state("high-concept-cosmic-vortex", liked=True),
        "active": True,
        "reaction": "like",
    })
    monkeypatch.setattr(public_gallery_reaction_repo, "toggle_reaction", toggle)

    item = await public_gallery_reactions.toggle_reaction(
        user_id=USER_ID,
        item_id="high-concept-cosmic-vortex",
        reaction="like",
    )

    assert item["id"] == "high-concept-cosmic-vortex"
    assert item["liked"] is True
    assert item["likes"] == 1
    toggle.assert_awaited_once_with(
        user_id=USER_ID,
        item_key="high-concept-cosmic-vortex",
        reaction="like",
        generation_id=None,
    )


@pytest.mark.asyncio
async def test_toggle_uuid_requires_approved_public_generation(monkeypatch):
    toggle = AsyncMock(return_value=None)
    monkeypatch.setattr(public_gallery_reaction_repo, "toggle_reaction", toggle)

    item = await public_gallery_reactions.toggle_reaction(
        user_id=USER_ID,
        item_id=GENERATION_ID,
        reaction="favorite",
    )

    assert item is None
    toggle.assert_awaited_once_with(
        user_id=USER_ID,
        item_key=GENERATION_ID,
        reaction="favorite",
        generation_id=GENERATION_ID,
    )


@pytest.mark.asyncio
async def test_toggle_unknown_static_item_does_not_write(monkeypatch):
    toggle = AsyncMock()
    monkeypatch.setattr(public_gallery_reaction_repo, "toggle_reaction", toggle)

    item = await public_gallery_reactions.toggle_reaction(
        user_id=USER_ID,
        item_id="poster-does-not-exist",
        reaction="like",
    )

    assert item is None
    toggle.assert_not_awaited()


@pytest.mark.asyncio
async def test_repository_toggle_serializes_same_user_item_reaction(monkeypatch):
    conn = MagicMock()
    conn.transaction.return_value = _FakeTransaction()
    conn.execute = AsyncMock()
    conn.fetchrow = AsyncMock(side_effect=[None, {"item_key": "gallery-canghe-501"}])
    conn.fetch = AsyncMock(return_value=[_state("gallery-canghe-501", liked=True)])
    monkeypatch.setattr(public_gallery_reaction_repo, "acquire", lambda: _FakeAcquire(conn))

    item = await public_gallery_reaction_repo.toggle_reaction(
        user_id=USER_ID,
        item_key="gallery-canghe-501",
        reaction="like",
    )

    assert item["active"] is True
    lock_sql = conn.execute.await_args_list[0].args[0]
    assert "pg_advisory_xact_lock" in lock_sql
    insert_sql = conn.fetchrow.await_args_list[1].args[0]
    assert "ON CONFLICT (item_key, user_id, reaction) DO NOTHING" in insert_sql


@pytest.mark.asyncio
async def test_repository_checks_generation_visibility_inside_mutation_transaction(monkeypatch):
    conn = MagicMock()
    conn.transaction.return_value = _FakeTransaction()
    conn.execute = AsyncMock()
    conn.fetchval = AsyncMock(return_value=None)
    conn.fetchrow = AsyncMock()
    monkeypatch.setattr(public_gallery_reaction_repo, "acquire", lambda: _FakeAcquire(conn))

    item = await public_gallery_reaction_repo.toggle_reaction(
        user_id=USER_ID,
        item_key=GENERATION_ID,
        reaction="like",
        generation_id=GENERATION_ID,
    )

    assert item is None
    visibility_sql = conn.fetchval.await_args.args[0]
    assert "visibility = 'public'" in visibility_sql
    assert "moderation_status = 'approved'" in visibility_sql
    assert "FOR SHARE" in visibility_sql
    conn.fetchrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_repository_set_reaction_is_idempotent(monkeypatch):
    conn = MagicMock()
    conn.transaction.return_value = _FakeTransaction()
    conn.execute = AsyncMock(return_value="INSERT 0 0")
    conn.fetchval = AsyncMock(return_value=None)
    conn.fetch = AsyncMock(return_value=[_state("poster-night-run", favorited=True)])
    monkeypatch.setattr(public_gallery_reaction_repo, "acquire", lambda: _FakeAcquire(conn))

    item = await public_gallery_reaction_repo.set_reaction(
        user_id=USER_ID,
        item_key="poster-night-run",
        reaction="favorite",
        active=True,
    )

    assert item["active"] is True
    mutation_sql = conn.execute.await_args_list[0].args[0]
    assert "ON CONFLICT (item_key, user_id, reaction) DO NOTHING" in mutation_sql


@pytest.mark.asyncio
async def test_router_queries_and_toggles_static_items(monkeypatch):
    query = AsyncMock(return_value=[{
        "id": "science-organ-chip",
        "item_id": "science-organ-chip",
        "likes": 4,
        "favorites": 2,
        "liked": True,
        "favorited": False,
    }])
    toggle = AsyncMock(return_value={
        "id": "science-organ-chip",
        "item_id": "science-organ-chip",
        "likes": 5,
        "favorites": 2,
        "liked": True,
        "favorited": False,
        "active": True,
        "reaction": "like",
    })
    monkeypatch.setattr(public_gallery.public_gallery_reactions, "get_reaction_states", query)
    monkeypatch.setattr(public_gallery.public_gallery_reactions, "toggle_reaction", toggle)

    response = await public_gallery.query_public_gallery_reactions(
        body=public_gallery.GalleryReactionQueryBody(item_ids=["science-organ-chip"]),
        user={"id": USER_ID},
    )
    toggled = await public_gallery.toggle_public_gallery_like(
        item_id="science-organ-chip",
        user={"id": USER_ID},
    )

    assert response["items"][0]["liked"] is True
    assert toggled["item"]["likes"] == 5
    toggle.assert_awaited_once_with(
        user_id=USER_ID,
        item_id="science-organ-chip",
        reaction="like",
    )


@pytest.mark.asyncio
async def test_reaction_routes_require_authentication():
    app = FastAPI()
    app.include_router(public_gallery.router)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/public-gallery/reactions/query",
            json={"item_ids": ["science-organ-chip"]},
        )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_reaction_query_rejects_unsafe_item_id_before_database(monkeypatch):
    app = FastAPI()
    app.include_router(public_gallery.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": USER_ID}
    get_states = AsyncMock()
    monkeypatch.setattr(public_gallery_reaction_repo, "get_reaction_states", get_states)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/public-gallery/reactions/query",
            json={"item_ids": ["../private"]},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_item_id"
    get_states.assert_not_awaited()


@pytest.mark.asyncio
async def test_public_generation_feed_reads_unified_reactions(monkeypatch):
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=[])
    monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

    await public_gallery_repo.list_public_generations(user_id=USER_ID)

    sql = conn.fetch.await_args.args[0]
    assert "public_gallery_item_reactions" in sql
    assert "public_generation_reactions" not in sql


def test_gallery_reaction_migration_is_idempotent_and_concurrency_safe():
    migration = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "20260808_003_public_gallery_item_reactions.sql"
    )
    sql = migration.read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS public_gallery_item_reactions" in sql
    assert "PRIMARY KEY (item_key, user_id, reaction)" in sql
    assert "CHECK (reaction IN ('like', 'favorite'))" in sql
    assert "char_length(item_key) BETWEEN 1 AND 160" in sql
    assert "FROM public_generation_reactions" in sql
    assert "ON CONFLICT (item_key, user_id, reaction) DO NOTHING" in sql
    assert "LOCK TABLE public_generation_reactions IN SHARE ROW EXCLUSIVE MODE" in sql
    assert "CREATE OR REPLACE FUNCTION sync_legacy_public_gallery_reaction()" in sql
    assert "AFTER INSERT OR DELETE ON public_generation_reactions" in sql
    assert "trg_sync_legacy_public_gallery_reaction" in sql
    assert "AFTER DELETE ON public_generations" in sql
    assert "trg_delete_public_generation_gallery_reactions" in sql


def test_schema_audit_covers_reaction_key_constraint_primary_key_and_sync_function():
    from scripts import audit_db_schema

    checks = audit_db_schema.EXPECTED_CHECK_TOKENS["public_gallery_item_reactions"]
    assert "public_gallery_item_reactions_item_key_check" in checks
    assert "public_gallery_item_reactions_reaction_check" in checks
    assert "public_gallery_item_reactions_pkey" in audit_db_schema.EXPECTED_INDEXES
    assert "public_gallery_item_reactions_pkey" in audit_db_schema.EXPECTED_REQUIRED_INDEXES
    assert "sync_legacy_public_gallery_reaction" in audit_db_schema.EXPECTED_FUNCTIONS
    assert "delete_public_generation_gallery_reactions" in audit_db_schema.EXPECTED_FUNCTIONS
    assert (
        "public_generation_reactions",
        "trg_sync_legacy_public_gallery_reaction",
    ) in audit_db_schema.EXPECTED_TRIGGERS
    assert (
        "public_generations",
        "trg_delete_public_generation_gallery_reactions",
    ) in audit_db_schema.EXPECTED_TRIGGERS


def test_review_mutations_return_counts_from_unified_reaction_table():
    source = Path(public_gallery_repo.__file__).read_text(encoding="utf-8")

    assert source.count(
        "WHERE reaction_counts.item_key = public_generations.id::text"
    ) == 4


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.getenv("PIXELSCRIBE_RUN_DB_INTEGRATION") != "1",
    reason="set PIXELSCRIBE_RUN_DB_INTEGRATION=1 to run local PostgreSQL concurrency coverage",
)
async def test_postgres_reactions_are_unique_isolated_and_concurrency_safe(monkeypatch):
    import asyncpg

    from core.config import settings

    dsn = settings.DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlsplit(dsn)
    assert parsed.hostname in {"127.0.0.1", "localhost"}, "integration test refuses non-local databases"
    schema = f"gallery_reaction_test_{uuid4().hex}"
    setup = await asyncpg.connect(dsn)
    schema_created = False
    try:
        await setup.execute(f'CREATE SCHEMA "{schema}"')
        schema_created = True
        await setup.execute(
            f"""
            CREATE TABLE "{schema}".public_gallery_item_reactions (
                item_key TEXT NOT NULL,
                user_id UUID NOT NULL,
                reaction TEXT NOT NULL CHECK (reaction IN ('like', 'favorite')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (item_key, user_id, reaction)
            )
            """
        )

        @asynccontextmanager
        async def integration_acquire():
            conn = await asyncpg.connect(dsn)
            try:
                await conn.execute(f'SET search_path TO "{schema}"')
                yield conn
            finally:
                await conn.close()

        monkeypatch.setattr(public_gallery_reaction_repo, "acquire", integration_acquire)
        second_user = "2e88d407-9f79-489e-b95e-c37675490c37"
        same_user = await asyncio.gather(*(
            public_gallery_reaction_repo.set_reaction(
                user_id=USER_ID,
                item_key="poster-night-run",
                reaction="like",
                active=True,
            )
            for _ in range(2)
        ))
        assert all(item and item["active"] for item in same_user)

        await public_gallery_reaction_repo.set_reaction(
            user_id=second_user,
            item_key="poster-night-run",
            reaction="like",
            active=True,
        )
        first_user_state = await public_gallery_reaction_repo.get_reaction_states(
            user_id=USER_ID,
            item_keys=["poster-night-run"],
        )
        second_user_state = await public_gallery_reaction_repo.get_reaction_states(
            user_id=second_user,
            item_keys=["poster-night-run"],
        )
        assert first_user_state[0] == {
            "item_key": "poster-night-run",
            "likes": 2,
            "favorites": 0,
            "liked": True,
            "favorited": False,
        }
        assert second_user_state[0]["likes"] == 2
        assert second_user_state[0]["liked"] is True

        toggles = await asyncio.gather(*(
            public_gallery_reaction_repo.toggle_reaction(
                user_id=USER_ID,
                item_key="science-organ-chip",
                reaction="favorite",
            )
            for _ in range(2)
        ))
        assert sorted(bool(item and item["active"]) for item in toggles) == [False, True]
        final_state = await public_gallery_reaction_repo.get_reaction_states(
            user_id=USER_ID,
            item_keys=["science-organ-chip"],
        )
        assert final_state[0]["favorites"] == 0
        assert final_state[0]["favorited"] is False
    finally:
        try:
            if schema_created:
                await setup.execute(f'DROP SCHEMA "{schema}" CASCADE')
        finally:
            await setup.close()
