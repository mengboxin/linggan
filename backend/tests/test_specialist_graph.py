import pytest

from services.agents.specialist_graph import run_specialist_graph


@pytest.mark.asyncio
async def test_specialist_graph_executes_pending_work_then_delivers():
    state = {"status": "pending", "progress": 0, "message": "等待执行"}
    calls = 0

    async def load_state():
        return state

    async def execute():
        nonlocal calls
        calls += 1
        state.update({"status": "preview", "progress": 100, "message": "已生成预览"})

    result = await run_specialist_graph(
        module="poster",
        job_id="poster-1",
        load_state=load_state,
        execute=execute,
    )

    assert calls == 1
    assert result["outcome"] == "deliver"
    assert result["snapshot"]["status"] == "preview"


@pytest.mark.asyncio
async def test_specialist_graph_does_not_execute_a_paused_run():
    calls = 0

    async def load_state():
        return {
            "status": "checkpoint",
            "progress": 40,
            "intervention": {"kind": "budget", "phase": "slides"},
        }

    async def execute():
        nonlocal calls
        calls += 1

    result = await run_specialist_graph(
        module="ppt",
        job_id="ppt-1",
        load_state=load_state,
        execute=execute,
    )

    assert calls == 0
    assert result["outcome"] == "pause"


@pytest.mark.asyncio
async def test_specialist_graph_can_force_a_revision_from_preview_state():
    state = {"status": "preview", "progress": 100}
    calls = 0

    async def load_state():
        return state

    async def execute():
        nonlocal calls
        calls += 1

    result = await run_specialist_graph(
        module="sci_fig",
        job_id="figure-1",
        load_state=load_state,
        execute=execute,
        force_execute=True,
    )

    assert calls == 1
    assert result["outcome"] == "deliver"
