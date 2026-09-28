"""AI 模型广场路由"""
import logging
from typing import Optional, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
import json as _json

import repositories.model_repo as model_repo
from routers.admin import require_admin
from routers.auth import get_optional_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/models", tags=["模型广场"])


# These routes are consumed by the browser.  Keep transport/provider configuration
# in the repository and the protected admin routes, but never serialize it into a
# public model response.
_PUBLIC_MODEL_FIELDS = frozenset({
    "id",
    "name",
    "category",
    "tags",
    "description",
    "cover_url",
    "provider",
    "provider_logo",
    "price_type",
    "price_credits",
    "enabled",
    "is_featured",
    "sort_order",
    "total_calls",
    "avg_duration_ms",
    "created_at",
    "updated_at",
    "billing_mode",
})


def _public_model(model: dict[str, Any]) -> dict[str, Any]:
    """Return only browser-safe display metadata for public model endpoints."""
    return {key: value for key, value in model.items() if key in _PUBLIC_MODEL_FIELDS}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ModelCreateBody(BaseModel):
    id: str
    name: str
    category: str
    tags: list[str] = []
    description: str = ""
    cover_url: str = ""
    endpoint: str = ""
    api_key: str = ""
    provider: str = ""
    provider_logo: str = ""
    price_type: str = "free"
    price_credits: float = 0
    enabled: bool = True
    is_featured: bool = False
    sort_order: int = 0
    meta: Any = {}

    @field_validator('id')
    @classmethod
    def id_must_not_be_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('模型 ID 不能为空')
        return v.strip()

    @field_validator('meta', mode='before')
    @classmethod
    def parse_meta_create(cls, v: Any) -> dict:
        if isinstance(v, str):
            try:
                return _json.loads(v)
            except Exception:
                return {}
        return v if isinstance(v, dict) else {}


class ModelUpdateBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    provider: Optional[str] = None
    provider_logo: Optional[str] = None
    price_type: Optional[str] = None
    price_credits: Optional[float] = None
    enabled: Optional[bool] = None
    is_featured: Optional[bool] = None
    sort_order: Optional[int] = None
    meta: Optional[Any] = None

    @field_validator('id')
    @classmethod
    def id_must_not_be_empty(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if not v.strip():
            raise ValueError('模型 ID 不能为空')
        return v.strip()

    @field_validator('meta', mode='before')
    @classmethod
    def parse_meta(cls, v: Any) -> Optional[dict]:
        if v is None:
            return None
        if isinstance(v, str):
            try:
                return _json.loads(v)
            except Exception:
                return {}
        if isinstance(v, dict):
            return v
        return {}


# ─── 公开接口（用户端）────────────────────────────────────────────────────────

@router.get("")
async def list_models(
    category: Optional[str] = None,
    _user: Optional[dict] = Depends(get_optional_current_user),
):
    """获取已启用的模型列表（用户端模型广场）"""
    models = await model_repo.list_models(enabled_only=True, category=category)
    return [_public_model(model) for model in models]


@router.get("/{model_id}")
async def get_model(
    model_id: str,
    _user: Optional[dict] = Depends(get_optional_current_user),
):
    """获取单个模型详情"""
    model = await model_repo.get_model(model_id)
    if not model:
        raise HTTPException(404, "模型不存在")
    return _public_model(model)


# ─── 管理接口（管理员）────────────────────────────────────────────────────────

@router.get("/admin/all")
async def admin_list_models(category: Optional[str] = None, _: bool = Depends(require_admin)):
    """管理员获取全部模型（含禁用）。下线 Grok 时仍返回模型行，方便随时恢复。"""
    return await model_repo.list_models(
        enabled_only=False,
        category=category,
        hide_unavailable_grok=False,
    )


@router.post("/admin")
async def admin_create_model(body: ModelCreateBody, _: bool = Depends(require_admin)):
    """管理员新建模型"""
    existing = await model_repo.get_model(body.id, hide_unavailable_grok=False)
    if existing:
        raise HTTPException(400, f"模型 ID '{body.id}' 已存在")
    return await model_repo.create_model(body.model_dump())


@router.patch("/admin/{model_id}")
async def admin_update_model(model_id: str, body: ModelUpdateBody, _: bool = Depends(require_admin)):
    """管理员更新模型"""
    data = body.model_dump(exclude_none=True)
    new_id = str(data.get("id") or model_id).strip()
    if new_id != model_id:
        existing = await model_repo.get_model(new_id, hide_unavailable_grok=False)
        if existing:
            raise HTTPException(400, f"模型 ID '{new_id}' 已存在")
    updated = await model_repo.update_model(model_id, data)
    if not updated:
        raise HTTPException(404, "模型不存在")
    return updated


@router.delete("/admin/{model_id}")
async def admin_delete_model(model_id: str, _: bool = Depends(require_admin)):
    """管理员删除模型"""
    if not model_id or not model_id.strip():
        raise HTTPException(400, "模型 ID 无效")
    try:
        ok = await model_repo.delete_model(model_id.strip())
        if not ok:
            raise HTTPException(404, "模型不存在")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[models] 删除模型失败: {e}", exc_info=True)
        raise HTTPException(500, f"删除失败: {e}")
