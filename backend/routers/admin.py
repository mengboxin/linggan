"""管理员路由：统计、用户管理、系统设置"""
from collections import defaultdict
import hashlib
import json as _json
import logging
import mimetypes
import secrets
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Literal
from fastapi import APIRouter, HTTPException, Query, Depends, Header
from fastapi.responses import Response
from pydantic import BaseModel, Field

from core import cache as ui_cache
from core.pool import acquire
from core.config import settings
from core.redis import get_redis
from core.settings_parsers import parse_bool_setting
from models.schemas import AdminLoginRequest, AdminLoginResponse, StatsResponse, UserOut
import repositories.user_repo as user_repo
import repositories.credit_repo as credit_repo
from repositories import conversation_repo, creative_style_repo, notification_repo, public_gallery_repo, storage_repo
from services import asset_storage

router = APIRouter(prefix="/api/admin", tags=["管理员"])

logger = logging.getLogger(__name__)

_ASSET_VARIANT_KEY_FIELD = {
    "original": "original_key",
    "preview": "preview_key",
    "thumb": "thumb_key",
    "thumbnail": "thumb_key",
}
ADMIN_STORAGE_OVERVIEW_CACHE_TTL_SECONDS = 30


# ─── 管理员鉴权 ────────────────────────────────────────────────────────────────
# 管理员 token 存在 Redis 中：admin_token:{token} -> "1"，有效期 24 小时
# 所有敏感接口都通过 Depends(require_admin) 校验

_ADMIN_TOKEN_TTL = 86400  # 24 小时


def _admin_token_key(token: str) -> str:
    return f"admin_token:{token}"


def _get_admin_email() -> str:
    """
    获取接收管理员验证码的邮箱。
    优先用 ADMIN_EMAIL 配置，其次用 SMTP_USER（发件人邮箱自收自发）。
    """
    email = (getattr(settings, "ADMIN_EMAIL", "") or "").strip()
    if not email:
        email = (settings.SMTP_USER or "").strip()
    return email


async def _ensure_settings_table(conn):
    """确保 system_settings 表存在"""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS system_settings (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)


async def _load_admin_settings() -> dict:
    """从 system_settings 读取管理员当前的 username 和 password_hash"""
    username = "admin"
    password_hash = None
    try:
        async with acquire() as conn:
            await _ensure_settings_table(conn)
            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = 'admin_username'"
            )
            if row:
                stored = row["value"]
                if isinstance(stored, str):
                    stored = _json.loads(stored)
                username = stored.get("username", "admin")

            row2 = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = 'admin_password_hash'"
            )
            if row2:
                stored = row2["value"]
                if isinstance(stored, str):
                    stored = _json.loads(stored)
                password_hash = stored.get("hash")
    except Exception:
        pass
    return {"username": username, "password_hash": password_hash}


async def _save_admin_setting(key: str, value: dict):
    """写入 system_settings"""
    async with acquire() as conn:
        await _ensure_settings_table(conn)
        value_type = await conn.fetchval("""
            SELECT data_type
            FROM information_schema.columns
            WHERE table_name = 'system_settings' AND column_name = 'value'
        """)
        value_json = _json.dumps(value)
        value_expr = "$2::jsonb" if value_type == "jsonb" else "$2"
        await conn.execute(f"""
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ($1, {value_expr}, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
        """, key, value_json)


async def require_admin(authorization: str | None = Header(default=None)) -> bool:
    """管理员鉴权依赖。Authorization: Bearer <token>"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未提供管理员 token")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "token 为空")
    try:
        r = get_redis()
        exists = await r.get(_admin_token_key(token))
        if not exists:
            raise HTTPException(401, "管理员 token 无效或已过期，请重新登录")
    except HTTPException:
        raise
    except Exception as e:
        # Redis 不可用时退化到仅允许本地环境访问（不抛出，避免全站挂）
        import logging
        logging.getLogger(__name__).error(f"[admin] Redis 异常，管理员鉴权降级失败: {e}")
        raise HTTPException(503, "鉴权服务暂不可用")
    return True


# ─── 登录 ──────────────────────────────────────────────────────────────────────

@router.post("/login", response_model=AdminLoginResponse)
async def login(body: AdminLoginRequest):
    # 读取当前的用户名和密码哈希
    admin = await _load_admin_settings()

    # 用户名校验
    username = getattr(body, 'username', 'admin') or 'admin'
    if username != admin["username"]:
        raise HTTPException(401, "用户名或密码错误")

    # 密码校验：优先用数据库里的 hash，回退到 .env 里的明文
    password_hash = hashlib.sha256(body.password.encode()).hexdigest()
    if admin["password_hash"]:
        # 只要数据库里存了 hash，就只认数据库的
        if password_hash != admin["password_hash"]:
            raise HTTPException(401, "用户名或密码错误")
    else:
        # 兼容：数据库还没初始化过，用 .env
        if body.password != settings.ADMIN_PASSWORD:
            raise HTTPException(401, "用户名或密码错误")

    # 生成随机 token 并写入 Redis
    token = secrets.token_urlsafe(32)
    try:
        r = get_redis()
        await r.set(_admin_token_key(token), "1", ex=_ADMIN_TOKEN_TTL)
    except Exception as e:
        raise HTTPException(503, f"登录服务暂不可用，请稍后重试：{e}")
    return AdminLoginResponse(token=token, expires_in=_ADMIN_TOKEN_TTL)


@router.post("/logout")
async def logout(_: bool = Depends(require_admin), authorization: str | None = Header(default=None)):
    """管理员登出，吊销 token"""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
        try:
            r = get_redis()
            await r.delete(_admin_token_key(token))
        except Exception:
            pass
    return {"ok": True}


# ─── 统计（真实数据）──────────────────────────────────────────────────────────

@router.get("/stats", response_model=StatsResponse)
async def stats(_: bool = Depends(require_admin)):
    tz8 = timezone(timedelta(hours=8))
    today_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0)
    week_start  = today_start - timedelta(days=6)

    async with acquire() as conn:
        daily = []
        for i in range(6, -1, -1):
            day_s = today_start - timedelta(days=i)
            day_e = day_s + timedelta(days=1)

            row = await conn.fetchrow(
                """
                SELECT COUNT(*) AS calls,
                       COUNT(*) FILTER (WHERE success) AS success,
                       COUNT(DISTINCT user_id) AS users
                FROM model_call_logs
                WHERE created_at >= $1 AND created_at < $2
                """, day_s, day_e,
            )
            calls = int(row["calls"] or 0)
            users = int(row["users"] or 0)
            success = int(row["success"] or 0)
            daily.append({"day": f"{day_s.month}/{day_s.day}", "calls": calls, "success": success, "users": users})

        total_calls   = sum(d["calls"]   for d in daily)
        total_success = sum(d["success"] for d in daily)
        today = daily[-1]
        today_category_rows = await conn.fetch(
            """
            SELECT model_category, COUNT(*)::int AS calls
            FROM model_call_logs
            WHERE created_at >= $1 AND created_at < $2
            GROUP BY model_category
            ORDER BY model_category
            """,
            today_start,
            today_start + timedelta(days=1),
        )
        today_by_category = {
            str(row["model_category"] or "other"): int(row["calls"] or 0)
            for row in today_category_rows
        }

        avg_row = await conn.fetchrow(
            "SELECT AVG(duration_ms) FROM model_call_logs WHERE success AND duration_ms IS NOT NULL"
        )
        avg_sec = round((avg_row[0] or 0) / 1000, 1)

        model_rows = await conn.fetch(
            """
            SELECT COALESCE(NULLIF(model_name, ''), model_id) AS model_name,
                   COUNT(*)::int AS cnt
            FROM model_call_logs
            WHERE created_at >= $1
            GROUP BY COALESCE(NULLIF(model_name, ''), model_id)
            ORDER BY cnt DESC LIMIT 10
            """,
            week_start,
        )

        PALETTE = ["#a78bfa","#22d3ee","#fbbf24","#34d399","#f87171",
                   "#60a5fa","#fb923c","#a3e635","#e879f9","#94a3b8"]
        model_usage = [
            {"name": r["model_name"] or "未知", "value": int(r["cnt"]), "color": PALETTE[i % len(PALETTE)]}
            for i, r in enumerate(model_rows)
        ] or [{"name": "暂无数据", "value": 1, "color": "#334155"}]

        if total_calls == 0:
            return StatsResponse(
                today_calls=0, today_users=0, total_tasks=0,
                today_by_category=today_by_category,
                success_rate=0, avg_duration_sec=avg_sec, daily=daily,
                model_usage=[{"name": "暂无数据", "value": 1, "color": "#334155"}],
            )

        return StatsResponse(
            today_calls=today["calls"], today_users=today["users"],
            today_by_category=today_by_category,
            total_tasks=total_calls,
            success_rate=round(total_success / total_calls, 4) if total_calls else 0,
            avg_duration_sec=avg_sec, daily=daily, model_usage=model_usage,
        )


@router.get("/model-calls")
async def model_calls(
    limit: int = Query(default=50, ge=1, le=200),
    category: Literal["llm", "vision", "generate", "other"] | None = None,
    billing_mode: Literal["platform_credits", "external_api_key"] | None = None,
    success: bool | None = None,
    _: bool = Depends(require_admin),
):
    """Recent unified model calls, without prompts, assets, endpoints, or secrets."""
    conditions: list[str] = []
    args: list[Any] = []
    if category:
        args.append(category)
        conditions.append(f"l.model_category = ${len(args)}")
    if billing_mode:
        args.append(billing_mode)
        conditions.append(f"l.billing_mode = ${len(args)}")
    if success is not None:
        args.append(success)
        conditions.append(f"l.success = ${len(args)}")
    args.append(limit)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    async with acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT l.id::text, l.model_id, l.model_name, l.model_category,
                   l.provider, l.billing_mode, l.success, l.duration_ms,
                   l.error_message, l.created_at, u.email AS user_email
            FROM model_call_logs l
            LEFT JOIN users u ON u.id = l.user_id
            {where}
            ORDER BY l.created_at DESC
            LIMIT ${len(args)}
            """,
            *args,
        )
    return [
        {
            "id": row["id"],
            "modelId": row["model_id"],
            "modelName": row["model_name"] or row["model_id"],
            "category": row["model_category"],
            "provider": row["provider"],
            "billingMode": row["billing_mode"],
            "success": bool(row["success"]),
            "durationMs": row["duration_ms"],
            "error": row["error_message"],
            "userEmail": row["user_email"] or "system",
            "createdAt": row["created_at"].isoformat() if row["created_at"] else "",
        }
        for row in rows
    ]


# ─── 最近任务 ──────────────────────────────────────────────────────────────────

@router.get("/recent-tasks")
async def recent_tasks(limit: int = 10, _: bool = Depends(require_admin)):
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT t.id::text, t.type, t.status, t.model_id,
                   t.duration_ms, t.created_at, u.email AS user_email
            FROM tasks t LEFT JOIN users u ON u.id = t.user_id
            ORDER BY t.created_at DESC LIMIT $1
            """, limit,
        )
        return [
            {
                "id":        r["id"],
                "type":      r["type"],
                "status":    r["status"],
                "modelId":   r["model_id"],
                "elapsed":   f"{round(r['duration_ms']/1000)}s" if r["duration_ms"] else "—",
                "userEmail": r["user_email"] or "匿名",
                "createdAt": r["created_at"].isoformat() if r["created_at"] else "",
            }
            for r in rows
        ]


# ─── 用户管理 ──────────────────────────────────────────────────────────────────

@router.get("/users", response_model=list[UserOut])
async def list_users(_: bool = Depends(require_admin)):
    rows = await user_repo.list_all()
    # 从 tasks 表实时统计每个用户的任务数
    async with acquire() as conn:
        task_counts = await conn.fetch(
            "SELECT user_id::text, COUNT(*) AS cnt FROM tasks GROUP BY user_id"
        )
        call_counts = await conn.fetch(
            """
            SELECT user_id::text,
                   COUNT(*)::int AS calls,
                   COUNT(*) FILTER (WHERE NOT success)::int AS failed
            FROM model_call_logs
            WHERE user_id IS NOT NULL
            GROUP BY user_id
            """
        )
        latest_calls = await conn.fetch(
            """
            SELECT DISTINCT ON (user_id)
                   user_id::text, model_id, model_category, error_message,
                   created_at::text
            FROM model_call_logs
            WHERE user_id IS NOT NULL
            ORDER BY user_id, created_at DESC
            """
        )
    count_map = {r["user_id"]: int(r["cnt"]) for r in task_counts}
    call_count_map = {
        r["user_id"]: {
            "calls": int(r.get("calls") or 0),
            "failed": int(r.get("failed") or 0),
        }
        for r in call_counts
    }
    latest_call_map = {r["user_id"]: r for r in latest_calls}
    return [UserOut(
        id=r["id"], email=r["email"], display_name=r.get("display_name"),
        role=r["role"], status=r["status"],
        task_count=count_map.get(r["id"], 0), created_at=str(r.get("created_at", "")),
        auth_provider=r.get("auth_provider") or "password",
        billing_mode=r.get("billing_mode") or "platform_credits",
        key_fingerprint=(str(r.get("key_fingerprint") or "")[-6:] or None),
        api_key_status=r.get("api_key_status"),
        foxapi_model_count=int(r.get("foxapi_model_count") or 0),
        grok_key_fingerprint=(str(r.get("grok_key_fingerprint") or "")[-6:] or None),
        grok_api_key_status=r.get("grok_api_key_status"),
        grok_model_count=int(r.get("grok_model_count") or 0),
        request_count=call_count_map.get(r["id"], {}).get("calls", 0),
        failed_count=call_count_map.get(r["id"], {}).get("failed", 0),
        last_used_at=str(latest_call_map.get(r["id"], {}).get("created_at") or "") or None,
        last_verified_at=str(r.get("last_verified_at") or "") or None,
        last_model_id=latest_call_map.get(r["id"], {}).get("model_id"),
        last_call_category=latest_call_map.get(r["id"], {}).get("model_category"),
        last_error=latest_call_map.get(r["id"], {}).get("error_message"),
    ) for r in rows]


class RoleBody(BaseModel):
    role: str

class StatusBody(BaseModel):
    status: str

@router.patch("/users/{user_id}/status")
async def set_user_status(user_id: str, body: StatusBody, _: bool = Depends(require_admin)):
    if body.status not in ("active", "banned"):
        raise HTTPException(400, "status 只能是 active 或 banned")
    user = await user_repo.get_by_id(user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    await user_repo.set_status(user_id, body.status)
    return {"ok": True}


@router.patch("/users/{user_id}/role")
async def set_user_role(user_id: str, body: RoleBody, _: bool = Depends(require_admin)):
    if body.role not in ("user", "vip", "admin"):
        raise HTTPException(400, "role 只能是 user / vip / admin")
    async with acquire() as conn:
        await conn.execute("UPDATE users SET role=$1 WHERE id=$2::uuid", body.role, user_id)
    return {"ok": True}


# ─── 健康检查 ──────────────────────────────────────────────────────────────────

@router.get("/health")
def health():
    return {"ok": True}


# ─── 诊断 ──────────────────────────────────────────────────────────────────────

@router.get("/debug/tasks")
async def debug_tasks(_: bool = Depends(require_admin)):
    tz8 = timezone(timedelta(hours=8))
    week_start = datetime.now(tz8).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)

    async with acquire() as conn:
        total    = await conn.fetchval("SELECT COUNT(*) FROM tasks")
        recent   = await conn.fetch(
            "SELECT id::text, type, status, model_id, user_id::text, created_at::text FROM tasks ORDER BY created_at DESC LIMIT 5"
        )
        tx_total = await conn.fetchval("SELECT COUNT(*) FROM credit_transactions")
        tx_7d    = await conn.fetchval(
            "SELECT COUNT(*) FROM credit_transactions WHERE type='consume' AND created_at >= $1", week_start
        )

        import repositories.task_repo as task_repo
        test_task_id = await task_repo.create(
            "compose", user_id="84966033-6bb3-4bc8-91d6-5e83f40c90c0", model_id="debug-test",
        )
        pg_row = await conn.fetchrow(
            "SELECT id::text, type, status FROM tasks WHERE id = $1::uuid", test_task_id
        )
        await conn.execute("DELETE FROM tasks WHERE id = $1::uuid", test_task_id)

        return {
            "db_now": str(datetime.now(tz8)),
            "tasks_total": total,
            "tasks_recent": [dict(r) for r in recent],
            "credit_tx_total": tx_total,
            "credit_tx_consume_7d": tx_7d,
            "test_task_id": test_task_id,
            "test_pg_row": dict(pg_row) if pg_row else "NOT WRITTEN",
        }


# ─── 积分管理 ──────────────────────────────────────────────────────────────────

@router.get("/users/credits")
async def list_users_credits(_: bool = Depends(require_admin)):
    async with acquire() as conn:
        rows = await conn.fetch(
            "SELECT id::text, email, display_name, role, credits FROM users ORDER BY credits ASC, created_at DESC"
        )
        return [dict(r) for r in rows]


class CreditAdjustBody(BaseModel):
    amount: float
    description: str = "管理员调整"


class RegistrationWelcomeCreditsBody(BaseModel):
    amount: float = Field(default=30.0, ge=0, le=100000)


class FoxApiPromoBody(BaseModel):
    enabled: bool


class GrokAvailabilityBody(BaseModel):
    enabled: bool


class PaymentSettingsBody(BaseModel):
    credits_ratio: int = Field(default=10, ge=1, le=1000)
    min_amount_yuan: int = Field(default=1, ge=1, le=100000)
    max_amount_yuan: int = Field(default=200, ge=1, le=100000)
    order_timeout_minutes: int = Field(default=20, ge=1, le=1440)
    max_pending_orders: int = Field(default=2, ge=1, le=20)
    daily_amount_limit_yuan: int = Field(default=1000, ge=0, le=1000000)
    cancel_cooldown_seconds: int = Field(default=30, ge=0, le=3600)
    cancel_window_minutes: int = Field(default=60, ge=1, le=1440)
    max_cancellations_per_window: int = Field(default=6, ge=1, le=100)


class RechargePackageBody(BaseModel):
    amount_yuan: int = Field(ge=1, le=100000)
    base_credits: int = Field(ge=1, le=100000000)
    bonus_credits: int = Field(default=0, ge=0, le=100000000)
    discount_label: str = Field(default="", max_length=20)
    sort_order: int = Field(default=0, ge=0, le=10000)
    enabled: bool = True


class RechargePackagesBody(BaseModel):
    packages: list[RechargePackageBody] = Field(default_factory=list, max_length=60)


class AdminStoragePolicyRunBody(BaseModel):
    dry_run: bool = True
    limit: int = Field(default=500, ge=1, le=5000)


class AdminStorageSelectedCleanupBody(BaseModel):
    item_ids: list[str] = Field(default_factory=list, max_length=500)
    dry_run: bool = True


class AdminStorageNoticeBody(BaseModel):
    dry_run: bool = True
    base_url: str = Field(default="", max_length=500)


class PublicGalleryReviewBody(BaseModel):
    reason: str = Field(default="", max_length=500)
    reward_credits: float | None = Field(default=None, ge=0, le=100000)


class GlobalAnnouncementBody(BaseModel):
    enabled: bool = False
    show_popup: bool = True
    title: str = Field(default="平台公告", max_length=200)
    body_markdown: str = Field(default="", max_length=20000)
    version: str = Field(default="", max_length=120)


class PublicGalleryRewardSettingsBody(BaseModel):
    per_item: float = Field(default=1.0, ge=0, le=100000)
    daily_cap: float = Field(default=30.0, ge=0, le=100000)


class PublicGalleryAdminMutationBody(BaseModel):
    user_id: str = Field(default="", max_length=80)
    user_email: str = Field(default="", max_length=200)
    task_id: str = Field(default="", max_length=80)
    source_task_id: str = Field(default="", max_length=200)
    variant_index: int = Field(default=0, ge=0, le=10000)
    asset_id: str = Field(default="", max_length=500)
    image_url: str = Field(default="", max_length=2000)
    preview_url: str = Field(default="", max_length=2000)
    thumbnail_url: str = Field(default="", max_length=2000)
    title: str = Field(default="", max_length=200)
    subtitle: str = Field(default="", max_length=500)
    prompt: str = Field(default="", max_length=20000)
    final_prompt: str = Field(default="", max_length=20000)
    module: str = Field(default="TEXT_TO_IMAGE", max_length=40)
    source: str = Field(default="admin_manual", max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=20)
    meta: dict[str, Any] = Field(default_factory=dict)
    visibility: str = Field(default="public", max_length=20)
    moderation_status: str = Field(default="approved", max_length=20)
    rejection_reason: str = Field(default="", max_length=500)


class PublicGalleryAdminUpdateBody(BaseModel):
    asset_id: str | None = Field(default=None, max_length=500)
    image_url: str | None = Field(default=None, max_length=2000)
    preview_url: str | None = Field(default=None, max_length=2000)
    thumbnail_url: str | None = Field(default=None, max_length=2000)
    title: str | None = Field(default=None, max_length=200)
    subtitle: str | None = Field(default=None, max_length=500)
    prompt: str | None = Field(default=None, max_length=20000)
    final_prompt: str | None = Field(default=None, max_length=20000)
    module: str | None = Field(default=None, max_length=40)
    source: str | None = Field(default=None, max_length=80)
    tags: list[str] | None = Field(default=None, max_length=20)
    meta: dict[str, Any] | None = None
    visibility: str | None = Field(default=None, max_length=20)
    moderation_status: str | None = Field(default=None, max_length=20)
    rejection_reason: str | None = Field(default=None, max_length=500)


class CreativeStylePresetCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    module: Literal["TEXT_TO_IMAGE", "IMAGE_EDIT", "POSTER_GEN", "SCI_FIG"]
    description: str = Field(default="", max_length=500)
    prompt_template: str = Field(default="", max_length=1000)
    style_hint: str = Field(default="", max_length=300)
    tags: list[str] = Field(default_factory=list, max_length=8)
    preview_url: str = Field(default="", max_length=2000)
    source_name: str = Field(default="", max_length=200)
    source_url: str = Field(default="", max_length=2000)
    enabled: bool = True
    sort_order: int = Field(default=0, ge=-9999, le=9999)
    schema_version: int = Field(default=1, ge=1, le=100)
    execution_adapter: Literal["prompt_append", "image_generate", "image_edit", "poster", "sci_fig"] = "prompt_append"
    execution_instructions: str = Field(default="", max_length=20000)
    input_contract: dict[str, Any] = Field(default_factory=dict)
    constraints: dict[str, Any] = Field(default_factory=dict)
    default_params: dict[str, Any] = Field(default_factory=dict)
    show_in_gallery: bool = False


class CreativeStylePresetUpdateBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    module: Literal["TEXT_TO_IMAGE", "IMAGE_EDIT", "POSTER_GEN", "SCI_FIG"] | None = None
    description: str | None = Field(default=None, max_length=500)
    prompt_template: str | None = Field(default=None, max_length=1000)
    style_hint: str | None = Field(default=None, max_length=300)
    tags: list[str] | None = Field(default=None, max_length=8)
    preview_url: str | None = Field(default=None, max_length=2000)
    source_name: str | None = Field(default=None, max_length=200)
    source_url: str | None = Field(default=None, max_length=2000)
    enabled: bool | None = None
    sort_order: int | None = Field(default=None, ge=-9999, le=9999)
    schema_version: int | None = Field(default=None, ge=1, le=100)
    execution_adapter: Literal["prompt_append", "image_generate", "image_edit", "poster", "sci_fig"] | None = None
    execution_instructions: str | None = Field(default=None, max_length=20000)
    input_contract: dict[str, Any] | None = None
    constraints: dict[str, Any] | None = None
    default_params: dict[str, Any] | None = None
    show_in_gallery: bool | None = None


def _public_gallery_mutation_error(exc: ValueError) -> HTTPException:
    code = str(exc)
    if code == "owner_required":
        return HTTPException(400, "请填写有效的用户 ID 或用户邮箱，手动新增作品需要归属用户。")
    if code == "prompt_required":
        return HTTPException(400, "请填写提示词或最终提示词。")
    if code == "image_required":
        return HTTPException(400, "请填写可访问的图片地址，或提供有效 asset_id。")
    return HTTPException(400, "创作广场内容参数不完整，请检查后重试。")


@router.get("/announcement")
async def admin_get_global_announcement(_: bool = Depends(require_admin)):
    return {"announcement": await notification_repo.get_global_announcement()}


@router.put("/announcement")
async def admin_update_global_announcement(
    body: GlobalAnnouncementBody,
    _: bool = Depends(require_admin),
):
    announcement = await notification_repo.update_global_announcement(
        enabled=body.enabled,
        show_popup=body.show_popup,
        title=body.title,
        body_markdown=body.body_markdown,
        version=body.version,
    )
    return {"ok": True, "announcement": announcement}


@router.get("/public-gallery")
async def admin_list_public_gallery_review_items(
    status: Literal["pending", "approved", "rejected", "all"] = Query(default="pending"),
    module: str = Query(default="all"),
    visibility: str = Query(default="all"),
    q: str = Query(default="", max_length=120),
    limit: int = Query(default=80, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin),
):
    items = await public_gallery_repo.list_admin_review_items(
        status=status,
        module=module,
        visibility=visibility,
        q=q,
        limit=limit,
        offset=offset,
    )
    reward = await public_gallery_repo.get_public_reward_settings()
    return {
        "items": items,
        "reward": reward,
    }


@router.post("/public-gallery")
async def admin_create_public_gallery_item(
    body: PublicGalleryAdminMutationBody,
    _: bool = Depends(require_admin),
):
    try:
        item = await public_gallery_repo.admin_create_public_generation(
            user_id=body.user_id,
            user_email=body.user_email,
            task_id=body.task_id,
            source_task_id=body.source_task_id,
            variant_index=body.variant_index,
            asset_id=body.asset_id,
            image_url=body.image_url,
            preview_url=body.preview_url,
            thumbnail_url=body.thumbnail_url,
            title=body.title,
            subtitle=body.subtitle,
            prompt=body.prompt,
            final_prompt=body.final_prompt,
            module=body.module,
            source=body.source,
            tags=body.tags,
            meta=body.meta,
            visibility=body.visibility,
            moderation_status=body.moderation_status,
        )
    except ValueError as exc:
        raise _public_gallery_mutation_error(exc)
    if not item:
        raise HTTPException(409, "该作品可能已经存在，请通过搜索找到后编辑。")
    return {"ok": True, "item": item}


@router.get("/public-gallery/reward-settings")
async def admin_get_public_gallery_reward_settings(_: bool = Depends(require_admin)):
    return await public_gallery_repo.get_public_reward_settings()


@router.put("/public-gallery/reward-settings")
async def admin_update_public_gallery_reward_settings(
    body: PublicGalleryRewardSettingsBody,
    _: bool = Depends(require_admin),
):
    settings_payload = await public_gallery_repo.update_public_reward_settings(
        per_item=body.per_item,
        daily_cap=body.daily_cap,
    )
    return {"ok": True, "settings": settings_payload}


@router.put("/public-gallery/{generation_id}")
async def admin_update_public_gallery_item(
    generation_id: str,
    body: PublicGalleryAdminUpdateBody,
    _: bool = Depends(require_admin),
):
    try:
        item = await public_gallery_repo.admin_update_public_generation(
            generation_id=generation_id,
            title=body.title,
            subtitle=body.subtitle,
            prompt=body.prompt,
            final_prompt=body.final_prompt,
            module=body.module,
            source=body.source,
            tags=body.tags,
            asset_id=body.asset_id,
            image_url=body.image_url,
            preview_url=body.preview_url,
            thumbnail_url=body.thumbnail_url,
            visibility=body.visibility,
            moderation_status=body.moderation_status,
            rejection_reason=body.rejection_reason,
            meta=body.meta,
        )
    except ValueError as exc:
        raise _public_gallery_mutation_error(exc)
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.post("/public-gallery/{generation_id}/hide")
async def admin_hide_public_gallery_item(
    generation_id: str,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.admin_set_public_generation_visibility(
        generation_id=generation_id,
        visibility="hidden",
    )
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.post("/public-gallery/{generation_id}/restore")
async def admin_restore_public_gallery_item(
    generation_id: str,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.admin_set_public_generation_visibility(
        generation_id=generation_id,
        visibility="public",
    )
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.post("/public-gallery/{generation_id}/pending")
async def admin_reset_public_gallery_item_review(
    generation_id: str,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.admin_reset_public_generation_review(generation_id=generation_id)
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.delete("/public-gallery/{generation_id}")
async def admin_remove_public_gallery_item(
    generation_id: str,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.admin_soft_delete_public_generation(generation_id=generation_id)
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.post("/public-gallery/{generation_id}/approve")
async def admin_approve_public_gallery_item(
    generation_id: str,
    body: PublicGalleryReviewBody | None = None,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.review_public_generation(
        generation_id=generation_id,
        action="approve",
        reviewer="admin",
        reward_credits_override=body.reward_credits if body else None,
    )
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


@router.post("/public-gallery/{generation_id}/reject")
async def admin_reject_public_gallery_item(
    generation_id: str,
    body: PublicGalleryReviewBody,
    _: bool = Depends(require_admin),
):
    item = await public_gallery_repo.review_public_generation(
        generation_id=generation_id,
        action="reject",
        reviewer="admin",
        reason=body.reason,
    )
    if not item:
        raise HTTPException(404, "公开作品不存在")
    return {"ok": True, "item": item}


# ─── 创作风格配方 ────────────────────────────────────────────────────────────

@router.get("/creative-styles")
async def admin_list_creative_style_presets(_: bool = Depends(require_admin)):
    return {"items": await creative_style_repo.list_style_presets()}


@router.post("/creative-styles")
async def admin_create_creative_style_preset(
    body: CreativeStylePresetCreateBody,
    _: bool = Depends(require_admin),
):
    try:
        item = await creative_style_repo.create_style_preset(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "item": item}


@router.put("/creative-styles/{style_id}")
async def admin_update_creative_style_preset(
    style_id: str,
    body: CreativeStylePresetUpdateBody,
    _: bool = Depends(require_admin),
):
    try:
        item = await creative_style_repo.update_style_preset(
            style_id,
            body.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not item:
        raise HTTPException(404, "风格配方不存在")
    return {"ok": True, "item": item}


@router.delete("/creative-styles/{style_id}")
async def admin_delete_creative_style_preset(
    style_id: str,
    _: bool = Depends(require_admin),
):
    if not await creative_style_repo.delete_style_preset(style_id):
        raise HTTPException(404, "风格配方不存在")
    return {"ok": True}


def _summarize_storage_items(items: list[dict]) -> dict:
    by_kind: dict[str, dict[str, int]] = {}
    by_user: dict[str, dict[str, int]] = {}
    total_bytes = 0
    total_objects = 0
    for item in items:
        kind = str(item.get("kind") or "unknown")
        user_id = str(item.get("user_id") or "")
        size = int(item.get("size_bytes") or 0)
        object_count = len(item.get("object_keys") or [])
        total_bytes += size
        total_objects += object_count
        kind_stats = by_kind.setdefault(kind, {"items": 0, "bytes": 0, "objects": 0})
        kind_stats["items"] += 1
        kind_stats["bytes"] += size
        kind_stats["objects"] += object_count
        if user_id:
            user_stats = by_user.setdefault(user_id, {"items": 0, "bytes": 0, "objects": 0})
            user_stats["items"] += 1
            user_stats["bytes"] += size
            user_stats["objects"] += object_count
    return {
        "items": len(items),
        "bytes_estimated": total_bytes,
        "objects": total_objects,
        "users": len(by_user),
        "by_kind": by_kind,
        "by_user": by_user,
    }


async def _cleanup_admin_storage_items(
    items: list[dict],
    *,
    mode: str,
    dry_run: bool,
) -> dict:
    summary = _summarize_storage_items(items)
    if dry_run:
        return {
            "dry_run": True,
            **summary,
            "records_deleted": 0,
            "object_keys_deleted": 0,
            "object_delete_failed": [],
        }

    grouped: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        user_id = str(item.get("user_id") or "").strip()
        if user_id:
            grouped[user_id].append(item)

    result = {
        "dry_run": False,
        **summary,
        "records_deleted": 0,
        "image_records_deleted": 0,
        "ppt_records_deleted": 0,
        "file_records_deleted": 0,
        "object_keys_requested": 0,
        "object_keys_deleted": 0,
        "object_delete_failed": [],
    }
    for user_id, user_items in grouped.items():
        candidate_keys = {key for item in user_items for key in item.get("object_keys", [])}
        await storage_repo.enqueue_asset_object_deletions(
            candidate_keys,
            user_id=user_id,
            reason=f"admin-{mode}-cleanup",
        )
        deleted_records = await storage_repo.delete_item_records(user_id, user_items)
        keys = storage_repo.object_keys_for_deleted_records(user_items, deleted_records)
        storage_result = await asset_storage.delete_asset_keys_with_queue(
            keys,
            user_id=user_id,
            reason=f"admin-{mode}-cleanup",
        )
        cleanup = {
            **deleted_records,
            "object_keys_requested": len(keys),
            "object_keys_deleted": storage_result.get("deleted", 0),
            "object_delete_failed": storage_result.get("failed", []),
            "bytes_estimated": sum(int(item.get("size_bytes") or 0) for item in user_items),
        }
        result["image_records_deleted"] += int(deleted_records.get("image_records_deleted", 0))
        result["ppt_records_deleted"] += int(deleted_records.get("ppt_records_deleted", 0))
        result["file_records_deleted"] += int(deleted_records.get("file_records_deleted", 0))
        result["records_deleted"] += (
            int(deleted_records.get("image_records_deleted", 0))
            + int(deleted_records.get("ppt_records_deleted", 0))
            + int(deleted_records.get("file_records_deleted", 0))
        )
        result["object_keys_requested"] += len(keys)
        result["object_keys_deleted"] += int(storage_result.get("deleted", 0))
        result["object_delete_failed"].extend(storage_result.get("failed", []))
        await storage_repo.log_cleanup_run(mode=mode, user_id=user_id, items=user_items, cleanup=cleanup)
    return result


@router.post("/credits/adjust/{target_user_id}")
async def admin_adjust_credits(target_user_id: str, body: CreditAdjustBody, _: bool = Depends(require_admin)):
    user = await user_repo.get_by_id(target_user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    if body.amount == 0:
        raise HTTPException(400, "金额不能为 0")
    try:
        if body.amount > 0:
            result = await credit_repo.add_credits(
                user_id=target_user_id, amount=body.amount,
                tx_type="admin_adjust", description=body.description,
            )
        else:
            result = await credit_repo.consume_credits(
                user_id=target_user_id, amount=abs(body.amount), description=body.description,
                funding_source="metered",
            )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **result}


@router.get("/credits/transactions")
async def list_all_transactions(limit: int = Query(default=30, ge=1, le=200), _: bool = Depends(require_admin)):
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ct.id::text, ct.user_id::text, u.email AS user_email,
                   ct.amount, ct.balance_after, ct.type, ct.description, ct.created_at::text
            FROM credit_transactions ct
            LEFT JOIN users u ON u.id = ct.user_id
            ORDER BY ct.created_at DESC LIMIT $1
            """,
            limit,
        )
        return {"transactions": [dict(r) for r in rows]}


# ─── 支付管理 ──────────────────────────────────────────────────────────────────

@router.get("/payment/orders")
async def list_payment_orders(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: str = Query(default=""),
    _: bool = Depends(require_admin),
):
    """获取所有支付订单"""
    import repositories.payment_repo as payment_repo
    if status and status not in ("pending", "paid", "completed", "failed", "cancelled", "expired", "refunded"):
        raise HTTPException(400, "订单状态不合法")
    orders = await payment_repo.get_all_orders(limit=limit, offset=offset, status=status)
    return {"orders": orders}


@router.get("/payment/channels")
async def get_payment_channels(_: bool = Depends(require_admin)):
    """获取支付渠道配置"""
    import repositories.payment_repo as payment_repo
    channels = await payment_repo.get_all_channels()
    # 脱敏处理
    for ch in channels:
        if ch.get("merchant_key"):
            ch["merchant_key"] = ch["merchant_key"][:4] + "****" + ch["merchant_key"][-4:] if len(ch["merchant_key"]) > 8 else "****"
    return {"channels": channels}


class PaymentChannelBody(BaseModel):
    channel_code: str
    merchant_id: str = ""
    merchant_key: str = ""
    api_url: str = ""
    notify_url: str = ""
    return_url: str = ""
    enabled: bool = False
    config_json: dict = Field(default_factory=dict)


@router.post("/payment/channels")
async def update_payment_channel(body: PaymentChannelBody, _: bool = Depends(require_admin)):
    """更新支付渠道配置。
    关键修复：
    - 脱敏保护：若前端传回脱敏字符串（含 ****），保持数据库原值不变
    - 否则才覆盖，避免清空密钥
    """
    import repositories.payment_repo as payment_repo

    # 读取当前配置以便做"密钥不变"的回退
    existing = await payment_repo.get_channel(body.channel_code)
    if not existing:
        raise HTTPException(404, "支付渠道不存在")

    merchant_key = body.merchant_key
    if not merchant_key or "****" in merchant_key:
        # 前端传的是脱敏值或空值，保持原有密钥
        merchant_key = existing.get("merchant_key", "")

    ok = await payment_repo.update_channel(
        channel_code=body.channel_code,
        merchant_id=body.merchant_id,
        merchant_key=merchant_key,
        api_url=body.api_url,
        notify_url=body.notify_url,
        return_url=body.return_url,
        enabled=body.enabled,
        config_json=body.config_json,
    )
    if not ok:
        raise HTTPException(404, "支付渠道不存在")
    return {"ok": True}


@router.get("/payment/settings")
async def get_payment_settings(_: bool = Depends(require_admin)):
    """获取支付安全和订单策略配置。"""
    import repositories.payment_repo as payment_repo
    return {"settings": await payment_repo.get_payment_settings()}


@router.put("/payment/settings")
async def update_payment_settings(body: PaymentSettingsBody, _: bool = Depends(require_admin)):
    """更新支付安全和订单策略配置。"""
    import repositories.payment_repo as payment_repo
    settings_value = await payment_repo.update_payment_settings(body.model_dump())
    return {"ok": True, "settings": settings_value}


@router.get("/payment/packages")
async def get_recharge_packages(_: bool = Depends(require_admin)):
    """获取后台可配置的充值套餐。"""
    import repositories.payment_repo as payment_repo
    return {"packages": await payment_repo.get_current_package_configs()}


@router.put("/payment/packages")
async def update_recharge_packages(body: RechargePackagesBody, _: bool = Depends(require_admin)):
    """批量更新充值套餐。"""
    import repositories.payment_repo as payment_repo
    if not body.packages:
        raise HTTPException(400, "至少保留一个充值套餐")

    seen_amounts: set[int] = set()
    normalized = []
    for idx, pkg in enumerate(body.packages, start=1):
        if pkg.amount_yuan in seen_amounts:
            raise HTTPException(400, f"充值金额 {pkg.amount_yuan} 元重复")
        seen_amounts.add(pkg.amount_yuan)
        if pkg.base_credits < pkg.amount_yuan:
            raise HTTPException(400, f"{pkg.amount_yuan} 元套餐基础积分不能低于充值金额")
        normalized.append({
            **pkg.model_dump(),
            "discount_label": pkg.discount_label.strip() or None,
            "sort_order": pkg.sort_order or idx,
        })

    packages = await payment_repo.replace_packages(normalized)
    return {"ok": True, "packages": packages}


@router.get("/finance/stats")
async def get_finance_stats(_: bool = Depends(require_admin)):
    """获取财务统计数据"""
    import repositories.payment_repo as payment_repo
    stats = await payment_repo.get_finance_stats()
    return stats


# ─── 存储监控与清理 ─────────────────────────────────────────────────────────────

@router.get("/storage/overview")
async def admin_storage_overview(_: bool = Depends(require_admin)):
    """后台存储监控概览：桶容量、到期候选、用户占用排行、最近清理记录。"""
    version = await ui_cache.get_global_cache_version("storage")
    cache_key = ui_cache.global_cache_key("admin-storage-overview", version)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached
    try:
        bucket = await storage_repo.bucket_usage_estimate()
        retention = await storage_repo.admin_retention_summary()
        top_users = await storage_repo.top_storage_users(limit=100)
        recent_runs = await storage_repo.recent_cleanup_runs(limit=12)
    except RuntimeError as exc:
        logger.exception("admin storage overview schema/runtime error")
        raise HTTPException(500, str(exc))
    except Exception:
        logger.exception("admin storage overview failed")
        raise
    payload = {
        "bucket": bucket,
        "retention": retention,
        "top_users": top_users,
        "recent_runs": recent_runs,
        "policy": {
            "web_history_retention_days": settings.WEB_HISTORY_RETENTION_DAYS,
            "expiry_notice_days": settings.WEB_HISTORY_EXPIRY_NOTICE_DAYS,
            "export_retention_days": settings.EXPORTED_FILE_RETENTION_DAYS,
            "temporary_retention_days": settings.TEMP_ASSET_RETENTION_DAYS,
            "large_asset_warning_bytes": settings.LARGE_ASSET_WARNING_BYTES,
            "bucket_quota_bytes": settings.CLOUD_STORAGE_BUCKET_QUOTA_BYTES,
            "bucket_warn_bytes": settings.CLOUD_STORAGE_BUCKET_WARN_BYTES,
        },
        "automation": {
            "recommended": True,
            "mode": "scheduled_cleanup",
            "command": "cd /www/wwwroot/pixelscribe/backend && python scripts/storage_policy_job.py --delete-expired --base-url https://你的域名",
            "notice_only_command": "cd /www/wwwroot/pixelscribe/backend && python scripts/storage_policy_job.py --notice-only --base-url https://你的域名",
        },
    }
    await ui_cache.set_json(cache_key, payload, ADMIN_STORAGE_OVERVIEW_CACHE_TTL_SECONDS)
    return payload


@router.get("/storage/candidates")
async def admin_storage_candidates(
    status: Literal["all", "expired", "expiring", "large"] = Query(default="expired"),
    kind: Literal[
        "all",
        "image",
        "text_image",
        "workspace",
        "sci_fig",
        "poster",
        "ppt",
        "ppt_file",
        "ppt_slide",
        "presentation_upload",
    ] = Query(default="all"),
    sort: Literal["size_desc", "size_asc", "time_desc", "time_asc", "expires_asc"] = Query(default="expires_asc"),
    limit: int = Query(default=100, ge=1, le=300),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin),
):
    """查看后台可清理候选项。expired 是真正会被定时清理的集合。"""
    try:
        items = await storage_repo.admin_list_storage_items(
            status=status,
            kind=kind,
            sort=sort,
            limit=limit,
            offset=offset,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"items": items, "summary": _summarize_storage_items(items)}


@router.get("/storage/assets/{asset_id}/{variant}")
async def admin_storage_asset_preview(
    asset_id: str,
    variant: Literal["original", "preview", "thumb", "thumbnail"] = "thumb",
    _: bool = Depends(require_admin),
):
    """后台存储监管预览图代理。管理员页的 img 标签无法携带 Authorization，前端用 fetch+blob 调此接口。"""
    key_field = _ASSET_VARIANT_KEY_FIELD.get(variant)
    if not key_field:
        raise HTTPException(404, "资源不存在")

    async with acquire() as conn:
        asset = await conn.fetchrow(
            """
            SELECT id::text, mime_type, original_key, preview_key, thumb_key
            FROM image_assets
            WHERE id = $1::uuid
            """,
            asset_id,
        )
    if not asset:
        raise HTTPException(404, "资源不存在")

    asset_data = dict(asset)
    key = asset_data.get(key_field) or asset_data.get("original_key")
    if not key:
        raise HTTPException(404, "资源文件不存在")

    try:
        data = await asset_storage.fetch_asset_key_bytes(key)
    except Exception as exc:
        raise HTTPException(404, f"资源读取失败: {exc}")

    media_type = mimetypes.guess_type(key)[0] or asset_data.get("mime_type") or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/storage/cleanup/expired")
async def admin_cleanup_expired(body: AdminStoragePolicyRunBody, _: bool = Depends(require_admin)):
    """手动执行到期清理。dry_run=true 时只返回预估，不删除数据库或对象存储。"""
    from scripts.storage_policy_job import expired_items

    items = await expired_items(body.limit)
    cleanup = await _cleanup_admin_storage_items(items, mode="admin_expired", dry_run=body.dry_run)
    return {
        "success": True,
        "cleanup": cleanup,
        "preview_items": items[:100] if body.dry_run else [],
        "overview": await storage_repo.admin_retention_summary(),
    }


@router.post("/storage/cleanup/selected")
async def admin_cleanup_selected(body: AdminStorageSelectedCleanupBody, _: bool = Depends(require_admin)):
    """后台按选中项清理。真实执行时会按用户分组并跳过仍被引用的对象 key。"""
    item_ids = [item.strip() for item in body.item_ids if item and item.strip()]
    if not item_ids:
        raise HTTPException(400, "请选择要清理的记录")
    items = await storage_repo.get_admin_cleanup_items_by_ids(item_ids)
    if not items:
        raise HTTPException(404, "未找到可清理的记录")
    cleanup = await _cleanup_admin_storage_items(items, mode="admin_selected", dry_run=body.dry_run)
    return {
        "success": True,
        "cleanup": cleanup,
        "preview_items": items[:100] if body.dry_run else [],
        "overview": await storage_repo.admin_retention_summary(),
    }


@router.post("/storage/notices/send")
async def admin_send_storage_notices(body: AdminStorageNoticeBody, _: bool = Depends(require_admin)):
    """手动发送即将到期提醒邮件。dry_run=true 时只统计不发信。"""
    from scripts.storage_policy_job import send_expiry_notices

    result = await send_expiry_notices(body.base_url, dry_run=body.dry_run)
    return {"success": True, "result": result}


@router.post("/storage/warning/send")
async def admin_send_storage_warning(body: AdminStorageNoticeBody, _: bool = Depends(require_admin)):
    """手动检测并发送桶容量预警邮件。未达到阈值时不会发信。"""
    from scripts.storage_policy_job import send_bucket_warning

    result = await send_bucket_warning(body.base_url, dry_run=body.dry_run)
    return {"success": True, "result": result}


# ─── 管理员账户安全（改用户名 / 改密码必须走邮箱验证码）─────────────────────

class SendAdminOtpBody(BaseModel):
    purpose: str = Field(pattern="^(change_username|change_password)$")


class ChangeUsernameBody(BaseModel):
    new_username: str = Field(min_length=2, max_length=32)
    code: str = Field(min_length=6, max_length=6)


class ChangePasswordBody(BaseModel):
    new_password: str = Field(min_length=8)
    confirm_password: str
    code: str = Field(min_length=6, max_length=6)


@router.get("/settings/account")
async def get_admin_account(_: bool = Depends(require_admin)):
    """获取当前管理员账户信息（用户名 + 脱敏邮箱）"""
    admin = await _load_admin_settings()
    email = _get_admin_email()
    # 脱敏邮箱：a***@example.com
    masked = ""
    if email and "@" in email:
        local, _sep, domain = email.partition("@")
        masked = (local[:1] + "***" if len(local) > 1 else "***") + "@" + domain
    return {
        "username": admin["username"],
        "email": masked,
        "has_email": bool(email),
        "has_custom_password": bool(admin["password_hash"]),
    }


@router.post("/settings/send-otp")
async def send_admin_otp(body: SendAdminOtpBody, _: bool = Depends(require_admin)):
    """给管理员绑定邮箱发验证码（改用户名/改密码前必须调用）"""
    from services.otp import create_otp, send_otp_email

    email = _get_admin_email()
    if not email:
        raise HTTPException(
            500,
            "系统未配置管理员邮箱，请在 .env 设置 SMTP_USER 或 ADMIN_EMAIL",
        )

    # purpose 前缀避免和用户端 OTP 串
    purpose = f"admin_{body.purpose}"
    code, wait = await create_otp(email, purpose)
    if wait > 0:
        raise HTTPException(429, f"发送太频繁，请 {wait} 秒后再试")

    try:
        # 复用用户端 OTP 邮件模板
        await send_otp_email(email, code, "reset")
    except Exception as e:
        raise HTTPException(500, f"邮件发送失败：{e}")

    local, _sep, domain = email.partition("@")
    masked = (local[:1] + "***" if len(local) > 1 else "***") + "@" + domain
    return {"ok": True, "message": f"验证码已发送至 {masked}，5 分钟内有效"}


@router.post("/settings/username")
async def change_admin_username(body: ChangeUsernameBody, _: bool = Depends(require_admin)):
    """修改管理员用户名（必须先通过邮箱验证码）"""
    from services.otp import verify_otp

    email = _get_admin_email()
    if not email:
        raise HTTPException(500, "系统未配置管理员邮箱")

    if not await verify_otp(email, body.code, "admin_change_username"):
        raise HTTPException(400, "验证码错误或已过期")

    new_username = body.new_username.strip()
    if not new_username:
        raise HTTPException(400, "用户名不能为空")

    await _save_admin_setting("admin_username", {"username": new_username})
    return {"ok": True, "username": new_username}


@router.post("/settings/password")
async def change_admin_password(body: ChangePasswordBody, _: bool = Depends(require_admin)):
    """修改管理员密码（必须先通过邮箱验证码）"""
    from services.otp import verify_otp

    if body.new_password != body.confirm_password:
        raise HTTPException(400, "两次输入的密码不一致")

    email = _get_admin_email()
    if not email:
        raise HTTPException(500, "系统未配置管理员邮箱")

    if not await verify_otp(email, body.code, "admin_change_password"):
        raise HTTPException(400, "验证码错误或已过期")

    password_hash = hashlib.sha256(body.new_password.encode()).hexdigest()
    await _save_admin_setting("admin_password_hash", {"hash": password_hash})
    # 同步更新内存的明文密码
    settings.ADMIN_PASSWORD = body.new_password

    # 吊销所有 admin token，强制重新登录
    try:
        r = get_redis()
        cursor = 0
        while True:
            cursor, keys = await r.scan(cursor=cursor, match="admin_token:*", count=100)
            if keys:
                await r.delete(*keys)
            if cursor == 0:
                break
    except Exception:
        pass

    return {"ok": True, "message": "密码已修改，请重新登录"}


# ─── FoxAPI 弹窗开关 ─────────────────────────────────────────────────────────

@router.get("/settings/foxapi-promo")
async def get_foxapi_promo_setting(_: bool = Depends(require_admin)):
    """获取 FoxAPI 弹窗开关状态"""
    async with acquire() as conn:
        await _ensure_settings_table(conn)
        row = await conn.fetchrow(
            "SELECT value FROM system_settings WHERE key = 'foxapi_promo_enabled'"
        )
    enabled = parse_bool_setting(row["value"] if row else None, default=False)
    return {"enabled": enabled}


@router.put("/settings/foxapi-promo")
async def update_foxapi_promo_setting(body: FoxApiPromoBody, _: bool = Depends(require_admin)):
    """更新 FoxAPI 弹窗开关"""
    enabled = bool(body.enabled)
    await _save_admin_setting("foxapi_promo_enabled", {"enabled": enabled})
    return {"ok": True, "enabled": enabled}


@router.get("/settings/grok")
async def get_grok_availability_setting(_: bool = Depends(require_admin)):
    """获取 Grok 通道开关。关闭后前台不再展示 Grok 模型、Key 和生视频。"""
    async with acquire() as conn:
        await _ensure_settings_table(conn)
        row = await conn.fetchrow(
            "SELECT value FROM system_settings WHERE key = 'grok_enabled'"
        )
    enabled = parse_bool_setting(row["value"] if row else None, default=True)
    return {"enabled": enabled}


@router.put("/settings/grok")
async def update_grok_availability_setting(body: GrokAvailabilityBody, _: bool = Depends(require_admin)):
    """一键下线或恢复 Grok 通道。不删除已保存的 Key 和模型行。"""
    enabled = bool(body.enabled)
    await _save_admin_setting("grok_enabled", {"enabled": enabled})
    if not enabled:
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE users SET billing_mode = 'platform_credits', updated_at = NOW()
                WHERE billing_mode = 'grok_api_key'
                """
            )
    return {"ok": True, "enabled": enabled}


@router.get("/settings/registration-welcome-credits")
async def get_registration_welcome_credits_setting(_: bool = Depends(require_admin)):
    """获取新用户注册送积分配置。"""
    async with acquire() as conn:
        await _ensure_settings_table(conn)
        row = await conn.fetchrow(
            "SELECT value FROM system_settings WHERE key = 'registration_welcome_credits'"
        )
    amount = 30.0
    if row:
        val = row["value"]
        try:
            if isinstance(val, str):
                val = _json.loads(val)
            amount = float(val.get("amount", 30.0)) if isinstance(val, dict) else float(val)
        except Exception:
            amount = 30.0
    return {"amount": max(0.0, amount)}


@router.put("/settings/registration-welcome-credits")
async def update_registration_welcome_credits_setting(
    body: RegistrationWelcomeCreditsBody,
    _: bool = Depends(require_admin),
):
    """更新新用户注册送积分配置，仅影响之后注册的用户。"""
    amount = max(0.0, float(body.amount))
    await _save_admin_setting("registration_welcome_credits", {"amount": amount})
    return {"ok": True, "amount": amount}
