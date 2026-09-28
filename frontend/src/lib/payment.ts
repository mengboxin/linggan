/**
 * Payment-related API helpers.
 */
import { auth } from './auth'
import type { LegalAcceptanceClaim } from './legal'

export interface RechargePackage {
  id: string
  amount_yuan: number
  base_credits: number
  bonus_credits: number
  discount_label: string | null
  sort_order: number
  enabled?: boolean
}

export interface SubscriptionPlan {
  id: string
  name: string
  billing_period: string
  duration_days: number
  price_yuan: number
  included_credits: number
  badge: string | null
  benefits: string[]
  sort_order: number
  original_price_yuan?: number | null
  discount_label?: string | null
  enabled?: boolean
}

export interface MembershipStatus {
  active: boolean
  benefits_active?: boolean
  billing_mode?: string
  plan_id: string | null
  plan_name: string | null
  badge: string | null
  starts_at: string | null
  expires_at: string | null
  days_remaining: number
  status?: string
  quota_total?: number
  quota_remaining?: number
  wallet?: MembershipWalletSnapshot
}

export type FundingSource = 'metered' | 'subscription'

export interface MembershipCard {
  id: string
  plan_id: string
  plan_name: string
  badge_label: string
  status: 'active' | 'queued' | 'exhausted' | 'expired' | 'revoked'
  quota_total: number
  quota_remaining: number
  starts_at: string | null
  activated_at: string | null
  expires_at: string | null
  exhausted_at: string | null
  created_at: string
  queue_position: number | null
}

export interface MembershipWalletSnapshot {
  billing_mode: string
  funding_source: FundingSource | null
  selected_subscription_id: string | null
  spendable_balance: number
  metered_balance: number
  cards: MembershipCard[]
}

export interface PaymentSettings {
  credits_ratio: number
  min_amount_yuan: number
  max_amount_yuan: number
  order_timeout_minutes: number
  max_pending_orders: number
  daily_amount_limit_yuan: number
  cancel_cooldown_seconds: number
  cancel_window_minutes: number
  max_cancellations_per_window: number
}

export interface PaymentChannelStatus {
  code: 'zpay'
  label: string
  enabled: boolean
  configured: boolean
  available: boolean
}

export interface PaymentOrder {
  id: string
  order_no: string
  amount_yuan: number
  credits: number
  bonus_credits: number
  pay_channel: string
  status: string
  paid_at: string | null
  expires_at?: string | null
  cancelled_at?: string | null
  completed_at?: string | null
  created_at: string
  product_kind?: string | null
  product_name?: string | null
  product_id?: string | null
}

export interface PaymentStatus {
  order_no: string
  status: string
  amount_yuan: number
  credits: number
  bonus_credits: number
  paid_at: string | null
  expires_at?: string | null
  completed_at?: string | null
  product_kind?: string | null
  product_name?: string | null
  product_id?: string | null
}

export interface CreatePaymentResult {
  order_no: string
  pay_url: string
  gateway_url?: string
  pay_method?: 'GET' | 'POST'
  pay_params?: Record<string, string | number>
  amount_yuan: number
  credits: number
  bonus_credits: number
  status?: string
  expires_at?: string | null
  product_kind?: string | null
  product_name?: string | null
  product_id?: string | null
}

export interface PaymentPackagesResponse {
  packages: RechargePackage[]
  subscription_plans: SubscriptionPlan[]
  channels: Record<string, PaymentChannelStatus>
  payment_enabled: boolean
  settings: PaymentSettings
}

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  credits_ratio: 10,
  min_amount_yuan: 1,
  max_amount_yuan: 200,
  order_timeout_minutes: 20,
  max_pending_orders: 2,
  daily_amount_limit_yuan: 1000,
  cancel_cooldown_seconds: 30,
  cancel_window_minutes: 60,
  max_cancellations_per_window: 6,
}

type ApiErrorPayload = Record<string, unknown>

function asErrorPayload(value: unknown): ApiErrorPayload | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ApiErrorPayload
    : null
}

function readableErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const payload = asErrorPayload(value)
  if (!payload) return fallback

  for (const candidate of [payload.message, payload.detail, payload.error]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }

  const detail = asErrorPayload(payload.detail)
  if (detail) {
    for (const candidate of [detail.message, detail.error]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  return fallback
}

function paymentErrorCode(value: unknown): string | undefined {
  const payload = asErrorPayload(value)
  if (!payload) return undefined
  if (typeof payload.code === 'string' && payload.code) return payload.code
  const detail = asErrorPayload(payload.detail)
  return typeof detail?.code === 'string' && detail.code ? detail.code : undefined
}

export class PaymentRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(response: Response, payload: unknown, fallback: string) {
    super(readableErrorMessage(payload, fallback))
    this.name = 'PaymentRequestError'
    this.status = response.status
    this.code = paymentErrorCode(payload)
  }
}

async function paymentRequestError(response: Response, fallback: string): Promise<PaymentRequestError> {
  const payload = await response.json().catch(() => null)
  return new PaymentRequestError(response, payload, fallback)
}

export async function fetchPackages(): Promise<PaymentPackagesResponse> {
  const res = await auth.fetchWithAuth('/api/payment/packages')
  if (!res.ok) throw new Error('Failed to load recharge packages')
  const data = await res.json()
  const rawChannels = data?.channels
  const channels = Array.isArray(rawChannels)
    ? rawChannels.reduce((acc: Record<string, PaymentChannelStatus>, item: any) => {
        const code = String(item?.code || '')
        if (code) acc[code] = item
        return acc
      }, {})
    : (rawChannels && typeof rawChannels === 'object' ? rawChannels : {})
  return {
    packages: Array.isArray(data?.packages) ? data.packages : [],
    subscription_plans: Array.isArray(data?.subscription_plans) ? data.subscription_plans : [],
    channels,
    payment_enabled: !!data.payment_enabled,
    settings: { ...DEFAULT_PAYMENT_SETTINGS, ...(data.settings || {}) },
  }
}

export async function fetchMembershipStatus(): Promise<MembershipStatus> {
  const res = await auth.fetchWithAuth('/api/payment/subscription/status')
  if (!res.ok) throw new Error('Failed to load membership status')
  const data = await res.json()
  return (data?.membership || data) as MembershipStatus
}

export async function fetchMembershipWallet(): Promise<MembershipWalletSnapshot> {
  const res = await auth.fetchWithAuth('/api/credits/wallet')
  if (!res.ok) throw new Error('Failed to load billing wallets')
  return res.json()
}

export async function setMembershipFundingSource(
  fundingSource: FundingSource,
  subscriptionId: string | null = null,
): Promise<MembershipWalletSnapshot> {
  const res = await auth.fetchWithAuth('/api/credits/wallet/preference', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      funding_source: fundingSource,
      subscription_id: fundingSource === 'subscription' ? subscriptionId : null,
    }),
  })
  if (!res.ok) {
    throw await paymentRequestError(res, 'Failed to switch billing wallet')
  }
  return res.json()
}

export async function createSubscriptionPayment(
  planId: string,
  legalAcceptance: LegalAcceptanceClaim,
): Promise<CreatePaymentResult> {
  const res = await auth.fetchWithAuth('/api/payment/subscription/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, legal_acceptance: legalAcceptance }),
  })
  if (!res.ok) {
    throw await paymentRequestError(res, 'Failed to create subscription order')
  }
  return res.json()
}

export async function createPayment(
  amountYuan: number,
  legalAcceptance: LegalAcceptanceClaim,
  payChannel: 'zpay' = 'zpay'
): Promise<CreatePaymentResult> {
  const res = await auth.fetchWithAuth('/api/payment/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_yuan: amountYuan,
      pay_channel: payChannel,
      legal_acceptance: legalAcceptance,
    }),
  })
  if (!res.ok) {
    throw await paymentRequestError(res, 'Failed to create payment order')
  }
  return res.json()
}

export async function resumePayment(orderNo: string): Promise<CreatePaymentResult> {
  const res = await auth.fetchWithAuth(`/api/payment/pay-url/${orderNo}`)
  if (!res.ok) {
    throw await paymentRequestError(res, 'Failed to resume payment order')
  }
  return res.json()
}

export function openPaymentWindow(payment: CreatePaymentResult, features = 'width=600,height=720') {
  if (payment.pay_method === 'POST' && payment.gateway_url && payment.pay_params) {
    const target = `zpay_${payment.order_no}`
    window.open('', target, features)
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = payment.gateway_url
    form.target = target
    form.style.display = 'none'
    Object.entries(payment.pay_params).forEach(([key, value]) => {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = key
      input.value = String(value)
      form.appendChild(input)
    })
    document.body.appendChild(form)
    form.submit()
    document.body.removeChild(form)
    return
  }
  if (payment.pay_url) {
    window.open(payment.pay_url, '_blank', features)
  }
}

export async function queryPaymentStatus(orderNo: string): Promise<PaymentStatus> {
  const res = await auth.fetchWithAuth(`/api/payment/status/${orderNo}`)
  if (!res.ok) throw new Error('Failed to query payment status')
  return res.json()
}

export async function cancelPayment(orderNo: string): Promise<{ ok: boolean; order_no: string; status: string }> {
  const res = await auth.fetchWithAuth(`/api/payment/cancel/${orderNo}`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw await paymentRequestError(res, 'Failed to cancel payment order')
  }
  return res.json()
}

export async function fetchPaymentOrders(
  limit = 20,
  offset = 0
): Promise<{ orders: PaymentOrder[] }> {
  const res = await auth.fetchWithAuth(
    `/api/payment/orders?limit=${limit}&offset=${offset}`
  )
  if (!res.ok) throw new Error('Failed to load payment orders')
  return res.json()
}
