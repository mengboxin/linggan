from unittest.mock import AsyncMock

import pytest


def attachment(filename: str, text: str, size: int = 12) -> dict:
    return {
        "filename": filename,
        "kind": "text",
        "text": text,
        "size": size,
        "warnings": [],
    }


@pytest.mark.asyncio
async def test_poster_refine_merges_new_attachments_into_job_state(monkeypatch):
    from routers import poster

    state = {
        "job_id": "poster-job",
        "user_id": "user-1",
        "status": "preview",
        "posters": [{"versions": [{"renderedB64": "image"}]}],
        "attachments": [attachment("brief.txt", "old brief")],
        "attachment_context": "old brief",
    }
    save_state = AsyncMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(poster, "_load_state", AsyncMock(return_value=state))
    monkeypatch.setattr(poster, "_save_state", save_state)
    monkeypatch.setattr(poster, "_record_message", AsyncMock())
    monkeypatch.setattr(poster, "enqueue", enqueue)

    await poster.refine_poster(
        "poster-job",
        poster.PosterRefineRequest(
            poster_index=0,
            prompt="Use the updated figures",
            attachments=[attachment("data.csv", "revenue,42")],
        ),
        {"id": "user-1"},
    )

    assert [item["filename"] for item in state["attachments"]] == ["brief.txt", "data.csv"]
    assert "old brief" in state["attachment_context"]
    assert "revenue,42" in state["attachment_context"]
    save_state.assert_awaited()
    enqueue.assert_awaited_once()


@pytest.mark.asyncio
async def test_sci_fig_refine_merges_new_attachments_into_job_state(monkeypatch):
    from routers import sci_fig

    state = {
        "job_id": "sci-job",
        "user_id": "user-1",
        "status": "preview",
        "gen_mode": "image2",
        "rendered_b64": "image",
        "attachments": [attachment("paper.txt", "baseline result")],
        "attachment_context": "baseline result",
    }
    save_state = AsyncMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(sci_fig, "_load_state", AsyncMock(return_value=state))
    monkeypatch.setattr(sci_fig, "_save_state", save_state)
    monkeypatch.setattr(sci_fig, "enqueue", enqueue)

    await sci_fig.refine_figure(
        "sci-job",
        sci_fig.SciFigRefineRequest(
            code_feedback="Update the chart with the new sample",
            attachments=[attachment("sample.csv", "group,value\nA,8")],
        ),
        {"id": "user-1"},
    )

    assert [item["filename"] for item in state["attachments"]] == ["paper.txt", "sample.csv"]
    assert "baseline result" in state["attachment_context"]
    assert "group,value" in state["attachment_context"]
    save_state.assert_awaited()
    enqueue.assert_awaited_once()


@pytest.mark.asyncio
async def test_ppt_slide_edit_merges_new_attachments_into_job_state(monkeypatch):
    from routers import ppt

    state = {
        "job_id": "ppt-job",
        "user_id": "user-1",
        "status": "checkpoint",
        "outline": {"slides": [{"title": "Slide 1"}]},
        "image_slide_decks": [{
            "id": "slide-1",
            "title": "Slide 1",
            "versions": ["image"],
            "selected_version_index": 0,
        }],
        "attachments": [attachment("outline.txt", "original outline")],
        "attachment_context": "original outline",
    }
    save_state = AsyncMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(ppt._agent, "get_state", AsyncMock(return_value=state))
    monkeypatch.setattr(ppt, "save_ppt_state", save_state)
    monkeypatch.setattr(ppt, "enqueue", enqueue)

    await ppt.queue_slide_render(
        "ppt-job",
        ppt.SlideRenderRequest(
            prompt="Refresh the KPI page",
            slide_index=0,
            source_image_b64="image",
            attachments=[attachment("kpi.csv", "metric,value\nARR,120")],
        ),
        {"id": "user-1"},
    )

    assert [item["filename"] for item in state["attachments"]] == ["outline.txt", "kpi.csv"]
    assert "original outline" in state["attachment_context"]
    assert "ARR,120" in state["attachment_context"]
    save_state.assert_awaited()
    enqueue.assert_awaited_once()
