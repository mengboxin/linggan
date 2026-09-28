import { navigateRoute } from './navigation'
import { getStorageWorkspace, requestDesktopLocalWorkspace } from './storage-workspace'

/**
 * 统一 API 请求基础地址
 * - 网页端：相对路径 ''，走 vite proxy 或同域
 * - Electron 客户端：从 electronAPI 读取服务器地址，或用内置默认值
 */
export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    // 优先读 preload 同步注入的配置（时机最早，不会有竞态）
    const preloadBase = (window as unknown as { __LG_CONFIG__?: { apiBase: string } }).__LG_CONFIG__?.apiBase
    if (window.__LG_API_BASE__ || preloadBase) return window.__LG_API_BASE__ ?? preloadBase ?? ''
    if (!window.electronAPI) return ''
    // 其次读主进程 did-finish-load 注入的值
    return 'http://localhost:8000'
  }
  return ''
}

export function apiUrl(path: string): string {
  const base = getApiBase()
  return base ? `${base}${path}` : path
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: string
  credits?: number
  petId?: string | null
  petCustomName?: string
  authProvider?: string
  billingMode?: 'platform_credits' | 'external_api_key' | 'grok_api_key' | string
  hasApiKey?: boolean
  apiKeyFingerprint?: string
  apiKeyStatus?: string | null
  foxapiModelCount?: number
  foxapiLastVerifiedAt?: string | null
  foxapiLastUsedAt?: string | null
  hasGrokApiKey?: boolean
  grokApiKeyFingerprint?: string
  grokApiKeyStatus?: string | null
  grokModelCount?: number
  grokLastVerifiedAt?: string | null
  grokLastUsedAt?: string | null
  grokEnabled?: boolean
}

const ACCESS_KEY  = 'lg_access_token'
const REFRESH_KEY = 'lg_refresh_token'
const USER_KEY    = 'lg_user'
const SESSION_STARTED_AT_KEY = 'pixelscribe-auth-session-started-at'
const SESSION_FALLBACK_PREFIX = 'pixelscribe-auth-session:'
export const AUTH_CHANGED_EVENT = 'pixelscribe-auth-changed'
export const LEGAL_RECONSENT_EVENT = 'linggan-legal-reconsent-required'
export const LOGIN_NOTICE_KEY = 'pixelscribe-login-notice'
const SESSION_EXPIRED_ROUTE = '/login?auth=1&reason=session-expired'
const USER_SYNC_INTERVAL_MS = 5 * 60 * 1000
const USER_SYNC_TIMEOUT_MS = 5000
const ABSOLUTE_SESSION_LIMIT_MS = 7 * 24 * 60 * 60 * 1000

function notifyAuthChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
  }
}

export function queueLoginNotice(reason: 'session-expired' | 'idle') {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(LOGIN_NOTICE_KEY, reason)
  }
}

function normalizeAuthUser(raw: Record<string, unknown>): AuthUser {
  return {
    id: String(raw.id || ''),
    email: String(raw.email || ''),
    displayName: String(raw.displayName ?? raw.display_name ?? ''),
    role: String(raw.role || 'user'),
    credits: typeof raw.credits === 'number' ? raw.credits : undefined,
    petId: raw.petId != null || raw.pet_id != null
      ? String(raw.petId ?? raw.pet_id ?? '')
      : null,
    petCustomName: String(raw.petCustomName ?? raw.pet_custom_name ?? ''),
    authProvider: String(raw.authProvider ?? raw.auth_provider ?? 'password'),
    billingMode: String(raw.billingMode ?? raw.billing_mode ?? 'platform_credits'),
    hasApiKey: Boolean(raw.hasApiKey ?? raw.has_api_key ?? raw.apiKeyFingerprint ?? raw.api_key_fingerprint),
    apiKeyFingerprint: String(raw.apiKeyFingerprint ?? raw.api_key_fingerprint ?? ''),
    apiKeyStatus: raw.apiKeyStatus != null || raw.api_key_status != null
      ? String(raw.apiKeyStatus ?? raw.api_key_status)
      : null,
    foxapiModelCount: Number(raw.foxapiModelCount ?? raw.foxapi_model_count ?? 0),
    foxapiLastVerifiedAt: raw.foxapiLastVerifiedAt != null || raw.foxapi_last_verified_at != null
      ? String(raw.foxapiLastVerifiedAt ?? raw.foxapi_last_verified_at)
      : null,
    foxapiLastUsedAt: raw.foxapiLastUsedAt != null || raw.foxapi_last_used_at != null
      ? String(raw.foxapiLastUsedAt ?? raw.foxapi_last_used_at)
      : null,
    hasGrokApiKey: Boolean(raw.hasGrokApiKey ?? raw.has_grok_api_key ?? raw.grokApiKeyFingerprint ?? raw.grok_api_key_fingerprint),
    grokApiKeyFingerprint: String(raw.grokApiKeyFingerprint ?? raw.grok_api_key_fingerprint ?? ''),
    grokApiKeyStatus: raw.grokApiKeyStatus != null || raw.grok_api_key_status != null
      ? String(raw.grokApiKeyStatus ?? raw.grok_api_key_status)
      : null,
    grokModelCount: Number(raw.grokModelCount ?? raw.grok_model_count ?? 0),
    grokLastVerifiedAt: raw.grokLastVerifiedAt != null || raw.grok_last_verified_at != null
      ? String(raw.grokLastVerifiedAt ?? raw.grok_last_verified_at)
      : null,
    grokLastUsedAt: raw.grokLastUsedAt != null || raw.grok_last_used_at != null
      ? String(raw.grokLastUsedAt ?? raw.grok_last_used_at)
      : null,
    grokEnabled: raw.grokEnabled == null && raw.grok_enabled == null
      ? true
      : Boolean(raw.grokEnabled ?? raw.grok_enabled),
  }
}

function isApiReadRequest(input: RequestInfo, init: RequestInit) {
  const requestMethod = input instanceof Request ? input.method : 'GET'
  const method = String(init.method || requestMethod || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  const raw = typeof input === 'string' ? input : input.url
  try {
    return new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname.startsWith('/api/')
  } catch {
    return raw.startsWith('/api/')
  }
}

// 防止并发刷新：同时只发一次 refresh 请求
let _refreshPromise: Promise<boolean> | null = null
let _userSyncPromise: Promise<boolean> | null = null
let _lastUserSyncAt = 0
let _redirectingToLogin = false
let _intentionalLogout = false
let _pendingLegalReconsent: Record<string, unknown> | null = null

async function readLegalReconsent(response: Response): Promise<Record<string, unknown> | null> {
  if (response.status !== 428) return null
  try {
    const payload = await response.clone().json()
    const detail = payload?.detail
    return detail?.code === 'LEGAL_RECONSENT_REQUIRED' ? detail : null
  } catch {
    return null
  }
}

function notifyLegalReconsent(detail: Record<string, unknown>) {
  _pendingLegalReconsent = detail
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LEGAL_RECONSENT_EVENT, { detail }))
  }
}

function readAuthStorage(key: string): string | null {
  try {
    const fallback = sessionStorage.getItem(`${SESSION_FALLBACK_PREFIX}${key}`)
    if (fallback !== null) return fallback
  } catch {
    // Continue to persistent storage when sessionStorage is unavailable.
  }
  try {
    const persistent = localStorage.getItem(key)
    if (persistent !== null) return persistent
  } catch {
    // A hardened browser profile can deny persistent storage altogether.
  }
  return null
}

function writeAuthStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    try { sessionStorage.removeItem(`${SESSION_FALLBACK_PREFIX}${key}`) } catch {}
    return
  } catch {
    // Do not turn a successful server login into a fake network failure when
    // an old browser profile has exhausted or blocked localStorage.
  }
  try {
    sessionStorage.setItem(`${SESSION_FALLBACK_PREFIX}${key}`, value)
  } catch {
    // The caller can still surface a normal authentication failure if both
    // browser storage mechanisms are unavailable.
  }
}

function removeAuthStorage(key: string) {
  try { localStorage.removeItem(key) } catch {}
  try { sessionStorage.removeItem(`${SESSION_FALLBACK_PREFIX}${key}`) } catch {}
}

function hasUsableStoredSession() {
  const hasToken = Boolean(readAuthStorage(ACCESS_KEY) || readAuthStorage(REFRESH_KEY))
  if (!hasToken) return false

  const startedAt = Number(readAuthStorage(SESSION_STARTED_AT_KEY))
  const expired = !Number.isFinite(startedAt)
    || startedAt <= 0
    || Date.now() - startedAt >= ABSOLUTE_SESSION_LIMIT_MS
  if (!expired) return true

  removeAuthStorage(ACCESS_KEY)
  removeAuthStorage(REFRESH_KEY)
  removeAuthStorage(USER_KEY)
  removeAuthStorage(SESSION_STARTED_AT_KEY)
  _lastUserSyncAt = 0
  _pendingLegalReconsent = null
  queueLoginNotice('session-expired')
  notifyAuthChanged()
  return false
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isAccessTokenExpired(token: string | null): boolean {
  if (!token) return true
  const payload = decodeJwtPayload(token)
  if (!payload) return true
  if (typeof payload.exp !== 'number') return false
  return payload.exp * 1000 <= Date.now()
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ detail: '登录已过期，请重新登录' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 强制跳转到登录页（清除 token） */
function redirectToLogin() {
  if (_redirectingToLogin) return
  _redirectingToLogin = true
  const intentionalLogout = _intentionalLogout
  auth.clear()
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    if (intentionalLogout) {
      navigateRoute('/login', { replace: true })
      return
    }
    queueLoginNotice('session-expired')
    navigateRoute(SESSION_EXPIRED_ROUTE, { replace: true })
  }
}

/** 尝试用 refresh token 换新 access token，返回是否成功 */
async function tryRefresh(): Promise<boolean> {
  if (!hasUsableStoredSession()) return false
  const refreshToken = readAuthStorage(REFRESH_KEY)
  if (!refreshToken) return false

  try {
    const res = await fetch(apiUrl('/api/auth/refresh'), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!res.ok) {
      const reconsent = await readLegalReconsent(res)
      if (reconsent) {
        const temporaryToken = reconsent.reconsentAccessToken
        if (typeof temporaryToken === 'string' && temporaryToken) {
          writeAuthStorage(ACCESS_KEY, temporaryToken)
        }
        notifyLegalReconsent(reconsent)
        return true
      }
      return false
    }

    const data = await res.json()
    if (!data.access_token) return false

    // 保存新 token
    writeAuthStorage(ACCESS_KEY, data.access_token)
    if (data.refresh_token) {
      writeAuthStorage(REFRESH_KEY, data.refresh_token)
    }
    if (data.user) {
      writeAuthStorage(USER_KEY, JSON.stringify(normalizeAuthUser(data.user)))
      _lastUserSyncAt = Date.now()
    }
    _redirectingToLogin = false
    notifyAuthChanged()
    return true
  } catch {
    return false
  }
}

function refreshAccessToken(): Promise<boolean> {
  if (!_refreshPromise) {
    const promise = tryRefresh().finally(() => {
      if (_refreshPromise === promise) _refreshPromise = null
    })
    _refreshPromise = promise
  }
  return _refreshPromise
}

function syncCurrentUser(force = false): Promise<boolean> {
  if (!force && _lastUserSyncAt > 0 && Date.now() - _lastUserSyncAt < USER_SYNC_INTERVAL_MS) {
    return Promise.resolve(true)
  }
  if (_userSyncPromise) return _userSyncPromise

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), USER_SYNC_TIMEOUT_MS)
  const promise = auth.fetchWithAuth(apiUrl('/api/auth/me'), { signal: controller.signal })
    .then(async response => {
      if (!response.ok) return false
      const payload = await response.json()
      const rawUser = payload?.user ?? payload
      if (!rawUser || typeof rawUser !== 'object') return false
      const nextUser = normalizeAuthUser(rawUser as Record<string, unknown>)
      const previousUser = auth.getUser()
      _lastUserSyncAt = Date.now()
      if (JSON.stringify(previousUser) !== JSON.stringify(nextUser)) {
        writeAuthStorage(USER_KEY, JSON.stringify(nextUser))
        notifyAuthChanged()
      }
      return true
    })
    .catch(() => false)
    .finally(() => {
      window.clearTimeout(timeoutId)
      if (_userSyncPromise === promise) _userSyncPromise = null
    })
  _userSyncPromise = promise
  return promise
}

async function ensureAccessToken(): Promise<{ valid: boolean; refreshed: boolean }> {
  if (!hasUsableStoredSession()) return { valid: false, refreshed: false }
  const accessToken = readAuthStorage(ACCESS_KEY)
  if (accessToken && !isAccessTokenExpired(accessToken)) {
    return { valid: true, refreshed: false }
  }
  const refreshed = await refreshAccessToken()
  return { valid: refreshed, refreshed }
}

export const auth = {
  save(accessToken: string, refreshToken: string, user: AuthUser) {
    _redirectingToLogin = false
    _intentionalLogout = false
    _lastUserSyncAt = 0
    _pendingLegalReconsent = null
    writeAuthStorage(ACCESS_KEY, accessToken)
    writeAuthStorage(REFRESH_KEY, refreshToken)
    writeAuthStorage(USER_KEY, JSON.stringify(normalizeAuthUser(user as unknown as Record<string, unknown>)))
    writeAuthStorage(SESSION_STARTED_AT_KEY, String(Date.now()))
    notifyAuthChanged()
  },

  getAccessToken(): string | null {
    if (!hasUsableStoredSession()) return null
    return readAuthStorage(ACCESS_KEY)
  },

  getUser(): AuthUser | null {
    const raw = readAuthStorage(USER_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object'
        ? normalizeAuthUser(parsed as Record<string, unknown>)
        : null
    } catch {
      removeAuthStorage(USER_KEY)
      return null
    }
  },

  clear(options: { intentional?: boolean } = {}) {
    if (options.intentional) _intentionalLogout = true
    _lastUserSyncAt = 0
    _pendingLegalReconsent = null
    removeAuthStorage(ACCESS_KEY)
    removeAuthStorage(REFRESH_KEY)
    removeAuthStorage(USER_KEY)
    removeAuthStorage(SESSION_STARTED_AT_KEY)
    notifyAuthChanged()
  },

  updateUser(patch: Partial<AuthUser>) {
    const current = auth.getUser()
    if (!current) return
    writeAuthStorage(USER_KEY, JSON.stringify(normalizeAuthUser({ ...current, ...patch })))
    notifyAuthChanged()
  },

  isExternalComputeUser(user: AuthUser | null = auth.getUser()): boolean {
    if (user?.billingMode === 'grok_api_key') return user?.grokEnabled !== false
    return user?.billingMode === 'external_api_key'
  },

  /** 检查 access token 是否已过期（解码 JWT 的 exp 字段） */
  isTokenExpired(): boolean {
    return isAccessTokenExpired(readAuthStorage(ACCESS_KEY))
  },

  isLoggedIn(): boolean {
    return hasUsableStoredSession()
  },

  /** 确保当前会话可用，并在启动阶段校准用户的算力与计费状态。 */
  async ensureAccessSession(): Promise<boolean> {
    const session = await ensureAccessToken()
    if (!session.valid) {
      redirectToLogin()
      return false
    }
    return true
  },

  getPendingLegalReconsent(): Record<string, unknown> | null {
    return _pendingLegalReconsent
  },

  /** 确保当前会话可用，并在启动阶段校准用户的算力与计费状态。 */
  async ensureValidSession(forceUserSync = false): Promise<boolean> {
    const valid = await auth.ensureAccessSession()
    if (!valid) return false
    await syncCurrentUser(forceUserSync)
    return true
  },

  /** Refresh an asset URL after an <img> request rejected an old token. */
  async refreshImageAccessToken(): Promise<boolean> {
    return refreshAccessToken()
  },

  /**
   * 带 Authorization 头的 fetch
   * - 自动附加 Bearer token
   * - 收到 401 时尝试 refresh，成功则重试原请求
   * - refresh 失败则清除 token 并跳转登录页
   */
  async fetchWithAuth(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
    const localResponse = await requestDesktopLocalWorkspace(input, init, auth.getUser()?.id || 'anonymous')
    if (localResponse) return localResponse

    const doFetch = (token: string | null) => {
      const headers = new Headers(init.headers)
      if (token) headers.set('Authorization', `Bearer ${token}`)
      if (typeof window !== 'undefined' && window.electronAPI) {
        headers.set('X-PixelScribe-Storage-Workspace', getStorageWorkspace())
      }
      const requestInit: RequestInit = {
        ...init,
        headers,
      }
      if (typeof init.cache === 'undefined' && isApiReadRequest(input, init)) {
        requestInit.cache = 'no-store'
      }
      return fetch(input, requestInit)
    }

    const session = await ensureAccessToken()
    if (!session.valid) {
      redirectToLogin()
      return unauthorizedResponse()
    }

    // 第一次请求
    const res = await doFetch(auth.getAccessToken())

    const reconsent = await readLegalReconsent(res)
    if (reconsent) {
      notifyLegalReconsent(reconsent)
      return res
    }

    // 非 401 直接返回
    if (res.status !== 401) return res

    // access token 刚续期仍然 401，说明服务端已拒绝当前会话。
    if (session.refreshed) {
      redirectToLogin()
      return res
    }

    // 收到 401 — 尝试刷新 token（防并发：多个请求同时 401 只刷新一次）
    const refreshed = await refreshAccessToken()

    if (!refreshed) {
      // 刷新失败 → 强制退出
      redirectToLogin()
      // 返回原始 401 响应（调用方不会再处理，因为页面已跳转）
      return res
    }

    // 刷新成功 → 用新 token 重试。重试仍 401 时必须彻底退出。
    const retryResponse = await doFetch(auth.getAccessToken())
    if (retryResponse.status === 401) redirectToLogin()
    return retryResponse
  },
}
