import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileProfile from '../MobileProfile'

const mocks = vi.hoisted(() => ({
  fetchTransactions: vi.fn(),
  fetchWithAuth: vi.fn(),
  refreshBalance: vi.fn(),
  updateUser: vi.fn(),
  refreshWallet: vi.fn().mockResolvedValue(null),
  selectWallet: vi.fn().mockResolvedValue(true),
  themeState: {
    theme: 'light' as const,
    lightSurface: 'warm' as const,
    darkSurface: 'black' as const,
    lightAccent: 'signature' as const,
    darkAccent: 'signature' as const,
    toggle: vi.fn(),
    setTheme: vi.fn(),
    setSurfacePreset: vi.fn(),
    setAccentPreset: vi.fn(),
    resetAppearance: vi.fn(),
  },
}))

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    clear: vi.fn(),
    fetchWithAuth: mocks.fetchWithAuth,
    updateUser: mocks.updateUser,
    isExternalComputeUser: vi.fn(() => false),
    getUser: () => ({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      role: 'user',
      credits: 12,
    }),
  },
}))

vi.mock('../../../lib/credits', () => ({
  CreditApiError: class CreditApiError extends Error {},
  fetchTransactions: mocks.fetchTransactions,
  formatCredits: (credits: number) => String(credits),
}))

vi.mock('../../../lib/credit-balance-store', () => ({
  useCreditBalanceStore: (selector: (state: { balance: number; refresh: typeof mocks.refreshBalance }) => unknown) => selector({
    balance: 12,
    refresh: mocks.refreshBalance,
  }),
}))

vi.mock('../../../lib/membership-wallet-store', () => ({
  ensureMembershipWalletEvents: vi.fn(),
  useMembershipWalletStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    snapshot: {
      billing_mode: 'platform_credits',
      funding_source: 'metered',
      selected_subscription_id: null,
      spendable_balance: 12,
      metered_balance: 12,
      cards: [],
    },
    loading: false,
    switching: false,
    error: '',
    refresh: mocks.refreshWallet,
    select: mocks.selectWallet,
  }),
}))

vi.mock('../../../lib/theme', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/theme')>()
  return {
    ...actual,
    useThemeStore: (selector?: (state: typeof mocks.themeState) => unknown) => (
      selector ? selector(mocks.themeState) : mocks.themeState
    ),
  }
})

vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh', toggle: vi.fn() }),
}))

vi.mock('../../../lib/pet-store', () => ({
  usePetStore: () => ({ visible: true, toggleVisible: vi.fn() }),
}))

vi.mock('../../../lib/navigation', () => ({
  navigateRoute: vi.fn(),
  routeHref: (path: string) => path,
}))

describe('MobileProfile credit history', () => {
  beforeEach(() => {
    mocks.fetchTransactions.mockReset()
    mocks.fetchWithAuth.mockReset()
    mocks.refreshBalance.mockReset()
    mocks.updateUser.mockReset()
    mocks.refreshBalance.mockResolvedValue(12)
    mocks.fetchWithAuth.mockImplementation(async (input: RequestInfo) => {
      if (String(input).endsWith('/api/auth/compute-source')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            computeSource: {
              provider: 'foxapi',
              billing_mode: 'platform_credits',
              active: false,
              configured: false,
              status: 'not_configured',
              key_fingerprint: '',
              model_count: 0,
            },
            user: {
              id: 'user-1',
              email: 'user@example.com',
              displayName: 'User',
              role: 'user',
              credits: 12,
              billingMode: 'platform_credits',
            },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          id: 'user-1',
          email: 'user@example.com',
          displayName: 'User',
          role: 'user',
          credits: 12,
          billingMode: 'platform_credits',
        }),
      }
    })
    mocks.fetchTransactions.mockResolvedValue([
      {
        id: 'tx-1',
        amount: -2,
        balance_after: 10,
        type: 'consume',
        related_task_id: null,
        description: '生成图片',
        created_at: '2026-07-12T08:00:00Z',
      },
    ])
  })

  it('loads transactions when the credits tab is opened, not during initial settings render', async () => {
    render(<MobileProfile />)

    expect(mocks.fetchTransactions).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '算力' }))

    await waitFor(() => expect(mocks.fetchTransactions).toHaveBeenCalledWith(
      20,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(await screen.findByText('生成图片')).toBeInTheDocument()
    expect(screen.getByLabelText('扣除积分')).toBeInTheDocument()
  })

  it('keeps the onboarding guide available from My', () => {
    const onGuideOpen = vi.fn()
    render(<MobileProfile onGuideOpen={onGuideOpen} />)

    fireEvent.click(screen.getByRole('button', { name: '新手导览' }))

    expect(onGuideOpen).toHaveBeenCalledTimes(1)
  })

  it('opens the shared appearance settings from My settings', () => {
    render(<MobileProfile />)

    fireEvent.click(screen.getByRole('button', { name: /外观设置/ }))

    expect(screen.getByRole('region', { name: '外观设置' })).toHaveAttribute('data-appearance-variant', 'mobile')
    expect(screen.getByRole('radiogroup', { name: '界面模式 Display mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /返回设置/ })).toBeInTheDocument()
  })

  it('opens a second-level legal center with all current documents', () => {
    render(<MobileProfile />)

    fireEvent.click(screen.getByRole('button', { name: /协议与隐私/ }))

    expect(screen.getByRole('heading', { name: '协议与隐私' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看用户服务协议' })).toHaveAttribute('href', '/terms?from=%2Fprofile')
    expect(screen.getByRole('link', { name: '查看隐私政策' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看AI 服务与生成内容免责声明' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看付费服务与退款规则' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /返回设置/ })).toBeInTheDocument()
  })

  it('does not expose storage quota management to users', () => {
    render(<MobileProfile />)

    expect(screen.queryByRole('link', { name: '存储空间' })).not.toBeInTheDocument()
  })

  it('distinguishes a client-side network failure from an empty history', async () => {
    mocks.fetchTransactions.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<MobileProfile />)

    fireEvent.click(screen.getByRole('button', { name: '算力' }))

    expect(await screen.findByText('积分请求未到达服务器，请检查网络或反向代理后重试')).toBeInTheDocument()
  })
})
