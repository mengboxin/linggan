import hashlib
import threading
import time
import asyncio
from contextlib import asynccontextmanager
from io import BytesIO
from unittest.mock import AsyncMock

import pytest
from PIL import Image
from starlette.requests import Request

from repositories import asset_mirror_repo, storage_repo
from routers import assets
from services import asset_storage


def _request() -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/assets/asset-1/thumb",
        "headers": [],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("test", 1234),
        "scheme": "http",
    })


def test_asset_delivery_url_is_signed_and_uses_stable_object_path(monkeypatch):
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets/")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")

    url = asset_storage.asset_delivery_url(
        "assets/users/user-1/images/task-1/thumb.webp",
        expires_at=2_000_000_000,
    )

    assert url.startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/images/task-1/thumb.webp?"
    )
    assert "expires=2000000000" in url
    assert "signature=" in url
    assert asset_storage.verify_asset_delivery_signature(url)


def test_asset_fallback_urls_force_backend_storage_read(monkeypatch):
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")

    urls = asset_storage.client_image_asset_urls({
        "asset_id": "asset-1",
        "original_key": "assets/users/user-1/task/original.png",
        "preview_key": "assets/users/user-1/task/preview.webp",
        "thumb_key": "assets/users/user-1/task/thumb.webp",
    }, allow_delivery_keys=True)

    assert urls["thumbnail_url"].startswith("https://image.example.com/cdn-assets/")
    assert urls["image_fallback_url"] == "/api/assets/asset-1/original?direct=1"
    assert urls["preview_fallback_url"] == "/api/assets/asset-1/preview?direct=1"
    assert urls["thumbnail_fallback_url"] == "/api/assets/asset-1/thumb?direct=1"


def test_cos_mirror_client_uses_virtual_host_addressing(monkeypatch):
    monkeypatch.setattr(
        asset_storage.settings,
        "STORAGE_MIRROR_ENDPOINT",
        "https://cos.ap-guangzhou.myqcloud.com",
    )
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_ACCESS_KEY_ID", "test-id")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_SECRET_ACCESS_KEY", "test-key")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_REGION", "ap-guangzhou")

    client = asset_storage._mirror_s3_client()
    url = client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": "image-foxapi-1405021960",
            "Key": "assets/test.txt",
        },
        ExpiresIn=60,
    )

    assert client.meta.config.s3["addressing_style"] == "virtual"
    assert url.startswith(
        "https://image-foxapi-1405021960.cos.ap-guangzhou.myqcloud.com/assets/test.txt?"
    )


@pytest.mark.asyncio
async def test_file_upload_is_not_blocked_by_legacy_user_quota(monkeypatch):
    uploads: list[dict] = []

    class FakeClient:
        def put_object(self, **kwargs):
            uploads.append(kwargs)

    quota_summary = AsyncMock(return_value={
        "quota_bytes": 1,
        "used_bytes": 1,
        "remaining_bytes": 0,
        "limit_exceeded": True,
    })
    monkeypatch.setattr(storage_repo, "storage_summary", quota_summary)
    monkeypatch.setattr(storage_repo, "invalidate_user_storage_cache", AsyncMock())
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(
        asset_storage.file_asset_repo,
        "create_file_asset",
        AsyncMock(return_value={"id": "file-1"}),
    )

    stored = await asset_storage.store_file_bytes(
        data=b"file contents beyond the old quota",
        user_id="user-1",
        category="workspace",
        task_id="task-1",
        filename="result.png",
        content_type="image/png",
    )

    assert stored is not None
    assert stored["id"] == "file-1"
    assert len(uploads) == 1
    quota_summary.assert_not_awaited()


@pytest.mark.asyncio
async def test_file_upload_enqueues_mirror_without_changing_primary_provider(monkeypatch):
    primary_uploads: list[str] = []

    class PrimaryClient:
        def put_object(self, **kwargs):
            primary_uploads.append(kwargs["Key"])

    create_file = AsyncMock(return_value={"id": "file-1"})
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage.settings, "STORAGE_PROVIDER", "r2")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_PROVIDER", "cos")
    monkeypatch.setattr(asset_storage.file_asset_repo, "create_file_asset", create_file)
    monkeypatch.setattr(storage_repo, "invalidate_user_storage_cache", AsyncMock())

    stored = await asset_storage.store_file_bytes(
        data=b"mirrored asset",
        user_id="user-1",
        category="workspace",
        task_id="task-1",
        filename="result.png",
        content_type="image/png",
    )

    assert stored is not None
    assert len(primary_uploads) == 1
    assert stored["storage_provider"] == "r2"
    assert create_file.await_args.kwargs["storage_provider"] == "r2"
    assert create_file.await_args.kwargs["mirror_keys"] == primary_uploads


@pytest.mark.asyncio
async def test_file_upload_succeeds_when_optional_mirror_is_unavailable(monkeypatch):
    primary_uploads: list[str] = []

    class PrimaryClient:
        def put_object(self, **kwargs):
            primary_uploads.append(kwargs["Key"])

    create_file = AsyncMock(return_value={"id": "file-1"})
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage.settings, "STORAGE_PROVIDER", "r2")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_ENABLED", True)
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_PROVIDER", "cos")
    monkeypatch.setattr(
        asset_storage.settings,
        "STORAGE_MIRROR_ENDPOINT",
        "https://cos.ap-guangzhou.myqcloud.com",
    )
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_BUCKET", "mirror-bucket")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_ACCESS_KEY_ID", "")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_SECRET_ACCESS_KEY", "")
    monkeypatch.setattr(asset_storage.file_asset_repo, "create_file_asset", create_file)
    monkeypatch.setattr(storage_repo, "invalidate_user_storage_cache", AsyncMock())

    stored = await asset_storage.store_file_bytes(
        data=b"primary asset",
        user_id="user-1",
        category="workspace",
        task_id="task-1",
        filename="result.png",
        content_type="image/png",
    )

    assert stored is not None
    assert len(primary_uploads) == 1
    assert asset_storage.is_asset_storage_mirror_enabled() is True
    assert asset_storage.is_asset_storage_mirror_client_configured() is False
    create_file.assert_awaited_once()
    assert create_file.await_args.kwargs["mirror_keys"] == primary_uploads


@pytest.mark.asyncio
async def test_ppt_replacement_enqueues_immutable_file_key_for_mirror(monkeypatch):
    payload = b"replacement-presentation"
    digest = hashlib.sha256(payload).hexdigest()
    uploaded: list[str] = []
    old_key = "assets/users/user1/ppt/task-1/files/old-presentation.pptx"
    replace_file = AsyncMock(return_value=({"id": "file-1"}, [old_key]))
    delete_keys = AsyncMock()

    class PrimaryClient:
        def put_object(self, **kwargs):
            uploaded.append(kwargs["Key"])

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage.file_asset_repo, "replace_task_file_asset", replace_file)
    monkeypatch.setattr(asset_storage, "delete_asset_keys", delete_keys)
    monkeypatch.setattr(storage_repo, "invalidate_user_storage_cache", AsyncMock())

    stored = await asset_storage.store_file_bytes(
        data=payload,
        user_id="user-1",
        category="ppt",
        task_id="task-1",
        filename="presentation.pptx",
        content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        replace_task_asset=True,
    )

    assert stored is not None
    assert len(uploaded) == 1
    assert uploaded[0].endswith(f"/{digest}-presentation.pptx")
    assert replace_file.await_args.kwargs["storage_key"] == uploaded[0]
    assert replace_file.await_args.kwargs["mirror_keys"] == uploaded
    delete_keys.assert_not_awaited()


@pytest.mark.asyncio
async def test_file_path_upload_streams_original_without_reading_it_all(monkeypatch, tmp_path):
    source = tmp_path / "presentation.pptx"
    payload = b"pptx-payload" * 256
    source.write_bytes(payload)
    uploaded: list[dict] = []

    class FakeClient:
        def put_object(self, **kwargs):
            body = kwargs["Body"]
            assert not isinstance(body, (bytes, bytearray))
            uploaded.append({
                "content_length": kwargs.get("ContentLength"),
                "payload": body.read(),
            })

    def reject_read_bytes(_path):
        raise AssertionError("file-path uploads must not materialize the full file")

    monkeypatch.setattr(asset_storage.Path, "read_bytes", reject_read_bytes)
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(
        asset_storage.file_asset_repo,
        "create_file_asset",
        AsyncMock(return_value={"id": "file-1"}),
    )
    monkeypatch.setattr(storage_repo, "invalidate_user_storage_cache", AsyncMock())

    stored = await asset_storage.store_file_asset(
        file_path=source,
        user_id="user-1",
        category="ppt",
        task_id="task-1",
        filename="presentation.pptx",
        content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )

    assert stored is not None
    assert stored["size_bytes"] == len(payload)
    assert stored["sha256"] == hashlib.sha256(payload).hexdigest()
    assert uploaded == [{"content_length": len(payload), "payload": payload}]


@pytest.mark.asyncio
async def test_asset_route_redirects_to_edge_without_downloading_r2_bytes(monkeypatch):
    monkeypatch.setattr(assets, "_resolve_user", AsyncMock(return_value={"id": "user-1"}))
    monkeypatch.setattr(
        assets.image_asset_repo,
        "get_image_asset",
        AsyncMock(return_value={"thumb_key": "assets/users/user-1/task/thumb.webp"}),
    )
    monkeypatch.setattr(
        assets.asset_storage,
        "asset_delivery_url",
        lambda key: f"https://image.example.com/cdn-assets/{key}?expires=1&signature=signed",
    )
    fetch_bytes = AsyncMock()
    monkeypatch.setattr(assets.asset_storage, "fetch_asset_key_bytes", fetch_bytes)

    response = await assets.get_asset_variant(
        request=_request(),
        asset_id="asset-1",
        variant="thumb",
        token=None,
    )

    assert response.status_code == 307
    assert response.headers["location"].startswith("https://image.example.com/cdn-assets/")
    assert response.headers["cache-control"] == "private, max-age=300"
    fetch_bytes.assert_not_awaited()


@pytest.mark.asyncio
async def test_asset_route_direct_fallback_reads_backend_storage(monkeypatch):
    monkeypatch.setattr(assets, "_resolve_user", AsyncMock(return_value={"id": "user-1"}))
    monkeypatch.setattr(
        assets.image_asset_repo,
        "get_image_asset",
        AsyncMock(return_value={
            "thumb_key": "assets/users/user-1/task/thumb.webp",
            "mime_type": "image/webp",
        }),
    )
    monkeypatch.setattr(
        assets.asset_storage,
        "asset_delivery_url",
        lambda key: f"https://image.example.com/cdn-assets/{key}?expires=1&signature=signed",
    )
    fetch_bytes = AsyncMock(return_value=b"mirror-webp")
    monkeypatch.setattr(assets.asset_storage, "fetch_asset_key_bytes", fetch_bytes)

    response = await assets.get_asset_variant(
        request=_request(),
        asset_id="asset-1",
        variant="thumb",
        token=None,
        direct=True,
    )

    assert response.status_code == 200
    assert response.body == b"mirror-webp"
    fetch_bytes.assert_awaited_once_with("assets/users/user-1/task/thumb.webp")


@pytest.mark.asyncio
async def test_asset_key_fallback_serves_reference_images_inline(monkeypatch):
    monkeypatch.setattr(assets, "_resolve_user", AsyncMock(return_value={"id": "user-1"}))
    monkeypatch.setattr(assets.asset_storage, "user_asset_prefix", lambda _user_id: "assets/users/user-1")
    monkeypatch.setattr(assets.asset_storage, "fetch_asset_key_bytes", AsyncMock(return_value=b"webp"))

    response = await assets.get_file_by_key(
        request=_request(),
        key="assets/users/user-1/workspace/task-1/images/ref/thumb.webp",
        filename="thumb.webp",
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["content-disposition"] == 'inline; filename="thumb.webp"'


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_resolves_legacy_asset_ids_in_one_batch(monkeypatch):
    asset_id = "11111111-1111-1111-1111-111111111111"
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    list_assets = AsyncMock(return_value=[{
        "id": asset_id,
        "original_key": "assets/users/user-1/task/original.png",
        "preview_key": "assets/users/user-1/task/preview.webp",
        "thumb_key": "assets/users/user-1/task/thumb.webp",
    }])
    monkeypatch.setattr(asset_storage.image_asset_repo, "list_assets_by_ids", list_assets)

    payload = [{
        "asset_id": asset_id,
        "thumbnail_url": f"/api/assets/{asset_id}/thumb",
    }, {
        "assetId": asset_id,
        "previewUrl": f"/api/assets/{asset_id}/preview",
    }, {
        "root_thumbnail_url": f"/api/assets/{asset_id}/thumb",
    }]

    prepared = await asset_storage.prepare_image_asset_payload(payload, "user-1")

    list_assets.assert_awaited_once_with([asset_id], "user-1")
    assert prepared[0]["thumbnail_url"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/thumb.webp?"
    )
    assert prepared[0]["thumbnail_fallback_url"] == f"/api/assets/{asset_id}/thumb?direct=1"
    assert prepared[1]["previewUrl"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/preview.webp?"
    )
    assert prepared[1]["previewFallbackUrl"] == f"/api/assets/{asset_id}/preview?direct=1"
    assert prepared[2]["root_thumbnail_url"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/thumb.webp?"
    )
    assert prepared[2]["root_thumbnail_fallback_url"] == f"/api/assets/{asset_id}/thumb?direct=1"


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_reuses_fresh_signed_cache_without_database_lookup(monkeypatch):
    asset_id = "11111111-1111-1111-1111-111111111111"
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    list_assets = AsyncMock()
    monkeypatch.setattr(asset_storage.image_asset_repo, "list_assets_by_ids", list_assets)
    thumbnail_url = asset_storage.asset_delivery_url("assets/users/user-1/task/thumb.webp")

    prepared = await asset_storage.prepare_image_asset_payload({
        "asset_id": asset_id,
        "thumbnail_url": thumbnail_url,
        "thumbnail_fallback_url": f"/api/assets/{asset_id}/thumb",
    }, "user-1")

    assert prepared["thumbnail_url"] == thumbnail_url
    list_assets.assert_not_awaited()


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_keeps_workflow_references_on_stable_asset_routes(monkeypatch):
    asset_id = "11111111-1111-1111-1111-111111111111"
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    list_assets = AsyncMock(return_value=[{
        "id": asset_id,
        "original_key": "assets/users/user-1/workspace/task-1/images/ref/original.png",
        "preview_key": "assets/users/user-1/workspace/task-1/images/ref/preview.webp",
        "thumb_key": "assets/users/user-1/workspace/task-1/images/ref/thumb.webp",
    }])
    monkeypatch.setattr(asset_storage.image_asset_repo, "list_assets_by_ids", list_assets)

    prepared = await asset_storage.prepare_image_asset_payload({
        "workflow_snapshot": {
            "nodes": [{"refImages": [f"/api/assets/{asset_id}/original"]}],
        },
    }, "user-1")

    assert prepared["workflow_snapshot"]["nodes"][0]["refImages"] == [f"/api/assets/{asset_id}/thumb"]


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_recovers_legacy_signed_workflow_references(monkeypatch):
    user_id = "00000000-0000-0000-0000-000000000001"
    asset_id = "11111111-1111-1111-1111-111111111111"
    prefix = asset_storage.user_asset_prefix(user_id)
    original_key = f"{prefix}/workspace/task-1/images/ref/original.png"
    thumb_key = f"{prefix}/workspace/task-1/images/ref/thumb.webp"
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    list_by_keys = AsyncMock(return_value=[{
        "id": asset_id,
        "original_key": original_key,
        "preview_key": f"{prefix}/workspace/task-1/images/ref/preview.webp",
        "thumb_key": thumb_key,
    }])
    monkeypatch.setattr(
        asset_storage.image_asset_repo,
        "list_assets_by_object_keys",
        list_by_keys,
        raising=False,
    )
    stale_signed_original = asset_storage.asset_delivery_url(original_key, expires_at=int(time.time()) - 60)

    prepared = await asset_storage.prepare_image_asset_payload({
        "workflow_snapshot": {
            "nodes": [{"refImages": [stale_signed_original]}],
        },
    }, user_id)

    assert prepared["workflow_snapshot"]["nodes"][0]["refImages"] == [f"/api/assets/{asset_id}/thumb"]
    list_by_keys.assert_awaited_once_with([original_key], user_id)


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_trusts_only_current_user_embedded_keys(monkeypatch):
    user_id = "00000000-0000-0000-0000-000000000001"
    asset_id = "11111111-1111-1111-1111-111111111111"
    prefix = asset_storage.user_asset_prefix(user_id)
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    list_assets = AsyncMock(return_value=[])
    monkeypatch.setattr(asset_storage.image_asset_repo, "list_assets_by_ids", list_assets)

    prepared = await asset_storage.prepare_image_asset_payload({
        "asset_id": asset_id,
        "asset_original_key": f"{prefix}/task/original.png",
        "asset_preview_key": f"{prefix}/task/preview.webp",
        "asset_thumb_key": f"{prefix}/task/thumb.webp",
        "thumbnail_url": f"/api/assets/{asset_id}/thumb",
    }, user_id)

    assert prepared["thumbnail_url"].startswith(
        f"https://image.example.com/cdn-assets/{prefix}/task/thumb.webp?"
    )
    list_assets.assert_not_awaited()

    untrusted = await asset_storage.prepare_image_asset_payload({
        "asset_id": asset_id,
        "asset_thumb_key": "assets/users/someone-else/private/thumb.webp",
        "thumbnail_url": f"/api/assets/{asset_id}/thumb",
    }, user_id)

    assert untrusted["thumbnail_url"] == f"/api/assets/{asset_id}/thumb"
    list_assets.assert_awaited_once_with([asset_id], user_id)


@pytest.mark.asyncio
async def test_generated_image_uploads_run_off_loop_and_in_parallel(monkeypatch):
    main_thread = threading.get_ident()
    upload_threads: list[int] = []
    upload_keys: list[str] = []
    active_uploads = 0
    max_active_uploads = 0
    lock = threading.Lock()

    class FakeClient:
        def put_object(self, **kwargs):
            nonlocal active_uploads, max_active_uploads
            with lock:
                upload_threads.append(threading.get_ident())
                upload_keys.append(kwargs["Key"])
                active_uploads += 1
                max_active_uploads = max(max_active_uploads, active_uploads)
            time.sleep(0.03)
            with lock:
                active_uploads -= 1

    created: dict = {}

    async def create_asset(**kwargs):
        created.update(kwargs)
        return {
            "id": kwargs["asset_id"],
            "original_url": kwargs["original_url"],
            "preview_url": kwargs["preview_url"],
            "thumb_url": kwargs["thumb_url"],
            "original_key": kwargs["original_key"],
            "preview_key": kwargs["preview_key"],
            "thumb_key": kwargs["thumb_key"],
        }

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(
        asset_storage,
        "_image_metadata",
        lambda _raw: (1024, 1024, "image/png", "png"),
    )
    monkeypatch.setattr(asset_storage, "_webp_variant", lambda _raw, _px, _quality: (b"webp", 320, 320))
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    stored = await asset_storage.store_generated_image(
        image_bytes=b"image-bytes",
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="test",
        model_id="image-model",
    )

    assert stored is not None
    assert len(upload_threads) == 3
    assert all(thread_id != main_thread for thread_id in upload_threads)
    assert max_active_uploads >= 2
    assert sorted(created["mirror_keys"]) == sorted(upload_keys)


@pytest.mark.asyncio
async def test_imported_jpeg_keeps_original_mime_and_extension(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (8, 6), color=(220, 80, 40)).save(image, format="JPEG")
    jpeg_bytes = image.getvalue()
    uploads: list[dict] = []
    created: dict = {}

    class FakeClient:
        def put_object(self, **kwargs):
            uploads.append(kwargs)

    async def create_asset(**kwargs):
        created.update(kwargs)
        return {
            "id": kwargs["asset_id"],
            "original_url": kwargs["original_url"],
            "preview_url": kwargs["preview_url"],
            "thumb_url": kwargs["thumb_url"],
            "original_key": kwargs["original_key"],
            "preview_key": kwargs["preview_key"],
            "thumb_key": kwargs["thumb_key"],
        }

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    stored = await asset_storage.store_generated_image(
        image_bytes=jpeg_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="import-1",
        prompt="imported jpeg",
        model_id="import",
    )

    original_digest = hashlib.sha256(jpeg_bytes).hexdigest()
    original = next(upload for upload in uploads if "/original-" in upload["Key"])
    assert original["Key"].endswith(f"/original-{original_digest}.jpg")
    assert original["ContentType"] == "image/jpeg"
    for variant, extension in (("preview", "webp"), ("thumb", "webp")):
        upload = next(item for item in uploads if f"/{variant}-" in item["Key"])
        variant_digest = hashlib.sha256(upload["Body"]).hexdigest()
        assert upload["Key"].endswith(f"/{variant}-{variant_digest}.{extension}")
    assert stored is not None
    assert stored.mime_type == "image/jpeg"
    assert created["mime_type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_generated_image_strips_nul_bytes_before_metadata_insert(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (8, 8), color=(80, 120, 220)).save(image, format="PNG")
    created: dict = {}

    class FakeClient:
        def put_object(self, **_kwargs):
            return None

    async def create_asset(**kwargs):
        created.update(kwargs)
        return {
            "id": kwargs["asset_id"],
            "original_url": kwargs["original_url"],
            "preview_url": kwargs["preview_url"],
            "thumb_url": kwargs["thumb_url"],
            "original_key": kwargs["original_key"],
            "preview_key": kwargs["preview_key"],
            "thumb_key": kwargs["thumb_key"],
        }

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    stored = await asset_storage.store_generated_image(
        image_bytes=image.getvalue(),
        user_id="user-1",
        conversation_id="conversation-1\x00",
        task_id="task-1\x00",
        prompt="prompt before\x00prompt after",
        model_id="image-model\x00",
        category="images\x00",
        item_id="item-1\x00",
    )

    assert stored is not None
    assert created["conversation_id"] == "conversation-1"
    assert created["task_id"] == "task-1"
    assert created["prompt"] == "prompt beforeprompt after"
    assert created["model_id"] == "image-model"
    assert "\x00" not in created["original_key"]


@pytest.mark.asyncio
async def test_workspace_image_reuses_existing_asset_on_later_snapshot(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (16, 16), color=(80, 120, 220)).save(image, format="PNG")
    image_bytes = image.getvalue()
    uploads: list[str] = []
    created_rows: list[dict] = []

    class FakeClient:
        def put_object(self, **kwargs):
            uploads.append(kwargs["Key"])

    async def create_asset(**kwargs):
        row = dict(kwargs)
        row["id"] = kwargs["asset_id"]
        created_rows.append(row)
        return row

    existing_asset = AsyncMock(return_value=None)
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "find_workspace_asset_by_sha", existing_asset)
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    first = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="workflow-1",
        prompt="imported",
        model_id="import",
        category="workspace",
        item_id="layers.0",
    )
    assert first is not None

    existing_asset.return_value = created_rows[0]
    second = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="workflow-1",
        prompt="imported again",
        model_id="import",
        category="workspace",
        item_id="workflow.nodes.3",
    )

    assert second is not None
    assert second.id == first.id
    assert len(created_rows) == 1
    assert len(uploads) == 3
    assert all(first.id in key for key in uploads)


@pytest.mark.asyncio
async def test_explicit_asset_id_reuses_archived_image_on_callback_retry(monkeypatch):
    image_bytes = b"callback-retry-image"
    existing = {
        "id": "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5",
        "task_id": "task-1",
        "original_url": "/api/assets/8b53c068-246e-4ac4-84f2-7f19fd0b3fb5/original",
        "preview_url": "/api/assets/8b53c068-246e-4ac4-84f2-7f19fd0b3fb5/preview",
        "thumb_url": "/api/assets/8b53c068-246e-4ac4-84f2-7f19fd0b3fb5/thumb",
        "original_key": "assets/users/user-1/images/task-1/images/retry/original.png",
        "preview_key": "assets/users/user-1/images/task-1/images/retry/preview.webp",
        "thumb_key": "assets/users/user-1/images/task-1/images/retry/thumb.webp",
        "width": 32,
        "height": 32,
        "mime_type": "image/png",
        "size_bytes": 100,
        "sha256": hashlib.sha256(image_bytes).hexdigest(),
    }
    get_existing = AsyncMock(return_value=existing)
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_existing)

    stored = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="retry",
        model_id="image2",
        asset_id=existing["id"],
    )

    assert stored is not None
    assert stored.id == existing["id"]
    get_existing.assert_awaited_once_with(existing["id"], "user-1")


@pytest.mark.asyncio
async def test_explicit_asset_id_rejects_a_different_task_or_image(monkeypatch):
    existing = {
        "id": "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5",
        "task_id": "different-task",
        "sha256": "0" * 64,
    }
    get_existing = AsyncMock(return_value=existing)
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_existing)

    stored = await asset_storage.store_generated_image(
        image_bytes=b"different-image",
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="retry",
        model_id="image2",
        asset_id=existing["id"],
    )

    assert stored is None
    get_existing.assert_awaited_once_with(existing["id"], "user-1")


@pytest.mark.asyncio
async def test_archive_reuses_committed_metadata_when_database_response_breaks(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (8, 8), color=(80, 120, 220)).save(image, format="PNG")
    image_bytes = image.getvalue()
    asset_id = "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5"
    existing = {
        "id": asset_id,
        "task_id": "task-1",
        "sha256": hashlib.sha256(image_bytes).hexdigest(),
        "original_url": f"/api/assets/{asset_id}/original",
        "preview_url": f"/api/assets/{asset_id}/preview",
        "thumb_url": f"/api/assets/{asset_id}/thumb",
        "original_key": "assets/users/user-1/images/task-1/images/result/original.png",
        "preview_key": "assets/users/user-1/images/task-1/images/result/preview.webp",
        "thumb_key": "assets/users/user-1/images/task-1/images/result/thumb.webp",
        "width": 8,
        "height": 8,
        "mime_type": "image/png",
        "size_bytes": len(image_bytes),
    }

    class FakeClient:
        def put_object(self, **_kwargs):
            return None

    # Pre-transform, post-lock, post-upload, then recover after a lost DB response.
    get_existing = AsyncMock(side_effect=[None, None, None, existing])
    delete_objects = AsyncMock()
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_existing)
    monkeypatch.setattr(
        asset_storage.image_asset_repo,
        "create_image_asset",
        AsyncMock(side_effect=RuntimeError("database response lost")),
    )
    monkeypatch.setattr(asset_storage, "delete_asset_keys", delete_objects)

    stored = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="retry",
        model_id="image2",
        asset_id=asset_id,
    )

    assert stored is not None
    assert stored.id == asset_id
    assert get_existing.await_count == 4
    delete_objects.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicit_asset_id_serializes_concurrent_callback_archives(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (12, 12), color=(80, 120, 220)).save(image, format="PNG")
    image_bytes = image.getvalue()
    asset_id = "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5"
    persisted: dict[str, dict] = {}
    uploaded_keys: list[str] = []
    create_calls = 0

    class FakeClient:
        def put_object(self, **kwargs):
            uploaded_keys.append(kwargs["Key"])

    async def get_asset(requested_id, _user_id, *, connection=None):
        return persisted.get(requested_id)

    async def create_asset(**kwargs):
        nonlocal create_calls
        create_calls += 1
        await asyncio.sleep(0)
        row = {**kwargs, "id": kwargs["asset_id"]}
        persisted[kwargs["asset_id"]] = row
        return row

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_asset)
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    first, second = await asyncio.gather(*(
        asset_storage.store_generated_image(
            image_bytes=image_bytes,
            user_id="user-1",
            conversation_id=None,
            task_id="task-1",
            prompt="retry",
            model_id="image2",
            asset_id=asset_id,
        )
        for _ in range(2)
    ))

    assert first is not None
    assert second is not None
    assert first.id == second.id == asset_id
    assert create_calls == 1
    assert len(uploaded_keys) == 3


@pytest.mark.asyncio
async def test_explicit_asset_id_conflict_discovered_under_lock_does_not_upload(monkeypatch):
    old_image = BytesIO()
    Image.new("RGB", (8, 8), color=(80, 120, 220)).save(old_image, format="PNG")
    new_image = BytesIO()
    Image.new("RGB", (8, 8), color=(220, 80, 120)).save(new_image, format="PNG")
    asset_id = "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5"
    existing = {
        "id": asset_id,
        "task_id": "task-1",
        "sha256": hashlib.sha256(old_image.getvalue()).hexdigest(),
    }
    get_existing = AsyncMock(side_effect=[None, existing])
    uploads: list[str] = []

    class FakeClient:
        def put_object(self, **kwargs):
            uploads.append(kwargs["Key"])

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_existing)

    stored = await asset_storage.store_generated_image(
        image_bytes=new_image.getvalue(),
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="retry",
        model_id="image2",
        asset_id=asset_id,
    )

    assert stored is None
    assert uploads == []
    assert get_existing.await_count == 2


@pytest.mark.asyncio
async def test_explicit_asset_write_uses_its_lock_connection_for_metadata(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (8, 8), color=(80, 120, 220)).save(image, format="PNG")
    image_bytes = image.getvalue()
    asset_id = "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5"
    digest = hashlib.sha256(image_bytes).hexdigest()
    acquisitions = 0
    statements: list[str] = []
    lookup_connections: list[object | None] = []

    class Transaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _traceback):
            return False

    class Connection:
        def transaction(self):
            return Transaction()

        async def execute(self, sql, *_args):
            statements.append(sql)

        async def fetchrow(self, _sql, *_args):
            return {
                "id": asset_id,
                "task_id": "task-1",
                "sha256": digest,
                "original_url": f"/api/assets/{asset_id}/original",
                "preview_url": f"/api/assets/{asset_id}/preview",
                "thumb_url": f"/api/assets/{asset_id}/thumb",
                "original_key": "assets/users/user-1/images/task-1/images/result/original.png",
                "preview_key": "assets/users/user-1/images/task-1/images/result/preview.webp",
                "thumb_key": "assets/users/user-1/images/task-1/images/result/thumb.webp",
                "width": 8,
                "height": 8,
                "mime_type": "image/png",
                "size_bytes": len(image_bytes),
            }

    @asynccontextmanager
    async def acquire_once():
        nonlocal acquisitions
        acquisitions += 1
        yield Connection()

    async def get_missing(_asset_id, _user_id, *, connection=None):
        lookup_connections.append(connection)
        return None

    class FakeClient:
        def put_object(self, **_kwargs):
            assert acquisitions == 0

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_pool", lambda: object())
    monkeypatch.setattr(asset_storage.image_asset_repo, "acquire", acquire_once)
    monkeypatch.setattr(asset_storage.image_asset_repo, "get_image_asset", get_missing)

    stored = await asset_storage.store_generated_image(
        image_bytes=image_bytes,
        user_id="user-1",
        conversation_id=None,
        task_id="task-1",
        prompt="retry",
        model_id="image2",
        asset_id=asset_id,
    )

    assert stored is not None
    assert acquisitions == 1
    assert lookup_connections[0] is None
    assert lookup_connections[1] is None
    assert lookup_connections[2] is not None
    assert any("pg_advisory_xact_lock" in statement for statement in statements)


@pytest.mark.asyncio
async def test_asset_write_lock_drops_idle_local_entry():
    lock_id = "8b53c068-246e-4ac4-84f2-7f19fd0b3fb5"

    async with asset_storage.image_asset_repo.image_asset_write_lock(lock_id):
        assert asset_storage.image_asset_repo._local_write_locks.get(lock_id) is not None

    assert asset_storage.image_asset_repo._local_write_locks.get(lock_id) is None


@pytest.mark.asyncio
async def test_asset_fallback_serves_original_with_detected_content_type(monkeypatch):
    monkeypatch.setattr(assets, "_resolve_user", AsyncMock(return_value={"id": "user-1"}))
    monkeypatch.setattr(
        assets.image_asset_repo,
        "get_image_asset",
        AsyncMock(return_value={
            "original_key": "assets/users/user-1/task/original.jpg",
            "mime_type": "image/jpeg",
        }),
    )
    monkeypatch.setattr(assets.asset_storage, "asset_delivery_url", lambda _key: "")
    monkeypatch.setattr(assets.asset_storage, "fetch_asset_key_bytes", AsyncMock(return_value=b"jpeg"))

    response = await assets.get_asset_variant(
        request=_request(),
        asset_id="asset-1",
        variant="original",
        token=None,
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_asset_download_reads_r2_body_off_the_event_loop(monkeypatch):
    main_thread = threading.get_ident()
    read_threads: list[int] = []

    class FakeBody:
        def read(self):
            read_threads.append(threading.get_ident())
            return b"asset"

        def close(self):
            return None

    class FakeClient:
        def get_object(self, **_kwargs):
            return {"Body": FakeBody()}

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())

    assert await asset_storage.fetch_asset_key_bytes("asset-key") == b"asset"
    assert read_threads and read_threads[0] != main_thread


@pytest.mark.asyncio
async def test_asset_download_falls_back_to_mirror_after_primary_failure(monkeypatch):
    reads: list[tuple[str, str]] = []

    class FakeBody:
        def __init__(self, data: bytes):
            self.data = data

        def read(self):
            return self.data

        def close(self):
            return None

    class PrimaryClient:
        def get_object(self, **kwargs):
            reads.append(("r2", kwargs["Key"]))
            raise RuntimeError("R2 unavailable")

    class MirrorClient:
        def get_object(self, **kwargs):
            reads.append(("cos", kwargs["Key"]))
            return {"Body": FakeBody(b"mirror asset")}

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage, "_mirror_s3_client", lambda: MirrorClient())
    monkeypatch.setattr(asset_storage, "storage_bucket_name", lambda: "primary-bucket")
    monkeypatch.setattr(asset_storage, "mirror_storage_bucket_name", lambda: "mirror-bucket")
    monkeypatch.setattr(asset_mirror_repo, "is_read_ready", AsyncMock(return_value=True))

    assert await asset_storage.fetch_asset_key_bytes("asset-key") == b"mirror asset"
    assert reads == [("r2", "asset-key"), ("cos", "asset-key")]


@pytest.mark.asyncio
async def test_asset_download_does_not_use_pending_mirror(monkeypatch):
    class PrimaryClient:
        def get_object(self, **_kwargs):
            raise RuntimeError("R2 unavailable")

    mirror = AsyncMock()
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage, "_mirror_s3_client", mirror)
    monkeypatch.setattr(asset_storage, "storage_bucket_name", lambda: "primary-bucket")
    monkeypatch.setattr(asset_mirror_repo, "is_read_ready", AsyncMock(return_value=False))

    with pytest.raises(RuntimeError, match="R2 unavailable"):
        await asset_storage.fetch_asset_key_bytes("asset-key")

    mirror.assert_not_called()


@pytest.mark.asyncio
async def test_asset_download_does_not_use_mirror_without_client_credentials(monkeypatch):
    class PrimaryClient:
        def get_object(self, **_kwargs):
            raise RuntimeError("R2 unavailable")

    mirror = AsyncMock()
    ready = AsyncMock(return_value=True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: False)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage, "_mirror_s3_client", mirror)
    monkeypatch.setattr(asset_mirror_repo, "is_read_ready", ready)

    with pytest.raises(RuntimeError, match="R2 unavailable"):
        await asset_storage.fetch_asset_key_bytes("asset-key")

    ready.assert_not_awaited()
    mirror.assert_not_called()


@pytest.mark.asyncio
async def test_mirror_worker_streams_primary_object_and_marks_copy_ready(monkeypatch):
    completed: list[dict] = []
    uploaded: list[dict] = []

    class FakeBody:
        def __init__(self):
            self.closed = False

        def read(self, *_args):
            return b"asset"

        def close(self):
            self.closed = True

    body = FakeBody()

    class PrimaryClient:
        def get_object(self, **_kwargs):
            return {
                "Body": body,
                "ContentLength": 5,
                "ContentType": "image/webp",
                "CacheControl": "public, max-age=60",
            }

    class MirrorClient:
        def put_object(self, **kwargs):
            uploaded.append(kwargs)

    job = {
        "target_provider": "cos",
        "target_endpoint": "https://cos.ap-guangzhou.myqcloud.com",
        "target_bucket": "mirror-bucket",
        "target_region": "ap-guangzhou",
        "object_key": "assets/users/u/a.webp",
        "operation": "copy",
        "revision": 1,
    }

    @asynccontextmanager
    async def claim(**_kwargs):
        yield object(), job if not completed else None

    async def complete(_connection, claimed):
        completed.append(claimed)
        return True

    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(asset_storage, "_mirror_s3_client", lambda **_kwargs: MirrorClient())
    monkeypatch.setattr(asset_storage, "storage_bucket_name", lambda: "primary-bucket")
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)
    monkeypatch.setattr(asset_mirror_repo, "complete_claimed_job", complete)

    result = await asset_storage.retry_pending_asset_mirror_operations(limit=2)

    assert result == {"requested": 1, "completed": 1, "failed": []}
    assert completed == [job]
    assert uploaded[0]["Bucket"] == "mirror-bucket"
    assert uploaded[0]["Key"] == "assets/users/u/a.webp"
    assert uploaded[0]["Body"] is body
    assert uploaded[0]["ContentLength"] == 5
    assert body.closed is True


@pytest.mark.asyncio
async def test_mirror_worker_retains_failed_copy_for_retry(monkeypatch):
    failures: list[tuple[dict, str]] = []
    claimed = False
    job = {
        "target_provider": "cos",
        "target_endpoint": "https://cos.ap-guangzhou.myqcloud.com",
        "target_bucket": "mirror-bucket",
        "target_region": "ap-guangzhou",
        "object_key": "assets/users/u/a.webp",
        "operation": "copy",
        "revision": 1,
    }

    @asynccontextmanager
    async def claim(**_kwargs):
        nonlocal claimed
        current = None if claimed else job
        claimed = True
        yield object(), current

    async def fail(_connection, failed_job, error):
        failures.append((failed_job, error))
        return True

    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(
        asset_storage,
        "_copy_primary_object_to_mirror_sync",
        lambda _job: (_ for _ in ()).throw(RuntimeError("COS unavailable")),
    )
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)
    monkeypatch.setattr(asset_mirror_repo, "fail_claimed_job", fail)

    result = await asset_storage.retry_pending_asset_mirror_operations(limit=2)

    assert result["requested"] == 1
    assert result["completed"] == 0
    assert result["failed"][0]["error"] == "COS unavailable"
    assert failures == [(job, "COS unavailable")]


@pytest.mark.asyncio
async def test_mirror_delete_uses_captured_target_and_marks_completion(monkeypatch):
    client_calls: list[dict] = []
    deletes: list[dict] = []
    completed: list[dict] = []
    claimed = False
    job = {
        "target_provider": "cos",
        "target_endpoint": "https://captured.cos.example.com",
        "target_bucket": "captured-bucket",
        "target_region": "captured-region",
        "object_key": "assets/users/u/a.webp",
        "operation": "delete",
        "revision": 2,
    }

    class MirrorClient:
        def delete_object(self, **kwargs):
            deletes.append(kwargs)

    @asynccontextmanager
    async def claim(**_kwargs):
        nonlocal claimed
        current = None if claimed else job
        claimed = True
        yield object(), current

    async def complete(_connection, completed_job):
        completed.append(completed_job)
        return True

    def mirror_client(**kwargs):
        client_calls.append(kwargs)
        return MirrorClient()

    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(asset_storage, "_mirror_s3_client", mirror_client)
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)
    monkeypatch.setattr(asset_mirror_repo, "complete_claimed_job", complete)

    result = await asset_storage.retry_pending_asset_mirror_operations(limit=2)

    assert result == {"requested": 1, "completed": 1, "failed": []}
    assert client_calls == [{
        "endpoint": "https://captured.cos.example.com",
        "region": "captured-region",
    }]
    assert deletes == [{
        "Bucket": "captured-bucket",
        "Key": "assets/users/u/a.webp",
    }]
    assert completed == [job]


@pytest.mark.asyncio
async def test_mirror_delete_failure_returns_job_to_pending(monkeypatch):
    failures: list[tuple[dict, str]] = []
    claimed = False
    job = {
        "target_provider": "cos",
        "target_endpoint": "https://captured.cos.example.com",
        "target_bucket": "captured-bucket",
        "target_region": "captured-region",
        "object_key": "assets/users/u/a.webp",
        "operation": "delete",
        "revision": 2,
    }

    @asynccontextmanager
    async def claim(**_kwargs):
        nonlocal claimed
        current = None if claimed else job
        claimed = True
        yield object(), current

    async def fail(_connection, failed_job, error):
        failures.append((failed_job, error))
        return True

    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(
        asset_storage,
        "_delete_mirror_object_sync",
        lambda _job: (_ for _ in ()).throw(RuntimeError("COS delete unavailable")),
    )
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)
    monkeypatch.setattr(asset_mirror_repo, "fail_claimed_job", fail)

    result = await asset_storage.retry_pending_asset_mirror_operations(limit=2)

    assert result["requested"] == 1
    assert result["completed"] == 0
    assert result["failed"] == [{
        "key": "assets/users/u/a.webp",
        "operation": "delete",
        "error": "COS delete unavailable",
    }]
    assert failures == [(job, "COS delete unavailable")]


@pytest.mark.asyncio
async def test_mirror_worker_cancellation_waits_for_inflight_io_before_releasing_lock(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    events: list[str] = []
    job = {
        "target_provider": "cos",
        "target_endpoint": "https://captured.cos.example.com",
        "target_bucket": "captured-bucket",
        "target_region": "captured-region",
        "object_key": "assets/users/u/a.webp",
        "operation": "copy",
        "revision": 3,
    }

    @asynccontextmanager
    async def claim(**_kwargs):
        events.append("lock-acquired")
        try:
            yield object(), job
        finally:
            events.append("lock-released")

    def copy(_job):
        started.set()
        if not release.wait(timeout=5):
            raise RuntimeError("test did not release mirror I/O")
        events.append("io-finished")
        finished.set()

    complete = AsyncMock()
    fail = AsyncMock()
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(asset_storage, "_copy_primary_object_to_mirror_sync", copy)
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)
    monkeypatch.setattr(asset_mirror_repo, "complete_claimed_job", complete)
    monkeypatch.setattr(asset_mirror_repo, "fail_claimed_job", fail)

    worker = asyncio.create_task(asset_storage.retry_pending_asset_mirror_operations(limit=1))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        worker.cancel()
        await asyncio.sleep(0)
        assert not finished.is_set()
        assert not worker.done()
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError):
        await worker

    assert events == ["lock-acquired", "io-finished", "lock-released"]
    complete.assert_not_awaited()
    fail.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_mirror_worker_only_claims_delete_jobs(monkeypatch):
    include_copy_values: list[bool] = []

    @asynccontextmanager
    async def claim(*, include_copies: bool):
        include_copy_values.append(include_copies)
        yield None, None

    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_client_configured", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: False)
    monkeypatch.setattr(asset_mirror_repo, "claim_pending_job", claim)

    result = await asset_storage.retry_pending_asset_mirror_operations(limit=1)

    assert result == {"requested": 0, "completed": 0, "failed": []}
    assert include_copy_values == [False]


@pytest.mark.asyncio
async def test_delete_asset_keys_persists_intent_before_remote_io_and_finalizes(monkeypatch):
    events: list[str] = []
    queued: list[tuple[list[str], dict]] = []
    deleted_from_queue: list[str] = []
    failed_in_queue: list[dict] = []

    class FakeClient:
        def delete_objects(self, **kwargs):
            events.append("remote-delete")
            keys = [item["Key"] for item in kwargs["Delete"]["Objects"]]
            return {"Errors": [{"Key": keys[0], "Message": "R2 busy"}]}

    async def enqueue(keys, **kwargs):
        events.append("queue-intent")
        queued.append((list(keys), kwargs))
        return len(keys)

    async def mark_deleted(keys):
        deleted_from_queue.extend(keys)
        return len(keys)

    async def mark_failed(failures):
        failed_in_queue.extend(failures)
        return len(failures)

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_mirror_repo, "enqueue_deletions", AsyncMock(return_value=[]))
    monkeypatch.setattr(storage_repo, "enqueue_asset_object_deletions", enqueue)
    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_deleted", mark_deleted)
    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_failed", mark_failed)

    result = await asset_storage.delete_asset_keys(
        ["assets/users/u/a.webp", "assets/users/u/b.webp"],
        max_retries=0,
        user_id="00000000-0000-0000-0000-000000000001",
        reason="unit-test",
    )

    assert result["deleted"] == 1
    assert result["queued"] == 2
    assert events == ["queue-intent", "remote-delete"]
    assert queued == [(
        ["assets/users/u/a.webp", "assets/users/u/b.webp"],
        {
            "user_id": "00000000-0000-0000-0000-000000000001",
            "reason": "unit-test",
        },
    )]
    assert deleted_from_queue == ["assets/users/u/b.webp"]
    assert failed_in_queue == [{"key": "assets/users/u/a.webp", "error": "R2 busy"}]


@pytest.mark.asyncio
async def test_delete_asset_keys_cancellation_leaves_durable_intent_pending(monkeypatch):
    events: list[str] = []
    mark_deleted = AsyncMock()
    mark_failed = AsyncMock()

    class FakeClient:
        def delete_objects(self, **_kwargs):
            events.append("remote-delete")
            raise asyncio.CancelledError()

    async def enqueue(keys, **_kwargs):
        events.append("queue-intent")
        return len(keys)

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_mirror_repo, "enqueue_deletions", AsyncMock(return_value=[]))
    monkeypatch.setattr(storage_repo, "enqueue_asset_object_deletions", enqueue)
    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_deleted", mark_deleted)
    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_failed", mark_failed)

    with pytest.raises(asyncio.CancelledError):
        await asset_storage.delete_asset_keys(
            ["assets/users/u/a.webp"],
            max_retries=0,
            reason="unit-test-cancelled",
        )

    assert events == ["queue-intent", "remote-delete"]
    mark_deleted.assert_not_awaited()
    mark_failed.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_asset_keys_removes_primary_and_enqueues_mirror(monkeypatch):
    deletes: list[list[str]] = []
    mirror_deletes: list[str] = []

    class FakeClient:
        def delete_objects(self, **kwargs):
            keys = [item["Key"] for item in kwargs["Delete"]["Objects"]]
            deletes.append(keys)
            return {}

    async def enqueue_mirror(keys, **_kwargs):
        mirror_deletes.extend(keys)
        return []

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage, "storage_bucket_name", lambda: "primary-bucket")
    monkeypatch.setattr(asset_mirror_repo, "enqueue_deletions", enqueue_mirror)

    result = await asset_storage.delete_asset_keys(
        ["assets/users/u/a.webp", "assets/users/u/b.webp"],
        max_retries=0,
        enqueue_failed=False,
    )

    assert result["deleted"] == 2
    assert result["failed"] == []
    assert deletes == [["assets/users/u/a.webp", "assets/users/u/b.webp"]]
    assert mirror_deletes == ["assets/users/u/a.webp", "assets/users/u/b.webp"]


@pytest.mark.asyncio
async def test_delete_asset_keys_retries_when_mirror_queue_is_unavailable(monkeypatch):
    queued: list[str] = []

    class PrimaryClient:
        def delete_objects(self, **_kwargs):
            return {}

    async def enqueue(keys, **_kwargs):
        queued.extend(keys)
        return len(keys)

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "is_asset_storage_mirror_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: PrimaryClient())
    monkeypatch.setattr(
        asset_mirror_repo,
        "enqueue_deletions",
        AsyncMock(side_effect=RuntimeError("mirror queue unavailable")),
    )
    monkeypatch.setattr(asset_storage, "storage_bucket_name", lambda: "primary-bucket")
    monkeypatch.setattr(asset_storage, "mirror_storage_bucket_name", lambda: "mirror-bucket")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_PROVIDER", "r2")
    monkeypatch.setattr(asset_storage.settings, "STORAGE_MIRROR_PROVIDER", "cos")
    monkeypatch.setattr(storage_repo, "enqueue_asset_object_deletions", enqueue)

    result = await asset_storage.delete_asset_keys(
        ["assets/users/u/a.webp"],
        max_retries=0,
        reason="unit-test",
    )

    assert result["deleted"] == 0
    assert result["failed"] == [{
        "key": "assets/users/u/a.webp",
        "error": "mirror queue: mirror queue unavailable",
    }]
    assert result["queued"] == 1
    assert queued == ["assets/users/u/a.webp"]


@pytest.mark.asyncio
async def test_retry_pending_asset_deletions_removes_successful_queue_rows(monkeypatch):
    deleted_from_queue: list[str] = []
    failed_in_queue: list[dict] = []

    class FakeClient:
        def delete_objects(self, **_kwargs):
            return {}

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_mirror_repo, "enqueue_deletions", AsyncMock(return_value=[]))
    monkeypatch.setattr(storage_repo, "pending_asset_object_deletions", AsyncMock(return_value=["assets/users/u/a.webp"]))

    async def mark_deleted(keys):
        deleted_from_queue.extend(keys)
        return len(keys)

    async def mark_failed(failures):
        failed_in_queue.extend(failures)
        return len(failures)

    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_deleted", mark_deleted)
    monkeypatch.setattr(storage_repo, "mark_asset_object_deletions_failed", mark_failed)

    result = await asset_storage.retry_pending_asset_deletions(limit=10)

    assert result["deleted"] == 1
    assert result["queue_deleted"] == 1
    assert deleted_from_queue == ["assets/users/u/a.webp"]
    assert failed_in_queue == []


@pytest.mark.asyncio
async def test_generated_image_upload_failure_rolls_back_all_attempted_keys(monkeypatch):
    image = BytesIO()
    Image.new("RGB", (8, 8), color=(80, 120, 220)).save(image, format="PNG")
    attempted: list[str] = []
    rolled_back: list[str] = []

    class FakeClient:
        def put_object(self, **kwargs):
            attempted.append(kwargs["Key"])
            if "/preview-" in kwargs["Key"]:
                raise RuntimeError("preview upload failed")

    async def delete_keys(keys, **_kwargs):
        rolled_back.extend(keys)
        return {"requested": len(keys), "deleted": len(keys), "failed": []}

    monkeypatch.setattr(asset_storage, "is_asset_storage_enabled", lambda: True)
    monkeypatch.setattr(asset_storage, "_s3_client", lambda: FakeClient())
    monkeypatch.setattr(asset_storage, "delete_asset_keys", delete_keys)
    create_asset = AsyncMock()
    monkeypatch.setattr(asset_storage.image_asset_repo, "create_image_asset", create_asset)

    stored = await asset_storage.store_generated_image(
        image_bytes=image.getvalue(),
        user_id="user-1",
        conversation_id=None,
        task_id="task-rollback",
        prompt="rollback",
        model_id="image-model",
    )

    assert stored is None
    assert len(attempted) == 3
    assert set(rolled_back) == set(attempted)
    create_asset.assert_not_awaited()


@pytest.mark.asyncio
async def test_prepare_image_asset_payload_refreshes_nearly_expired_signed_cache(monkeypatch):
    asset_id = "11111111-1111-1111-1111-111111111111"
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")
    stale_soon_url = asset_storage.asset_delivery_url(
        "assets/users/user-1/task/thumb.webp",
        expires_at=int(time.time()) + 120,
    )
    list_assets = AsyncMock(return_value=[{
        "id": asset_id,
        "original_key": "assets/users/user-1/task/original.png",
        "preview_key": "assets/users/user-1/task/preview.webp",
        "thumb_key": "assets/users/user-1/task/thumb.webp",
    }])
    monkeypatch.setattr(asset_storage.image_asset_repo, "list_assets_by_ids", list_assets)

    prepared = await asset_storage.prepare_image_asset_payload({
        "asset_id": asset_id,
        "thumbnail_url": stale_soon_url,
        "thumbnail_fallback_url": f"/api/assets/{asset_id}/thumb",
    }, "user-1")

    assert prepared["thumbnail_url"] != stale_soon_url
    assert asset_storage.verify_asset_delivery_signature(prepared["thumbnail_url"], min_ttl_seconds=300)
    list_assets.assert_awaited_once_with([asset_id], "user-1")


def test_slide_keys_and_size_collects_nested_key_fields():
    keys, total = storage_repo._slide_keys_and_size([{
        "size_bytes": 12,
        "layers": [
            {"image_key": "assets/users/u/ppt/slide-1.webp"},
            {"asset": {"rendered_key": "/assets/users/u/ppt/rendered.webp"}},
            {"key": "react-key-without-path"},
        ],
    }])

    assert keys == [
        "assets/users/u/ppt/slide-1.webp",
        "assets/users/u/ppt/rendered.webp",
    ]
    assert total == 12
