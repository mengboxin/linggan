import { create } from 'zustand'
import { AUTH_CHANGED_EVENT, apiUrl, auth } from './auth'
import { getPetById } from './pet-catalog'

export type PetMode = 'idle' | 'working' | 'celebrating' | 'thinking' | 'sad'

interface PetState {
  visible: boolean
  closing: boolean // 正在等待关闭确认中，防止重复触发
  petMode: PetMode
  taskLabel: string
  selectedPetId: string | null
  customName: string
  setVisible: (v: boolean) => void
  toggleVisible: () => void
  setClosing: (v: boolean) => void
  setPetMode: (mode: PetMode, taskLabel?: string) => void
  setSelectedPetId: (id: string | null) => void
  setCustomName: (name: string) => void
  applyAccountPreference: () => void
}

const STORAGE_KEY = 'img-edit-selected-pet'
const CUSTOM_NAME_KEY = 'img-edit-pet-custom-name'
const PET_VISIBLE_KEY = 'img-edit-pet-visible'
export const DEFAULT_PET_ID = 'xueying-wawa'
let lastDesktopPetSignature = ''

function loadSelectedPet(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return stored
    localStorage.setItem(STORAGE_KEY, DEFAULT_PET_ID)
    return DEFAULT_PET_ID
  } catch {
    return DEFAULT_PET_ID
  }
}

function saveSelectedPet(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {}
}

function loadCustomName(): string {
  try {
    return localStorage.getItem(CUSTOM_NAME_KEY) || ''
  } catch {
    return ''
  }
}

function saveCustomName(name: string) {
  try {
    if (name) {
      localStorage.setItem(CUSTOM_NAME_KEY, name)
    } else {
      localStorage.removeItem(CUSTOM_NAME_KEY)
    }
  } catch {}
}

function loadPetVisible(): boolean {
  try {
    return localStorage.getItem(PET_VISIBLE_KEY) === 'true'
  } catch {
    return false
  }
}

function savePetVisible(v: boolean) {
  try {
    localStorage.setItem(PET_VISIBLE_KEY, String(v))
  } catch {}
}

function sendPetToDesktop(id: string | null, customName?: string) {
  const api = (window as any).electronAPI
  if (!api?.petSetPet) return
  let payload: { petId: string | null; spritesheetUrl: string | null; petName: string | null; petTags: string[] | null }
  if (id) {
    const pet = getPetById(id)
    if (pet) {
      payload = { petId: pet.id, spritesheetUrl: pet.spritesheetUrl, petName: customName || pet.name, petTags: pet.tags }
    } else {
      return
    }
  } else {
    payload = { petId: null, spritesheetUrl: null, petName: null, petTags: null }
  }
  const signature = JSON.stringify(payload)
  if (signature === lastDesktopPetSignature) return
  lastDesktopPetSignature = signature
  api.petSetPet(payload)
}

function normalizePetId(id: string | null | undefined): string | null {
  if (!id) return null
  return getPetById(id) ? id : null
}

function trimCustomName(name: string | null | undefined): string {
  return (name || '').trim().slice(0, 50)
}

let persistTimer: number | null = null
let persistInFlight: Promise<void> | null = null

function schedulePersistPetPreference(id: string | null, customName: string, delay = 320) {
  if (typeof window === 'undefined' || !auth.isLoggedIn()) return
  if (persistTimer) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    void persistPetPreference(id, customName)
  }, delay)
}

async function persistPetPreference(id: string | null, customName: string) {
  if (!auth.isLoggedIn()) return
  persistInFlight = auth.fetchWithAuth(apiUrl('/api/auth/pet-preference'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pet_id: normalizePetId(id),
      pet_custom_name: trimCustomName(customName),
    }),
  })
    .then(async response => {
      if (!response.ok) return
      const payload = await response.json().catch(() => null)
      const user = payload?.user
      if (user && typeof user === 'object') {
        auth.updateUser({
          petId: String(user.petId ?? user.pet_id ?? ''),
          petCustomName: String(user.petCustomName ?? user.pet_custom_name ?? ''),
        })
      }
    })
    .catch(() => {})
    .finally(() => {
      persistInFlight = null
    })
  await persistInFlight
}

function applyAccountPreferenceToStore() {
  const user = auth.getUser()
  const state = usePetStore.getState()
  if (!user) {
    sendPetToDesktop(state.selectedPetId, state.customName)
    return
  }

  const serverPetId = normalizePetId(user.petId)
  const serverCustomName = trimCustomName(user.petCustomName)
  if (serverPetId) {
    saveSelectedPet(serverPetId)
    saveCustomName(serverCustomName)
    sendPetToDesktop(serverPetId, serverCustomName)
    usePetStore.setState({ selectedPetId: serverPetId, customName: serverCustomName })
    return
  }

  const localPetId = normalizePetId(state.selectedPetId)
  if (localPetId && !persistInFlight) {
    schedulePersistPetPreference(localPetId, state.customName, 0)
  }
  sendPetToDesktop(localPetId, state.customName)
}

export const usePetStore = create<PetState>((set) => ({
  visible: loadPetVisible(),
  closing: false,
  petMode: 'idle',
  taskLabel: '',
  selectedPetId: loadSelectedPet(),
  customName: loadCustomName(),
  setVisible: (v) => { savePetVisible(v); set({ visible: v }) },
  toggleVisible: () => set((s) => { const next = !s.visible; savePetVisible(next); return { visible: next } }),
  setClosing: (v) => set({ closing: v }),
  setPetMode: (mode, taskLabel) => set({ petMode: mode, taskLabel: taskLabel ?? '' }),
  setSelectedPetId: (id) => {
    const nextId = normalizePetId(id)
    const state = usePetStore.getState()
    saveSelectedPet(nextId)
    sendPetToDesktop(nextId, state.customName)
    schedulePersistPetPreference(nextId, state.customName)
    set({ selectedPetId: nextId })
  },
  setCustomName: (name) => {
    const nextName = trimCustomName(name)
    saveCustomName(nextName)
    const state = usePetStore.getState()
    sendPetToDesktop(state.selectedPetId, nextName)
    schedulePersistPetPreference(state.selectedPetId, nextName)
    set({ customName: nextName })
  },
  applyAccountPreference: applyAccountPreferenceToStore,
}))

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_CHANGED_EVENT, applyAccountPreferenceToStore)
  window.setTimeout(applyAccountPreferenceToStore, 0)
}
