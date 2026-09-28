import copy

import pytest

from routers import poster


def test_poster_output_resolution_maps_to_valid_native_sizes():
    assert poster._poster_output_size("a3_landscape", "2k") == "2016x1344"
    assert poster._poster_output_size("a3_landscape", "4k") == "3456x2304"
    assert poster._poster_output_size("a3_portrait", "4k") == "2304x3456"
    assert poster._poster_output_size("square", "4k") == "2880x2880"


def test_poster_status_keeps_inline_result_when_archive_is_unavailable():
    result = poster._compact_posters_for_status([{
        "id": "poster-1",
        "versions": [{"id": "inline", "renderedB64": "image-bytes"}],
    }])

    assert result[0]["versions"][0]["renderedB64"] == "image-bytes"


def test_poster_status_strips_inline_result_after_durable_archive_exists():
    result = poster._compact_posters_for_status([{
        "id": "poster-1",
        "versions": [{
            "id": "archived",
            "renderedB64": "image-bytes",
            "assetId": "asset-1",
            "previewUrl": "/api/assets/asset-1/preview",
        }],
    }])

    assert "renderedB64" not in result[0]["versions"][0]


@pytest.mark.asyncio
async def test_poster_artifact_message_ignores_selection_only_changes(monkeypatch):
    recorded: list[dict] = []

    async def noop(*args, **kwargs):
        return None

    async def record_message(state, role, content, meta):
        recorded.append({
            "role": role,
            "content": content,
            "meta": copy.deepcopy(meta),
        })
        return {"id": f"message-{len(recorded)}"}

    monkeypatch.setattr(poster, "_ensure_conversation", noop)
    monkeypatch.setattr(poster, "_attach_poster_assets_to_message", noop)
    monkeypatch.setattr(poster, "_save_state", noop)
    monkeypatch.setattr(poster, "_record_message", record_message)

    state = {
        "job_id": "poster-job-1",
        "conversation_id": "conversation-1",
        "user_id": "user-1",
        "size": "a3_portrait",
        "agent_plan": {},
        "agent_steps": [],
        "selected_versions": [0],
        "posters": [{
            "id": "poster-1",
            "poster_index": 0,
            "number": "01",
            "title": "Poster",
            "selected_version_index": 0,
            "versions": [
                {"id": "version-1", "renderedB64": "one"},
                {"id": "version-2", "renderedB64": "two"},
            ],
        }],
    }

    await poster._save_artifact_message(state)
    assert len(recorded) == 1

    state["posters"][0]["selected_version_index"] = 1
    state["selected_versions"] = [1]
    await poster._save_artifact_message(state)

    assert len(recorded) == 1


@pytest.mark.asyncio
async def test_select_version_persists_selection_without_writing_artifact(monkeypatch):
    state = {
        "job_id": "poster-job-1",
        "user_id": "user-1",
        "selected_versions": [0],
        "posters": [{
            "selected_version_index": 0,
            "versions": [
                {"id": "version-1", "renderedB64": "one"},
                {"id": "version-2", "renderedB64": "two"},
            ],
        }],
    }
    save_calls: list[dict] = []
    artifact_calls = 0

    async def load_state(job_id):
        assert job_id == "poster-job-1"
        return state

    async def save_state(job_id, next_state):
        assert job_id == "poster-job-1"
        save_calls.append(copy.deepcopy(next_state))

    async def save_artifact_message(next_state):
        nonlocal artifact_calls
        artifact_calls += 1

    monkeypatch.setattr(poster, "_load_state", load_state)
    monkeypatch.setattr(poster, "_save_state", save_state)
    monkeypatch.setattr(poster, "_save_artifact_message", save_artifact_message)

    result = await poster.select_version(
        "poster-job-1",
        poster.PosterSelectVersionRequest(poster_index=0, version_index=1),
        {"id": "user-1"},
    )

    assert result == {"ok": True, "selected_versions": [1]}
    assert state["posters"][0]["selected_version_index"] == 1
    assert save_calls[-1]["selected_versions"] == [1]
    assert artifact_calls == 0
