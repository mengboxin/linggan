import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreditBalanceStore } from '../../lib/credit-balance-store'
import RechargePage from '../RechargePage'

const mocks = vi.hoisted(() => ({
  fetchBalance: vi.fn(),
  fetchPackages: vi.fn(),
  fetchPaymentOrders: vi.fn(),
  fetchMembershipStatus: vi.fn(),
  currentUser: { billingMode: 'platform_credits' } as { billingMode: string } | null,
}))

vi.mock('../../lib/auth', () => ({
  AUTH_CHANGED_EVENT: 'pixelscribe-auth-changed',
  auth: {
    isLoggedIn: vi.fn(() => true),
    getUser: vi.fn(() => mocks.currentUser),
    isExternalComputeUser: vi.fn((user?: { billingMode?: string } | null) => user?.billingMode === 'external_api_key'),
  },
}))

vi.mock('../../components/ui/ExternalComputeStatus', () => ({
  ExternalComputeStatus: () => <div data-testid="external-compute-settings" />,
}))

vi.mock('../../lib/credits', () => ({
  fetchBalance: mocks.fetchBalance,
  formatCredits: (value: number) => String(value),
}))

vi.mock('../../lib/payment', () => ({
  DEFAULT_PAYMENT_SETTINGS: {
    credits_ratio: 10,
    min_amount_yuan: 1,
    max_amount_yuan: 200,
    order_timeout_minutes: 20,
    max_pending_orders: 2,
    daily_amount_limit_yuan: 1000,
    cancel_cooldown_seconds: 30,
    cancel_window_minutes: 60,
    max_cancellations_per_window: 6,
  },
  cancelPayment: vi.fn(),
  createPayment: vi.fn(),
  fetchPackages: mocks.fetchPackages,
  fetchPaymentOrders: mocks.fetchPaymentOrders,
  fetchMembershipStatus: mocks.fetchMembershipStatus,
  openPaymentWindow: vi.fn(),
  queryPaymentStatus: vi.fn(),
  resumePayment: vi.fn(),
}))

vi.mock('../../lib/event-stream', () => ({
  eventStream: { on: vi.fn(() => vi.fn()) },
}))

vi.mock('../../components/ui/PaymentIcons', () => ({
  AlipayIcon: () => <span>Alipay</span>,
}))

vi.mock('../../components/Billing/MembershipWalletPanel', () => ({
  MembershipWalletPanel: () => <div data-testid="membership-wallet-panel">会员卡配额</div>,
}))

function neverResolves() {
  return new Promise<never>(() => {})
}

function openCreditsPanel() {
  fireEvent.click(screen.getByRole('tab', { name: '按量积分' }))
}

describe('RechargePage loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCreditBalanceStore.setState({
      balance: null,
      loading: false,
      error: false,
      lastLoadedAt: 0,
    })
    mocks.fetchBalance.mockImplementation(neverResolves)
    mocks.fetchPackages.mockImplementation(neverResolves)
    mocks.fetchPaymentOrders.mockImplementation(neverResolves)
    mocks.fetchMembershipStatus.mockResolvedValue({
      active: false,
      plan_id: null,
      plan_name: null,
      badge: null,
      starts_at: null,
      expires_at: null,
      days_remaining: 0,
    })
    mocks.currentUser = { billingMode: 'platform_credits' }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows structured placeholders without false empty or low-balance states', () => {
    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('tab', { name: '会员服务' })).toHaveAttribute('aria-selected', 'true')
    openCreditsPanel()
    expect(screen.getByTestId('recharge-balance-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('recharge-packages-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('recharge-orders-skeleton')).toBeInTheDocument()
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument()
    expect(screen.queryByText(/余额偏低/)).not.toBeInTheDocument()
    expect(screen.queryByText('暂无充值记录')).not.toBeInTheDocument()
  })

  it('keeps a cached balance visible while refreshing it in the background', () => {
    useCreditBalanceStore.setState({ balance: 128, lastLoadedAt: Date.now() })

    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    openCreditsPanel()
    expect(screen.getByText('128')).toBeInTheDocument()
    expect(screen.queryByTestId('recharge-balance-skeleton')).not.toBeInTheDocument()
  })

  it('times out stalled requests and exposes retry actions', async () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    openCreditsPanel()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(screen.getByText('积分余额加载失败')).toBeInTheDocument()
    expect(screen.getByText('充值套餐加载失败')).toBeInTheDocument()
    expect(screen.getByText('充值记录加载失败')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重新加载' })).toHaveLength(3)
  })

  it('renders successful sections even when packages fail', async () => {
    mocks.fetchBalance.mockResolvedValueOnce(128)
    mocks.fetchPackages.mockRejectedValueOnce(new Error('packages unavailable'))
    mocks.fetchPaymentOrders.mockResolvedValueOnce({ orders: [] })

    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    openCreditsPanel()
    await waitFor(() => expect(screen.getByText('128')).toBeInTheDocument())
    expect(screen.getByText('充值套餐加载失败')).toBeInTheDocument()
    expect(screen.getByText('暂无支付记录')).toBeInTheDocument()
    expect(screen.queryByTestId('recharge-balance-skeleton')).not.toBeInTheDocument()
  })

  it('switches the mounted view immediately when the compute source changes', async () => {
    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    openCreditsPanel()
    expect(screen.getByTestId('recharge-balance-skeleton')).toBeInTheDocument()

    await act(async () => {
      mocks.currentUser = { billingMode: 'external_api_key' }
      window.dispatchEvent(new Event('pixelscribe-auth-changed'))
    })

    expect(screen.getByTestId('external-compute-settings')).toBeInTheDocument()
    expect(await screen.findByText('平台会员身份')).toBeInTheDocument()
    expect(screen.queryByTestId('recharge-balance-skeleton')).not.toBeInTheDocument()
  })

  it('keeps membership-card quota inside the membership view, not pay-as-you-go credits', () => {
    render(
      <MemoryRouter>
        <RechargePage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('membership-wallet-panel')).toBeInTheDocument()
    openCreditsPanel()
    expect(screen.queryByTestId('membership-wallet-panel')).not.toBeInTheDocument()
  })
})
