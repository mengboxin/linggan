import { create } from 'zustand'

import { AUTH_CHANGED_EVENT, auth } from './auth'
import { eventStream } from './event-stream'
import {
  fetchMembershipWallet,
  setMembershipFundingSource,
  type FundingSource,
  type MembershipWalletSnapshot,
} from './payment'

interface MembershipWalletState {
  snapshot: MembershipWalletSnapshot | null
  loading: boolean
  switching: boolean
  error: string
  refresh: (force?: boolean) => Promise<MembershipWalletSnapshot | null>
  select: (source: FundingSource, subscriptionId?: string | null) => Promise<boolean>
}

let inFlight: Promise<MembershipWalletSnapshot | null> | null = null
let lastLoadedAt = 0
let eventsBound = false

function applySnapshot(snapshot: MembershipWalletSnapshot) {
  useMembershipWalletStore.setState({ snapshot, loading: false, error: '' })
  lastLoadedAt = Date.now()
}

export const useMembershipWalletStore = create<MembershipWalletState>((set, get) => ({
  snapshot: null,
  loading: false,
  switching: false,
  error: '',
  refresh: async (force = false) => {
    if (!auth.isLoggedIn() || auth.isExternalComputeUser()) {
      set({ snapshot: null, loading: false, switching: false, error: '' })
      return null
    }
    if (!force && get().snapshot && Date.now() - lastLoadedAt < 3000) return get().snapshot
    if (inFlight) return inFlight
    set({ loading: true, error: '' })
    inFlight = fetchMembershipWallet()
      .then(snapshot => {
        applySnapshot(snapshot)
        return snapshot
      })
      .catch(error => {
        set({ loading: false, error: error instanceof Error ? error.message : '会员钱包加载失败' })
        return get().snapshot
      })
      .finally(() => { inFlight = null })
    return inFlight
  },
  select: async (source, subscriptionId = null) => {
    set({ switching: true, error: '' })
    try {
      const snapshot = await setMembershipFundingSource(source, subscriptionId)
      applySnapshot(snapshot)
      set({ switching: false })
      return true
    } catch (error) {
      set({
        switching: false,
        error: error instanceof Error ? error.message : '扣费来源切换失败',
      })
      return false
    }
  },
}))

export function ensureMembershipWalletEvents() {
  if (eventsBound) return
  eventsBound = true
  const refresh = () => { void useMembershipWalletStore.getState().refresh(true) }
  eventStream.on('payment_success', refresh)
  eventStream.on('task_complete', refresh)
  eventStream.on('balance_update', refresh)
  if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_CHANGED_EVENT, () => {
      lastLoadedAt = 0
      useMembershipWalletStore.setState({ snapshot: null, loading: false, switching: false, error: '' })
      refresh()
    })
  }
}
