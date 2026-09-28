from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from routers import poster, sci_fig


USER = {"id": "specialist-skill-user"}


def _skill(*, skill_id: str, module: str, adapter: str, instructions: str, revision: int = 3, params=None):
    return {
        "id": skill_id,
        "name": f"{skill_id} 名称",
        "module": module,
        "enabled": True,
        "schema_version": 2,
        "revision": revision,
        "execution_adapter": adapter,
        "execution_instructions": instructions,
        "input_contract": {
            "prompt": {"required": False, "max_length": 4000},
            "images": {"min": 0, "max": 0, "roles": ["reference"]},
        },
        "constraints": {},
        "default_params": dict(params or {}),
    }


@pytest.mark.asyncio
async def test_poster_start_compiles_empty_description_skill_and_persists_audit_metadata():
    skill = _skill(
        skill_id="poster-editorial-skill",
        module="POSTER_GEN",
        adapter="poster",
        instructions="生成留有中文排版安全区的编辑式海报。",
        params={"model_id": "poster-image-model", "poster_count": 2, "output_resolution": "2k"},
    )
    expected_meta = {
        "skill_id": "poster-editorial-skill",
        "skill_schema_version": 2,
        "skill_revision": 3,
        "execution_adapter": "poster",
        "resolved_params": skill["default_params"],
    }

    with patch(
        "routers.poster.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=skill),
    ), patch(
        "routers.poster.provider_policy.choose_llm_model_id", new=AsyncMock(return_value="")
    ), patch(
        "routers.poster.provider_policy.choose_image_model_id",
        new=AsyncMock(return_value="poster-image-model"),
    ) as choose_image, patch(
        "routers.poster.check_model_call", new=AsyncMock(return_value=0.0)
    ), patch(
        "routers.poster.canonicalize_image_asset_references", new=AsyncMock(return_value=[])
    ), patch(
        "routers.poster._ensure_conversation", new=AsyncMock()
    ), patch(
        "routers.poster.create_module_run", new=AsyncMock(return_value={"run_id": "poster-run-1"})
    ) as create_run, patch(
        "routers.poster._save_state", new=AsyncMock()
    ) as save_state, patch("routers.poster.enqueue", new=AsyncMock()) as enqueue:
        result = await poster.start_generation(
            poster.PosterStartRequest(
                description="",
                skill_id="poster-editorial-skill",
                skill_revision=3,
            ),
            user=USER,
        )

    state = save_state.await_args.args[1]
    assert result["status"] == "generating"
    assert state["description"] == "生成留有中文排版安全区的编辑式海报。"
    assert state["user_description"] == ""
    assert state["creative_skill"] == expected_meta
    assert state["skill_name"] == "poster-editorial-skill 名称"
    assert state["poster_count"] == 2
    assert state["output_resolution"] == "2k"
    choose_image.assert_awaited_once_with("poster-image-model")
    assert create_run.await_args.kwargs["instruction"] == state["description"]
    assert create_run.await_args.kwargs["context"]["creative_skill"] == expected_meta
    enqueue.assert_awaited_once()
    assert enqueue.await_args.kwargs["task_type"] == "poster"


@pytest.mark.asyncio
async def test_sci_fig_start_compiles_empty_description_skill_and_persists_audit_metadata():
    skill = _skill(
        skill_id="sci-mechanism-skill",
        module="SCI_FIG",
        adapter="sci_fig",
        instructions="绘制出版级细胞递送机制图。",
        params={
            "category": "flow_diagram",
            "gen_mode": "svg",
            "style_preset": "science",
            "output_format": "svg",
            "output_resolution": "2k",
        },
    )
    expected_meta = {
        "skill_id": "sci-mechanism-skill",
        "skill_schema_version": 2,
        "skill_revision": 3,
        "execution_adapter": "sci_fig",
        "resolved_params": skill["default_params"],
    }

    with patch(
        "routers.sci_fig._get_user_sem",
        return_value=SimpleNamespace(locked=lambda: False),
    ), patch(
        "routers.sci_fig.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=skill),
    ), patch(
        "routers.sci_fig.provider_policy.choose_llm_model_id", new=AsyncMock(return_value="")
    ), patch(
        "routers.sci_fig.provider_policy.choose_vision_model_id", new=AsyncMock(return_value="")
    ), patch(
        "routers.sci_fig.canonicalize_image_asset_references", new=AsyncMock(return_value=[])
    ), patch(
        "routers.sci_fig._ensure_conversation", new=AsyncMock()
    ), patch(
        "routers.sci_fig.create_module_run", new=AsyncMock(return_value={"run_id": "sci-run-1"})
    ) as create_run, patch(
        "routers.sci_fig._save_state", new=AsyncMock()
    ) as save_state, patch("routers.sci_fig.enqueue", new=AsyncMock()) as enqueue:
        result = await sci_fig.start_generation(
            sci_fig.SciFigStartRequest(
                description="",
                skill_id="sci-mechanism-skill",
                skill_revision=3,
            ),
            user=USER,
        )

    state = save_state.await_args.args[1]
    assert result["status"] == "generating"
    assert state["description"] == "绘制出版级细胞递送机制图。"
    assert state["user_description"] == ""
    assert state["creative_skill"] == expected_meta
    assert state["skill_name"] == "sci-mechanism-skill 名称"
    assert state["category"] == "flow_diagram"
    assert state["gen_mode"] == "svg"
    assert state["style_preset"] == "science"
    assert state["output_format"] == "svg"
    assert state["output_resolution"] == "2k"
    assert create_run.await_args.kwargs["instruction"] == state["description"]
    assert create_run.await_args.kwargs["context"]["creative_skill"] == expected_meta
    enqueue.assert_awaited_once()
    assert enqueue.await_args.kwargs["task_type"] == "sci-fig"


@pytest.mark.asyncio
async def test_poster_start_rejects_wrong_skill_module_without_enqueue():
    enqueue = AsyncMock()
    save_state = AsyncMock()
    with patch(
        "routers.poster.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(
            skill_id="wrong-poster-skill",
            module="SCI_FIG",
            adapter="sci_fig",
            instructions="不应执行。",
        )),
    ), patch("routers.poster._save_state", new=save_state), patch(
        "routers.poster.enqueue", new=enqueue
    ):
        with pytest.raises(HTTPException) as caught:
            await poster.start_generation(
                poster.PosterStartRequest(
                    description="",
                    skill_id="wrong-poster-skill",
                    skill_revision=3,
                ),
                user=USER,
            )

    assert caught.value.status_code == 400
    save_state.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_poster_start_rejects_stale_skill_revision_without_enqueue():
    enqueue = AsyncMock()
    save_state = AsyncMock()
    with patch(
        "routers.poster.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(
            skill_id="poster-stale-skill",
            module="POSTER_GEN",
            adapter="poster",
            instructions="不应执行。",
            revision=4,
        )),
    ), patch("routers.poster._save_state", new=save_state), patch(
        "routers.poster.enqueue", new=enqueue
    ):
        with pytest.raises(HTTPException) as caught:
            await poster.start_generation(
                poster.PosterStartRequest(
                    description="",
                    skill_id="poster-stale-skill",
                    skill_revision=3,
                ),
                user=USER,
            )

    assert caught.value.status_code == 409
    save_state.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_sci_fig_start_rejects_wrong_skill_module_without_enqueue():
    enqueue = AsyncMock()
    save_state = AsyncMock()
    with patch(
        "routers.sci_fig._get_user_sem",
        return_value=SimpleNamespace(locked=lambda: False),
    ), patch(
        "routers.sci_fig.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(
            skill_id="wrong-sci-skill",
            module="POSTER_GEN",
            adapter="poster",
            instructions="不应执行。",
        )),
    ), patch("routers.sci_fig._save_state", new=save_state), patch(
        "routers.sci_fig.enqueue", new=enqueue
    ):
        with pytest.raises(HTTPException) as caught:
            await sci_fig.start_generation(
                sci_fig.SciFigStartRequest(
                    description="",
                    skill_id="wrong-sci-skill",
                    skill_revision=3,
                ),
                user=USER,
            )

    assert caught.value.status_code == 400
    save_state.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_sci_fig_start_rejects_stale_skill_revision_without_enqueue():
    enqueue = AsyncMock()
    save_state = AsyncMock()
    with patch(
        "routers.sci_fig._get_user_sem",
        return_value=SimpleNamespace(locked=lambda: False),
    ), patch(
        "routers.sci_fig.creative_style_repo.get_style_preset",
        new=AsyncMock(return_value=_skill(
            skill_id="sci-stale-skill",
            module="SCI_FIG",
            adapter="sci_fig",
            instructions="不应执行。",
            revision=4,
        )),
    ), patch("routers.sci_fig._save_state", new=save_state), patch(
        "routers.sci_fig.enqueue", new=enqueue
    ):
        with pytest.raises(HTTPException) as caught:
            await sci_fig.start_generation(
                sci_fig.SciFigStartRequest(
                    description="",
                    skill_id="sci-stale-skill",
                    skill_revision=3,
                ),
                user=USER,
            )

    assert caught.value.status_code == 409
    save_state.assert_not_awaited()
    enqueue.assert_not_awaited()
