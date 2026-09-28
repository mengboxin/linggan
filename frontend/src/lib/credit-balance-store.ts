import { create } from 'zustand'
import { AUTH_CHANGED_EVENT, auth } from './auth'
import { fetchBalance } from './credits'
import { eventStream } from './event-stream'

interface CreditBalanceState {
  balance: number | null
  loading: boolean
  error: boolean
  lastLoadedAt: number
  refresh: (force?: boolean) => Promise<number | null>
  applyBalance: (balance: number | null) => void
}

const REFRESH_DEDUPE_MS = 3000
// v1 cached the active funding wallet, which could be a membership quota.
// v2 caches only the permanent pay-as-you-go balance returned by /balance.
const CREDIT_CACHE_PREFIX = 'pixelscribe-credit-balance:v2:'
const CREDIT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface CachedCreditBalance {
  balance: number
  loadedAt: number
}

function creditCacheKey() {
  const userId = auth.getUser()?.id
  return userId ? `${CREDIT_CACHE_PREFIX}${userId}` : ''
}

function readCachedCreditBalance(): CachedCreditBalance | null {
  if (typeof localStorage === 'undefined') return null
  const key = creditCacheKey()
  if (!key) return null
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null') as CachedCreditBalance | null
    if (
      !cached
      || !Number.isFinite(cached.balance)
      || !Number.isFinite(cached.loadedAt)
      || Date.now() - cached.loadedAt > CREDIT_CACHE_MAX_AGE_MS
    ) return null
    return cached
  } catch {
    return null
  }
}

function writeCachedCreditBalance(balance: number, loadedAt: number) {
  if (typeof localStorage === 'undefined') return
  const key = creditCacheKey()
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify({ balance, loadedAt }))
  } catch {
    // Cache failure must not block the live balance.
  }
}

let inFlight: Promise<number | null> | null = null
let subscribed = false
const initialCachedBalance = readCachedCreditBalance()

export const useCreditBalanceStore = create<CreditBalanceState>((set, get) => ({
  balance: initialCachedBalance?.balance ?? null,
  loading: false,
  error: false,
  lastLoadedAt: initialCachedBalance?.loadedAt ?? 0,
  applyBalance: balance => {
    if (typeof balance === 'number' && Number.isFinite(balance)) {
      const loadedAt = Date.now()
      writeCachedCreditBalance(balance, loadedAt)
      set({ balance, lastLoadedAt: loadedAt, loading: false, error: false })
    }
  },
  refresh: async (force = false) => {
    if (!auth.isLoggedIn()) {
      set({ balance: null, loading: false, error: false, lastLoadedAt: 0 })
      return null
    }
    if (auth.isExternalComputeUser()) {
      set({ balance: null, loading: false, error: false, lastLoadedAt: Date.now() })
      return null
    }
    const state = get()
    if (!force && state.balance !== null && Date.now() - state.lastLoadedAt < REFRESH_DEDUPE_MS) {
      return state.balance
    }
    if (inFlight) return inFlight

    set({ loading: true, error: false })
    inFlight = fetchBalance()
      .then(balance => {
        if (Number.isFinite(balance)) {
          const loadedAt = Date.now()
          writeCachedCreditBalance(balance, loadedAt)
          set({ balance, lastLoadedAt: loadedAt, loading: false, error: false })
          return balance
        }
        set({ loading: false, error: true })
        return get().balance
      })
      .catch(() => {
        set({ loading: false, error: true })
        return get().balance
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  },
}))

export function ensureCreditBalanceEvents() {
  if (subscribed) return
  subscribed = true
  const refresh = () => {
    void useCreditBalanceStore.getState().refresh(true)
  }
  eventStream.on('payment_success', refresh)
  eventStream.on('task_complete', refresh)
  // Membership quota updates and pay-as-you-go updates share this event name.
  // Re-read the permanent wallet instead of accepting an untyped balance value.
  eventStream.on('balance_update', refresh)
  if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_CHANGED_EVENT, () => {
      const cached = auth.isExternalComputeUser() ? null : readCachedCreditBalance()
      useCreditBalanceStore.setState({
        balance: cached?.balance ?? null,
        loading: false,
        error: false,
        lastLoadedAt: cached?.loadedAt ?? 0,
      })
      void useCreditBalanceStore.getState().refresh(true)
    })
  }
}
