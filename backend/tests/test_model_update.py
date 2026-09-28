from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_admin_model_update_can_rename_model_id(monkeypatch):
    from routers import models

    get_model = AsyncMock(return_value=None)
    update_model = AsyncMock(return_value={"id": "gpt-5.6", "name": "GPT"})
    monkeypatch.setattr(models.model_repo, "get_model", get_model)
    monkeypatch.setattr(models.model_repo, "update_model", update_model)

    result = await models.admin_update_model(
        "gpt-5.5",
        models.ModelUpdateBody(id="gpt-5.6", name="GPT"),
        True,
    )

    assert result["id"] == "gpt-5.6"
    get_model.assert_awaited_once_with("gpt-5.6")
    update_model.assert_awaited_once_with(
        "gpt-5.5",
        {"id": "gpt-5.6", "name": "GPT"},
    )


@pytest.mark.asyncio
async def test_admin_model_update_rejects_duplicate_target_id(monkeypatch):
    from fastapi import HTTPException
    from routers import models

    monkeypatch.setattr(
        models.model_repo,
        "get_model",
        AsyncMock(return_value={"id": "gpt-5.6"}),
    )
    update_model = AsyncMock()
    monkeypatch.setattr(models.model_repo, "update_model", update_model)

    with pytest.raises(HTTPException) as exc_info:
        await models.admin_update_model(
            "gpt-5.5",
            models.ModelUpdateBody(id="gpt-5.6"),
            True,
        )

    assert exc_info.value.status_code == 400
    assert "gpt-5.6" in str(exc_info.value.detail)
    update_model.assert_not_awaited()


@pytest.mark.asyncio
async def test_model_repository_updates_primary_id_and_fields(monkeypatch):
    from repositories import model_repo

    conn = AsyncMock()
    conn.fetchrow.return_value = {"id": "gpt-5.6", "name": "GPT 5.6"}
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=conn)
    context.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(model_repo, "acquire", MagicMock(return_value=context))

    result = await model_repo.update_model(
        "gpt-5.5",
        {"id": "gpt-5.6", "name": "GPT 5.6"},
    )

    query, old_id, new_id, name = conn.fetchrow.await_args.args[:4]
    assert "id            = COALESCE($2, id)" in query
    assert (old_id, new_id, name) == ("gpt-5.5", "gpt-5.6", "GPT 5.6")
    assert result == {"id": "gpt-5.6", "name": "GPT 5.6"}
