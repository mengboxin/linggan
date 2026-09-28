from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


async def _invoke_billed(**kwargs):
    return await kwargs["invoke"]()


@pytest.mark.asyncio
async def test_intent_model_fallback_is_billed_for_current_user(monkeypatch):
    from services.agents import intent_router

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(intent_router, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        intent_router.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-router"),
    )
    monkeypatch.setattr(
        intent_router,
        "call_chat",
        AsyncMock(return_value=(
            '{"module":"poster","action":"edit","confidence":0.9,'
            '"missing_information":[],"constraints":[]}'
        )),
    )

    request = intent_router.IntentRouteRequest(
        instruction="make this more polished",
        context={"has_current_artifact": True},
        user_id="user-1",
        client_request_id="route-request-1",
    )
    route = await intent_router.resolve_intent_route(request)
    await intent_router.resolve_intent_route(request)

    assert route.source == "model"
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args.kwargs["model_id"] == "llm-router"
    assert billed.await_args.kwargs["expected_category"] == "llm"
    assert [call.kwargs["idempotency_key"] for call in billed.await_args_list] == [
        billed.await_args_list[0].kwargs["idempotency_key"],
        billed.await_args_list[0].kwargs["idempotency_key"],
    ]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_plan_node_bills_the_resolved_default_model(monkeypatch):
    from services.agents.nodes import plan

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(plan, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        plan.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-default"),
    )
    monkeypatch.setattr(
        plan,
        "call_chat_messages",
        AsyncMock(return_value='{"tasks":[{"operation":"edit","target":"slide"}]}'),
    )

    context = {"client_request_id": "plan-request-1"}
    _, tasks = await plan.plan_node("edit the slide", context=context, user_id="user-1")
    await plan.plan_node("edit the slide", context=context, user_id="user-1")

    assert tasks[0].operation == "edit"
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args.kwargs["model_id"] == "llm-default"
    assert billed.await_args_list[0].kwargs["idempotency_key"] == billed.await_args_list[1].kwargs["idempotency_key"]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_deep_plan_material_analysis_uses_separate_billed_call(monkeypatch):
    from services.agents import creative_agent

    request = creative_agent.DeepPlanRequest(
        instruction="restyle this image",
        image_bytes=[b"png"],
        image_roles=["source"],
        has_images=True,
        user_id="user-1",
        client_request_id="deep-plan-request-1",
    )
    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(creative_agent, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        creative_agent.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-vision"),
    )
    monkeypatch.setattr(
        creative_agent,
        "call_chat_with_images",
        AsyncMock(return_value='{"summary":"ok"}'),
    )

    result = await creative_agent._analyze_materials_node({"request": request})
    await creative_agent._analyze_materials_node({"request": request})

    assert result["material_analysis"]["vision_available"] is True
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args.kwargs["description"] == "Agent visual material analysis"
    assert billed.await_args_list[0].kwargs["idempotency_key"] == billed.await_args_list[1].kwargs["idempotency_key"]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_nlp_default_model_call_is_billed_but_transport_failure_falls_back(monkeypatch):
    from routers import nlp

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(nlp, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        nlp.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-default"),
    )
    monkeypatch.setattr(nlp, "call_chat_messages", AsyncMock(side_effect=RuntimeError("offline")))
    body = nlp.NLPParseRequest(
        instruction="replace the background",
        layers=[nlp.LayerInfo(id="layer-1", name="background", index=0)],
        client_request_id="nlp-request-1",
    )

    result = await nlp.parse_instruction(body, _user={"id": "user-1"})
    await nlp.parse_instruction(body, _user={"id": "user-1"})

    assert result.ok is True
    assert result.plan is not None
    assert billed.await_args.kwargs["model_id"] == "llm-default"
    assert billed.await_args_list[0].kwargs["idempotency_key"] == billed.await_args_list[1].kwargs["idempotency_key"]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_nlp_does_not_swallow_billing_errors(monkeypatch):
    from routers import nlp

    monkeypatch.setattr(
        nlp.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-default"),
    )
    monkeypatch.setattr(
        nlp,
        "execute_billed_model_call",
        AsyncMock(side_effect=HTTPException(402, "insufficient credits")),
    )
    body = nlp.NLPParseRequest(
        instruction="replace the background",
        layers=[nlp.LayerInfo(id="layer-1", name="background", index=0)],
    )

    with pytest.raises(HTTPException) as exc_info:
        await nlp.parse_instruction(body, _user={"id": "user-1"})

    assert exc_info.value.status_code == 402


@pytest.mark.asyncio
async def test_nlp_malformed_response_is_billed_before_rule_fallback(monkeypatch):
    from routers import nlp

    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(nlp, "execute_billed_model_call", billed)
    monkeypatch.setattr(
        nlp.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-default"),
    )
    transport = AsyncMock(return_value="not valid json")
    monkeypatch.setattr(nlp, "call_chat_messages", transport)
    body = nlp.NLPParseRequest(
        instruction="replace the background",
        layers=[nlp.LayerInfo(id="layer-1", name="background", index=0)],
    )

    result = await nlp.parse_instruction(body, _user={"id": "user-1"})

    assert result.ok is True
    assert result.plan is not None
    billed.assert_awaited_once()
    transport.assert_awaited_once()


@pytest.mark.asyncio
async def test_pet_default_model_call_is_billed(monkeypatch):
    from routers import pet

    monkeypatch.setattr(pet, "get_pet_config", AsyncMock(return_value={
        "enabled": True,
        "model_id": None,
        "model_category": "llm",
        "system_prompt": "You are {pet_name}.",
        "max_tokens": 200,
        "temperature": 0.5,
    }))
    monkeypatch.setattr(pet.model_repo, "list_models", AsyncMock(return_value=[{
        "id": "llm-default",
        "category": "llm",
        "enabled": True,
    }]))
    monkeypatch.setattr(pet, "call_text_messages", AsyncMock(return_value="hello"))
    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(pet, "execute_billed_model_call", billed)

    body = pet.ChatRequest(message="hello", pet_name="Pixel", client_request_id="pet-request-1")
    response = await pet._run_pet_chat(
        body,
        user_id="user-1",
    )
    await pet._run_pet_chat(body, user_id="user-1")

    assert response.reply == "hello"
    assert billed.await_args.kwargs["model_id"] == "llm-default"
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args_list[0].kwargs["idempotency_key"] == billed.await_args_list[1].kwargs["idempotency_key"]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_legacy_prompt_default_model_is_billed_and_model_failure_is_not_hidden_billing(monkeypatch):
    from routers import prompt
    from services.agents import prompt_agent

    model = {"id": "llm-default", "category": "llm", "enabled": True}
    monkeypatch.setattr(prompt_agent, "get_llm_model", AsyncMock(return_value=model))
    monkeypatch.setattr(prompt_agent, "call_llm_chat", AsyncMock(side_effect=RuntimeError("offline")))
    billed = AsyncMock(side_effect=_invoke_billed)
    monkeypatch.setattr(prompt_agent, "execute_billed_model_call", billed)

    body = prompt.ProcessPromptRequest(prompt="draw a city", client_request_id="prompt-request-1")
    result = await prompt.process_prompt(
        body,
        {"id": "user-1"},
    )
    await prompt.process_prompt(body, {"id": "user-1"})

    assert result["optimized"] == "draw a city"
    assert billed.await_args.kwargs["model_id"] == "llm-default"
    assert billed.await_args.kwargs["user_id"] == "user-1"
    assert billed.await_args_list[0].kwargs["idempotency_key"] == billed.await_args_list[1].kwargs["idempotency_key"]
    assert billed.await_args.kwargs["idempotency_key"]


@pytest.mark.asyncio
async def test_legacy_prompt_does_not_swallow_billing_errors(monkeypatch):
    from routers import prompt
    from services.agents import prompt_agent

    model = {"id": "llm-default", "category": "llm", "enabled": True}
    monkeypatch.setattr(prompt_agent, "get_llm_model", AsyncMock(return_value=model))
    monkeypatch.setattr(
        prompt_agent,
        "execute_billed_model_call",
        AsyncMock(side_effect=HTTPException(402, "insufficient credits")),
    )

    with pytest.raises(HTTPException) as exc_info:
        await prompt.process_prompt(
            prompt.ProcessPromptRequest(prompt="draw a city"),
            {"id": "user-1"},
        )

    assert exc_info.value.status_code == 402
