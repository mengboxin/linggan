import pytest


@pytest.mark.asyncio
async def test_ppt_image_bytes_accepts_unpadded_base64():
    from services.agents import ppt_agent

    assert await ppt_agent._ppt_image_bytes("aGVsbG8") == b"hello"
