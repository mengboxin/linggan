import { create } from 'zustand'

export const TOPBAR_PINNED_STORAGE_KEY = 'linggan.topbar-pinned.v1'
export const TOPBAR_COLLAPSED_EVENT = 'linggan:topbar-collapsed'

function readPinnedPreference() {
  if (typeof window === 'undefined') return true
  try {
    const stored = window.localStorage.getItem(TOPBAR_PINNED_STORAGE_KEY)
    if (stored === null) return true
    return stored !== 'false'
  } catch {
    return true
  }
}

function reflectPinnedPreference(pinned: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.topbarPinned = String(pinned)
}

function persistPinnedPreference(pinned: boolean) {
  try {
    window.localStorage.setItem(TOPBAR_PINNED_STORAGE_KEY, String(pinned))
  } catch {
    // A blocked storage backend must not prevent the top bar from working.
  }
}

type TopbarPreferenceState = {
  pinned: boolean
  setPinned: (pinned: boolean) => void
  togglePinned: () => void
  syncFromStorage: () => void
}

const initialPinned = readPinnedPreference()
reflectPinnedPreference(initialPinned)

export const useTopbarPreferenceStore = create<TopbarPreferenceState>((set, get) => ({
  pinned: initialPinned,
  setPinned: pinned => {
    persistPinnedPreference(pinned)
    reflectPinnedPreference(pinned)
    set({ pinned })
  },
  togglePinned: () => get().setPinned(!get().pinned),
  syncFromStorage: () => {
    const pinned = readPinnedPreference()
    reflectPinnedPreference(pinned)
    set({ pinned })
  },
}))

export function resetTopbarPreferenceForTests() {
  try {
    window.localStorage.removeItem(TOPBAR_PINNED_STORAGE_KEY)
  } catch {
    // Test environments can provide an intentionally unavailable localStorage.
  }
  reflectPinnedPreference(true)
  useTopbarPreferenceStore.setState({ pinned: true })
}
