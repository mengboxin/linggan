import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancelPayment: vi.fn(),
  createSubscriptionPayment: vi.fn(),
  fetchMembershipStatus: vi.fn(),
  fetchPackages: vi.fn(),
  openPaymentWindow: vi.fn(),
  queryPaymentStatus: vi.fn(),
  resumePayment: vi.fn(),
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))

vi.mock('../../../lib/payment', () => ({
  cancelPayment: mocks.cancelPayment,
  createSubscriptionPayment: mocks.createSubscriptionPayment,
  fetchMembershipStatus: mocks.fetchMembershipStatus,
  fetchPackages: mocks.fetchPackages,
  openPaymentWindow: mocks.openPaymentWindow,
  queryPaymentStatus: mocks.queryPaymentStatus,
  resumePayment: mocks.resumePayment,
}))

vi.mock('../../../lib/legal', () => ({
  fetchLegalDocument: vi.fn().mockResolvedValue({
    documentType: 'payment', version: '2026.08.13', title: '付费规则', summary: '',
    contentHash: 'c'.repeat(64), publishedOn: '2026-08-13', effectiveOn: '2026-08-13',
    requiresReacceptance: true, requiredAtLogin: false, contentMarkdown: '# 付费规则',
  }),
  legalAcceptanceClaim: (document: { documentType: string; version: string; contentHash: string }) => ({
    documentType: document.documentType,
    version: document.version,
    contentHash: document.contentHash,
  }),
}))

import { SubscriptionMembershipPanel } from '../SubscriptionMembershipPanel'

const plans = [
  {
    id: 'weekly',
    name: '周享会员',
    billing_period: 'week',
    duration_days: 7,
    price_yuan: 9.9,
    included_credits: 80,
    badge: '轻量',
    benefits: ['80 积分', '标准模型'],
    sort_order: 1,
  },
  {
    id: 'monthly',
    name: '月享会员',
    billing_period: 'month',
    duration_days: 30,
    price_yuan: 29,
    original_price_yuan: 39,
    discount_label: '省 10 元',
    included_credits: 300,
    badge: '热门',
    benefits: ['300 积分', '高级模型'],
    sort_order: 2,
  },
  {
    id: 'pro',
    name: 'Pro 创作',
    billing_period: 'month',
    duration_days: 30,
    price_yuan: 69,
    included_credits: 900,
    badge: 'PRO',
    benefits: ['900 积分', '续费顺延'],
    sort_order: 3,
  },
]

describe('SubscriptionMembershipPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchPackages.mockResolvedValue({
      packages: [],
      subscription_plans: plans,
      channels: { zpay: { code: 'zpay', label: '支付宝', enabled: true, configured: true, available: true } },
      payment_enabled: true,
      settings: {},
    })
    mocks.fetchMembershipStatus.mockResolvedValue({
      active: true,
      plan_id: 'monthly',
      plan_name: '月享会员',
      badge: '热门',
      starts_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-01T00:00:00Z',
      days_remaining: 22,
    })
    mocks.createSubscriptionPayment.mockResolvedValue({
      order_no: 'sub-order-1',
      pay_url: 'https://pay.example/sub-order-1',
      amount_yuan: 69,
      credits: 0,
      bonus_credits: 0,
      product_kind: 'subscription',
      product_name: 'Pro 创作',
    })
    mocks.queryPaymentStatus.mockResolvedValue({
      order_no: 'sub-order-1',
      status: 'paid',
      amount_yuan: 69,
      credits: 0,
      bonus_credits: 0,
      paid_at: '2026-08-10T12:00:00Z',
      product_kind: 'subscription',
      product_name: 'Pro 创作',
    })
  })

  it('renders current membership and server-provided plans in mobile mode', async () => {
    render(<SubscriptionMembershipPanel variant="mobile" />)

    expect(await screen.findByText('当前会员')).toBeInTheDocument()
    expect(screen.getAllByText('月享会员').length).toBeGreaterThan(0)
    expect(screen.getByText('还剩 22 天')).toBeInTheDocument()
    expect(screen.getByText('周享会员')).toBeInTheDocument()
    expect(screen.getByText('Pro 创作')).toBeInTheDocument()
    expect(screen.getByTestId('subscription-membership-panel')).toHaveAttribute('data-variant', 'mobile')
  })

  it('creates, opens and polls a subscription payment before notifying the host', async () => {
    const onPaymentComplete = vi.fn()
    render(<SubscriptionMembershipPanel variant="desktop" onPaymentComplete={onPaymentComplete} />)

    await screen.findByText('Pro 创作')
    fireEvent.click(screen.getByRole('button', { name: '选择 Pro 创作' }))
    fireEvent.click(screen.getByRole('button', { name: '开通 Pro 创作' }))

    expect(screen.getByRole('dialog', { name: '确认会员订单' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认支付 69 元' }))

    await waitFor(() => expect(mocks.createSubscriptionPayment).toHaveBeenCalledWith('pro', {
      documentType: 'payment',
      version: '2026.08.13',
      contentHash: 'c'.repeat(64),
    }))
    expect(mocks.openPaymentWindow).toHaveBeenCalledWith(expect.objectContaining({ order_no: 'sub-order-1' }))
    await waitFor(() => expect(mocks.queryPaymentStatus).toHaveBeenCalledWith('sub-order-1'))
    await waitFor(() => expect(onPaymentComplete).toHaveBeenCalledTimes(1))
  })

  it('mounts the membership confirmation above the page stacking context', async () => {
    render(<SubscriptionMembershipPanel variant="desktop" />)

    const checkout = await screen.findByRole('button', { name: '再买一张 月享会员' })
    fireEvent.click(checkout)

    expect(screen.getByRole('dialog', { name: '确认会员订单' }).parentElement?.parentElement).toBe(document.body)
  })

  it('requires an existing pending membership order to be continued or cancelled before creating another', async () => {
    render(
      <SubscriptionMembershipPanel
        variant="desktop"
        {...{
          pendingSubscriptionOrder: {
            id: 'pending-membership-1',
            order_no: 'pending-membership-1',
            amount_yuan: 29,
            credits: 300,
            bonus_credits: 0,
            pay_channel: 'zpay',
            status: 'pending',
            paid_at: null,
            created_at: '2026-08-20T00:00:00Z',
            product_kind: 'subscription',
            product_name: '月享会员',
          },
        } as any}
      />,
    )

    const checkout = await screen.findByRole('button', { name: '处理待支付订单' })
    fireEvent.click(checkout)

    expect(screen.getByRole('dialog', { name: '处理待支付会员订单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续支付' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消订单' })).toBeInTheDocument()
    expect(mocks.createSubscriptionPayment).not.toHaveBeenCalled()
  })

  it('disables checkout when subscription payment is unavailable', async () => {
    render(<SubscriptionMembershipPanel variant="mobile" paymentAvailable={false} />)

    const checkout = await screen.findByRole('button', { name: '再买一张 月享会员' })
    expect(checkout).toBeDisabled()
    expect(screen.getByText('会员支付暂不可用')).toBeInTheDocument()
  })

  it('shows existing membership without exposing purchase actions in status-only mode', async () => {
    mocks.fetchMembershipStatus.mockResolvedValueOnce({
      active: true,
      benefits_active: false,
      billing_mode: 'external_api_key',
      plan_id: 'monthly',
      plan_name: '月享会员',
      badge: '热门',
      starts_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-01T00:00:00Z',
      days_remaining: 22,
    })
    render(
      <SubscriptionMembershipPanel
        variant="desktop"
        statusOnly
        paymentAvailable={false}
      />,
    )

    expect(await screen.findByText('平台会员身份')).toBeInTheDocument()
    expect(screen.getByText('会员有效，切换回平台积分后恢复权益')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /续订|开通|切换到/ })).not.toBeInTheDocument()
    expect(mocks.fetchPackages).not.toHaveBeenCalled()
    expect(mocks.createSubscriptionPayment).not.toHaveBeenCalled()
  })
})
