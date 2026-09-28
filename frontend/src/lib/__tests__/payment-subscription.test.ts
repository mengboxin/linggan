import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
}))

vi.mock('../auth', () => ({
  auth: {
    fetchWithAuth: mocks.fetchWithAuth,
  },
}))

import {
  createSubscriptionPayment,
  fetchMembershipStatus,
  fetchPackages,
} from '../payment'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('subscription payment API', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset()
  })

  it('normalizes subscription plans from the packages response', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(jsonResponse({
      packages: [],
      subscription_plans: [{
        id: 'monthly',
        name: '月享会员',
        billing_period: 'month',
        duration_days: 30,
        price_yuan: 29,
        included_credits: 300,
        badge: '热门',
        benefits: ['每月 300 积分'],
        sort_order: 2,
      }],
      channels: [],
      payment_enabled: true,
      settings: {},
    }))

    const result = await fetchPackages()

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/api/payment/packages')
    expect(result.subscription_plans).toEqual([
      expect.objectContaining({ id: 'monthly', price_yuan: 29 }),
    ])
  })

  it('loads membership status from the dedicated endpoint', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(jsonResponse({
      active: true,
      plan_id: 'pro',
      plan_name: 'Pro 会员',
      badge: 'PRO',
      starts_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-01T00:00:00Z',
      days_remaining: 22,
    }))

    const status = await fetchMembershipStatus()

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/api/payment/subscription/status')
    expect(status).toEqual(expect.objectContaining({ active: true, plan_id: 'pro' }))
  })

  it('creates a subscription order with the selected plan', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(jsonResponse({
      order_no: 'sub-order-1',
      pay_url: 'https://pay.example/sub-order-1',
      amount_yuan: 29,
      credits: 0,
      bonus_credits: 0,
      product_kind: 'subscription',
      product_name: '月享会员',
    }))

    const legalAcceptance = {
      documentType: 'payment' as const,
      version: '2026.08.13',
      contentHash: 'a'.repeat(64),
    }
    const order = await createSubscriptionPayment('monthly', legalAcceptance)

    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/api/payment/subscription/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'monthly', legal_acceptance: legalAcceptance }),
    })
    expect(order.product_kind).toBe('subscription')
  })

  it('renders a structured payment conflict as readable text', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(jsonResponse({
      detail: {
        code: 'PENDING_SUBSCRIPTION_ORDER',
        message: '当前已有待支付会员订单，请先继续支付或取消订单后再创建',
      },
    }, 409))

    await expect(createSubscriptionPayment('monthly', {
      documentType: 'payment',
      version: '2026.08.13',
      contentHash: 'a'.repeat(64),
    })).rejects.toThrow('当前已有待支付会员订单')
  })
})
