from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_submit_existing_is_rejected_when_user_submissions_are_disabled(monkeypatch):
    from routers import public_gallery

    monkeypatch.setattr(public_gallery.settings, "PUBLIC_GALLERY_USER_SUBMISSIONS_ENABLED", False)
    submit = AsyncMock()
    monkeypatch.setattr(public_gallery.public_gallery_repo, "submit_existing_generation", submit)

    with pytest.raises(HTTPException) as error:
        await public_gallery.submit_existing_public_gallery_item(
            public_gallery.SubmitExistingPublicGenerationBody(prompt="test", image_url="/api/assets/example/original"),
            {"id": "user-1"},
        )

    assert error.value.status_code == 403
    assert "已关闭" in str(error.value.detail)
    submit.assert_not_awaited()
