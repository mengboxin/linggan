from unittest.mock import AsyncMock, patch

import pytest

from services.image_asset_contract import (
    ImageAssetReference,
    ImageAssetReferenceError,
    load_original_reference_bytes,
    normalize_image_asset_references,
)


def test_reference_contract_preserves_roles_and_normalizes_prompt_order():
    references = normalize_image_asset_references([
        ImageAssetReference(asset_id="source-asset", role="source", index=8),
        ImageAssetReference(asset_id="reference-b", role="reference", index=7),
        ImageAssetReference(asset_id="reference-a", role="reference", index=2),
    ])

    assert [(item.asset_id, item.role, item.index) for item in references] == [
        ("source-asset", "source", 0),
        ("reference-b", "reference", 1),
        ("reference-a", "reference", 2),
    ]


def test_reference_contract_rejects_duplicate_assets():
    with pytest.raises(ImageAssetReferenceError, match="不能重复"):
        normalize_image_asset_references([
            ImageAssetReference(asset_id="same", role="reference", index=1),
            ImageAssetReference(asset_id="same", role="reference", index=2),
        ])


@pytest.mark.asyncio
async def test_reference_contract_reads_only_original_variant():
    # Queue state is JSON, so workers receive dictionaries rather than models.
    references = [{"asset_id": "reference-asset", "role": "reference", "index": 1}]
    with patch(
        "services.image_asset_contract.asset_storage.fetch_image_asset_variant",
        new=AsyncMock(return_value=(b"original-bytes", "image/png")),
    ) as fetch:
        images = await load_original_reference_bytes(references, user_id="user-1")

    assert images == [b"original-bytes"]
    fetch.assert_awaited_once_with("reference-asset", "user-1", variant="original")
