import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_CHANGED_EVENT, LEGAL_RECONSENT_EVENT, LOGIN_NOTICE_KEY, apiUrl, auth } from '../auth'
import { navigateRoute } from '../navigation'

vi.mock('../navigation', () => ({
  navigateRoute: vi.fn(),
}))

const user = {
  id: 'user-cache-test',
  email: 'cache@example.com',
  displayName: 'Cache Test',
  role: 'user',
}

function accessToken(expiresInSeconds = 3600) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, type: 'access' })}.signature`
}

describe('authenticated browser state recovery', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.pushState(null, '', '/')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(navigateRoute).mockReset()
  })

  it('disables the browser HTTP cache for API reads by default', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await auth.fetchWithAuth('/api/credits/balance')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/credits/balance',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('uses the desktop preload API base before electronAPI is fully bridged', () => {
    Object.defineProperty(window, '__LG_CONFIG__', {
      configurable: true,
      value: { apiBase: 'https://image.foxapi.cn' },
    })
    Reflect.deleteProperty(window, 'electronAPI')

    expect(apiUrl('/api/assets/asset-1/preview')).toBe('https://image.foxapi.cn/api/assets/asset-1/preview')

    Reflect.deleteProperty(window, '__LG_CONFIG__')
  })

  it('drops malformed persisted user data instead of throwing during app boot', () => {
    window.localStorage.setItem('lg_user', '{broken-json')

    expect(auth.getUser()).toBeNull()
    expect(window.localStorage.getItem('lg_user')).toBeNull()
  })

  it('notifies subscribers after a refresh token repairs the session', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    const changed = vi.fn()
    window.addEventListener(AUTH_CHANGED_EVENT, changed)
    const freshAccess = accessToken(7200)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshAccess,
        refresh_token: 'fresh-refresh',
        user: {
          id: user.id,
          email: user.email,
          display_name: user.displayName,
          role: user.role,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await auth.fetchWithAuth('/api/credits/balance')

    expect(changed).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBe(freshAccess)
    window.removeEventListener(AUTH_CHANGED_EVENT, changed)
  })

  it('keeps an expired access token refreshable as an active session', () => {
    auth.save(accessToken(-60), 'refresh-token', user)

    expect(auth.isLoggedIn()).toBe(true)
  })

  it('does not restore a browser session beyond the absolute session limit', () => {
    auth.save(accessToken(), 'refresh-token', user)
    window.localStorage.setItem('pixelscribe-auth-session-started-at', String(Date.now() - (8 * 24 * 60 * 60 * 1000)))

    expect(auth.isLoggedIn()).toBe(false)
    expect(auth.getAccessToken()).toBeNull()
    expect(auth.getUser()).toBeNull()
  })

  it('recognizes users whose compute is billed by their own API key', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      authProvider: 'password',
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'abcdef123456',
    })

    expect(auth.isExternalComputeUser()).toBe(true)
  })

  it('recognizes users whose compute is billed by a Grok API key', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      authProvider: 'password',
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grokkey123456',
    })

    expect(auth.isExternalComputeUser()).toBe(true)
  })

  it('does not treat Grok billing as external compute when Grok is offline', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      authProvider: 'password',
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grokkey123456',
      grokEnabled: false,
    })

    expect(auth.isExternalComputeUser()).toBe(false)
    expect(auth.getUser()).toEqual(expect.objectContaining({ grokEnabled: false }))
  })

  it('normalizes persisted compute metadata independently from login type', () => {
    window.localStorage.setItem('lg_user', JSON.stringify({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      role: user.role,
      auth_provider: 'password',
      billing_mode: 'external_api_key',
      api_key_fingerprint: 'stored123456',
    }))

    expect(auth.getUser()).toEqual(expect.objectContaining({
      displayName: user.displayName,
      authProvider: 'password',
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'stored123456',
    }))
    expect(auth.isExternalComputeUser()).toBe(true)
  })

  it('does not activate external compute merely because a key is configured', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      authProvider: 'password',
      billingMode: 'platform_credits',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
    })

    expect(auth.isExternalComputeUser()).toBe(false)
  })

  it('preserves external compute metadata when refreshing tokens', async () => {
    auth.save(accessToken(-60), 'refresh-token', {
      ...user,
      authProvider: 'password',
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'abcdef123456',
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: accessToken(7200),
      refresh_token: 'fresh-refresh',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        authProvider: 'password',
        billingMode: 'external_api_key',
        apiKeyFingerprint: 'abcdef123456',
        foxapiModelCount: 13,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await auth.ensureValidSession()

    expect(auth.getUser()).toEqual(expect.objectContaining({
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'abcdef123456',
      foxapiModelCount: 13,
    }))
  })

  it('refreshes persisted compute metadata before considering a valid session ready', async () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      billingMode: 'platform_credits',
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        role: user.role,
        billing_mode: 'external_api_key',
        api_key_fingerprint: 'server123456',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await auth.ensureValidSession()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(auth.getUser()).toEqual(expect.objectContaining({
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'server123456',
    }))
  })

  it('preserves the session and publishes a legal re-consent request from refresh', async () => {
    auth.save(accessToken(-60), 'old-refresh', user)
    const temporaryAccess = accessToken(300)
    const reconsent = vi.fn()
    window.addEventListener(LEGAL_RECONSENT_EVENT, reconsent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: {
        code: 'LEGAL_RECONSENT_REQUIRED',
        documents: [{ documentType: 'terms', version: 'next' }],
        reconsentAccessToken: temporaryAccess,
      },
    }), { status: 428, headers: { 'Content-Type': 'application/json' } })))

    const valid = await auth.ensureAccessSession()

    expect(valid).toBe(true)
    expect(auth.getAccessToken()).toBe(temporaryAccess)
    expect(auth.getUser()).toEqual(expect.objectContaining({ id: user.id }))
    expect(reconsent).toHaveBeenCalledTimes(1)
    expect(auth.getPendingLegalReconsent()).toEqual(expect.objectContaining({
      code: 'LEGAL_RECONSENT_REQUIRED',
    }))
    expect(navigateRoute).not.toHaveBeenCalled()
    window.removeEventListener(LEGAL_RECONSENT_EVENT, reconsent)
  })

  it('validates an already usable access token without blocking route navigation on a profile sync', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const valid = await auth.ensureAccessSession()

    expect(valid).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('can force a compute-source refresh when the app regains focus', async () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      billingMode: 'platform_credits',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { ...user, billing_mode: 'platform_credits' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: {
          ...user,
          billing_mode: 'external_api_key',
          api_key_fingerprint: 'focus123456',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await auth.ensureValidSession()
    await auth.ensureValidSession(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.getUser()).toEqual(expect.objectContaining({
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'focus123456',
    }))
  })

  it('updates the cached compute source and notifies mounted views', () => {
    auth.save(accessToken(), 'refresh-token', {
      ...user,
      billingMode: 'platform_credits',
    })
    const changed = vi.fn()
    window.addEventListener(AUTH_CHANGED_EVENT, changed)

    auth.updateUser({
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
    })

    expect(auth.getUser()).toEqual(expect.objectContaining({
      billingMode: 'external_api_key',
      hasApiKey: true,
      apiKeyFingerprint: 'abcdef123456',
    }))
    expect(changed).toHaveBeenCalledTimes(1)
    window.removeEventListener(AUTH_CHANGED_EVENT, changed)
  })

  it('logs out immediately when an expired session cannot be refreshed', async () => {
    auth.save(accessToken(-60), 'expired-refresh-token', user)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await auth.fetchWithAuth('/api/conversations')

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBeNull()
    expect(auth.getUser()).toBeNull()
    expect(navigateRoute).toHaveBeenCalledWith('/login?auth=1&reason=session-expired', { replace: true })
    expect(window.sessionStorage.getItem(LOGIN_NOTICE_KEY)).toBe('session-expired')
  })

  it('does not label an intentional logout as an expired session when a pending request finishes', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    auth.clear({ intentional: true })

    const response = await auth.fetchWithAuth('/api/conversations')

    expect(response.status).toBe(401)
    expect(navigateRoute).toHaveBeenCalledWith('/login', { replace: true })
    expect(window.sessionStorage.getItem(LOGIN_NOTICE_KEY)).toBeNull()
  })

  it('quietly clears an expired session on the public login page without a noisy redirect', async () => {
    window.history.pushState(null, '', '/login')
    auth.save(accessToken(-60), 'expired-refresh-token', user)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const valid = await auth.ensureValidSession()

    expect(valid).toBe(false)
    expect(auth.getAccessToken()).toBeNull()
    expect(auth.getUser()).toBeNull()
    expect(navigateRoute).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(LOGIN_NOTICE_KEY)).toBeNull()
  })

  it('logs out when the request is still unauthorized after a successful token refresh', async () => {
    auth.save(accessToken(), 'refresh-token', user)
    const freshAccess = accessToken(7200)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshAccess,
        refresh_token: 'fresh-refresh',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await auth.fetchWithAuth('/api/conversations')

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(auth.getAccessToken()).toBeNull()
    expect(navigateRoute).toHaveBeenCalledWith('/login?auth=1&reason=session-expired', { replace: true })
  })
})
