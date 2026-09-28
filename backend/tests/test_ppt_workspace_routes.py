from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_direct_slide_batch_keeps_the_agent_selected_offset(monkeypatch):
    """A bounded batch must not be sliced a second time by the route."""
    from routers import ppt

    selected_deck = {
        "id": "direct-slide-2",
        "title": "第二页",
        "versions": ["PHN2Zy8+"],
        "selected_version_index": 0,
        "slide": {"title": "第二页"},
    }
    batch = AsyncMock(return_value=([selected_deck], 6))
    monkeypatch.setattr(ppt._agent, "get_ppt_master_direct_slide_batch", batch)

    payload = await ppt.get_workspace_direct_slides(
        "ppt-job",
        offset=1,
        limit=1,
        user={"id": "user-1"},
    )

    batch.assert_awaited_once_with("ppt-job", 1, 1)
    assert payload["slide_total"] == 6
    assert payload["next_offset"] == 2
    assert payload["slides"] == [
        {
            "id": "direct-slide-2",
            "title": "第二页",
            "prompt": "",
            "kind": "svg",
            "versions": ["PHN2Zy8+"],
            "selectedVersionIndex": 0,
            "slide": {"title": "第二页", "page": 2},
            "slide_index": 1,
        },
    ]
