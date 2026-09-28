from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from routers.system import get_download_config

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


@router.get("/windows", include_in_schema=False)
async def download_windows():
    config = await get_download_config()
    url = config.get("windows_url")
    if not url:
        raise HTTPException(status_code=404, detail="Windows installer is not configured")
    return RedirectResponse(url, status_code=302)


@router.get("/macos", include_in_schema=False)
async def download_macos():
    config = await get_download_config()
    url = config.get("mac_url")
    if not url:
        raise HTTPException(status_code=404, detail="macOS installer is not configured")
    return RedirectResponse(url, status_code=302)
