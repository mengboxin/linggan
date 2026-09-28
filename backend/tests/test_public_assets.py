import asyncio

from routers import system


def test_public_asset_redirect_is_cached_for_repeat_visits(monkeypatch):
    monkeypatch.setattr(system.settings, "PUBLIC_ASSET_BASE_URL", "https://assets.example.com/root/")

    response = asyncio.run(system.public_asset("pets/bubu.webp"))

    assert response.status_code == 307
    assert response.headers["location"] == "https://assets.example.com/root/pets/bubu.webp"
    assert response.headers["cache-control"] == "public, max-age=604800, stale-while-revalidate=86400"
