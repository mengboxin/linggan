import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auth } from '../auth'
import { usePetStore } from '../pet-store'

const user = {
  id: 'pet-user',
  email: 'pet@example.com',
  displayName: 'Pet User',
  role: 'user',
}

function accessToken(expiresInSeconds = 3600) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, type: 'access' })}.signature`
}

describe('pet store account preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
    usePetStore.setState({
      selectedPetId: 'xueying-wawa',
      customName: '',
      visible: false,
      closing: false,
      petMode: 'idle',
      taskLabel: '',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as any).electronAPI
  })

  it('hydrates the selected pet from the authenticated account', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      petId: 'bubu',
      petCustomName: 'Bubu',
    })

    expect(usePetStore.getState()).toEqual(expect.objectContaining({
      selectedPetId: 'bubu',
      customName: 'Bubu',
    }))
    expect(window.localStorage.getItem('img-edit-selected-pet')).toBe('bubu')
    expect(window.localStorage.getItem('img-edit-pet-custom-name')).toBe('Bubu')
  })

  it('persists user pet changes to the account', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      user: {
        ...user,
        petId: 'bubu',
        petCustomName: 'Bubu',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    usePetStore.getState().setCustomName('Bubu')
    usePetStore.getState().setSelectedPetId('bubu')
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/pet-preference',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ pet_id: 'bubu', pet_custom_name: 'Bubu' }),
      }),
    )
    expect(auth.getUser()).toEqual(expect.objectContaining({
      petId: 'bubu',
      petCustomName: 'Bubu',
    }))
  })

  it('does not resend the same desktop pet on repeated account sync', () => {
    const petSetPet = vi.fn()
    ;(window as any).electronAPI = { petSetPet }

    auth.save(accessToken(), 'refresh-token', {
      ...user,
      petId: 'bubu',
      petCustomName: 'Bubu',
    })
    auth.updateUser({
      petId: 'bubu',
      petCustomName: 'Bubu',
    })

    expect(petSetPet).toHaveBeenCalledTimes(1)
    expect(petSetPet).toHaveBeenCalledWith(expect.objectContaining({
      petId: 'bubu',
      petName: 'Bubu',
    }))
  })
})
