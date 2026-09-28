import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileAppBar from '../MobileAppBar'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refreshCredits: vi.fn().mockResolvedValue(null),
  creditState: {
    balance: null as number | null,
    loading: false,
    error: true,
  },
  user: null as { externalCompute?: boolean; apiKeyFingerprint?: string } | null,
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light', toggle: vi.fn() }),
}))

vi.mock('../../../lib/auth', () => ({
  auth: {
    isExternalComputeUser: (user: { externalCompute?: boolean } | null) => Boolean(user?.externalCompute),
    isLoggedIn: () => false,
  },
}))

vi.mock('../../../lib/use-auth-user', () => ({
  useAuthUser: () => mocks.user,
}))

vi.mock('../../../components/Notifications/NotificationCenter', () => ({
  NotificationCenter: () => null,
}))

vi.mock('../../Billing/MembershipWalletControl', () => ({
  MembershipWalletControl: () => <button type="button" aria-label="平台算力状态">平台算力</button>,
}))

vi.mock('../../../lib/credit-balance-store', () => ({
  ensureCreditBalanceEvents: vi.fn(),
  useCreditBalanceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...mocks.creditState,
    refresh: mocks.refreshCredits,
  }),
}))

vi.mock('../../../lib/storage-quota', () => ({
  fetchStorageSummary: vi.fn().mockRejectedValue(new Error('offline')),
  formatStorageBytes: vi.fn(() => '0 B'),
}))

describe('MobileAppBar credit recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.creditState.balance = null
    mocks.creditState.loading = false
    mocks.creditState.error = true
    mocks.user = null
  })

  it('shows one platform billing status without an API Key action', () => {
    render(<MobileAppBar onMenuOpen={vi.fn()} />)

    expect(screen.getByRole('button', { name: '平台算力状态' })).toBeInTheDocument()
    expect(screen.queryByText(/接入 Key/)).not.toBeInTheDocument()
  })

  it('opens compute settings from the FoxAPI indicator for an external Key user', () => {
    const onComputeSourceOpen = vi.fn()
    mocks.user = { externalCompute: true, apiKeyFingerprint: 'abcd' }

    render(<MobileAppBar onMenuOpen={vi.fn()} onComputeSourceOpen={onComputeSourceOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'FoxAPI connected' }))

    expect(onComputeSourceOpen).toHaveBeenCalledTimes(1)
  })

  it('plays an inspiration plus-one feedback when the brand is tapped', () => {
    render(<MobileAppBar onMenuOpen={vi.fn()} />)

    expect(screen.getByRole('img', { name: '灵感' })).toHaveClass('brand-wordmark--compact')
    fireEvent.click(screen.getByTestId('mobile-inspiration-brand'))

    expect(screen.getByTestId('mobile-inspiration-plus-one')).toHaveAttribute('data-burst', '1')
    expect(mocks.navigate).toHaveBeenCalledWith('/text-to-image')
  })
})
