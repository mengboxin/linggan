import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


def _model_cost_by_category(**kwargs):
    return {
        "llm": 1.0,
        "generate": 3.0,
        "vision": 2.0,
    }[kwargs["expected_category"]]


def _patch_poster_start(monkeypatch, *, reserve, enqueue=None):
    from routers import poster

    monkeypatch.setattr(
        poster.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-model"),
    )
    monkeypatch.setattr(
        poster.provider_policy,
        "choose_image_model_id",
        AsyncMock(return_value="image-model"),
    )
    monkeypatch.setattr(
        poster.provider_policy,
        "choose_vision_model_id",
        AsyncMock(return_value="vision-model"),
    )
    monkeypatch.setattr(
        poster,
        "check_model_call",
        AsyncMock(side_effect=_model_cost_by_category),
    )
    monkeypatch.setattr(
        poster,
        "canonicalize_image_asset_references",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(poster, "_ensure_conversation", AsyncMock())
    monkeypatch.setattr(
        poster,
        "create_module_run",
        AsyncMock(return_value={"run_id": "poster-run"}),
    )
    monkeypatch.setattr(poster, "_save_state", AsyncMock())
    monkeypatch.setattr(
        poster,
        "reserve_for_task",
        reserve,
        raising=False,
    )
    monkeypatch.setattr(
        poster,
        "get_available_balance",
        AsyncMock(return_value=0.0),
        raising=False,
    )
    enqueue_mock = enqueue or AsyncMock()
    monkeypatch.setattr(poster, "enqueue", enqueue_mock)
    return poster, enqueue_mock


def _poster_request():
    from routers.poster import PosterStartRequest

    return PosterStartRequest(
        description="two poster series",
        poster_count=2,
        llm_model_id="llm-model",
        image_model_id="image-model",
        vision_model_id="vision-model",
    )


@pytest.mark.asyncio
async def test_concurrent_poster_starts_atomically_hold_the_full_worst_case_budget(monkeypatch):
    balance = 21.0
    held = 0.0
    lock = asyncio.Lock()
    reserve_calls: list[tuple[str, str, float]] = []

    async def reserve(user_id: str, task_id: str, amount: float) -> bool:
        nonlocal held
        async with lock:
            reserve_calls.append((user_id, task_id, amount))
            if held + amount > balance:
                return False
            held += amount
            return True

    poster, enqueue = _patch_poster_start(monkeypatch, reserve=reserve)

    results = await asyncio.gather(
        poster._start_generation(_poster_request(), {"id": "user-1"}),
        poster._start_generation(_poster_request(), {"id": "user-1"}),
        return_exceptions=True,
    )

    errors = [item for item in results if isinstance(item, HTTPException)]
    successes = [item for item in results if isinstance(item, dict)]
    assert len(successes) == 1
    assert len(errors) == 1 and errors[0].status_code == 402
    assert [call[2] for call in reserve_calls] == [21.0, 21.0]
    assert enqueue.await_count == 1


def _patch_sci_start(monkeypatch, *, reserve, enqueue=None):
    from routers import sci_fig

    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_llm_model_id",
        AsyncMock(return_value="llm-model"),
    )
    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_image_model_id",
        AsyncMock(return_value="image-model"),
    )
    monkeypatch.setattr(
        sci_fig.provider_policy,
        "choose_vision_model_id",
        AsyncMock(return_value="vision-model"),
    )
    monkeypatch.setattr(
        sci_fig,
        "check_model_call",
        AsyncMock(side_effect=_model_cost_by_category),
    )
    monkeypatch.setattr(
        sci_fig,
        "canonicalize_image_asset_references",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(sci_fig, "_ensure_conversation", AsyncMock())
    monkeypatch.setattr(
        sci_fig,
        "create_module_run",
        AsyncMock(return_value={"run_id": "sci-run"}),
    )
    monkeypatch.setattr(sci_fig, "_save_state", AsyncMock())
    monkeypatch.setattr(
        sci_fig,
        "reserve_for_task",
        reserve,
        raising=False,
    )
    monkeypatch.setattr(
        sci_fig,
        "get_available_balance",
        AsyncMock(return_value=4.0),
        raising=False,
    )
    enqueue_mock = enqueue or AsyncMock()
    monkeypatch.setattr(sci_fig, "enqueue", enqueue_mock)
    return sci_fig, enqueue_mock


@pytest.mark.asyncio
async def test_sci_image_task_rejects_balance_that_only_covers_the_first_call(monkeypatch):
    reserve = AsyncMock(return_value=False)
    sci_fig, enqueue = _patch_sci_start(monkeypatch, reserve=reserve)
    body = sci_fig.SciFigStartRequest(
        description="cell pathway",
        gen_mode="image2",
        llm_model_id="llm-model",
        image_model_id="image-model",
        vision_model_id="vision-model",
    )

    with pytest.raises(HTTPException) as exc_info:
        await sci_fig._start_generation(body, {"id": "user-1"})

    assert exc_info.value.status_code == 402
    # Planner 1 + two image attempts 6 + two visual reviews 4.
    assert reserve.await_args.args[2] == 11.0
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_poster_enqueue_failure_releases_reserved_budget(monkeypatch):
    reserve = AsyncMock(return_value=True)
    enqueue = AsyncMock(side_effect=RuntimeError("queue unavailable"))
    poster, _ = _patch_poster_start(monkeypatch, reserve=reserve, enqueue=enqueue)
    release = AsyncMock()
    monkeypatch.setattr(
        poster,
        "_release_poster_generation_reservation",
        release,
    )

    with pytest.raises(HTTPException) as exc_info:
        await poster._start_generation(_poster_request(), {"id": "user-1"})

    assert exc_info.value.status_code == 503
    reserve.assert_awaited_once()
    release.assert_awaited_once_with(reserve.await_args.args[1])


@pytest.mark.asyncio
async def test_sci_enqueue_failure_releases_reserved_budget(monkeypatch):
    reserve = AsyncMock(return_value=True)
    enqueue = AsyncMock(side_effect=RuntimeError("queue unavailable"))
    sci_fig, _ = _patch_sci_start(monkeypatch, reserve=reserve, enqueue=enqueue)
    release = AsyncMock()
    monkeypatch.setattr(
        sci_fig,
        "_release_sci_generation_reservation",
        release,
    )
    body = sci_fig.SciFigStartRequest(
        description="cell pathway",
        gen_mode="image2",
        llm_model_id="llm-model",
        image_model_id="image-model",
        vision_model_id="vision-model",
    )

    with pytest.raises(HTTPException) as exc_info:
        await sci_fig._start_generation(body, {"id": "user-1"})

    assert exc_info.value.status_code == 503
    reserve.assert_awaited_once()
    release.assert_awaited_once_with(reserve.await_args.args[1])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module_name", "runner_name"),
    [
        ("poster", "run_poster_job_from_queue"),
        ("sci_fig", "run_sci_fig_from_queue"),
    ],
)
async def test_specialist_queue_runner_releases_unused_budget_on_terminal_state(
    monkeypatch,
    module_name,
    runner_name,
):
    if module_name == "poster":
        from routers import poster as module
    else:
        from routers import sci_fig as module

    monkeypatch.setattr(module, "run_specialist_graph", AsyncMock())
    release = AsyncMock(return_value=7.0)
    monkeypatch.setattr(
        module,
        "release_task_reservation",
        release,
        raising=False,
    )

    await getattr(module, runner_name)("job-1")

    release.assert_awaited_once_with("job-1")
