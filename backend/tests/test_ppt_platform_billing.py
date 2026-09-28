from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from services.agents import ppt_agent


def _outline(title: str) -> str:
    return json.dumps(
        {
            "title": title,
            "style": "editorial",
            "color_scheme": "navy",
            "slides": [
                {
                    "page": 1,
                    "title": title,
                    "type": "cover",
                    "points": ["specific point"],
                    "layout_hint": "full bleed",
                }
            ],
        },
        ensure_ascii=False,
    )


@pytest.mark.asyncio
async def test_outline_and_repair_are_billed_as_distinct_job_operations(monkeypatch):
    model_call = AsyncMock(side_effect=[_outline("first"), _outline("repaired")])
    billed_calls: list[dict] = []

    async def execute_billed(**kwargs):
        billed_calls.append(kwargs)
        return await kwargs["invoke"]()

    monkeypatch.setattr(ppt_agent, "get_default_model_id", AsyncMock(return_value="llm-default"))
    monkeypatch.setattr(ppt_agent, "call_chat", model_call)
    monkeypatch.setattr(ppt_agent, "execute_billed_model_call", execute_billed)
    monkeypatch.setattr(ppt_agent, "_outline_needs_repair", MagicMock(side_effect=[True, False]))

    result = await ppt_agent.generate_outline(
        "topic",
        user_id="user-1",
        job_id="job-1",
    )

    assert result["title"] == "repaired"
    assert [call["model_id"] for call in billed_calls] == ["llm-default", "llm-default"]
    assert [call["idempotency_key"] for call in billed_calls] == [
        "ppt:job-1:outline:attempt:1",
        "ppt:job-1:outline-repair:attempt:1",
    ]
    assert all(call["related_task_id"] is None for call in billed_calls)


@pytest.mark.asyncio
async def test_default_prompt_optimizer_uses_platform_billing_scope(monkeypatch):
    billed_calls: list[dict] = []

    async def execute_billed(**kwargs):
        billed_calls.append(kwargs)
        return await kwargs["invoke"]()

    monkeypatch.setattr(ppt_agent, "get_default_model_id", AsyncMock(return_value="llm-default"))
    monkeypatch.setattr(ppt_agent, "call_chat", AsyncMock(return_value="optimized"))
    monkeypatch.setattr(ppt_agent, "execute_billed_model_call", execute_billed)

    result = await ppt_agent.PPTAgent().optimize_prompt(
        "topic",
        user_id="user-1",
        operation_scope="request-1",
    )

    assert result == "optimized"
    assert billed_calls[0]["model_id"] == "llm-default"
    assert billed_calls[0]["idempotency_key"] == "ppt:request-1:optimize-topic:attempt:1"
    assert billed_calls[0]["related_task_id"] is None


@pytest.mark.asyncio
async def test_reference_analysis_is_billed_to_the_ppt_job(monkeypatch):
    billed_calls: list[dict] = []

    async def execute_billed(**kwargs):
        billed_calls.append(kwargs)
        return await kwargs["invoke"]()

    monkeypatch.setattr(ppt_agent, "call_vision", AsyncMock(return_value="reference guidance"))
    monkeypatch.setattr(ppt_agent, "execute_billed_model_call", execute_billed)

    result = await ppt_agent._analyze_reference_image_for_ppt(
        base64.b64encode(b"image").decode("ascii"),
        "vision-model",
        user_id="user-1",
        job_id="job-1",
    )

    assert result == "reference guidance"
    assert billed_calls[0]["idempotency_key"] == "ppt:job-1:reference-analysis:attempt:1"
    assert billed_calls[0]["expected_category"] == "vision"
    assert billed_calls[0]["related_task_id"] is None


@pytest.mark.asyncio
async def test_remove_text_model_call_uses_one_stable_slide_operation(monkeypatch):
    billed_calls: list[dict] = []

    async def execute_billed(**kwargs):
        billed_calls.append(kwargs)
        return await kwargs["invoke"]()

    monkeypatch.setattr(ppt_agent, "call_image", AsyncMock(return_value=b"clean"))
    monkeypatch.setattr(ppt_agent, "execute_billed_model_call", execute_billed)

    result = await ppt_agent._call_image_model_remove_text(
        b"slide",
        "image-model",
        user_id="user-1",
        job_id="job-1",
        slide_index=2,
    )

    assert result == b"clean"
    assert billed_calls[0]["idempotency_key"] == "ppt:job-1:remove-text:3:attempt:1"
    assert billed_calls[0]["expected_category"] == "generate"
    assert billed_calls[0]["related_task_id"] is None


@pytest.mark.asyncio
async def test_successful_model_response_does_not_hide_ledger_failure(monkeypatch):
    async def ledger_failure(**kwargs):
        await kwargs["invoke"]()
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(ppt_agent, "get_default_model_id", AsyncMock(return_value="llm-default"))
    monkeypatch.setattr(ppt_agent, "call_chat", AsyncMock(return_value="optimized"))
    monkeypatch.setattr(ppt_agent, "execute_billed_model_call", ledger_failure)

    with pytest.raises(HTTPException) as exc_info:
        await ppt_agent.PPTAgent().optimize_prompt(
            "topic",
            user_id="user-1",
            operation_scope="request-1",
        )

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_title_extraction_does_not_hide_platform_billing_failure(monkeypatch):
    billing_error = HTTPException(status_code=402, detail="Insufficient platform credits")

    monkeypatch.setattr(ppt_agent, "get_default_model_id", AsyncMock(return_value="llm-default"))
    monkeypatch.setattr(
        ppt_agent,
        "execute_billed_model_call",
        AsyncMock(side_effect=billing_error),
    )

    with pytest.raises(HTTPException) as exc_info:
        await ppt_agent.PPTAgent().extract_title(
            "A title that would otherwise become the local fallback",
            user_id="user-1",
            operation_scope="request-1",
        )

    assert exc_info.value is billing_error
