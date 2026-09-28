import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from core.config import settings
from core.pool import acquire

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])

DOWNLOAD_CONFIG_KEY = "download_config"

DEFAULT_DESKTOP_CHANGELOG = "\n".join([
    "新增本地与云端工作区切换，桌面端首次使用默认保存到本地。",
    "本地和云端记录完全隔离，切换不会复制、合并或同步已有记录。",
    "本地工作流、自由画布快照与生成素材写入独立的用户工作区目录。",
    "移除旧版云端记录镜像和自动同步逻辑。",
])

DEFAULT_DOWNLOAD_CONFIG = {
    "windows_url": "",
    "mac_url": "",
    "version": "",
    "changelog": DEFAULT_DESKTOP_CHANGELOG,
}


class DownloadConfigBody(BaseModel):
    windows_url: Optional[str] = None
    mac_url: Optional[str] = None
    version: Optional[str] = None
    changelog: Optional[str] = None


def _join_url(base: str, *parts: str) -> str:
    url = (base or "").strip().rstrip("/")
    for part in parts:
        clean = str(part or "").strip().strip("/")
        if clean:
            url = f"{url}/{clean}" if url else clean
    return url


def _public_asset_url(path: str) -> str:
    if not settings.PUBLIC_ASSET_BASE_URL:
        return ""
    return _join_url(settings.PUBLIC_ASSET_BASE_URL, path)


def _env_download_config() -> dict:
    values = {
        "windows_url": settings.DESKTOP_WINDOWS_URL,
        "mac_url": settings.DESKTOP_MAC_URL,
        "version": settings.DESKTOP_VERSION,
        "changelog": settings.DESKTOP_CHANGELOG,
    }
    return {key: value for key, value in values.items() if value}


def _parse_latest_yml(body: str) -> dict:
    info: dict = {}
    lines = body.strip().splitlines()
    idx = 0
    while idx < len(lines):
        raw_line = lines[idx]
        line = raw_line.strip()
        if line.startswith("version:"):
            info["version"] = line.split(":", 1)[1].strip().strip("'\"")
        elif line.startswith("path:"):
            info["path"] = line.split(":", 1)[1].strip().strip("'\"")
        elif line.startswith("releaseNotes:"):
            value = line.split(":", 1)[1].strip()
            if value and value not in {"|-", "|", ">-", ">"}:
                info["changelog"] = value.strip("'\"")
            else:
                notes: list[str] = []
                idx += 1
                while idx < len(lines):
                    note_line = lines[idx]
                    if note_line and not note_line.startswith((" ", "\t")):
                        idx -= 1
                        break
                    clean = note_line.strip()
                    if clean:
                        notes.append(clean[2:].strip() if clean.startswith("- ") else clean)
                    idx += 1
                if notes:
                    info["changelog"] = "\n".join(notes)
        idx += 1
    return info


async def _ensure_table(conn):
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS system_settings (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)


async def _fetch_latest_from_public_assets() -> dict:
    if not settings.PUBLIC_ASSET_BASE_URL:
        return {}

    def read_update_file(filename: str) -> dict:
        updates_url = _public_asset_url(f"updates/{filename}")
        if not updates_url:
            return {}
        try:
            import urllib.request
            import urllib.error

            req = urllib.request.Request(updates_url, headers={"User-Agent": "PixelScribe/1.0"})
            resp = urllib.request.urlopen(req, timeout=5)
            body = resp.read().decode("utf-8")
            return _parse_latest_yml(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                logger.debug(f"[system] optional desktop update file missing: {filename}")
            else:
                logger.warning(f"[system] failed to fetch desktop {filename}: HTTP {e.code}")
        except Exception as e:
            logger.warning(f"[system] failed to fetch desktop {filename}: {e}")
        return {}

    info: dict = {}
    windows = read_update_file("latest.yml")
    if windows.get("version") and windows.get("path"):
        info["version"] = windows["version"]
        info["windows_url"] = _join_url(settings.PUBLIC_ASSET_BASE_URL, "updates", windows["path"])
        if windows.get("changelog"):
            info["changelog"] = windows["changelog"]

    mac = read_update_file("latest-mac.yml")
    if mac.get("path"):
        info["mac_url"] = _join_url(settings.PUBLIC_ASSET_BASE_URL, "updates", mac["path"])
        if not info.get("version") and mac.get("version"):
            info["version"] = mac["version"]
    return info

@router.get("/download-config")
async def get_download_config():
    latest_info = await _fetch_latest_from_public_assets()

    db_config: dict = {}
    try:
        async with acquire() as conn:
            await _ensure_table(conn)
            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = $1",
                DOWNLOAD_CONFIG_KEY,
            )
            if row:
                val = row["value"]
                if isinstance(val, str):
                    val = json.loads(val)
                if isinstance(val, dict):
                    db_config = val
    except Exception as e:
        logger.warning(f"[system] failed to read download config: {e}")

    config = {**DEFAULT_DOWNLOAD_CONFIG, **db_config, **latest_info, **_env_download_config()}
    if latest_info.get("changelog") and not _env_download_config().get("changelog"):
        config["changelog"] = latest_info["changelog"]
    if not str(config.get("changelog") or "").strip():
        config["changelog"] = DEFAULT_DESKTOP_CHANGELOG
    return config


@router.put("/download-config")
async def update_download_config(body: DownloadConfigBody):
    try:
        async with acquire() as conn:
            await _ensure_table(conn)

            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = $1",
                DOWNLOAD_CONFIG_KEY,
            )
            current = DEFAULT_DOWNLOAD_CONFIG.copy()
            if row:
                val = row["value"]
                if isinstance(val, str):
                    val = json.loads(val)
                if isinstance(val, dict):
                    current.update(val)

            current.update(body.model_dump(exclude_none=True))

            await conn.execute("""
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ($1, $2::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
            """, DOWNLOAD_CONFIG_KEY, json.dumps(current, ensure_ascii=False))

        return {"ok": True, "config": current}
    except Exception as e:
        logger.error(f"[system] failed to update download config: {e}")
        return {"ok": False, "error": str(e)}


@router.get("/public-assets/{asset_path:path}")
async def public_asset(asset_path: str):
    target = _public_asset_url(asset_path)
    if not target:
        raise HTTPException(status_code=404, detail="PUBLIC_ASSET_BASE_URL is not configured")
    return RedirectResponse(
        target,
        status_code=307,
        headers={"Cache-Control": "public, max-age=604800, stale-while-revalidate=86400"},
    )
