"""
认证路由
- 密码登录：第一次密码失败后，下一次尝试必须通过图形验证码
- 注册/OTP登录/重置密码：邮箱验证码本身即人机验证，无需图形验证码
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr
from typing import AsyncIterator, Literal, Optional
import json
import logging
import re

from core.pool import acquire
from core.redis import get_redis
from core.settings_parsers import parse_bool_setting
from core.user_context import bind_user_context
from core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
)
import repositories.user_repo as user_repo
import repositories.credit_repo as credit_repo
import repositories.legal_repo as legal_repo
from services.otp import check_otp, consume_otp, create_otp, verify_otp, send_otp_email
from services.captcha import create_captcha, verify_captcha
from services import foxapi_credentials, grok_credentials
from services.compute_billing import FOXAPI_BILLING_MODE, GROK_BILLING_MODE, PLATFORM_BILLING_MODE
from services.grok_availability import GROK_DISABLED_MESSAGE, is_grok_enabled, suspend_grok_billing_if_disabled
from core.rate_limit import rate_limit, RateLimitExceeded
from services.legal_documents import (
    CURRENT_LEGAL_DOCUMENTS,
    LEGACY_BOOLEAN_LEGAL_VERSION,
    LegalDocument,
    current_required_legal_documents,
    current_required_legal_fingerprint,
    documents_cover_current_required,
    get_legal_document,
)

router = APIRouter(prefix="/api/auth", tags=["认证"])
bearer = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)

# 第一次密码失败后，下一次尝试必须通过一次性图形验证码。
_CAPTCHA_THRESHOLD = 1
# 失败计数 key 过期时间（秒）
_FAIL_TTL = 600
REGISTRATION_WELCOME_CREDITS_DEFAULT = 30.0
REGISTRATION_WELCOME_CREDITS_KEY = "registration_welcome_credits"


# ─── 请求模型 ──────────────────────────────────────────────────────────────────

class SendOTPRequest(BaseModel):
    email: EmailStr
    purpose: str = Field(default="register", pattern="^(register|login|reset)$")


class AuthLegalAcceptance(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    document_type: Literal["terms", "privacy", "ai", "payment"] = Field(alias="documentType")
    version: str = Field(min_length=1, max_length=64)
    content_hash: str = Field(alias="contentHash", pattern=r"^[0-9a-f]{64}$")

class RegisterRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    password: str = Field(min_length=8)
    confirm_password: str
    display_name: str = Field(default="", max_length=50)
    api_key: Optional[SecretStr] = None
    use_external_compute: bool = False
    terms_accepted: bool = False
    privacy_accepted: bool = False
    legal_acceptances: list[AuthLegalAcceptance] = Field(default_factory=list, max_length=4)

class LoginPasswordRequest(BaseModel):
    email: EmailStr
    password: str
    captcha_id: Optional[str] = None
    captcha_text: Optional[str] = None
    terms_accepted: bool = False
    privacy_accepted: bool = False
    legal_acceptances: list[AuthLegalAcceptance] = Field(default_factory=list, max_length=4)

class LoginOTPRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    terms_accepted: bool = False
    privacy_accepted: bool = False
    legal_acceptances: list[AuthLegalAcceptance] = Field(default_factory=list, max_length=4)

class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8)
    confirm_password: str

class RefreshRequest(BaseModel):
    refresh_token: str

class ConnectApiKeyRequest(BaseModel):
    api_key: SecretStr
    activate: bool = True

class ComputeSourceRequest(BaseModel):
    mode: Literal["platform_credits", "external_api_key", "grok_api_key"]

class PetPreferenceRequest(BaseModel):
    pet_id: Optional[str] = Field(default=None, max_length=80)
    pet_custom_name: str = Field(default="", max_length=50)

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: dict


# ─── 工具 ──────────────────────────────────────────────────────────────────────

def _public_user_payload(user: dict, *, grok_enabled: bool = True) -> dict:
    fingerprint = str(user.get("key_fingerprint") or "")
    grok_fingerprint = str(user.get("grok_key_fingerprint") or "")
    billing_mode = user.get("billing_mode") or PLATFORM_BILLING_MODE
    if billing_mode == foxapi_credentials.BILLING_MODE and not (
        fingerprint and user.get("api_key_status") == "active"
    ):
        billing_mode = PLATFORM_BILLING_MODE
    if billing_mode == GROK_BILLING_MODE and not (
        grok_enabled
        and grok_fingerprint
        and user.get("grok_api_key_status") == "active"
    ):
        billing_mode = PLATFORM_BILLING_MODE
    if not grok_enabled and billing_mode == GROK_BILLING_MODE:
        billing_mode = PLATFORM_BILLING_MODE
    return {
        "id":          user["id"],
        "email":       user["email"],
        "displayName": user.get("display_name") or user["email"].split("@")[0],
        "role":        user["role"],
        "credits":     float(user.get("credits", 0)),
        "petId":       user.get("pet_id"),
        "petCustomName": user.get("pet_custom_name") or "",
        "authProvider": user.get("auth_provider") or "password",
        "billingMode": billing_mode,
        "hasApiKey": bool(fingerprint),
        "apiKeyFingerprint": fingerprint[-12:] if fingerprint else "",
        "apiKeyStatus": user.get("api_key_status"),
        "foxapiModelCount": int(user.get("foxapi_model_count") or 0),
        "foxapiLastVerifiedAt": str(user.get("last_verified_at") or "") or None,
        "foxapiLastUsedAt": str(user.get("last_used_at") or "") or None,
        "hasGrokApiKey": bool(grok_fingerprint) if grok_enabled else False,
        "grokApiKeyFingerprint": grok_fingerprint[-12:] if grok_enabled and grok_fingerprint else "",
        "grokApiKeyStatus": user.get("grok_api_key_status") if grok_enabled else None,
        "grokModelCount": int(user.get("grok_model_count") or 0) if grok_enabled else 0,
        "grokLastVerifiedAt": str(user.get("grok_last_verified_at") or "") or None if grok_enabled else None,
        "grokLastUsedAt": str(user.get("grok_last_used_at") or "") or None if grok_enabled else None,
        "grokEnabled": grok_enabled,
    }


def _make_token_response(user: dict, *, legal_accepted: bool = False, grok_enabled: bool = True) -> TokenResponse:
    fingerprint = current_required_legal_fingerprint() if legal_accepted else None
    return TokenResponse(
        access_token=create_access_token(user["id"], user["email"], user["role"], fingerprint),
        refresh_token=create_refresh_token(user["id"], fingerprint),
        user=_public_user_payload(user, grok_enabled=grok_enabled),
    )


async def _token_response(user: dict, *, legal_accepted: bool = False) -> TokenResponse:
    grok_enabled = await is_grok_enabled()
    user = await suspend_grok_billing_if_disabled(user) or user
    return _make_token_response(user, legal_accepted=legal_accepted, grok_enabled=grok_enabled)


def _sanitize_pet_preference(body: PetPreferenceRequest) -> tuple[Optional[str], str]:
    pet_id = (body.pet_id or "").strip()
    if pet_id and not re.fullmatch(r"[A-Za-z0-9-]+", pet_id):
        raise HTTPException(400, "宠物 ID 格式不正确")
    custom_name = body.pet_custom_name.strip()[:50]
    return pet_id or None, custom_name


def _resolve_policy_acceptances(
    terms_accepted: bool,
    privacy_accepted: bool,
    claims: list[AuthLegalAcceptance] | None = None,
) -> list[LegalDocument]:
    if not claims:
        if not terms_accepted or not privacy_accepted:
            raise HTTPException(400, "请先阅读并同意服务条款和隐私政策")
        documents = [
            get_legal_document(document_type, LEGACY_BOOLEAN_LEGAL_VERSION)
            for document_type in ("terms", "privacy")
        ]
        if any(document is None for document in documents):
            raise HTTPException(
                426,
                detail={
                    "code": "LEGAL_CLIENT_UPGRADE_REQUIRED",
                    "message": "当前客户端展示的协议版本已停用，请升级客户端后重新确认",
                },
            )
        return [document for document in documents if document is not None]

    documents: list[LegalDocument] = []
    seen: set[str] = set()
    for claim in claims:
        if claim.document_type in seen:
            raise HTTPException(400, f"协议类型重复：{claim.document_type}")
        seen.add(claim.document_type)
        document = get_legal_document(claim.document_type, claim.version)
        if document is None or document.content_hash != claim.content_hash:
            current = CURRENT_LEGAL_DOCUMENTS[claim.document_type]
            raise HTTPException(
                409,
                detail={
                    "code": "LEGAL_DOCUMENT_OUTDATED",
                    "message": "协议版本已更新，请阅读最新版本后重新确认",
                    "document": current.public_payload(),
                },
            )
        documents.append(document)

    if not {"terms", "privacy"}.issubset(seen):
        raise HTTPException(400, "请确认当前版本的用户服务协议和隐私政策")
    return documents


def _ensure_policy_acceptance(terms_accepted: bool, privacy_accepted: bool):
    """Backward-compatible helper retained for direct callers."""
    _resolve_policy_acceptances(terms_accepted, privacy_accepted)


def _parse_registration_welcome_credits(value) -> float:
    if value is None:
        return REGISTRATION_WELCOME_CREDITS_DEFAULT
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            try:
                return max(0.0, float(value))
            except Exception:
                return REGISTRATION_WELCOME_CREDITS_DEFAULT
    if isinstance(value, dict):
        value = value.get("amount", REGISTRATION_WELCOME_CREDITS_DEFAULT)
    try:
        return max(0.0, float(value))
    except Exception:
        return REGISTRATION_WELCOME_CREDITS_DEFAULT


async def _get_registration_welcome_credits() -> float:
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = $1",
                REGISTRATION_WELCOME_CREDITS_KEY,
            )
    except Exception:
        return REGISTRATION_WELCOME_CREDITS_DEFAULT
    return _parse_registration_welcome_credits(row["value"] if row else None)


def _fail_key(email: str) -> str:
    return f"login_fail:{email.lower()}"


async def _get_fail_count(email: str) -> int:
    r = get_redis()
    try:
        val = await r.get(_fail_key(email))
        return int(val) if val else 0
    except Exception:
        return 0


async def _incr_fail(email: str):
    r = get_redis()
    try:
        key = _fail_key(email)
        await r.incr(key)
        await r.expire(key, _FAIL_TTL)
    except Exception:
        pass


async def _clear_fail(email: str):
    r = get_redis()
    try:
        await r.delete(_fail_key(email))
    except Exception:
        pass


def _request_ip(request: Request | None) -> str:
    """Resolve the client address without trusting forwarded headers blindly."""
    if request is None:
        return "unknown"
    direct = str(request.client.host if request.client else "").strip()
    if direct in {"127.0.0.1", "::1"}:
        forwarded = str(request.headers.get("x-real-ip") or "").strip()
        if not forwarded:
            forwarded = str(request.headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded[:128]
    return (direct or "unknown")[:128]


def _request_legal_evidence(request: Request | None) -> tuple[str, str]:
    user_agent = str(request.headers.get("user-agent") or "")[:1024] if request else ""
    return _request_ip(request), user_agent


async def _enforce_auth_rate_limit(request: Request | None, action: str) -> None:
    try:
        await rate_limit(f"ip:{_request_ip(request)}", action)
    except RateLimitExceeded as exc:
        raise HTTPException(
            429,
            "请求过于频繁，请稍后再试",
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


async def _authenticated_user(cred: HTTPAuthorizationCredentials | None) -> dict:
    if not cred:
        raise HTTPException(401, "未登录")
    payload = decode_token(cred.credentials)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "token 无效或已过期，请重新登录")
    user = await user_repo.get_by_id(payload["sub"])
    if not user:
        raise HTTPException(401, "用户不存在")
    if user["status"] == "banned":
        raise HTTPException(403, "账号已被封禁，请联系管理员")
    return user


def _legal_reconsent_error(user: dict | None = None) -> HTTPException:
    reconsent_access_token = None
    if user:
        reconsent_access_token = create_access_token(
            user["id"], user["email"], user["role"]
        )
    return HTTPException(
        428,
        detail={
            "code": "LEGAL_RECONSENT_REQUIRED",
            "message": "重要协议已更新，请阅读并确认后继续使用",
            "documents": [
                document.public_payload(include_content=True)
                for document in current_required_legal_documents()
            ],
            "reconsentAccessToken": reconsent_access_token,
        },
    )


async def _require_current_legal_acceptance(user: dict, token_payload: dict) -> None:
    if token_payload.get("legal") == current_required_legal_fingerprint():
        return
    if await legal_repo.has_current_required_acceptances(user["id"]):
        return
    raise _legal_reconsent_error(user)


# ─── 获取图形验证码 ────────────────────────────────────────────────────────────

async def get_current_user(
    request: Request = None,
    cred: HTTPAuthorizationCredentials = Depends(bearer),
) -> AsyncIterator[dict]:
    user = await _authenticated_user(cred)
    payload = decode_token(cred.credentials) if cred else None
    await _require_current_legal_acceptance(user, payload or {})
    storage_workspace = request.headers.get("x-pixelscribe-storage-workspace", "cloud") if request else "cloud"
    with bind_user_context(user["id"], user.get("billing_mode"), storage_workspace):
        yield user


async def get_optional_current_user(
    request: Request = None,
    cred: HTTPAuthorizationCredentials = Depends(bearer),
) -> AsyncIterator[Optional[dict]]:
    if not cred:
        yield None
        return
    user = await _authenticated_user(cred)
    payload = decode_token(cred.credentials)
    await _require_current_legal_acceptance(user, payload or {})
    storage_workspace = request.headers.get("x-pixelscribe-storage-workspace", "cloud") if request else "cloud"
    with bind_user_context(user["id"], user.get("billing_mode"), storage_workspace):
        yield user


@router.get("/captcha")
async def get_captcha(request: Request = None):
    await _enforce_auth_rate_limit(request, "auth-captcha")
    captcha_id, image_b64 = await create_captcha()
    return {"captchaId": captcha_id, "image": image_b64}


# ─── 查询是否需要验证码 ────────────────────────────────────────────────────────

@router.get("/login-status")
async def login_status(email: str, request: Request = None):
    """前端用来判断当前邮箱是否需要显示图形验证码"""
    await _enforce_auth_rate_limit(request, "auth-login")
    count = await _get_fail_count(email)
    return {"require_captcha": count >= _CAPTCHA_THRESHOLD, "fail_count": count}


# ─── 发送邮箱验证码（不再需要图形验证码）─────────────────────────────────────

@router.post("/send-otp")
async def send_otp(body: SendOTPRequest, request: Request = None):
    await _enforce_auth_rate_limit(request, "auth-otp")
    if body.purpose == "register":
        if await user_repo.email_exists(body.email):
            raise HTTPException(400, "该邮箱已被注册，请直接登录")
    elif body.purpose in ("login", "reset"):
        if not await user_repo.email_exists(body.email):
            raise HTTPException(404, "该邮箱尚未注册")

    try:
        code, wait = await create_otp(body.email, body.purpose)
    except Exception as exc:
        logger.warning("OTP storage unavailable for %s: %s", body.email, exc)
        raise HTTPException(503, "验证码服务暂时繁忙，请稍后重试") from exc
    if wait > 0:
        raise HTTPException(429, f"发送太频繁，请 {wait} 秒后再试")

    try:
        await send_otp_email(body.email, code, body.purpose)
    except Exception as e:
        raise HTTPException(500, f"邮件发送失败：{e}")

    return {"ok": True, "message": f"验证码已发送至 {body.email}，5 分钟内有效"}


# ─── 注册 ──────────────────────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse)
async def register(body: RegisterRequest, request: Request = None):
    await _enforce_auth_rate_limit(request, "auth-register")
    accepted_documents = _resolve_policy_acceptances(
        body.terms_accepted,
        body.privacy_accepted,
        body.legal_acceptances,
    )
    if body.password != body.confirm_password:
        raise HTTPException(400, "两次输入的密码不一致")
    if await user_repo.email_exists(body.email):
        raise HTTPException(400, "该邮箱已被注册")

    api_key = body.api_key.get_secret_value().strip() if body.api_key else ""
    if body.use_external_compute and not api_key:
        raise HTTPException(400, "请先填写 FoxAPI密钥，或使用平台积分")
    prepared_credential = None
    if api_key:
        try:
            prepared_credential = await foxapi_credentials.prepare_api_key(api_key)
        except foxapi_credentials.InvalidFoxApiKey as exc:
            raise HTTPException(400, str(exc))
        except foxapi_credentials.FoxApiUnavailable as exc:
            raise HTTPException(502, str(exc))

    if not await verify_otp(body.email, body.code, "register"):
        raise HTTPException(400, "邮箱验证码错误或已过期")

    display = body.display_name.strip() or body.email.split("@")[0]
    welcome_credits = await _get_registration_welcome_credits()
    client_ip, user_agent = _request_legal_evidence(request)
    if prepared_credential:
        try:
            async with acquire() as conn:
                async with conn.transaction():
                    user = await user_repo.create_user(
                        email=body.email,
                        password_hash=hash_password(body.password),
                        display_name=display,
                        welcome_credits=welcome_credits,
                        conn=conn,
                        legal_documents=accepted_documents,
                        legal_source="register",
                        legal_client_ip=client_ip,
                        legal_user_agent=user_agent,
                    )
                    await foxapi_credentials.store_prepared_credential(
                        conn,
                        user["id"],
                        prepared_credential,
                        activate=body.use_external_compute,
                    )
        except foxapi_credentials.FoxApiCredentialConflict as exc:
            raise HTTPException(409, str(exc))
        user = await user_repo.get_by_id(user["id"])
    else:
        user = await user_repo.create_user(
            email=body.email,
            password_hash=hash_password(body.password),
            display_name=display,
            welcome_credits=welcome_credits,
            legal_documents=accepted_documents,
            legal_source="register",
            legal_client_ip=client_ip,
            legal_user_agent=user_agent,
        )
    return await _token_response(
        user,
        legal_accepted=documents_cover_current_required(accepted_documents),
    )


# ─── 密码登录 ──────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login_password(body: LoginPasswordRequest, request: Request = None):
    accepted_documents = _resolve_policy_acceptances(
        body.terms_accepted,
        body.privacy_accepted,
        body.legal_acceptances,
    )
    await _enforce_auth_rate_limit(request, "auth-login")
    fail_count = await _get_fail_count(body.email)

    # 失败次数达到阈值时必须验证图形验证码
    if fail_count >= _CAPTCHA_THRESHOLD:
        if not body.captcha_id or not body.captcha_text:
            raise HTTPException(400, "请完成图形验证码验证")
        if not await verify_captcha(body.captcha_id, body.captcha_text):
            raise HTTPException(400, "图形验证码错误或已过期，请刷新后重试")

    user = await user_repo.get_by_email(body.email)
    if not user or not verify_password(body.password, user["password_hash"]):
        await _incr_fail(body.email)
        new_count = fail_count + 1
        # 告知前端是否需要展示验证码
        detail = "邮箱或密码错误"
        raise HTTPException(401, detail={"message": detail, "require_captcha": new_count >= _CAPTCHA_THRESHOLD})

    if user["status"] == "banned":
        raise HTTPException(403, "账号已被封禁，请联系管理员")
    if user["status"] == "pending":
        raise HTTPException(403, "账号待审核，请等待管理员审核")

    await _clear_fail(body.email)
    await user_repo.update_last_active(user["id"])
    client_ip, user_agent = _request_legal_evidence(request)
    legal_accepted = documents_cover_current_required(accepted_documents)
    try:
        await legal_repo.record_acceptances(
            user["id"],
            accepted_documents,
            source="login-password",
            client_ip=client_ip,
            user_agent=user_agent,
        )
    except Exception:
        logger.critical(
            "Legal acceptance audit failed after validated password authentication user=%s",
            user["id"],
            exc_info=True,
        )
    return await _token_response(user, legal_accepted=legal_accepted)


# ─── 验证码登录 ────────────────────────────────────────────────────────────────

@router.post("/login-otp", response_model=TokenResponse)
async def login_otp(body: LoginOTPRequest, request: Request = None):
    accepted_documents = _resolve_policy_acceptances(
        body.terms_accepted,
        body.privacy_accepted,
        body.legal_acceptances,
    )
    await _enforce_auth_rate_limit(request, "auth-login")
    user = await user_repo.get_by_email(body.email)
    if not user:
        raise HTTPException(404, "该邮箱尚未注册")
    if user["status"] == "banned":
        raise HTTPException(403, "账号已被封禁，请联系管理员")
    if not await check_otp(body.email, body.code, "login"):
        raise HTTPException(400, "邮箱验证码错误或已过期")

    client_ip, user_agent = _request_legal_evidence(request)
    legal_accepted = documents_cover_current_required(accepted_documents)
    try:
        await legal_repo.record_acceptances(
            user["id"],
            accepted_documents,
            source="login-otp",
            client_ip=client_ip,
            user_agent=user_agent,
        )
    except Exception:
        logger.critical(
            "Legal acceptance audit failed after validated OTP authentication user=%s",
            user["id"],
            exc_info=True,
        )
    if not await consume_otp(body.email, body.code, "login"):
        raise HTTPException(409, "邮箱验证码已被使用，请重新获取")
    await _clear_fail(body.email)
    try:
        await user_repo.update_last_active(user["id"])
    except Exception:
        logger.exception("Last-active update failed after OTP authentication user=%s", user["id"])
    return await _token_response(user, legal_accepted=legal_accepted)


# ─── 重置密码 ──────────────────────────────────────────────────────────────────

@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, request: Request = None):
    await _enforce_auth_rate_limit(request, "auth-otp")
    if body.new_password != body.confirm_password:
        raise HTTPException(400, "两次输入的密码不一致")
    if not await user_repo.email_exists(body.email):
        raise HTTPException(404, "该邮箱尚未注册")
    if not await verify_otp(body.email, body.code, "reset"):
        raise HTTPException(400, "邮箱验证码错误或已过期")

    await user_repo.update_password(body.email, hash_password(body.new_password))
    return {"ok": True, "message": "密码已重置，请用新密码登录"}


# ─── 刷新 token ────────────────────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(401, "refresh token 无效或已过期")
    user = await user_repo.get_by_id(payload["sub"])
    if not user:
        raise HTTPException(401, "用户不存在")
    if user["status"] == "banned":
        raise HTTPException(403, "账号已被封禁，请联系管理员")
    await _require_current_legal_acceptance(user, payload)
    return await _token_response(user, legal_accepted=True)


# ─── 当前用户信息 ──────────────────────────────────────────────────────────────

@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    grok_enabled = await is_grok_enabled()
    user = await suspend_grok_billing_if_disabled(user) or user
    public_user = _public_user_payload(user, grok_enabled=grok_enabled)
    billing_mode = public_user["billingMode"]
    external_billing = billing_mode in {FOXAPI_BILLING_MODE, GROK_BILLING_MODE}
    balance = 0.0 if external_billing else await credit_repo.get_balance(user["id"])
    # 从 tasks 表实时统计调用次数，与 admin stats 同步
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                (SELECT COUNT(*) FROM tasks WHERE user_id = $1::uuid) AS task_cnt,
                (
                    SELECT COUNT(*)
                    FROM credit_transactions
                    WHERE user_id = $1::uuid AND type = 'consume'
                ) AS consume_cnt
            """,
            user["id"],
        )
        task_count = max(int(row["task_cnt"] or 0), int(row["consume_cnt"] or 0)) if row else 0
        # 读取 FoxAPI 弹窗开关（表/字段不存在时静默返回默认值）
        try:
            row2 = await conn.fetchrow(
                "SELECT value FROM system_settings WHERE key = 'foxapi_promo_enabled'"
            )
        except Exception:
            row2 = None
    foxapi_promo_enabled = False if external_billing else parse_bool_setting(row2["value"] if row2 else None, default=False)
    fingerprint = str(user.get("key_fingerprint") or "")
    return {
        "id":          user["id"],
        "email":       user["email"],
        "displayName": user.get("display_name"),
        "role":        user["role"],
        "totalTasks":  task_count,
        "credits":     balance,
        "petId":       user.get("pet_id"),
        "petCustomName": user.get("pet_custom_name") or "",
        "authProvider": user.get("auth_provider") or "password",
        "billingMode": billing_mode,
        "hasApiKey": bool(fingerprint),
        "apiKeyFingerprint": fingerprint[-12:] if fingerprint else "",
        "apiKeyStatus": user.get("api_key_status"),
        "foxapiModelCount": int(user.get("foxapi_model_count") or 0),
        "foxapiLastVerifiedAt": str(user.get("last_verified_at") or "") or None,
        "foxapiLastUsedAt": str(user.get("last_used_at") or "") or None,
        "foxapiPromoEnabled": foxapi_promo_enabled,
        "hasGrokApiKey": bool(user.get("grok_key_fingerprint")) if grok_enabled else False,
        "grokApiKeyFingerprint": str(user.get("grok_key_fingerprint") or "")[-12:] if grok_enabled else "",
        "grokApiKeyStatus": user.get("grok_api_key_status") if grok_enabled else None,
        "grokModelCount": int(user.get("grok_model_count") or 0) if grok_enabled else 0,
        "grokLastVerifiedAt": str(user.get("grok_last_verified_at") or "") or None if grok_enabled else None,
        "grokLastUsedAt": str(user.get("grok_last_used_at") or "") or None if grok_enabled else None,
        "grokEnabled": grok_enabled,
    }


async def _compute_source_response(user_id: str) -> dict:
    grok_enabled = await is_grok_enabled()
    refreshed_user = await user_repo.get_by_id(user_id)
    if not refreshed_user:
        raise HTTPException(404, "用户不存在")
    refreshed_user = await suspend_grok_billing_if_disabled(refreshed_user) or refreshed_user
    payload = {
        "ok": True,
        "computeSource": foxapi_credentials.compute_source_from_user(refreshed_user),
        "user": _public_user_payload(refreshed_user, grok_enabled=grok_enabled),
        "grokEnabled": grok_enabled,
    }
    if grok_enabled:
        payload["grokComputeSource"] = grok_credentials.compute_source_from_user(refreshed_user)
    return payload


@router.get("/compute-source")
async def get_compute_source(user: dict = Depends(get_current_user)):
    return await _compute_source_response(user["id"])


@router.put("/pet-preference")
async def update_pet_preference(
    body: PetPreferenceRequest,
    user: dict = Depends(get_current_user),
):
    pet_id, pet_custom_name = _sanitize_pet_preference(body)
    updated = await user_repo.update_pet_preference(user["id"], pet_id, pet_custom_name)
    if not updated:
        raise HTTPException(404, "用户不存在")
    return {"ok": True, "user": _public_user_payload(updated, grok_enabled=await is_grok_enabled())}


@router.put("/compute-source/api-key")
async def connect_compute_api_key(
    body: ConnectApiKeyRequest,
    user: dict = Depends(get_current_user),
):
    try:
        await foxapi_credentials.connect_api_key(
            user["id"],
            body.api_key.get_secret_value(),
            activate=body.activate,
        )
    except foxapi_credentials.InvalidFoxApiKey as exc:
        raise HTTPException(400, str(exc))
    except foxapi_credentials.FoxApiCredentialConflict as exc:
        raise HTTPException(409, str(exc))
    except foxapi_credentials.FoxApiUnavailable as exc:
        raise HTTPException(502, str(exc))
    return await _compute_source_response(user["id"])


@router.post("/compute-source/api-key/refresh")
async def refresh_compute_api_key_catalog(user: dict = Depends(get_current_user)):
    """Re-fetch the connected FoxAPI model catalog without re-entering the key."""
    try:
        await foxapi_credentials.refresh_api_key_catalog(user["id"])
    except foxapi_credentials.InvalidFoxApiKey as exc:
        raise HTTPException(400, str(exc))
    except foxapi_credentials.FoxApiCredentialConflict as exc:
        raise HTTPException(409, str(exc))
    except foxapi_credentials.FoxApiUnavailable as exc:
        raise HTTPException(502, str(exc))
    return await _compute_source_response(user["id"])


@router.put("/compute-source/grok-api-key")
async def connect_grok_api_key(
    body: ConnectApiKeyRequest,
    user: dict = Depends(get_current_user),
):
    if not await is_grok_enabled():
        raise HTTPException(503, GROK_DISABLED_MESSAGE)
    try:
        await grok_credentials.connect_api_key(
            user["id"],
            body.api_key.get_secret_value(),
            activate=body.activate,
        )
    except grok_credentials.InvalidGrokApiKey as exc:
        raise HTTPException(400, str(exc))
    except grok_credentials.GrokCredentialConflict as exc:
        raise HTTPException(409, str(exc))
    except grok_credentials.GrokApiUnavailable as exc:
        raise HTTPException(502, str(exc))
    return await _compute_source_response(user["id"])


@router.patch("/compute-source")
async def update_compute_source(
    body: ComputeSourceRequest,
    user: dict = Depends(get_current_user),
):
    try:
        if body.mode == GROK_BILLING_MODE:
            if not await is_grok_enabled():
                raise HTTPException(503, GROK_DISABLED_MESSAGE)
            await grok_credentials.set_billing_mode(user["id"], body.mode)
        else:
            await foxapi_credentials.set_billing_mode(user["id"], body.mode)
    except (foxapi_credentials.InvalidFoxApiKey, grok_credentials.InvalidGrokApiKey) as exc:
        raise HTTPException(409, str(exc))
    return await _compute_source_response(user["id"])


@router.delete("/compute-source/api-key")
async def disconnect_compute_api_key(user: dict = Depends(get_current_user)):
    await foxapi_credentials.disconnect_api_key(user["id"])
    return await _compute_source_response(user["id"])


@router.delete("/compute-source/grok-api-key")
async def disconnect_grok_api_key(user: dict = Depends(get_current_user)):
    await grok_credentials.disconnect_api_key(user["id"])
    return await _compute_source_response(user["id"])


# ─── 修改昵称 ──────────────────────────────────────────────────────────────────

class UpdateProfileRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=50)

@router.patch("/update-profile")
async def update_profile(body: UpdateProfileRequest, user: dict = Depends(get_current_user)):
    async with acquire() as conn:
        await conn.execute(
            "UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2::uuid",
            body.display_name.strip(), user["id"],
        )
    return {"ok": True, "display_name": body.display_name.strip()}


# ─── 修改密码 ──────────────────────────────────────────────────────────────────

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)
    confirm_password: str

@router.post("/change-password")
async def change_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if body.new_password != body.confirm_password:
        raise HTTPException(400, "两次密码不一致")

    # 重新查询带 password_hash 的完整用户
    full_user = await user_repo.get_by_email(user["email"])
    if not full_user or not verify_password(body.current_password, full_user["password_hash"]):
        raise HTTPException(400, "当前密码错误")

    await user_repo.update_password(user["email"], hash_password(body.new_password))
    return {"ok": True}
