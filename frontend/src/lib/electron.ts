// ─── PS Sync (UXP) 类型定义 ─────────────────────────────────────────────────
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'syncing'

export interface PropertyChangedPayload {
  platformId: string
  changes: {
    name?: string
    visible?: boolean
    opacity?: number  // 0-1
  }
}

export interface LayerUpdatedPayload {
  platformId: string
  imageBase64: string
}

export interface OrderChangedPayload {
  orderedIds: string[]  // 平台 layer ID 数组，index 0 = bottom
}

export interface LayerAddedPayload {
  name: string
  imageBase64: string
  position: number
  psLayerId: number
}

export interface LayerDeletedPayload {
  platformId: string
}

export interface PsSyncErrorPayload {
  message: string
  layerId?: string
}

export interface PsSyncStatusPayload {
  status: ConnectionStatus
  port: number
}

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'manual-download'
  | 'not-available'
  | 'error'

export interface DesktopUpdateState {
  status?: DesktopUpdateStatus
  version?: string
  releaseDate?: string
  releaseNotes?: unknown
  progress?: {
    percent?: number
    bytesPerSecond?: number
    transferred?: number
    total?: number
  } | null
  error?: string
  downloadUrl?: string
  manualDownload?: boolean
  checkedAt?: string | null
  updatedAt?: number
}

export type StorageWorkspace = 'local' | 'cloud'

export interface DesktopLocalWorkspaceResponse {
  status: number
  data?: unknown
}

export interface DesktopPetAppearance {
  surface: string
  panel: string
  control: string
  controlHover: string
  text: string
  muted: string
  border: string
  primary: string
  primaryHover: string
  primarySoft: string
  onPrimary: string
  shadow: string
}

export interface DesktopPetTaskSnapshotItem {
  id: string
  taskType: string
  moduleLabel: string
  title: string
  status: 'running' | 'waiting' | 'success' | 'failed' | 'cancelled' | 'idle'
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
  modeState: string | null
  token?: string
}

// ─── 通用类型 ────────────────────────────────────────────────────────────────
export type EditorType = 'photoshop' | 'illustrator' | 'default'

export interface EditorDetectResult {
  photoshop: boolean; illustrator: boolean
  psPath: string | null; aiPath: string | null
}

export interface FileChangedEvent {
  layerId: string; base64: string; editor: EditorType
}

export interface LocalProject {
  id: string; name: string; savedAt: number
}

export interface ElectronAPI {
  // 外部编辑器
  exportAndOpen: (p: {
    layerId: string; layerName: string; base64: string; index: number; editor: EditorType
  }) => Promise<{ ok: boolean; filePath?: string; fileName?: string; watchDir?: string; editor?: EditorType; method?: string; error?: string }>

  watchFile: (p: {
    layerId: string; filePath: string; watchDir?: string; fileBaseName?: string; editor: EditorType
  }) => Promise<{ ok: boolean }>

  unwatchFile:     (p: { layerId: string; editor: EditorType }) => Promise<{ ok: boolean }>
  exportAllLayers: (p: { layers: Array<{ layerId: string; layerName: string; base64: string }>; editor: EditorType }) => Promise<{ ok: boolean; cancelled?: boolean; dir?: string; exported?: Array<{ layerId: string; filePath: string; fileName: string }> }>
  exportAllAndWatch: (p: { layers: Array<{ layerId: string; layerName: string; base64: string }>; editor: EditorType }) => Promise<{ ok: boolean; error?: string; tmpDir?: string; exported?: Array<{ layerId: string; filePath: string; fileName: string }>; opened?: number }>
  unwatchAll:      (p: { editor: EditorType }) => Promise<{ ok: boolean }>
  detectEditors:   () => Promise<EditorDetectResult>
  onFileChanged:   (cb: (d: FileChangedEvent) => void) => () => void

  // 本地项目
  saveProject:     (p: { projectId: string; name: string; data: unknown }) => Promise<{ ok: boolean; filePath?: string }>
  loadProject:     (p: { projectId: string }) => Promise<{ ok: boolean; data?: unknown; name?: string; savedAt?: number; error?: string }>
  listProjects:    () => Promise<LocalProject[]>
  deleteProject:   (p: { projectId: string }) => Promise<{ ok: boolean }>
  saveProjectAs:   (p: { name: string; data: unknown }) => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string; projectId?: string }>
  openProjectFile: () => Promise<{ ok: boolean; cancelled?: boolean; data?: unknown; name?: string; id?: string }>

  // 剪贴板
  readClipboardImage:  () => Promise<{ ok: boolean; base64?: string }>
  writeClipboardImage: (p: { base64: string }) => Promise<{ ok: boolean }>
  onClipboardPaste:    (cb: (d: { base64: string }) => void) => () => void

  // 批处理
  selectBatchFolder: () => Promise<{ ok: boolean; cancelled?: boolean; dir?: string; files?: Array<{ name: string; path: string }> }>
  readBatchImage:    (p: { filePath: string }) => Promise<{ ok: boolean; base64?: string; name?: string }>
  saveBatchResult:   (p: { originalPath: string; layers: Array<{ name: string; base64: string }> }) => Promise<{ ok: boolean; outDir?: string }>

  // 文件打开
  onOpenFile: (cb: (d: { filePath: string }) => void) => () => void

  // 自动更新
  onUpdateReady:      (cb: (info: { version?: string; releaseNotes?: unknown }) => void) => () => void
  onUpdateAvailable:  (cb: (info: { version?: string; releaseDate?: string; releaseNotes?: unknown }) => void) => () => void
  onUpdateProgress:   (cb: (progress: { percent: number; bytesPerSecond?: number; transferred?: number; total?: number }) => void) => () => void
  onUpdateChecking?:   (cb: (state: DesktopUpdateState) => void) => () => void
  onUpdateNotAvailable?: (cb: (state: DesktopUpdateState) => void) => () => void
  onUpdateError?:      (cb: (state: DesktopUpdateState) => void) => () => void
  onUpdateState?:      (cb: (state: DesktopUpdateState) => void) => () => void
  getUpdateState?:     () => Promise<DesktopUpdateState>
  installUpdate:      () => Promise<void>
  checkForUpdates:    () => Promise<{ ok: boolean; updateInfo?: { version?: string } | null; error?: string; state?: DesktopUpdateState }>
  openUpdateDownload?: () => Promise<{ ok: boolean; error?: string }>

  // 配置
  getVersion:   () => Promise<string>
  getServerUrl: () => Promise<string>
  setServerUrl: (url: string) => Promise<{ ok: boolean }>

  // 本地图片存储
  getStorageDir:    () => Promise<string>
  chooseStorageDir: () => Promise<{ ok: boolean; cancelled?: boolean; dir?: string }>
  saveImageLocal:   (p: { base64: string; filename?: string; subdir?: string; workspaceLocal?: boolean; userId?: string }) => Promise<{ ok: boolean; filePath?: string; fileUrl?: string; dir?: string; error?: string }>
  saveRemoteImageLocal?: (p: { url: string; filename?: string; subdir?: string; userId?: string; token?: string | null }) => Promise<{ ok: boolean; filePath?: string; fileUrl?: string; dir?: string; error?: string }>
  readImageLocal:   (p: { filePath: string }) => Promise<{ ok: boolean; base64?: string; dataUrl?: string; fileUrl?: string; error?: string }>
  openStorageDir:   (subdir?: string) => Promise<{ ok: boolean }>
  getStorageWorkspace?: () => Promise<StorageWorkspace>
  setStorageWorkspace?: (workspace: StorageWorkspace) => Promise<{ ok: boolean; workspace: StorageWorkspace }>
  openLocalWorkspaceDir?: (p?: { userId?: string }) => Promise<{ ok: boolean; dir?: string; error?: string }>
  requestLocalWorkspace?: (p: { userId: string; path: string; method: string; body?: string }) => Promise<DesktopLocalWorkspaceResponse>
  onStorageWorkspaceChanged?: (cb: (workspace: StorageWorkspace) => void) => () => void
  listLocalPresentationUploads: () => Promise<{ ok: boolean; items?: unknown[]; error?: string }>
  getLocalPresentationUpload: (p: { uploadId: string }) => Promise<{ ok: boolean; deck?: unknown; error?: string }>
  uploadLocalPresentation: (p?: { allowCloudFallback?: boolean; token?: string | null }) => Promise<{ ok: boolean; cancelled?: boolean; usedCloud?: boolean; deck?: unknown; record?: unknown; code?: string; error?: string }>
  getPresentationOfficeStatus?: () => Promise<{ ok: boolean; path?: string; message?: string }>
  choosePresentationOffice?: () => Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }>

  // 实时协作（仅客户端）
  collabConnect:    (p: { sessionId: string; token: string }) => Promise<{ ok: boolean; reused?: boolean; error?: string }>
  collabSend:       (p: { sessionId: string; message: unknown }) => Promise<{ ok: boolean; error?: string }>
  collabDisconnect: (p: { sessionId: string }) => Promise<{ ok: boolean }>
  collabStatus:     (p: { sessionId: string }) => Promise<{ connected: boolean; state: string }>
  onCollabMessage:      (cb: (d: { sessionId: string; data: string }) => void) => () => void
  onCollabDisconnected: (cb: (d: { sessionId: string; code: number; reason: string }) => void) => () => void

  // 关闭对话框
  onShowCloseDialog: (cb: () => void) => () => void
  closeDialogChoice: (p: { choice: 'minimize' | 'quit'; remember: boolean }) => Promise<{ ok: boolean }>

  // 桌宠
  petToggle:     (p: { visible: boolean }) => Promise<{ ok: boolean }>
  petSetState:   (p: { state: string; taskLabel?: string; text?: string; duration?: number; token?: string; lineKey?: string; progress?: number }) => Promise<{ ok: boolean }>
  petSyncTasks:  (p: DesktopPetTaskSnapshot) => Promise<{ ok: boolean }>
  petSetTheme:   (p: { theme: string; appearance: DesktopPetAppearance }) => Promise<{ ok: boolean }>
  petGetVisible: () => Promise<boolean>
  petSetPet:     (p: { petId: string | null; spritesheetUrl: string | null; petName: string | null; petTags?: string[] | null }) => Promise<{ ok: boolean }>
  petGetPet:     () => Promise<{ id: string; spritesheetUrl: string; petName: string } | null>
  petSay:        (p: { text: string; duration?: number; token?: string }) => Promise<{ ok: boolean }>
  onPetVisibleChange: (cb: (visible: boolean) => void) => () => void

  // 拖拽喂食
  feedFile: (filePath: string) => Promise<{ ok: boolean; fileName?: string; isDir?: boolean; error?: string }>

  // PS Sync (UXP)
  psSyncPush:           (p: Array<{ layerId: string; layerName: string; base64: string; visible: boolean; opacity: number }>) => Promise<{ ok: boolean; error?: string }>
  psSyncDisconnect:     () => Promise<{ ok: boolean }>
  psSyncGetStatus:      () => Promise<PsSyncStatusPayload>
  psSyncUpdateProperty: (p: PropertyChangedPayload) => Promise<{ ok: boolean }>
  psSyncUpdateOrder:    (p: { orderedIds: string[] }) => Promise<{ ok: boolean }>
  psSyncAddLayer:       (p: { layerId: string; layerName: string; base64: string; position: number }) => Promise<{ ok: boolean }>
  psSyncDeleteLayer:    (p: { platformId: string }) => Promise<{ ok: boolean }>
  onPsSyncStatusChanged:   (cb: (status: ConnectionStatus) => void) => () => void
  onPsSyncLayerUpdated:    (cb: (data: LayerUpdatedPayload) => void) => () => void
  onPsSyncPropertyChanged: (cb: (data: PropertyChangedPayload) => void) => () => void
  onPsSyncOrderChanged:    (cb: (data: OrderChangedPayload) => void) => () => void
  onPsSyncLayerAdded:      (cb: (data: LayerAddedPayload) => void) => () => void
  onPsSyncLayerDeleted:    (cb: (data: LayerDeletedPayload) => void) => () => void
  onPsSyncError:           (cb: (data: PsSyncErrorPayload) => void) => () => void

  // PS 插件安装
  psPluginInstall:        () => Promise<{ ok: boolean; error?: string }>
  psPluginCheckInstalled: () => Promise<{ installed: boolean; path?: string }>

  // 文件下载（PPTX / 图片）
  downloadFile: (p: { data: string; filename: string; mimeType?: string }) => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string; error?: string }>
  // Task notifications
  notifyTask: (p: {
    taskType: string
    status: 'success' | 'failed'
    title: string
    body: string
    targetMode?: string
  }) => Promise<{ ok: boolean }>
  onTaskNotificationClick: (cb: (d: { taskType: string; targetMode?: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    __LG_API_BASE__?: string
    __LG_CONFIG__?: {
      apiBase: string
      storageWorkspace?: StorageWorkspace
    }
  }
}

export const isElectron = (): boolean =>
  typeof window !== 'undefined' && !!window.electronAPI

export const getElectronAPI = (): ElectronAPI | null =>
  window.electronAPI ?? null
