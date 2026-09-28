from unittest.mock import AsyncMock

import pytest

from services.ai_client import ExternalBillingError, ImageSafetyBlockedError
from services.agents import ppt_agent


@pytest.mark.asyncio
async def test_all_safety_blocked_slides_end_ppt_job_as_failed(monkeypatch):
    state = {
        "job_id": "ppt-safety-job",
        "user_id": "",
        "status": "confirmed",
        "progress": 15,
        "message": "",
        "error": "",
        "image_model_id": "image-model",
        "image_quality": "auto",
        "output_resolution": "standard",
        "conversion_mode": "image_only",
        "outline": {
            "title": "Blocked deck",
            "style": "editorial",
            "color_scheme": "white and red",
            "slides": [
                {"page": 1, "title": "One", "points": []},
                {"page": 2, "title": "Two", "points": []},
            ],
        },
        "agent_steps": [],
        "snapshots": {},
    }
    saved_states: list[dict] = []

    async def fake_save(_job_id: str, value: dict):
        saved_states.append(dict(value))

    monkeypatch.setattr(ppt_agent, "_load_state", AsyncMock(return_value=state))
    monkeypatch.setattr(ppt_agent, "_save_state", fake_save)
    monkeypatch.setattr(
        ppt_agent,
        "call_image",
        AsyncMock(side_effect=ImageSafetyBlockedError("提示词被图像安全系统拦截，请调整后重试。")),
    )

    await ppt_agent.PPTAgent()._run_pipeline_from_images(state["job_id"])

    assert state["status"] == "failed"
    assert "安全系统拦截" in state["error"]
    assert saved_states[-1]["status"] == "failed"


@pytest.mark.asyncio
async def test_partial_external_billing_failure_keeps_ppt_at_checkpoint(monkeypatch):
    state = {
        "job_id": "ppt-billing-job",
        "user_id": "",
        "status": "confirmed",
        "progress": 15,
        "message": "",
        "error": "",
        "image_model_id": "image-model",
        "image_quality": "auto",
        "output_resolution": "standard",
        "conversion_mode": "ppt_master_direct",
        "outline": {
            "title": "Billing deck",
            "style": "editorial",
            "color_scheme": "white and blue",
            "slides": [
                {"page": 1, "title": "One", "points": []},
                {"page": 2, "title": "Two", "points": []},
            ],
        },
        "agent_steps": [],
        "snapshots": {},
    }
    saved_states: list[dict] = []

    async def fake_save(_job_id: str, value: dict):
        saved_states.append(dict(value))

    monkeypatch.setattr(ppt_agent, "_load_state", AsyncMock(return_value=state))
    monkeypatch.setattr(ppt_agent, "_save_state", fake_save)
    monkeypatch.setattr(
        ppt_agent,
        "call_image",
        AsyncMock(side_effect=[
            b"png-bytes",
            ExternalBillingError("算力 API 余额不足，请先充值后重试，或切换为平台积分算力。"),
        ]),
    )
    monkeypatch.setattr(
        ppt_agent,
        "store_ppt_slide_image_asset",
        AsyncMock(return_value="asset://slide-1"),
    )
    run_post_checkpoint = AsyncMock()
    monkeypatch.setattr(ppt_agent.PPTAgent, "_run_post_checkpoint_limited", run_post_checkpoint)

    await ppt_agent.PPTAgent()._run_pipeline_from_images(state["job_id"])

    assert state["status"] == "checkpoint"
    assert state["slide_images_b64"] == ["asset://slide-1", ""]
    assert "算力 API 余额不足" in state["error"]
    assert "已生成 1/2 页" in state["message"]
    assert saved_states[-1]["status"] == "checkpoint"
    run_post_checkpoint.assert_not_awaited()
