from core import ppt_workspace
from repositories import conversation_repo


def test_serialize_image_slide_decks_merges_duplicate_version_artifacts_once():
    state = {
        "outline": {"slides": [{"title": "Intro"}]},
        "image_slide_decks": [{
            "id": "slide-1",
            "title": "Intro",
            "versions": ["original"],
            "selectedVersionIndex": 0,
        }],
        "artifacts": [
            {"type": "slide_version", "slide_index": 0, "image_b64": "data:image/png;base64,variant", "prompt": "make brighter"},
            {"type": "slide_version", "slide_index": 0, "image_b64": "variant", "prompt": "make brighter"},
        ],
    }

    decks = ppt_workspace.serialize_image_slide_decks(state)

    assert decks[0]["versions"] == ["original", "variant"]
    assert decks[0]["selectedVersionIndex"] == 1
    assert decks[0]["slide"]["page"] == 1


def test_workspace_state_from_messages_restores_preview_and_versions_idempotently():
    messages = [
        {
            "meta": {
                "type": "slides_preview",
                "job_id": "job-1",
                "outline": {"title": "Deck", "slides": [{"title": "Intro"}]},
                "template_id": "presenton-momentum",
                "preview_b64_list": ["base"],
                "slide_count": 1,
            }
        },
        {"meta": {"type": "slide_version", "job_id": "job-1", "slide_index": 0, "image_b64": "variant"}},
        {"meta": {"type": "slide_version", "job_id": "job-1", "slide_index": 0, "image_b64": "variant"}},
    ]

    state = ppt_workspace.workspace_state_from_messages(messages, "conv-1")

    assert state is not None
    assert state["job_id"] == "job-1"
    assert state["conversation_id"] == "conv-1"
    assert state["image_slide_decks"][0]["versions"] == ["base", "variant"]
    assert state["image_slide_decks"][0]["selectedVersionIndex"] == 1
    assert state["template_id"] == "presenton-momentum"


def test_workspace_payload_from_state_uses_canonical_slide_count_and_versions():
    state = {
        "job_id": "job-1",
        "conversation_id": "conv-1",
        "status": "checkpoint",
        "outline": {"slides": [{"title": "Intro"}]},
        "template_id": "presenton-momentum",
        "image_slide_decks": [{"versions": ["a", "b"], "selectedVersionIndex": 1}],
        "artifacts": [{"type": "pptx_done", "job_id": "job-1", "slide_count": 1, "pptx_filename": "deck.pptx"}],
    }

    payload = ppt_workspace.workspace_payload_from_state(
        state,
        "job-1",
        workspace_phase=lambda status: f"phase:{status}",
        clean_agent_steps=lambda steps: ["clean"],
        chat_messages_from_history=lambda messages: [{"role": "user", "content": "hi"}],
    )

    assert payload["phase"] == "phase:checkpoint"
    assert payload["slide_count"] == 1
    assert payload["slide_images"] == ["b"]
    assert payload["pptx_versions"] == [{"version": 1, "slide_count": 1, "created_at": "", "job_id": "job-1", "pptx_filename": "deck.pptx"}]
    assert payload["agent_steps"] == ["clean"]
    assert payload["chat_messages"] == [{"role": "user", "content": "hi"}]
    assert payload["template_id"] == "presenton-momentum"


def test_direct_workspace_pages_are_complete_before_the_optional_export_step():
    state = {
        "job_id": "job-direct",
        "conversation_id": "conv-direct",
        "status": "checkpoint",
        "progress": 82,
        "conversion_mode": "ppt_master_direct",
        "outline": {"slides": [{"title": "Overview"}]},
        "direct_slide_decks": [{
            "id": "direct-slide-1",
            "title": "Overview",
            "kind": "svg",
            "versions": ["PHN2Zy8+"],
            "selected_version_index": 0,
            "slide": {"title": "Overview"},
        }],
    }

    payload = ppt_workspace.workspace_payload_from_state(state, "job-direct")

    assert payload["status"] == "checkpoint"
    assert payload["pptx_ready"] is False
    assert payload["progress"] == 100


def test_direct_workspace_manifest_omits_embedded_svg_until_a_page_is_requested():
    embedded_svg = "very-large-inline-svg-" * 50_000
    state = {
        "job_id": "job-direct-large",
        "conversion_mode": "ppt_master_direct",
        "status": "checkpoint",
        "outline": {"slides": [{"title": "封面"}]},
        "direct_slide_decks": [{
            "id": "direct-slide-1",
            "title": "封面",
            "kind": "svg",
            "versions": [embedded_svg],
            "selected_version_index": 0,
            "slide": {"title": "封面"},
        }],
        "artifacts": [{"type": "direct_slide_version", "svg_b64": embedded_svg}],
    }

    payload = ppt_workspace.workspace_payload_from_state(
        state,
        "job-direct-large",
        include_direct_slide_content=False,
    )

    assert payload["slide_content_deferred"] is True
    assert payload["direct_slide_decks"] == [{
        "id": "direct-slide-1",
        "title": "封面",
        "prompt": "",
        "kind": "svg",
        "selectedVersionIndex": 0,
        "slide": {"title": "封面", "page": 1},
        "slide_index": 0,
        "version_count": 1,
        "deferred": True,
    }]
    assert "very-large-inline-svg" not in repr(payload)
    assert payload["artifacts"] == [{"type": "direct_slide_version"}]


def test_light_history_query_drops_direct_slide_decks():
    assert "direct_slide_decks" in conversation_repo.LIGHT_META_DROP_KEYS


def test_light_history_never_rebuilds_all_direct_svg_files(monkeypatch):
    calls = []
    monkeypatch.setattr(
        ppt_workspace,
        "direct_decks_from_artifacts",
        lambda artifacts, outline: calls.append((artifacts, outline)) or [],
    )

    state = ppt_workspace.workspace_state_from_messages([{
        "meta": {
            "_light": True,
            "type": "ppt_master_direct",
            "job_id": "job-direct-light",
            "conversion_mode": "ppt_master_direct",
            "outline": {"title": "Deck", "slides": [{"title": "封面"}]},
            "artifacts": [{"conversion_mode": "ppt_master_direct", "project_dir": "/legacy/project"}],
        },
    }], "conversation-direct-light")

    assert state is not None
    assert state["direct_slide_decks"] == []
    assert calls == []


def test_workspace_state_restores_outline_only_template_jobs():
    state = ppt_workspace.workspace_state_from_messages([{
        "meta": {
            "type": "outline",
            "job_id": "job-outline",
            "template_id": "presenton-modern",
            "outline": {"title": "Draft", "slides": [{"title": "Cover"}]},
        },
    }], "conv-outline")

    assert state is not None
    assert state["outline"]["title"] == "Draft"
    assert state["template_id"] == "presenton-modern"
    assert state["status"] == "outline_done"
