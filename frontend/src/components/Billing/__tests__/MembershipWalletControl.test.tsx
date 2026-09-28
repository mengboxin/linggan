import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MembershipWalletControl } from '../MembershipWalletControl'

const mocks = vi.hoisted(() => ({
  navigateRoute: vi.fn(),
  refresh: vi.fn().mockResolvedValue(null),
  select: vi.fn().mockResolvedValue(true),
  state: {
    snapshot: {
      billing_mode: 'platform_credits',
      funding_source: 'metered' as const,
      selected_subscription_id: null,
      spendable_balance: 120,
      metered_balance: 120,
      cards: [
        {
          id: 'card-week-1',
          plan_id: 'weekly',
          plan_name: '创作周卡',
          badge_label: 'WEEK',
          status: 'active' as const,
          quota_total: 80,
          quota_remaining: 62,
          starts_at: '2026-08-10T00:00:00Z',
          activated_at: '2026-08-10T00:00:00Z',
          expires_at: '2026-08-17T00:00:00Z',
          exhausted_at: null,
          created_at: '2026-08-10T00:00:00Z',
          queue_position: null,
        },
      ],
    },
    loading: false,
    switching: false,
    error: '',
  },
}))

vi.mock('../../../lib/auth', () => ({
  auth: { isExternalComputeUser: () => false },
}))

vi.mock('../../../lib/navigation', () => ({
  navigateRoute: mocks.navigateRoute,
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

vi.mock('../../../lib/membership-wallet-store', () => ({
  ensureMembershipWalletEvents: vi.fn(),
  useMembershipWalletStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...mocks.state,
    refresh: mocks.refresh,
    select: mocks.select,
  }),
}))

describe('MembershipWalletControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('keeps the popover open while the pointer crosses the trigger gap', async () => {
    vi.useFakeTimers()
    const { container } = render(<MembershipWalletControl />)

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
    const popover = screen.getByRole('dialog', { name: '会员与扣费来源' })
    fireEvent.mouseLeave(container.firstElementChild as HTMLElement)
    fireEvent.mouseEnter(popover)

    await act(async () => { vi.advanceTimersByTime(240) })
    expect(screen.getByRole('dialog', { name: '会员与扣费来源' })).toBeInTheDocument()
  })

  it('does not close when the pointer leaves the trigger for its own popover', async () => {
    vi.useFakeTimers()
    const { container } = render(<MembershipWalletControl />)
    const control = container.firstElementChild as HTMLElement

    fireEvent.mouseEnter(control)
    const popover = screen.getByRole('dialog')
    fireEvent.mouseLeave(control, { relatedTarget: popover })

    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('lets the user choose a single active membership card explicitly', () => {
    render(<MembershipWalletControl />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: /会员卡|按量积分/ }).parentElement as HTMLElement)

    fireEvent.click(screen.getByRole('button', { name: /创作周卡.*62.*80/ }))
    expect(mocks.select).toHaveBeenCalledWith('subscription', 'card-week-1')
  })
})
