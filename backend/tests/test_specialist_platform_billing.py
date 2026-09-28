from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


async def _invoke_billed(**kwargs):
    return await kwargs["invoke"]()


@pytest.mark.asyncio
async def test_poster_generation_uses_job_operation_key_without_task_fk(monkeypatch):
    from routers import poster

    billed = AsyncMock(side_effect=_invoke_billed)
    transport = AsyncMock(return_value=b"poster")
    monkeypatch.setattr(poster, "execute_billed_model_call", billed)

    result = await poster._execute_poster_model_call(
        state={"job_id": "poster-job-1", "user_id": "user-1"},
        model_id="image-model",
        category="generate",
        description="poster generation",
        operation="poster-1:generate",
        attempt=2,
        material={"prompt": "draw a red poster", "image": b"private-reference"},
        invoke=transport,
    )

    assert result == b"poster"
    assert billed.await_args.kwargs["related_task_id"] is None
    first_key = billed.await_args.kwargs["idempotency_key"]

    await poster._execute_poster_model_call(
        state={"job_id": "poster-job-1", "user_id": "user-1"},
        model_id="image-model",
        category="generate",
        description="poster generation",
        operation="poster-1:generate",
        attempt=2,
        material={"prompt": "draw a red poster", "image": b"private-reference"},
        invoke=transport,
    )
    replay_key = billed.await_args.kwargs["idempotency_key"]

    await poster._execute_poster_model_call(
        state={"job_id": "poster-job-1", "user_id": "user-1"},
        model_id="image-model",
        category="generate",
        description="poster generation",
        operation="poster-1:generate",
        attempt=2,
        material={"prompt": "draw a blue poster", "image": b"private-reference"},
        invoke=transport,
    )
    changed_key = billed.await_args.kwargs["idempotency_key"]

    assert first_key == replay_key
    assert first_key != changed_key
    assert first_key.startswith("model:poster:")
    assert len(first_key) < 120
    assert "draw a red poster" not in first_key
    assert "private-reference" not in first_key


@pytest.mark.asyncio
async def test_sci_generation_operation_key_changes_with_model_request_material(monkeypatch):
    from routers import sci_fig

    billed = AsyncMock(side_effect=_invoke_billed)
    transport = AsyncMock(return_value=b"figure")
    monkeypatch.setattr(sci_fig, "execute_billed_model_call", billed)
    common = {
        "state": {"job_id": "sci-job-1", "user_id": "user-1"},
        "model_id": "image-model",
        "category": "generate",
        "description": "scientific figure generation",
        "operation": "image2-generate",
        "attempt": 1,
        "invoke": transport,
    }

    await sci_fig._execute_sci_model_call(
        **common,
        material={"prompt": "draw pathway A", "reference": b"private-reference"},
    )
    first_key = billed.await_args.kwargs["idempotency_key"]
    await sci_fig._execute_sci_model_call(
        **common,
        material={"prompt": "draw pathway A", "reference": b"private-reference"},
    )
    replay_key = billed.await_args.kwargs["idempotency_key"]
    await sci_fig._execute_sci_model_call(
        **common,
        material={"prompt": "draw pathway B", "reference": b"private-reference"},
    )
    changed_key = billed.await_args.kwargs["idempotency_key"]

    assert first_key == replay_key
    assert first_key != changed_key
    assert first_key.startswith("model:sci-fig:")
    assert len(first_key) < 120
    assert "draw pathway" not in first_key
    assert "private-reference" not in first_key


@pytest.mark.asyncio
async def test_poster_optional_review_does_not_swallow_billing_error(monkeypatch):
    from routers import poster

    monkeypatch.setattr(
        poster,
        "execute_billed_model_call",
        AsyncMock(side_effect=HTTPException(503, "billing unavailable")),
    )
    state = {"job_id": "poster-job-1", "user_id": "user-1", "description": "poster"}

    with pytest.raises(HTTPException) as exc_info:
        await poster._poster_variant_review_node({
            "state": state,
            "poster_index": 0,
            "poster_plan": {},
            "repair_attempt": 1,
            "review_model_id": "vision-model",
            "candidate_image": b"png",
        })

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_poster_reference_analysis_stays_disabled_without_explicit_reviewer(monkeypatch):
    from routers import poster

    choose_reviewer = AsyncMock(return_value="default-vision-model")
    load_references = AsyncMock(return_value=[b"png"])
    monkeypatch.setattr(
        poster.provider_policy,
        "choose_vision_model_id",
        choose_reviewer,
    )
    monkeypatch.setattr(
        poster,
        "load_original_reference_bytes",
        load_references,
    )

    result = await poster._analyze_reference({
        "job_id": "poster-job-1",
        "user_id": "user-1",
        "vision_model_id": "",
        "reference_assets": [{"asset_id": "reference-1"}],
    })

    assert result == {}
    choose_reviewer.assert_not_awaited()
    load_references.assert_not_awaited()


@pytest.mark.asyncio
async def test_sci_figure_qa_uses_stable_ledger_key_and_no_task_fk(monkeypatch):
    from routers import sci_fig

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(sci_fig, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_vision_model_id",
        AsyncMock(return_value="vision-model"),
    )
    monkeypatch.setattr(
        sci_fig,
        "call_vision",
        AsyncMock(return_value='{"pass": true, "score": 0.9, "issues": []}'),
    )
    state = {
        "job_id": "sci-job-1",
        "user_id": "user-1",
        "vision_model_id": "vision-model",
        "description": "figure",
        "category": "schematic",
        "style_preset": "nature",
    }

    result = await sci_fig._qa_sci_figure(state, "cG5n", "draw")

    assert result["pass"] is True
    assert billed.await_args.kwargs["related_task_id"] is None
    assert billed.await_args.kwargs["idempotency_key"].startswith("model:sci-fig:")


@pytest.mark.asyncio
async def test_sci_figure_qa_does_not_swallow_billing_error(monkeypatch):
    from routers import sci_fig

    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_vision_model_id",
        AsyncMock(return_value="vision-model"),
    )
    monkeypatch.setattr(
        sci_fig,
        "execute_billed_model_call",
        AsyncMock(side_effect=HTTPException(402, "insufficient credits")),
    )

    with pytest.raises(HTTPException) as exc_info:
        await sci_fig._qa_sci_figure(
            {"job_id": "sci-job-1", "user_id": "user-1"},
            "cG5n",
            "draw",
        )

    assert exc_info.value.status_code == 402


@pytest.mark.asyncio
async def test_poster_optimize_uses_client_operation_key(monkeypatch):
    from routers import poster

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(
        poster.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-model"),
    )
    monkeypatch.setattr(poster, "execute_billed_model_call", billed)
    monkeypatch.setattr(poster, "call_chat", AsyncMock(return_value="optimized"))

    result = await poster.optimize_prompt(
        poster.PosterOptimizeRequest(
            description="poster",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )

    assert result == {"optimized": "optimized"}
    first_key = billed.await_args.kwargs["idempotency_key"]
    await poster.optimize_prompt(
        poster.PosterOptimizeRequest(
            description="poster",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )
    replay_key = billed.await_args.kwargs["idempotency_key"]
    await poster.optimize_prompt(
        poster.PosterOptimizeRequest(
            description="different poster",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )
    changed_key = billed.await_args.kwargs["idempotency_key"]

    assert first_key == replay_key
    assert first_key != changed_key
    assert first_key.startswith("model:poster:")
    assert billed.await_args.kwargs["related_task_id"] is None


@pytest.mark.asyncio
async def test_sci_optimize_uses_client_operation_key(monkeypatch):
    from routers import sci_fig

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-model"),
    )
    monkeypatch.setattr(sci_fig, "execute_billed_model_call", billed)
    monkeypatch.setattr(sci_fig, "call_chat", AsyncMock(return_value="optimized"))

    result = await sci_fig.optimize_description(
        sci_fig.SciFigOptimizeRequest(
            description="figure",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )

    assert result == {"optimized": "optimized"}
    first_key = billed.await_args.kwargs["idempotency_key"]
    await sci_fig.optimize_description(
        sci_fig.SciFigOptimizeRequest(
            description="figure",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )
    replay_key = billed.await_args.kwargs["idempotency_key"]
    await sci_fig.optimize_description(
        sci_fig.SciFigOptimizeRequest(
            description="different figure",
            client_request_id="request-1",
        ),
        user={"id": "user-1"},
    )
    changed_key = billed.await_args.kwargs["idempotency_key"]

    assert first_key == replay_key
    assert first_key != changed_key
    assert first_key.startswith("model:sci-fig:")
    assert billed.await_args.kwargs["related_task_id"] is None


@pytest.mark.asyncio
async def test_paper_planner_uses_input_stable_key_and_propagates_billing(monkeypatch):
    from services.agents import paper_agent

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(paper_agent, "execute_billed_model_call", billed)
    monkeypatch.setattr(paper_agent, "_model_id", AsyncMock(return_value="llm-model"))
    monkeypatch.setattr(
        paper_agent,
        "call_chat",
        AsyncMock(return_value='{"title": "Paper", "sections": [], "figures": []}'),
    )
    state = {
        "job_id": "paper-job-1",
        "user_id": "user-1",
        "topic": "topic",
        "objective": "objective",
        "journal_style": "",
        "answers": {},
    }

    await paper_agent._call_planner(state, [])
    first_key = billed.await_args.kwargs["idempotency_key"]
    await paper_agent._call_planner(state, [])

    assert billed.await_args.kwargs["related_task_id"] is None
    assert billed.await_args.kwargs["idempotency_key"] == first_key
    assert first_key.startswith("paper:paper-job-1:outline-plan:")

    monkeypatch.setattr(
        paper_agent,
        "execute_billed_model_call",
        AsyncMock(side_effect=HTTPException(503, "billing unavailable")),
    )
    with pytest.raises(HTTPException):
        await paper_agent._call_planner(state, [])


@pytest.mark.asyncio
async def test_paper_manuscript_uses_stable_key_without_task_fk(monkeypatch):
    from services.agents import paper_agent

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(paper_agent, "execute_billed_model_call", billed)
    monkeypatch.setattr(paper_agent, "_model_id", AsyncMock(return_value="llm-model"))
    monkeypatch.setattr(paper_agent, "call_chat", AsyncMock(return_value="# Draft"))
    state = {
        "job_id": "paper-job-1",
        "user_id": "user-1",
        "topic": "topic",
        "objective": "objective",
        "answers": {},
        "outline": {"title": "Paper", "sections": []},
        "evidence_ledger": [],
    }

    assert await paper_agent._write_manuscript(state) == "# Draft"
    first_key = billed.await_args.kwargs["idempotency_key"]
    assert await paper_agent._write_manuscript(state) == "# Draft"

    assert billed.await_args.kwargs["idempotency_key"] == first_key
    assert first_key.startswith("paper:paper-job-1:manuscript:")
    assert billed.await_args.kwargs["expected_category"] == "llm"
    assert billed.await_args.kwargs["related_task_id"] is None


@pytest.mark.asyncio
async def test_paper_chat_uses_stable_turn_key_without_task_fk(monkeypatch):
    from services.agents import paper_agent

    billed = AsyncMock(side_effect=_invoke_billed)
    state = {
        "job_id": "paper-job-1",
        "user_id": "user-1",
        "topic": "topic",
        "objective": "objective",
        "status": "awaiting_confirmation",
        "outline": {},
        "evidence_ledger": [],
        "chat_messages": [],
        "worklog": [],
    }
    monkeypatch.setattr(paper_agent.paper_agent, "get_state", AsyncMock(return_value=state))
    monkeypatch.setattr(paper_agent, "_save_state", AsyncMock())
    monkeypatch.setattr(paper_agent, "_model_id", AsyncMock(return_value="llm-model"))
    monkeypatch.setattr(paper_agent, "execute_billed_model_call", billed)
    monkeypatch.setattr(paper_agent, "call_chat", AsyncMock(return_value="reply"))

    result = await paper_agent.paper_agent.chat(
        "paper-job-1",
        user_id="user-1",
        content="explain the outline",
    )

    assert result is state
    assert billed.await_args.kwargs["idempotency_key"].startswith(
        "paper:paper-job-1:chat:1:"
    )
    assert billed.await_args.kwargs["expected_category"] == "llm"
    assert billed.await_args.kwargs["related_task_id"] is None
