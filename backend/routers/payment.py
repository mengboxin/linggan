"""
支付路由 — Z-Pay 单通道
- GET  /api/payment/packages        获取充值套餐
- POST /api/payment/create          创建支付订单
- POST /api/payment/notify/{channel} 支付回调通知
- GET  /api/payment/return/{channel} 支付同步跳转
- GET  /api/payment/status/{order_no} 查询订单状态
- GET  /api/payment/orders          用户订单历史
"""
import hashlib
import hmac
import json
import logging
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

import repositories.payment_repo as payment_repo
from routers.auth import get_current_user
from routers.legal import LegalAcceptanceClaim, _client_evidence, resolve_acceptance_claims
from services import foxapi_credentials

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payment", tags=["支付"])
ZPAY_CHANNEL = "zpay"
ZPAY_DEFAULT_API_URL = "https://zpayz.cn"
ZPAY_DEFAULT_PAY_TYPE = "alipay"


# ─── Z-Pay 协议工具 ────────────────────────────────────────────────────────────

def _zpay_sign(params: dict, key: str) -> str:
    """
    Z-Pay MD5 签名：参数名 ASCII 升序，sign/sign_type/空值不参与签名。
    参数值不做 URL 编码，拼接后追加商户密钥再 MD5，小写。
    """
    filtered = {
        k: str(v)
        for k, v in params.items()
        if v is not None and str(v) != "" and k not in ("sign", "sign_type")
    }
    sign_str = "&".join(f"{k}={filtered[k]}" for k in sorted(filtered.keys()))
    sign_str += key
    return hashlib.md5(sign_str.encode("utf-8")).hexdigest()


def _zpay_verify(params: dict, key: str) -> bool:
    """验证 Z-Pay 回调签名"""
    sign = params.get("sign", "")
    if not sign:
        return False
    return hmac.compare_digest(str(sign), _zpay_sign(params, key))


def _zpay_config_value(channel: dict, key: str, default: str = "") -> str:
    config = channel.get("config_json") or {}
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except Exception:
            config = {}
    value = config.get(key) if isinstance(config, dict) else None
    return str(value or default).strip()


# ─── 请求/响应模型 ─────────────────────────────────────────────────────────────

class CreatePaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_yuan: Decimal = Field(ge=Decimal("1"), le=Decimal("999999"), description="充值金额（元）")
    pay_channel: str = Field(default=ZPAY_CHANNEL, pattern="^zpay$", description="支付渠道")
    legal_acceptance: LegalAcceptanceClaim | None = None


class CreateSubscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_id: str = Field(min_length=2, max_length=64, pattern=r"^[a-z][a-z0-9_]+$")
    legal_acceptance: LegalAcceptanceClaim | None = None


class PaymentStatusResponse(BaseModel):
    order_no: str
    status: str
    amount_yuan: float
    credits: int
    bonus_credits: int
    product_kind: str = "credits"
    product_id: Optional[str] = None
    product_name: str = ""
    paid_at: Optional[str] = None
    expires_at: Optional[str] = None
    completed_at: Optional[str] = None


class CancelPaymentResponse(BaseModel):
    ok: bool
    order_no: str
    status: str


def _success_resp(
    order: dict,
    pay_url: str,
    credits: int,
    bonus_credits: int,
    gateway_url: str = "",
    pay_params: Optional[dict] = None,
) -> dict:
    return {
        "order_no": order["order_no"],
        "pay_url": pay_url,
        "gateway_url": gateway_url,
        "pay_method": "POST" if gateway_url and pay_params else "GET",
        "pay_params": pay_params or {},
        "amount_yuan": float(order["amount_yuan"]),
        "credits": credits,
        "bonus_credits": bonus_credits,
        "product_kind": order.get("product_kind") or "credits",
        "product_id": order.get("product_id"),
        "product_name": order.get("product_name") or "",
        "status": order.get("status", "pending"),
        "expires_at": str(order.get("expires_at")) if order.get("expires_at") else None,
    }


def _money(value: object) -> Decimal:
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_DOWN)
    except (InvalidOperation, ValueError):
        raise HTTPException(400, "金额格式错误")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


def _zpay_runtime_config(channel: Optional[dict]) -> dict:
    if not channel or not channel.get("enabled"):
        raise HTTPException(400, "Z-Pay 支付渠道未启用")

    api_url = (channel.get("api_url") or ZPAY_DEFAULT_API_URL).rstrip("/")
    merchant_id = channel.get("merchant_id") or ""
    merchant_key = channel.get("merchant_key") or ""
    notify_url = channel.get("notify_url") or ""
    return_url = channel.get("return_url") or ""
    zpay_type = _zpay_config_value(channel, "type", ZPAY_DEFAULT_PAY_TYPE)
    zpay_cid = _zpay_config_value(channel, "cid")

    if not api_url or not merchant_id or not merchant_key:
        raise HTTPException(400, "Z-Pay 配置不完整，请在管理后台填写商户ID和密钥")
    if zpay_type not in ("alipay", "wxpay"):
        raise HTTPException(400, "Z-Pay 支付方式配置错误，仅支持 alipay 或 wxpay")
    if not notify_url or not return_url:
        raise HTTPException(400, "Z-Pay 回调地址未配置，请在管理后台设置 notify_url 和 return_url")

    return {
        "api_url": api_url,
        "merchant_id": merchant_id,
        "merchant_key": merchant_key,
        "notify_url": notify_url,
        "return_url": return_url,
        "zpay_type": zpay_type,
        "zpay_cid": zpay_cid,
    }


async def _build_zpay_payment_payload(order: dict, user_id: str) -> dict:
    """为一个已有订单生成 Z-Pay 跳转参数，不创建新订单。"""
    channel = await payment_repo.get_channel(ZPAY_CHANNEL)
    config = _zpay_runtime_config(channel)

    amount = _money(order["amount_yuan"])
    total_credits = int(order["credits"]) + int(order["bonus_credits"])
    product_kind = str(order.get("product_kind") or "credits")
    product_name = str(order.get("product_name") or "").strip()
    gateway_product_name = (
        f"灵感 {product_name}"
        if product_kind == "subscription" and product_name
        else f"灵感按量积分 {total_credits}"
    )
    zpay_params = {
        "pid": config["merchant_id"],
        "type": config["zpay_type"],
        "out_trade_no": order["order_no"],
        "notify_url": config["notify_url"],
        "return_url": config["return_url"],
        "name": gateway_product_name,
        "money": f"{amount:.2f}",
        "param": json.dumps({
            "user_id": user_id,
            "order_no": order["order_no"],
            "product_kind": product_kind,
        }, ensure_ascii=False),
    }
    if config["zpay_cid"]:
        zpay_params["cid"] = config["zpay_cid"]
    zpay_params["sign"] = _zpay_sign(zpay_params, config["merchant_key"])
    zpay_params["sign_type"] = "MD5"

    gateway_url = f"{config['api_url']}/submit.php"
    pay_url = f"{gateway_url}?{urlencode(zpay_params)}"
    return _success_resp(
        order,
        pay_url,
        int(order["credits"]),
        int(order["bonus_credits"]),
        gateway_url,
        zpay_params,
    )


def _billing_period(duration_days: int) -> str:
    if duration_days == 7:
        return "week"
    if duration_days == 30:
        return "month"
    return f"{duration_days}_days"


def _public_subscription_plan(plan: dict) -> dict:
    duration_days = int(plan.get("duration_days") or 0)
    credits = int(plan.get("credits") or 0)
    return {
        **plan,
        "price_yuan": float(plan["price_yuan"]),
        "credits": credits,
        "included_credits": credits,
        "badge": plan.get("badge_label") or "",
        "billing_period": _billing_period(duration_days),
        "duration_days": duration_days,
    }


async def _prepare_payment_order(user: dict, amount: Decimal) -> tuple[dict, dict]:
    if user.get("billing_mode") == foxapi_credentials.BILLING_MODE:
        raise HTTPException(409, "FoxAPI密钥账号不能购买平台积分或会员")

    from core.rate_limit import rate_limit, RateLimitExceeded
    try:
        await rate_limit(user["id"], "payment_create", limit=6, window=60)
    except RateLimitExceeded as exc:
        raise HTTPException(
            429,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc

    payment_settings = await payment_repo.get_payment_settings()
    min_amount = Decimal(str(payment_settings["min_amount_yuan"]))
    max_amount = Decimal(str(payment_settings["max_amount_yuan"]))
    if amount < min_amount:
        raise HTTPException(400, f"最低购买金额为 {min_amount} 元")
    if amount > max_amount:
        raise HTTPException(400, f"最高购买金额为 {max_amount} 元")

    pending_count = await payment_repo.count_pending_orders(user["id"])
    if pending_count >= payment_settings["max_pending_orders"]:
        raise HTTPException(
            409,
            f"你已有 {pending_count} 个待支付订单，请先完成或取消后再创建",
        )

    daily_paid = await payment_repo.sum_user_paid_amount_today(user["id"])
    daily_limit = Decimal(str(payment_settings["daily_amount_limit_yuan"]))
    if daily_limit > 0 and daily_paid + amount > daily_limit:
        remaining = max(Decimal("0"), daily_limit - daily_paid)
        raise HTTPException(429, f"今日购买额度剩余 {remaining} 元")

    channel = await payment_repo.get_channel(ZPAY_CHANNEL)
    _zpay_runtime_config(channel)
    return payment_settings, channel


async def _record_payment_legal_acceptance(
    claim: LegalAcceptanceClaim | None,
    request: Request,
    user_id: str,
    *,
    source: str,
):
    if claim is None:
        raise HTTPException(
            426,
            detail={
                "code": "LEGAL_CLIENT_UPGRADE_REQUIRED",
                "message": "当前客户端无法确认最新版付费规则，请升级后再创建订单",
            },
        )
    documents = resolve_acceptance_claims([claim])
    document = documents[0]
    if document.document_type != "payment":
        raise HTTPException(400, "创建订单前必须确认当前版本的付费服务与退款规则")
    return document


# ─── 获取充值套餐 ──────────────────────────────────────────────────────────────

@router.get("/packages")
async def get_packages():
    packages = await payment_repo.get_packages()
    subscription_plans = await payment_repo.get_subscription_plans()
    channels = await payment_repo.get_channel_statuses()
    payment_settings = await payment_repo.get_payment_settings()
    return {
        "packages": packages,
        "subscription_plans": [
            _public_subscription_plan(plan) for plan in subscription_plans
        ],
        "channels": channels,
        "payment_enabled": any(channel["available"] for channel in channels.values()),
        "settings": payment_settings,
    }


# ─── 创建支付订单 ──────────────────────────────────────────────────────────────

@router.post("/create")
async def create_payment(
    body: CreatePaymentRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    amount = _money(body.amount_yuan)
    payment_settings, channel = await _prepare_payment_order(user, amount)

    # 匹配套餐
    packages = await payment_repo.get_packages()
    matched_pkg = next((p for p in packages if Decimal(str(p["amount_yuan"])) == amount), None)

    if matched_pkg:
        credits = matched_pkg["base_credits"]
        bonus_credits = matched_pkg["bonus_credits"]
    else:
        credits = int(amount * Decimal(str(payment_settings["credits_ratio"])))
        bonus_credits = 0

    notify_url = channel.get("notify_url") or ""
    return_url = channel.get("return_url") or ""
    legal_document = await _record_payment_legal_acceptance(
        body.legal_acceptance,
        request,
        user["id"],
        source="payment-order",
    )
    client_ip, user_agent = _client_evidence(request)

    # 创建订单
    order = await payment_repo.create_order(
        user_id=user["id"],
        amount_yuan=amount,
        credits=credits,
        bonus_credits=bonus_credits,
        pay_channel=ZPAY_CHANNEL,
        product_snapshot={
            "legal_document_version": legal_document.version,
            "legal_document_hash": legal_document.content_hash,
        },
        notify_url=notify_url,
        return_url=return_url,
        timeout_minutes=payment_settings["order_timeout_minutes"],
        client_ip=_client_ip(request),
        legal_document=legal_document,
        legal_source="payment-order",
        legal_client_ip=client_ip,
        legal_user_agent=user_agent,
    )
    return await _build_zpay_payment_payload(order, user["id"])


@router.get("/subscription/status")
async def get_subscription_status(user: dict = Depends(get_current_user)):
    status = await payment_repo.get_subscription_status(user["id"])
    active = bool(status.get("active"))
    platform_billing = user.get("billing_mode") != foxapi_credentials.BILLING_MODE
    return {
        **status,
        "plan_name": status.get("name"),
        "badge": status.get("badge_label") or "",
        "days_remaining": int(status.get("days_remaining") or 0),
        "billing_mode": user.get("billing_mode") or foxapi_credentials.PLATFORM_BILLING_MODE,
        "benefits_active": active and platform_billing,
    }


@router.post("/subscription/create")
async def create_subscription_payment(
    body: CreateSubscriptionRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    if user.get("billing_mode") == foxapi_credentials.BILLING_MODE:
        raise HTTPException(409, "FoxAPI密钥账号不能购买平台会员")

    pending_membership_order = await payment_repo.get_pending_subscription_order(user["id"])
    if pending_membership_order:
        raise HTTPException(
            409,
            {
                "code": "PENDING_SUBSCRIPTION_ORDER",
                "message": "当前已有待支付会员订单，请先继续支付或取消订单后再创建",
                "orderNo": pending_membership_order["order_no"],
            },
        )

    plan = await payment_repo.get_subscription_plan(body.plan_id)
    if not plan:
        raise HTTPException(404, "会员套餐不存在或已下架")

    amount = _money(plan["price_yuan"])
    payment_settings, channel = await _prepare_payment_order(user, amount)
    public_plan = _public_subscription_plan(plan)
    product_snapshot = {
        "id": str(plan["id"]),
        "name": str(plan["name"]),
        "description": str(plan.get("description") or ""),
        "badge_label": str(plan.get("badge_label") or ""),
        "badge": public_plan["badge"],
        "price_yuan": f"{amount:.2f}",
        "credits": int(plan["credits"]),
        "included_credits": int(plan["credits"]),
        "duration_days": int(plan["duration_days"]),
        "billing_period": public_plan["billing_period"],
        "benefits": list(plan.get("benefits") or []),
    }
    legal_document = await _record_payment_legal_acceptance(
        body.legal_acceptance,
        request,
        user["id"],
        source="subscription-order",
    )
    product_snapshot.update({
        "legal_document_version": legal_document.version,
        "legal_document_hash": legal_document.content_hash,
    })
    client_ip, user_agent = _client_evidence(request)
    try:
        order = await payment_repo.create_order(
            user_id=user["id"],
            amount_yuan=amount,
            credits=int(plan["credits"]),
            bonus_credits=0,
            pay_channel=ZPAY_CHANNEL,
            product_kind="subscription",
            product_id=str(plan["id"]),
            product_name=str(plan["name"]),
            product_snapshot=product_snapshot,
            notify_url=channel.get("notify_url") or "",
            return_url=channel.get("return_url") or "",
            timeout_minutes=payment_settings["order_timeout_minutes"],
            client_ip=_client_ip(request),
            legal_document=legal_document,
            legal_source="subscription-order",
            legal_client_ip=client_ip,
            legal_user_agent=user_agent,
        )
    except payment_repo.PendingSubscriptionOrderError as exc:
        raise HTTPException(
            409,
            {
                "code": "PENDING_SUBSCRIPTION_ORDER",
                "message": "当前已有待支付会员订单，请先继续支付或取消订单后再创建",
                "orderNo": str(exc),
            },
        ) from exc
    return await _build_zpay_payment_payload(order, user["id"])


@router.get("/pay-url/{order_no}")
async def get_payment_url(
    order_no: str,
    user: dict = Depends(get_current_user),
):
    """继续支付一个待支付订单。刷新页面后不需要重复创建订单。"""
    order = await payment_repo.get_order(order_no)
    if not order:
        raise HTTPException(404, "订单不存在")
    if str(order["user_id"]) != str(user["id"]) and user["role"] != "admin":
        raise HTTPException(403, "无权操作此订单")
    if order["status"] != "pending":
        raise HTTPException(409, "订单当前状态不可继续支付")

    return await _build_zpay_payment_payload(order, str(order["user_id"]))


@router.post("/cancel/{order_no}", response_model=CancelPaymentResponse)
async def cancel_payment(
    order_no: str,
    user: dict = Depends(get_current_user),
):
    order = await payment_repo.get_order(order_no)
    if not order:
        raise HTTPException(404, "订单不存在")
    if str(order["user_id"]) != str(user["id"]) and user["role"] != "admin":
        raise HTTPException(403, "无权操作此订单")
    if order["status"] == "cancelled":
        return CancelPaymentResponse(ok=True, order_no=order_no, status="cancelled")
    if order["status"] != "pending":
        raise HTTPException(409, "订单当前状态不可取消")

    payment_settings = await payment_repo.get_payment_settings()
    recent = await payment_repo.count_recent_cancellations(
        user["id"],
        payment_settings["cancel_window_minutes"],
    )
    if recent >= payment_settings["max_cancellations_per_window"]:
        raise HTTPException(429, "取消订单过于频繁，请稍后再试")

    since = await payment_repo.seconds_since_last_cancellation(user["id"])
    cooldown = payment_settings["cancel_cooldown_seconds"]
    if since is not None and since < cooldown:
        raise HTTPException(429, f"请 {cooldown - since} 秒后再取消下一个订单")

    cancelled = await payment_repo.cancel_order(user["id"], order_no)
    if not cancelled:
        raise HTTPException(409, "订单当前状态不可取消")

    return CancelPaymentResponse(ok=True, order_no=order_no, status="cancelled")


# ─── 支付回调通知（核心） ─────────────────────────────────────────────────────

@router.api_route("/notify/{channel_code}", methods=["GET", "POST"], response_class=PlainTextResponse)
async def payment_notify(channel_code: str, request: Request):
    """
    Z-Pay 异步回调。平台付款成功后会 GET/POST 到此地址。
    必须返回 "success" 字符串表示处理成功，否则平台会重复通知。
    """
    # 1. 获取回调参数（兼容 form-data / json / query）
    params = dict(request.query_params)
    try:
        body = await request.body()
        if body:
            import json
            body_data = json.loads(body)
            if isinstance(body_data, dict):
                params.update(body_data)
    except Exception:
        pass
    try:
        form = await request.form()
        if form:
            params.update({k: v for k, v in form.items()})
    except Exception:
        pass

    log_params = {k: v for k, v in params.items() if k not in ("sign",)}
    logger.info(f"[ZPAY] 收到回调 channel={channel_code} params={log_params}")

    if channel_code != ZPAY_CHANNEL:
        logger.error(f"[ZPAY] 未知渠道: {channel_code}")
        return "fail"

    # 2. 获取渠道配置
    channel = await payment_repo.get_channel(ZPAY_CHANNEL)
    if not channel:
        logger.error("[ZPAY] 渠道配置不存在")
        return "fail"

    merchant_key = channel.get("merchant_key") or ""

    # 3. 验证签名
    if not merchant_key or not _zpay_verify(params, merchant_key):
        logger.error(f"[ZPAY] 签名验证失败: order_no={params.get('out_trade_no')}")
        return "fail"

    # 4. 检查 trade_status
    trade_status = params.get("trade_status", "")
    if trade_status != "TRADE_SUCCESS":
        logger.info(f"[ZPAY] 非成功状态: {trade_status}")
        return "success"  # 返回 success 避免平台重试

    # 5. 查询订单
    order_no = params.get("out_trade_no", "")
    if not order_no:
        logger.error("[ZPAY] 回调缺少 out_trade_no")
        return "fail"

    order = await payment_repo.get_order(order_no)
    if not order:
        logger.error(f"[ZPAY] 订单不存在: {order_no}")
        return "fail"

    trade_no = params.get("trade_no", "")

    paid_amount = _money(params.get("money", 0))
    order_amount = _money(order["amount_yuan"])
    if paid_amount != order_amount:
        logger.error(f"[ZPAY] 金额不匹配: order={order_amount} paid={paid_amount}")
        return "fail"

    if channel.get("merchant_id") and str(params.get("pid", "")) != str(channel.get("merchant_id")):
        logger.error(f"[ZPAY] 商户 ID 不匹配: order_no={order_no}")
        return "fail"

    result, completed_order = await payment_repo.complete_paid_order(order_no, trade_no, params)
    if result == "duplicate":
        logger.info(f"[ZPAY] 重复回调已忽略: {order_no}")
        return "success"
    if result != "completed" or not completed_order:
        logger.error(f"[ZPAY] 订单入账失败 result={result} order_no={order_no}")
        return "fail"

    total_credits = completed_order["credits"] + completed_order["bonus_credits"]
    product_kind = completed_order.get("product_kind") or "credits"
    product_name = completed_order.get("product_name") or ""
    try:
        from core.redis import get_redis
        r = get_redis()
        await r.delete(
            f"balance:{completed_order['user_id']}",
            f"wallet:{completed_order['user_id']}",
        )
        await r.publish(
            f"user_event:{completed_order['user_id']}",
            json.dumps({
                "type": "payment_success",
                "order_no": order_no,
                "credits": total_credits,
                "amount_yuan": float(completed_order["amount_yuan"]),
                "product_kind": product_kind,
                "product_id": completed_order.get("product_id"),
                "product_name": product_name,
                "subscription": completed_order.get("subscription"),
            }),
        )
    except Exception:
        pass
    logger.info(
        "[ZPAY] 支付完成: user=%s product=%s credits=%s",
        completed_order["user_id"],
        product_kind,
        total_credits,
    )

    return "success"


# ─── 支付同步跳转 ──────────────────────────────────────────────────────────────

@router.get("/return/{channel_code}")
async def payment_return(channel_code: str, request: Request):
    """支付完成后平台跳转到此地址，通知前端轮询结果"""
    params = dict(request.query_params)
    order_no = params.get("out_trade_no", "")

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>支付结果</title>
<style>body{{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;background:#f8f9fa}}
.box{{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)}}
.spinner{{width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#f59e0b;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}</style></head>
<body><div class="box">
<div class="spinner"></div>
<h2 style="margin:0 0 8px;font-size:18px">支付处理中</h2>
<p style="color:#666;margin:0 0 16px;font-size:14px">订单号: {order_no}</p>
<p style="color:#999;margin:0;font-size:13px">此窗口将自动关闭，请回到充值页面查看结果</p>
</div>
<script>
if(window.opener)window.opener.postMessage({{type:'payment_complete',order_no:'{order_no}'}},'*');
setTimeout(()=>window.close(),3000);
</script></body></html>"""
    return HTMLResponse(content=html)


# ─── 查询订单状态 ──────────────────────────────────────────────────────────────

@router.get("/status/{order_no}", response_model=PaymentStatusResponse)
async def get_payment_status(
    order_no: str,
    user: dict = Depends(get_current_user),
):
    order = await payment_repo.get_order(order_no)
    if not order:
        raise HTTPException(404, "订单不存在")
    if str(order["user_id"]) != str(user["id"]) and user["role"] != "admin":
        raise HTTPException(403, "无权查看此订单")

    return PaymentStatusResponse(
        order_no=order["order_no"],
        status=order["status"],
        amount_yuan=float(order["amount_yuan"]),
        credits=order["credits"],
        bonus_credits=order["bonus_credits"],
        product_kind=order.get("product_kind") or "credits",
        product_id=order.get("product_id"),
        product_name=order.get("product_name") or "",
        paid_at=str(order.get("paid_at")) if order.get("paid_at") else None,
        expires_at=str(order.get("expires_at")) if order.get("expires_at") else None,
        completed_at=str(order.get("completed_at")) if order.get("completed_at") else None,
    )


# ─── 用户订单历史 ──────────────────────────────────────────────────────────────

@router.get("/orders")
async def get_orders(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    orders = await payment_repo.get_user_orders(user["id"], limit=limit, offset=offset)
    return {"orders": orders}
