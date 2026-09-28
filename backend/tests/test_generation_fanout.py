import pytest


def test_default_generation_fanout_is_memory_bounded():
    from core.config import settings

    assert settings.TASK_FANOUT_CONCURRENCY == 1
    assert settings.PPT_SLIDE_FANOUT_CONCURRENCY == 1


@pytest.mark.asyncio
async def test_ppt_image_call_gate_is_memory_bounded():
    from services.agents import ppt_agent

    assert ppt_agent.PPT_MAX_ACTIVE_IMAGE_CALLS == 1
    assert getattr(ppt_agent._image_call_sem, "_value") == 1
