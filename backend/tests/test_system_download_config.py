import urllib.error

import pytest

from routers import system


def test_latest_manifest_release_notes_are_exposed_as_changelog():
    parsed = system._parse_latest_yml(
        """
version: 0.2.7
path: PixelScribe Setup 0.2.7.exe
releaseNotes: |-
  - 本地与云端工作区完全隔离。
  - 桌面端默认使用本地存储。
"""
    )

    assert parsed == {
        "version": "0.2.7",
        "path": "PixelScribe Setup 0.2.7.exe",
        "changelog": "本地与云端工作区完全隔离。\n桌面端默认使用本地存储。",
    }


@pytest.mark.asyncio
async def test_public_manifest_changelog_is_included_in_download_config(monkeypatch):
    manifest = b"""version: 0.2.7
path: PixelScribe Setup 0.2.7.exe
releaseNotes: |-
  - Local and cloud workspaces are isolated.
"""

    class Response:
        def read(self):
            return manifest

    def urlopen(request, timeout):
        if str(request.full_url).endswith("latest.yml"):
            return Response()
        raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)

    monkeypatch.setattr(system.settings, "PUBLIC_ASSET_BASE_URL", "https://assets.example.test")
    monkeypatch.setattr("urllib.request.urlopen", urlopen)

    result = await system._fetch_latest_from_public_assets()

    assert result["version"] == "0.2.7"
    assert result["windows_url"].endswith("/updates/PixelScribe Setup 0.2.7.exe")
    assert result["changelog"] == "Local and cloud workspaces are isolated."
