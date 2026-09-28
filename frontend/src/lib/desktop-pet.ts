import type { EditorMode } from './editor-store'
import type { RegisteredTaskStatus } from './task-registry'
import type { TaskType } from './task-toast-store'
import { resolveAppearanceTokens, type AppearancePreferences } from './theme'

export type DesktopPetModeState =
  | 'mode_image'
  | 'mode_layer'
  | 'mode_ppt'
  | 'mode_presentation'
  | 'mode_scifig'
  | 'mode_poster'
  | 'mode_paper'
  | 'mode_prompt'
  | 'mode_gallery'
  | 'mode_canvas'
  | 'mode_profile'
  | 'mode_billing'
  | 'mode_models'
  | 'mode_download'
  | 'mode_plugin'

export interface DesktopPetTaskSnapshotItem {
  id: string
  taskType: TaskType
  moduleLabel: string
  title: string
  status: RegisteredTaskStatus
  progress?: number
  stageLabel?: string
  stageDetail?: string
  message?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  groupId?: string
  parentTaskId?: string
  targetPath?: string
}

export interface DesktopPetTaskSnapshot {
  state: 'task_snapshot'
  tasks: DesktopPetTaskSnapshotItem[]
  activeTaskId?: string
  activeCount: number
  modeState: DesktopPetModeState | null
  token?: string
}

const EDITOR_MODE_STATES: Record<EditorMode, DesktopPetModeState> = {
  TEXT_TO_IMAGE: 'mode_image',
  IMAGE_EDIT: 'mode_layer',
  PPT_GEN: 'mode_ppt',
  SCI_FIG: 'mode_scifig',
  POSTER_GEN: 'mode_poster',
  PAPER_GEN: 'mode_paper',
}

const ROUTE_STATES: Array<[prefix: string, state: DesktopPetModeState]> = [
  ['/text-to-image', 'mode_image'],
  ['/image-edit', 'mode_layer'],
  ['/presentations', 'mode_presentation'],
  ['/ppt', 'mode_ppt'],
  ['/scientific-figure', 'mode_scifig'],
  ['/poster', 'mode_poster'],
  ['/paper-lab', 'mode_paper'],
  ['/image-to-prompt', 'mode_prompt'],
  ['/gallery', 'mode_gallery'],
  ['/canvas-flow', 'mode_canvas'],
  ['/profile', 'mode_profile'],
  ['/recharge', 'mode_billing'],
  ['/models', 'mode_models'],
  ['/download', 'mode_download'],
  ['/ps-plugin-setup', 'mode_plugin'],
]

export function desktopPetStateForRoute(pathname: string, editorMode: EditorMode): DesktopPetModeState | null {
  const routeState = ROUTE_STATES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1]
  if (routeState) return routeState
  return pathname === '/editor' ? EDITOR_MODE_STATES[editorMode] : null
}

export function desktopPetAppearance(preferences: AppearancePreferences) {
  const tokens = resolveAppearanceTokens(preferences)
  return {
    theme: preferences.theme,
    appearance: {
      surface: tokens.glassStrong,
      panel: tokens.panel,
      control: tokens.control,
      controlHover: tokens.controlHover,
      text: tokens.text,
      muted: tokens.muted,
      border: tokens.borderStrong,
      primary: tokens.primary,
      primaryHover: tokens.primaryHover,
      primarySoft: tokens.primarySoft,
      onPrimary: tokens.onPrimary,
      shadow: tokens.shadowRaised,
    },
  }
}

export interface DesktopPetBridgeApi {
  petSetTheme?: (payload: ReturnType<typeof desktopPetAppearance>) => Promise<{ ok: boolean }>
  petSetState?: (payload: { state: string; token?: string }) => Promise<{ ok: boolean }>
  petSyncTasks?: (payload: DesktopPetTaskSnapshot) => Promise<{ ok: boolean }>
  petGetVisible?: () => Promise<boolean>
  petToggle?: (payload: { visible: boolean }) => Promise<{ ok: boolean }>
  petGetPet?: () => Promise<{ id: string; spritesheetUrl: string; petName: string } | null>
  onPetVisibleChange?: (callback: (visible: boolean) => void) => () => void
}

export function syncDesktopPetTasks(
  api: DesktopPetBridgeApi | undefined,
  snapshot: DesktopPetTaskSnapshot,
) {
  if (api?.petSyncTasks) return api.petSyncTasks(snapshot)
  if (snapshot.activeCount === 0) return syncDesktopPetMode(api, snapshot.modeState, snapshot.token)
}

export function syncDesktopPetAppearance(api: DesktopPetBridgeApi | undefined, preferences: AppearancePreferences) {
  return api?.petSetTheme?.(desktopPetAppearance(preferences))
}

export function syncDesktopPetMode(
  api: DesktopPetBridgeApi | undefined,
  state: DesktopPetModeState | null,
  token?: string,
) {
  if (!state) return
  return api?.petSetState?.({ state, ...(token ? { token } : {}) })
}
