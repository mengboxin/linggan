import { create } from 'zustand'
import { getElectronAPI, isElectron, type DesktopUpdateState } from './electron'

const DEFAULT_RELEASE_NOTES = [
  '优化桌面端启动、更新下载和窗口展示体验。',
  '修复部分打包环境下启动页图标不显示的问题。',
  '手动检查更新时，如果远端是同版本覆盖包，会提供安装包下载入口。',
]

let initialized = false
let unsubscribeAll: (() => void) | null = null

function normalizeReleaseNotes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
  }
  return []
}

function mergeUpdateState(previous: DesktopUpdateState, incoming: DesktopUpdateState): DesktopUpdateState {
  const notes = normalizeReleaseNotes(incoming.releaseNotes)
  return {
    ...previous,
    ...incoming,
    releaseNotes: notes.length ? notes : previous.releaseNotes || DEFAULT_RELEASE_NOTES,
    progress: incoming.progress === undefined ? previous.progress : incoming.progress,
  }
}

interface DesktopUpdateStore {
  state: DesktopUpdateState
  dialogOpen: boolean
  minimized: boolean
  acknowledgedVersion: string
  changelogOnly: boolean
  appVersion: string
  applyState: (state: DesktopUpdateState, options?: { openDialog?: boolean; changelogOnly?: boolean }) => void
  openDialog: () => void
  minimizeDialog: () => void
  acknowledge: () => void
  checkNow: () => Promise<void>
  install: () => void
  openDownload: () => void
  setAppVersion: (version: string) => void
}

export const useDesktopUpdateStore = create<DesktopUpdateStore>((set, get) => ({
  state: {
    status: 'idle',
    releaseNotes: DEFAULT_RELEASE_NOTES,
    progress: null,
  },
  dialogOpen: false,
  minimized: false,
  acknowledgedVersion: '',
  changelogOnly: false,
  appVersion: '',

  applyState: (nextState, options = {}) => {
    set(current => {
      const state = mergeUpdateState(current.state, nextState)
      const dialogStatus = state.status === 'ready' || state.status === 'manual-download'
      const version = state.version || current.state.version || current.appVersion || ''
      const openDialog = options.openDialog ?? (dialogStatus && current.acknowledgedVersion !== version)
      return {
        state,
        dialogOpen: openDialog ? true : current.dialogOpen,
        minimized: openDialog ? false : current.minimized,
        changelogOnly: options.changelogOnly ?? current.changelogOnly,
      }
    })
  },

  openDialog: () => set({ dialogOpen: true, minimized: false }),
  minimizeDialog: () => set({ dialogOpen: false, minimized: true }),
  acknowledge: () => set(current => ({
    dialogOpen: false,
    minimized: true,
    acknowledgedVersion: current.state.version || current.appVersion || '',
  })),
  checkNow: async () => {
    const api = getElectronAPI()
    if (!api) return
    get().applyState({ status: 'checking', error: '' })
    const res = await api.checkForUpdates?.()
    if (res?.state) get().applyState(res.state)
    if (res && !res.ok) get().applyState({ status: 'error', error: res.error || '检查更新失败' })
  },
  install: () => {
    getElectronAPI()?.installUpdate?.()
  },
  openDownload: () => {
    void getElectronAPI()?.openUpdateDownload?.()
  },
  setAppVersion: (version) => set({ appVersion: version }),
}))

export function ensureDesktopUpdateEvents() {
  if (initialized || !isElectron()) return
  initialized = true
  const api = getElectronAPI()
  if (!api) return
  const store = useDesktopUpdateStore.getState()
  const unsubs: Array<(() => void) | undefined> = []

  api.getVersion?.()
    .then(version => {
      if (!version) return
      useDesktopUpdateStore.getState().setAppVersion(version)
      const lastSeenVersion = localStorage.getItem('lastSeenVersion')
      if (lastSeenVersion && lastSeenVersion !== version) {
        useDesktopUpdateStore.getState().applyState(
          { status: 'ready', version, releaseNotes: DEFAULT_RELEASE_NOTES, progress: { percent: 100 } },
          { openDialog: true, changelogOnly: true },
        )
      }
      localStorage.setItem('lastSeenVersion', version)
    })
    .catch(() => {})

  api.getUpdateState?.()
    .then(state => {
      if (state) useDesktopUpdateStore.getState().applyState(state)
    })
    .catch(() => {})

  unsubs.push(api.onUpdateState?.(state => {
    useDesktopUpdateStore.getState().applyState(state)
  }))
  unsubs.push(api.onUpdateChecking?.(state => {
    useDesktopUpdateStore.getState().applyState({ ...state, status: 'checking' })
  }))
  unsubs.push(api.onUpdateAvailable?.(info => {
    useDesktopUpdateStore.getState().applyState({ ...info, status: 'downloading', progress: { percent: 0 } })
  }))
  unsubs.push(api.onUpdateProgress?.(progress => {
    useDesktopUpdateStore.getState().applyState({ status: 'downloading', progress })
  }))
  unsubs.push(api.onUpdateReady?.(info => {
    useDesktopUpdateStore.getState().applyState(
      { ...info, status: 'ready', progress: { percent: 100 } },
      { openDialog: true, changelogOnly: false },
    )
  }))
  unsubs.push(api.onUpdateNotAvailable?.(state => {
    useDesktopUpdateStore.getState().applyState({ ...state, status: 'not-available' })
  }))
  unsubs.push(api.onUpdateError?.(state => {
    useDesktopUpdateStore.getState().applyState({ ...state, status: 'error' })
  }))

  unsubscribeAll = () => unsubs.forEach(unsub => unsub?.())
  void store
}

export function cleanupDesktopUpdateEvents() {
  unsubscribeAll?.()
  unsubscribeAll = null
  initialized = false
}

export function desktopUpdateNotes(notes: unknown) {
  const normalized = normalizeReleaseNotes(notes)
  return normalized.length ? normalized : DEFAULT_RELEASE_NOTES
}
