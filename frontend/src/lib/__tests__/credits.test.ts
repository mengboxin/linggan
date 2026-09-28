import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  isExternalComputeUser: vi.fn(() => false),
  navigateRoute: vi.fn(),
}))

vi.mock('../auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: mocks.fetchWithAuth,
    isExternalComputeUser: mocks.isExternalComputeUser,
  },
}))

vi.mock('../navigation', () => ({
  navigateRoute: mocks.navigateRoute,
}))

import { ensureCredits } from '../credits'

describe('ensureCredits', () => {
  beforeEach(() => {
    mocks.fetchWithAuth.mockReset()
    mocks.isExternalComputeUser.mockReset().mockReturnValue(false)
    mocks.navigateRoute.mockReset()
  })

  it('emits the in-app insufficient-credit event instead of opening a browser confirm dialog', async () => {
    mocks.fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ spendable_balance: 3 })))
    const nativeConfirm = vi.fn()
    const previousConfirm = window.confirm
    window.confirm = nativeConfirm
    const listener = vi.fn()
    window.addEventListener('pixelscribe-insufficient-credits', listener)

    try {
      await expect(ensureCredits(8)).resolves.toBe(false)
      expect(nativeConfirm).not.toHaveBeenCalled()
      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0][0] as CustomEvent<{ cost: number; balance: number }>
      expect(event.detail).toEqual({ cost: 8, balance: 3 })
    } finally {
      window.confirm = previousConfirm
      window.removeEventListener('pixelscribe-insufficient-credits', listener)
    }
  })
})
