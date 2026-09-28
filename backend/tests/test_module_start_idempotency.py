from unittest.mock import AsyncMock, patch

import pytest

from routers import paper, poster, ppt, sci_fig


USER = {"id": "module-submit-user"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module", "start", "request", "inner_name"),
    [
        (
            "ppt",
            ppt.start_ppt,
            ppt.StartRequest(topic="idempotent presentation", client_request_id="ppt-request-1"),
            "_start_ppt",
        ),
        (
            "poster",
            poster.start_generation,
            poster.PosterStartRequest(description="idempotent poster", client_request_id="poster-request-1"),
            "_start_generation",
        ),
        (
            "sci_fig",
            sci_fig.start_generation,
            sci_fig.SciFigStartRequest(description="idempotent science figure", client_request_id="sci-request-1"),
            "_start_generation",
        ),
        (
            "paper",
            paper.start_paper,
            paper.PaperStartRequest(topic="idempotent paper", client_request_id="paper-request-1"),
            "_start_paper",
        ),
    ],
)
async def test_module_start_replays_existing_job_without_starting_a_second_job(module, start, request, inner_name):
    duplicate = {"job_id": f"{module}-job-1", "status": "generating", "duplicate": True}
    router_path = {"ppt": "routers.ppt", "poster": "routers.poster", "sci_fig": "routers.sci_fig", "paper": "routers.paper"}[module]

    with patch(f"{router_path}.claim_submit_key", new=AsyncMock(return_value=duplicate)), patch(
        f"{router_path}.{inner_name}", new=AsyncMock()
    ) as start_inner:
        result = await start(request, user=USER)

    assert result == duplicate
    start_inner.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("module", "start", "request", "inner_name"),
    [
        (
            "ppt",
            ppt.start_ppt,
            ppt.StartRequest(topic="first presentation", client_request_id="ppt-request-2"),
            "_start_ppt",
        ),
        (
            "poster",
            poster.start_generation,
            poster.PosterStartRequest(description="first poster", client_request_id="poster-request-2"),
            "_start_generation",
        ),
        (
            "sci_fig",
            sci_fig.start_generation,
            sci_fig.SciFigStartRequest(description="first science figure", client_request_id="sci-request-2"),
            "_start_generation",
        ),
        (
            "paper",
            paper.start_paper,
            paper.PaperStartRequest(topic="first paper", client_request_id="paper-request-2"),
            "_start_paper",
        ),
    ],
)
async def test_module_start_remembers_the_first_job_for_retries(module, start, request, inner_name):
    created = {"job_id": f"{module}-job-2", "status": "generating"}
    router_path = {"ppt": "routers.ppt", "poster": "routers.poster", "sci_fig": "routers.sci_fig", "paper": "routers.paper"}[module]

    with patch(f"{router_path}.claim_submit_key", new=AsyncMock(return_value=None)), patch(
        f"{router_path}.{inner_name}", new=AsyncMock(return_value=created)
    ) as start_inner, patch(
        f"{router_path}.remember_submit_key", new=AsyncMock()
    ) as remember:
        result = await start(request, user=USER)

    assert result == created
    start_inner.assert_awaited_once_with(request, USER)
    remembered_key, remembered_result = remember.await_args.args
    assert remembered_key.startswith(f"submit:{module}:client:")
    assert remembered_result == created
