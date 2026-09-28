import json

from core import history_artifacts
from services import asset_storage


def test_asset_urls_from_meta_prefers_direct_signed_delivery_urls(monkeypatch):
    monkeypatch.setattr(
        asset_storage.settings,
        "ASSET_DELIVERY_BASE_URL",
        "https://image.example.com/cdn-assets",
    )
    monkeypatch.setattr(
        asset_storage.settings,
        "ASSET_DELIVERY_SIGNING_KEY",
        "test-signing-key",
    )

    meta = {
        "asset_id": "asset-1",
        "asset_original_key": "assets/users/user-1/task/original.png",
        "asset_preview_key": "assets/users/user-1/task/preview.webp",
        "asset_thumb_key": "assets/users/user-1/task/thumb.webp",
    }
    prepared_meta = {
        **meta,
        **asset_storage.client_image_asset_urls(meta, allow_delivery_keys=True),
    }
    urls = history_artifacts.asset_urls_from_meta(prepared_meta)

    assert urls["image_url"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/original.png?"
    )
    assert urls["preview_url"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/preview.webp?"
    )
    assert urls["thumbnail_url"].startswith(
        "https://image.example.com/cdn-assets/assets/users/user-1/task/thumb.webp?"
    )
    assert "signature=" in urls["thumbnail_url"]
    assert urls["image_fallback_url"] == "/api/assets/asset-1/original?direct=1"
    assert urls["preview_fallback_url"] == "/api/assets/asset-1/preview?direct=1"
    assert urls["thumbnail_fallback_url"] == "/api/assets/asset-1/thumb?direct=1"


def test_image_history_item_accepts_text_to_image_result_with_asset():
    item = history_artifacts.image_history_item({
        "conversation_id": "conv-1",
        "conversation_title": "Image chat",
        "message_id": "msg-1",
        "prompt": "draw a cat",
        "created_at": "2026-01-01T00:00:00",
        "request_meta": {"type": "image_request", "source": "mobile"},
        "meta": {"type": "image_result", "asset_id": "asset-1", "task_id": "task-1", "source": "mobile"},
    })

    assert item is not None
    assert item["job_id"] == "task-1"
    assert item["thumbnail_url"] == "/api/assets/asset-1/thumb"
    assert item["status"] == "completed"


def test_image_history_item_keeps_mobile_retouch_results_in_image_history():
    item = history_artifacts.image_history_item({
        "conversation_id": "retouch-conv",
        "message_id": "retouch-msg",
        "prompt": "移除画笔标注区域的杂物",
        "request_meta": {"type": "image_request", "source": "mobile_retouch_image2_shortcut"},
        "meta": {
            "type": "image_result",
            "asset_id": "retouch-asset",
            "task_id": "retouch-task",
            "source": "mobile_retouch_image2_shortcut",
        },
    })

    assert item is not None
    assert item["source"] == "mobile_retouch_image2_shortcut"
    assert item["image_url"] == "/api/assets/retouch-asset/original"


def test_image_history_item_excludes_web_image2_shortcut_from_text_to_image_history():
    item = history_artifacts.image_history_item({
        "conversation_id": "shortcut-conv",
        "message_id": "shortcut-msg",
        "prompt": "replace the selected object",
        "request_meta": {"type": "image_request", "source": "image2_shortcut"},
        "meta": {
            "type": "image_result",
            "asset_id": "shortcut-asset",
            "task_id": "shortcut-task",
            "source": "image2_shortcut",
        },
    })

    assert item is None


def test_image_history_item_excludes_workflow_edit_even_when_saved_as_web_bottom():
    item = history_artifacts.image_history_item({
        "conversation_id": "workflow-conv",
        "message_id": "workflow-msg",
        "prompt": "REFERENCE IMAGE CONTRACT (must follow):\n- Input image 1 is the current workflow image",
        "request_meta": {"type": "image_request", "source": "web-bottom"},
        "meta": {
            "type": "image_result",
            "asset_id": "workflow-asset",
            "task_id": "workflow-task",
            "source": "web-bottom",
        },
    })

    assert item is None


def test_message_history_summary_keeps_list_card_fields_only():
    summary = history_artifacts.message_history_summary({
        "type": "image_result",
        "source": "mobile",
        "status": "failed",
        "error": "upstream",
        "task_id": "task-1",
        "asset_id": "asset-1",
        "image_url": "/api/assets/asset-1/original",
        "preview_b64": "a" * 400,
        "images": ["huge"],
        "versions": [{"renderedB64": "x"}],
    })

    assert summary["job_id"] == "task-1"
    assert summary["asset_id"] == "asset-1"
    assert "preview_b64" not in summary
    assert "images" not in summary
    assert "versions" not in summary


def test_poster_history_summary_keeps_asset_backed_versions_without_inline_pixels():
    summary = history_artifacts.message_history_summary({
        "type": "poster_artifact",
        "job_id": "poster-job-1",
        "posters": [{
            "id": "poster-1",
            "poster_index": 0,
            "number": "01",
            "title": "Poster 1",
            "selected_version_index": 1,
            "versions": [
                {"id": "v1", "assetId": "asset-1", "renderedB64": "x" * 10000, "title": "First"},
                {"id": "v2", "assetId": "asset-2", "renderedB64": "y" * 10000, "title": "Second"},
            ],
        }],
    })

    assert summary["posters"][0]["selected_version_index"] == 1
    assert [version["assetId"] for version in summary["posters"][0]["versions"]] == ["asset-1", "asset-2"]
    assert "renderedB64" not in summary["posters"][0]["versions"][0]


def test_poster_history_summary_marks_legacy_inline_artifacts_without_returning_pixels():
    inline_image = "data:image/png;base64," + "x" * 120_000
    summary = history_artifacts.message_history_summary({
        "type": "poster_artifact",
        "job_id": "legacy-poster-job",
        "posters": [{
            "id": "poster-legacy",
            "selected_version_index": 0,
            "versions": [{
                "id": "legacy-version",
                "renderedB64": inline_image,
                "imageUrl": inline_image,
            }],
        }],
    })

    payload = json.dumps(summary)
    version = summary["posters"][0]["versions"][0]
    assert version["legacy_inline_artifact"] is True
    assert "data:image/" not in payload
    assert len(payload) < 5_000
    assert "image_url" not in summary


def test_poster_history_summary_does_not_copy_large_editor_plan_into_list_projection():
    summary = history_artifacts.message_history_summary({
        "type": "poster_artifact",
        "job_id": "poster-compact-job",
        "posters": [{
            "id": "poster-1",
            "title": "A poster",
            "visual_plan": "verbose editor plan " * 20_000,
            "versions": [{
                "id": "v1",
                "assetId": "poster-asset-1",
                "prompt": "verbose generation prompt " * 20_000,
            }],
        }],
    })

    payload = json.dumps(summary)

    assert "visual_plan" not in payload
    assert "verbose generation prompt" not in payload
    assert len(payload) < 8_000


def test_image_history_item_keeps_web_bottom_fallback_results_in_image_history():
    item = history_artifacts.image_history_item({
        "conversation_id": "web-bottom-conv",
        "message_id": "web-bottom-msg",
        "request_meta": {"type": "image_request", "source": "web-bottom"},
        "meta": {"type": "image_result", "asset_id": "web-bottom-asset", "source": "web-bottom"},
    })

    assert item is not None
    assert item["source"] == "web-bottom"


def test_image_history_item_rejects_non_text_to_image_result():
    item = history_artifacts.image_history_item({
        "conversation_id": "conv-1",
        "message_id": "msg-1",
        "request_meta": {"type": "image_request", "source": "layer-edit"},
        "meta": {"type": "image_result", "image_b64": "abc"},
    })

    assert item is None


def test_poster_history_item_uses_selected_version_thumbnail_and_status():
    item = history_artifacts.poster_history_item({
        "id": "conv-poster",
        "title": "Poster",
        "message_count": 3,
        "meta": {
            "job_id": "poster-job",
            "posters": [{
                "selected_version_index": 1,
                "versions": [{"previewUrl": "old"}, {"thumbnailUrl": "thumb"}],
            }],
        },
        "request_meta": {"poster_count": 1},
    })

    assert item["status"] == "preview"
    assert item["poster_count"] == 1
    assert item["thumbnail_url"] == "thumb"


def test_poster_history_item_builds_asset_urls_when_selected_version_only_has_asset_id():
    item = history_artifacts.poster_history_item({
        "id": "conv-poster-asset-only",
        "meta": {
            "posters": [{
                "selected_version_index": 0,
                "versions": [{"assetId": "poster-asset-1"}],
            }],
        },
    })

    assert item["thumbnail_url"] == "/api/assets/poster-asset-1/thumb"
    assert item["preview_url"] == "/api/assets/poster-asset-1/preview"
    assert item["image_url"] == "/api/assets/poster-asset-1/original"
    assert item["asset_id"] == "poster-asset-1"


def test_poster_history_item_signs_selected_version_asset_keys(monkeypatch):
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")

    version = {
        "assetId": "poster-asset-1",
        "assetOriginalKey": "assets/poster/original.png",
        "assetPreviewKey": "assets/poster/preview.webp",
        "assetThumbKey": "assets/poster/thumb.webp",
    }
    direct = asset_storage.client_image_asset_urls(version, allow_delivery_keys=True)
    version.update({
        "imageUrl": direct["image_url"],
        "previewUrl": direct["preview_url"],
        "thumbnailUrl": direct["thumbnail_url"],
    })
    item = history_artifacts.poster_history_item({
        "id": "conv-poster-direct",
        "meta": {
            "posters": [{
                "selected_version_index": 0,
                "versions": [version],
            }],
        },
    })

    assert item["thumbnail_url"].startswith(
        "https://image.example.com/cdn-assets/assets/poster/thumb.webp?"
    )
    assert item["thumbnail_fallback_url"] == "/api/assets/poster-asset-1/thumb?direct=1"


def test_poster_history_item_accepts_list_card_projection():
    item = history_artifacts.poster_history_item({
        "id": "conv-poster-proj",
        "title": "Poster",
        "meta": {
            "type": "poster_artifact",
            "job_id": "poster-job",
            "asset_id": "poster-asset-1",
            "poster_count": 2,
            "has_artifact": True,
            "thumbnail_url": "/api/assets/poster-asset-1/thumb",
        },
    })

    assert item["status"] == "preview"
    assert item["poster_count"] == 2
    assert item["asset_id"] == "poster-asset-1"
    assert item["thumbnail_url"] == "/api/assets/poster-asset-1/thumb"


def test_sci_fig_history_item_uses_rendered_asset_thumb_and_preview_status():
    item = history_artifacts.sci_fig_history_item({
        "id": "conv-sci",
        "title": "Figure",
        "meta": {
            "job_id": "sci-job",
            "rendered_asset": {"asset_id": "asset-fig"},
            "status": "saved",
        },
        "request_meta": {"gen_mode": "svg", "category": "data_chart"},
    })

    assert item["status"] == "preview"
    assert item["thumbnail_url"] == "/api/assets/asset-fig/thumb"
    assert item["gen_mode"] == "svg"


def test_sci_fig_history_item_signs_rendered_asset_key(monkeypatch):
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_BASE_URL", "https://image.example.com/cdn-assets")
    monkeypatch.setattr(asset_storage.settings, "ASSET_DELIVERY_SIGNING_KEY", "test-signing-key")

    rendered_asset = {
        "asset_id": "asset-fig",
        "asset_original_key": "assets/sci/original.png",
        "asset_preview_key": "assets/sci/preview.webp",
        "asset_thumb_key": "assets/sci/thumb.webp",
    }
    rendered_asset.update(
        asset_storage.client_image_asset_urls(rendered_asset, allow_delivery_keys=True)
    )
    item = history_artifacts.sci_fig_history_item({
        "id": "conv-sci-direct",
        "meta": {
            "rendered_asset": rendered_asset,
        },
    })

    assert item["thumbnail_url"].startswith(
        "https://image.example.com/cdn-assets/assets/sci/thumb.webp?"
    )
    assert item["thumbnail_fallback_url"] == "/api/assets/asset-fig/thumb?direct=1"


def test_sci_fig_history_item_accepts_list_card_projection():
    item = history_artifacts.sci_fig_history_item({
        "id": "conv-sci-proj",
        "title": "Figure",
        "meta": {
            "type": "sci_fig_artifact",
            "asset_id": "asset-fig",
            "has_artifact": True,
            "gen_mode": "svg",
            "thumbnail_url": "/api/assets/asset-fig/thumb",
        },
        "request_meta": {"category": "data_chart"},
    })

    assert item["status"] == "preview"
    assert item["has_artifact"] is True
    assert item["asset_id"] == "asset-fig"
    assert item["gen_mode"] == "svg"


def test_sci_fig_history_item_defaults_legacy_records_to_image2():
    item = history_artifacts.sci_fig_history_item({
        "id": "conv-sci-default-mode",
        "meta": {"job_id": "sci-default-mode"},
        "request_meta": {},
    })

    assert item["gen_mode"] == "image2"
