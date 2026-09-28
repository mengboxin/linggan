import io

import pytest
from PIL import Image


def _tiny_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (1, 1), "white").save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_sci_fig_pdf_download_recovers_selected_remote_asset(monkeypatch):
    from routers import sci_fig

    png = _tiny_png()
    state = {
        "job_id": "job-1",
        "user_id": "user-1",
        "status": "done",
        "rendered_b64": "",
        "artifact_versions": [{"assetId": "asset-1"}],
        "selected_version_index": 0,
    }

    async def fake_load_state(job_id: str):
        assert job_id == "job-1"
        return state

    async def fake_fetch_variant(asset_id: str, user_id: str, variant: str):
        assert (asset_id, user_id, variant) == ("asset-1", "user-1", "original")
        return png, "image/png"

    monkeypatch.setattr(sci_fig, "_load_state", fake_load_state)
    monkeypatch.setattr(sci_fig.asset_storage, "fetch_image_asset_variant", fake_fetch_variant)

    response = await sci_fig.get_result("job-1", format="pdf", user={"id": "user-1"})

    assert response.media_type == "application/pdf"
    assert response.body.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_sci_fig_pdf_download_recovers_expired_job_from_history(monkeypatch):
    from routers import sci_fig

    png = _tiny_png()

    async def fake_load_state(job_id: str):
        assert job_id == "job-1"
        return None

    async def fake_find_messages(job_id: str, user_id: str, conv_type: str | None = None):
        assert (job_id, user_id, conv_type) == ("job-1", "user-1", "sci-fig")
        return [{
            "conversation_id": "conv-1",
            "meta": {
                "type": "sci_fig_artifact",
                "job_id": "job-1",
                "status": "done",
                "artifact_versions": [{"assetId": "asset-1"}],
                "selected_version_index": 0,
            },
        }]

    async def fake_fetch_variant(asset_id: str, user_id: str, variant: str):
        assert (asset_id, user_id, variant) == ("asset-1", "user-1", "original")
        return png, "image/png"

    monkeypatch.setattr(sci_fig, "_load_state", fake_load_state)
    monkeypatch.setattr(sci_fig.conversation_repo, "find_messages_by_job_id", fake_find_messages)
    monkeypatch.setattr(sci_fig.asset_storage, "fetch_image_asset_variant", fake_fetch_variant)

    response = await sci_fig.get_result("job-1", format="pdf", user={"id": "user-1"})

    assert response.media_type == "application/pdf"
    assert response.body.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_ppt_download_allows_ready_pptx_key_even_when_status_is_not_done(monkeypatch):
    from routers import ppt

    async def fake_get_state(job_id: str):
        assert job_id == "job-1"
        return {
            "status": "checkpoint",
            "pptx_key": "assets/users/user-1/ppt/job-1/files/latest.pptx",
            "pptx_filename": "demo.pptx",
        }

    async def fake_sync_filename(state: dict, job_id: str, user_id: str, filename: str):
        assert state["status"] == "checkpoint"
        assert (job_id, user_id, filename) == ("job-1", "user-1", "")
        return "demo.pptx"

    async def fake_fetch_key(key: str):
        assert key == "assets/users/user-1/ppt/job-1/files/latest.pptx"
        return b"pptx-bytes"

    monkeypatch.setattr(ppt._agent, "get_state", fake_get_state)
    monkeypatch.setattr(ppt, "_sync_pptx_filename", fake_sync_filename)
    monkeypatch.setattr(ppt.asset_storage, "fetch_asset_key_bytes", fake_fetch_key)

    response = await ppt.download_pptx("job-1", filename="", user={"id": "user-1"})

    assert response.media_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    assert response.body == b"pptx-bytes"


@pytest.mark.asyncio
async def test_ppt_download_recovers_expired_job_from_history(monkeypatch):
    from routers import ppt

    async def fake_get_state(job_id: str):
        assert job_id == "job-1"
        return None

    async def fake_find_messages(job_id: str, user_id: str, conv_type: str | None = None):
        assert (job_id, user_id, conv_type) == ("job-1", "user-1", "ppt")
        return [{
            "conversation_id": "conv-1",
            "meta": {
                "type": "pptx_done",
                "job_id": "job-1",
                "status": "done",
                "pptx_key": "assets/users/user-1/ppt/job-1/files/latest.pptx",
                "pptx_filename": "history.pptx",
            },
        }]

    async def fake_sync_filename(state: dict, job_id: str, user_id: str, filename: str):
        assert state["pptx_key"] == "assets/users/user-1/ppt/job-1/files/latest.pptx"
        assert (job_id, user_id, filename) == ("job-1", "user-1", "")
        return "history.pptx"

    async def fake_fetch_key(key: str):
        assert key == "assets/users/user-1/ppt/job-1/files/latest.pptx"
        return b"pptx-history-bytes"

    monkeypatch.setattr(ppt._agent, "get_state", fake_get_state)
    monkeypatch.setattr(ppt.conversation_repo, "find_messages_by_job_id", fake_find_messages)
    monkeypatch.setattr(ppt, "_sync_pptx_filename", fake_sync_filename)
    monkeypatch.setattr(ppt.asset_storage, "fetch_asset_key_bytes", fake_fetch_key)

    response = await ppt.download_pptx("job-1", filename="", user={"id": "user-1"})

    assert response.media_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    assert response.body == b"pptx-history-bytes"
