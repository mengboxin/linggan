import asyncio
from unittest.mock import AsyncMock, MagicMock

from repositories import public_gallery_repo


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


def test_submit_existing_generation_keeps_empty_asset_id_when_url_is_publishable(monkeypatch):
    async def _run():
        conn = MagicMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": "public-1",
            "visibility": "public",
            "moderation_status": "pending",
            "created_at": "2026-07-18T09:22:44+00:00",
        })
        monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

        item = await public_gallery_repo.submit_existing_generation(
            user_id="e2871beb-bcd3-47ad-ab77-1a3c0a145c84",
            module="PPT_GEN",
            prompt="像素印记产品答辩 PPT",
            final_prompt="像素印记产品答辩 PPT",
            title="像素印记产品答辩 PPT",
            source="ppt_history_manual",
            source_task_id="48bdcd56-827b-4d71-924f-4492622e2345",
            asset_id="",
            image_url="https://image.example.com/users/deck/slide-1.png",
            preview_url="https://image.example.com/users/deck/slide-1.png",
            thumbnail_url="https://image.example.com/users/deck/slide-1.png",
        )

        assert item is not None
        sql = conn.fetchrow.await_args.args[0]
        args = conn.fetchrow.await_args.args[1:]
        assert "NULLIF($5" not in sql
        assert args[4] == ""

    asyncio.run(_run())


def test_list_public_generations_exposes_ppt_meta_as_multi_page_images(monkeypatch):
    async def _run():
        conn = MagicMock()
        conn.fetch = AsyncMock(return_value=[{
            "id": "public-ppt",
            "user_id": "e2871beb-bcd3-47ad-ab77-1a3c0a145c84",
            "task_id": None,
            "source_task_id": "ppt-job-1",
            "asset_id": "",
            "image_url": "https://image.example.com/slide-1.png",
            "preview_url": "https://image.example.com/slide-1.png",
            "thumbnail_url": "https://image.example.com/slide-1.png",
            "title": "PPT",
            "subtitle": "PPT 多页作品 · 共 3 页",
            "prompt": "PPT prompt",
            "final_prompt": "PPT prompt",
            "module": "PPT_GEN",
            "source": "ppt_history_manual",
            "tags": ["PPT"],
            "meta": {
                "page_count": 3,
                "slides": [
                    {"image": "https://image.example.com/slide-1.png", "title": "1"},
                    {"image_url": "https://image.example.com/slide-2.png", "title": "2"},
                    {"url": "https://image.example.com/slide-3.png", "title": "3"},
                ],
            },
            "likes": 0,
            "favorites": 0,
            "created_at": "2026-07-18T10:00:00+00:00",
            "author": "公开用户",
            "is_owner": True,
            "liked": False,
            "favorited": False,
        }])
        monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

        items = await public_gallery_repo.list_public_generations(user_id="e2871beb-bcd3-47ad-ab77-1a3c0a145c84")

        assert len(items) == 1
        assert items[0]["page_count"] == 3
        assert items[0]["images"] == [
            "https://image.example.com/slide-1.png",
            "https://image.example.com/slide-2.png",
            "https://image.example.com/slide-3.png",
        ]
        assert len(items[0]["slides"]) == 3

    asyncio.run(_run())


def test_list_admin_review_items_collapses_text_to_image_asset_variants(monkeypatch):
    async def _run():
        conn = MagicMock()
        conn.fetch = AsyncMock(return_value=[{
            "id": "public-text",
            "user_id": "e2871beb-bcd3-47ad-ab77-1a3c0a145c84",
            "task_id": None,
            "source_task_id": "txt-job-1",
            "asset_id": "asset-6",
            "image_url": "",
            "preview_url": "/api/assets/asset-6/preview",
            "thumbnail_url": "/api/assets/asset-6/thumb",
            "title": "One image",
            "subtitle": "Text to image",
            "prompt": "One prompt",
            "final_prompt": "One prompt",
            "module": "TEXT_TO_IMAGE",
            "source": "image_history_manual",
            "tags": ["TEXT_TO_IMAGE"],
            "meta": {
                "page_count": 6,
                "images": [
                    {"thumbnail_url": "/api/assets/asset-6/thumb", "preview_url": "/api/assets/asset-6/preview"},
                    {"preview_url": "/api/assets/asset-6/preview"},
                ],
                "preview_images": ["/api/assets/asset-6/preview"],
            },
            "likes": 0,
            "favorites": 0,
            "created_at": "2026-07-18T10:00:00+00:00",
            "author": "Public user",
            "author_email": "user@example.com",
            "visibility": "public",
            "moderation_status": "pending",
            "reviewed_at": None,
            "reviewed_by": None,
            "rejection_reason": "",
            "reward_granted": False,
            "reward_credits": 0,
        }])
        monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

        items = await public_gallery_repo.list_admin_review_items()

        assert len(items) == 1
        assert items[0]["images"] == ["/api/assets/asset-6/original"]
        assert items[0]["page_count"] == 1

    asyncio.run(_run())


def test_submit_existing_generation_does_not_write_missing_task_fk(monkeypatch):
    async def _run():
        conn = MagicMock()
        conn.fetchval = AsyncMock(return_value=None)
        conn.fetchrow = AsyncMock(return_value={
            "id": "public-2",
            "visibility": "public",
            "moderation_status": "pending",
            "created_at": "2026-07-18T10:00:00+00:00",
        })
        monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

        missing_task_id = "0b2ae3af-aedc-4dd5-a0dd-280c49f00864"
        item = await public_gallery_repo.submit_existing_generation(
            user_id="e2871beb-bcd3-47ad-ab77-1a3c0a145c84",
            module="PPT_GEN",
            prompt="PixelScribe product deck",
            final_prompt="PixelScribe product deck",
            title="PixelScribe product deck",
            source="ppt_history_manual",
            task_id=missing_task_id,
            asset_id="",
            image_url="https://image.example.com/users/deck/slide-1.png",
        )

        assert item is not None
        args = conn.fetchrow.await_args_list[0].args[1:]
        assert args[1] is None
        assert args[2] == missing_task_id

    asyncio.run(_run())


def test_review_public_generation_uses_per_item_reward_override(monkeypatch):
    async def _run():
        conn = MagicMock()
        conn.transaction.return_value = _FakeTransaction()
        conn.execute = AsyncMock()
        conn.fetchval = AsyncMock(return_value=0.0)
        conn.fetchrow = AsyncMock(side_effect=[
            {
                "id": "public-3",
                "user_id": "e2871beb-bcd3-47ad-ab77-1a3c0a145c84",
                "task_id": None,
                "title": "Rewarded work",
                "moderation_status": "pending",
                "reward_granted": False,
                "reward_credits": 0,
            },
            {"value": {"per_item": 1, "daily_cap": 30}},
            {"credits": 42},
            {
                "id": "public-3",
                "moderation_status": "approved",
                "visibility": "public",
                "reviewed_at": "2026-07-18T10:00:00+00:00",
                "reviewed_by": "admin",
                "rejection_reason": "",
                "reward_granted": True,
                "reward_credits": 5.0,
                "likes": 0,
                "favorites": 0,
            },
        ])
        monkeypatch.setattr(public_gallery_repo, "acquire", lambda: _FakeAcquire(conn))

        item = await public_gallery_repo.review_public_generation(
            generation_id="71dc77db-7400-4655-8b17-a254897fec66",
            action="approve",
            reward_credits_override=5,
        )

        assert item is not None
        assert item["reward_credits"] == 5.0
        update_users_call = next(call for call in conn.fetchrow.await_args_list if "UPDATE users SET credits" in call.args[0])
        assert update_users_call.args[1] == 5.0

    asyncio.run(_run())


def test_public_reward_settings_accepts_legacy_per_image_key():
    settings = public_gallery_repo._normalize_public_reward_settings({
        "per_image": 2,
        "daily_cap": 30,
    })

    assert settings["per_item"] == 2.0
    assert settings["daily_cap"] == 30.0
