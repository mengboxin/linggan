import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBalanceMock = vi.hoisted(() => vi.fn())

vi.mock('../credits', () => ({
  fetchBalance: fetchBalanceMock,
}))

const USER_ID = 'credit-cache-user'
const CACHE_KEY = `pixelscribe-credit-balance:v2:${USER_ID}`

function seedLoggedInUser() {
  localStorage.setItem('lg_access_token', 'cached-access-token')
  localStorage.setItem('lg_user', JSON.stringify({
    id: USER_ID,
    email: 'credit@example.com',
    displayName: 'Credit User',
    role: 'user',
    billingMode: 'platform_credits',
  }))
}

describe('credit balance cache', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchBalanceMock.mockReset()
    vi.resetModules()
  })

  it('shows the last known balance immediately and preserves it through a transient refresh error', async () => {
    seedLoggedInUser()
    localStorage.setItem(CACHE_KEY, JSON.stringify({ balance: 48, loadedAt: Date.now() - 60_000 }))
    fetchBalanceMock.mockRejectedValue(new Error('temporary network error'))

    const { useCreditBalanceStore } = await import('../credit-balance-store')

    expect(useCreditBalanceStore.getState().balance).toBe(48)
    await useCreditBalanceStore.getState().refresh(true)
    expect(useCreditBalanceStore.getState()).toMatchObject({
      balance: 48,
      loading: false,
      error: true,
    })
  })
})
