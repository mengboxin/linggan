from io import BytesIO

import pytest
from PIL import Image

from services import asset_storage


def test_image_metadata_rejects_excessive_pixel_count(monkeypatch):
    buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")
    monkeypatch.setattr(asset_storage.settings, "MAX_IMAGE_PIXELS", 3)

    with pytest.raises(ValueError, match="pixel count"):
        asset_storage._image_metadata(buffer.getvalue())
