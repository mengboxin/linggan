import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { BrandWordmark } from '../ui/BrandWordmark'
import { auth, apiUrl } from '../../lib/auth'
import { useT, useI18nStore } from '../../lib/i18n'
import { useConfirm } from '../ui/ConfirmDialog'
import { useThemeStore } from '../../lib/theme'
import { assetVariantUrl, imageSrc } from '../../lib/image-url'
import {
  filterDeletedHistoryRecords,
  imageHistoryTombstoneId,
  isHistoryDeleted,
  markHistoryDeleted,
  unmarkHistoryDeleted,
} from '../../lib/history-records'
import { getElectronAPI, isElectron } from '../../lib/electron'
import {
  workspaceDataFromCloudRecords,
  type WorkspaceMirrorData,
} from '../../lib/desktop-cloud-mirror'
import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../../lib/persistent-cache'
import { getStorageWorkspace, isDesktopLocalWorkspace } from '../../lib/storage-workspace'

export interface WorkspaceProject {
  id: string
  name: string
  description?: string
  is_archived: boolean
  task_count: number
  created_at: string
  updated_at: string
}

export interface WorkspaceConversation {
  id: string
  title: string
  type: 'ppt' | 'sci-fig' | 'poster' | 'paper' | 'image'
  message_count: number
  created_at: string
  updated_at: string
  conversationId?: string
  messageId?: string
  assetId?: string
  image?: string
  imageUrl?: string
  previewUrl?: string
  thumbnailUrl?: string
  status?: string
}

export interface WorkspaceTask {
  id: string
  project_id?: string
  name: string
  source_width?: number
  source_height?: number
  status: string
  workflow_kind?: 'image_edit' | 'canvas_flow'
  meta?: {
    layers?: unknown[]
    canvas_image?: string
    preview_base64?: string
    image_url?: string
    preview_url?: string
    thumbnail_url?: string
    preview_fallback_url?: string
    thumbnail_fallback_url?: string
    thumb_url?: string
    local_image_url?: string
    workflow_snapshot?: {
      nodes?: Array<{
        imageBase64?: string
        imageUrl?: string
        previewUrl?: string
        thumbnailUrl?: string
        localImageUrl?: string
      }>
    }
    gen_cards?: Array<{
      imageBase64?: string
      imageUrl?: string
      previewUrl?: string
      thumbnailUrl?: string
      thumbnailBase64?: string
      localImageUrl?: string
    }>
    saved_at?: string
    has_snapshot?: boolean
    has_large_preview?: boolean
  }
  created_at: string
  updated_at: string
}

type WorkspaceTaskMeta = NonNullable<WorkspaceTask['meta']>
type WorkspacePreviewNode = NonNullable<NonNullable<WorkspaceTaskMeta['workflow_snapshot']>['nodes']>[number]
type WorkspacePreviewCard = NonNullable<WorkspaceTaskMeta['gen_cards']>[number]

function Icon({ name, className = 'text-[16px]', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={{ fontVariationSettings: `'FILL' ${fill ? 1 : 0}` }}
    >
      {name}
    </span>
  )
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const raw = value.trim()
      if (raw && !raw.startsWith('__idb__:') && !raw.startsWith('blob:')) return raw
    }
  }
  return ''
}

function nodePreviewValue(node?: WorkspacePreviewNode): string {
  if (!node) return ''
  return firstString(
    node.thumbnailUrl,
    node.previewUrl,
    node.imageUrl,
    node.localImageUrl,
    node.imageBase64,
  )
}

function cardPreviewValue(card?: WorkspacePreviewCard): string {
  if (!card) return ''
  return firstString(
    card.thumbnailUrl,
    card.thumbnailBase64,
    card.previewUrl,
    card.imageUrl,
    card.localImageUrl,
    card.imageBase64,
  )
}

function getTaskPreview(task: WorkspaceTask): string {
  const meta = task.meta
  if (!meta) return ''
  const nodes = meta.workflow_snapshot?.nodes ?? []
  const latestNode = [...nodes].reverse().find(node => nodePreviewValue(node))
  const cards = meta.gen_cards ?? []
  const latestCard = [...cards].reverse().find(card => cardPreviewValue(card))
  const preview = firstString(
    meta.thumbnail_url,
    meta.thumb_url,
    meta.preview_url,
    meta.image_url,
    meta.local_image_url,
    meta.preview_base64,
    meta.canvas_image,
    nodePreviewValue(latestNode),
    cardPreviewValue(latestCard),
  )
  return imageSrc(preview)
}

function getTaskPreviewFallback(task: WorkspaceTask): string {
  const meta = task.meta
  if (!meta) return ''
  return imageSrc(firstString(meta.thumbnail_fallback_url, meta.preview_fallback_url))
}

function isMobileOnlyProject(project: WorkspaceProject) {
  return project.name.trim().startsWith('移动端')
}

const COLLAPSED_CONVERSATION_LIMIT = 6
const DEFAULT_WORKFLOW_PROJECT_NAME = '图片编辑工作流'
const CLOUD_INDEX_LIMIT = 200
const IMAGE_HISTORY_INDEX_LIMIT = 100
const CLOUD_INDEX_REFRESH_MS = 30_000
const WORKSPACE_CLOUD_INDEX_CACHE_KEY = 'workspace-cloud-index-v1'

type WorkspaceTabKey = 'projects' | 'canvas-flow' | 'image' | 'conversations' | 'sci-fig' | 'poster'
type WorkspaceModuleCounts = Partial<Record<WorkspaceTabKey, number>>
type CloudIndexSourceKey = 'workspaceProjects' | 'workspaceTasks' | 'conversations' | 'conversationCounts' | 'imageHistory' | 'posterHistory' | 'sciFigHistory' | 'pptPresentations'
type CloudIndexSource = {
  key: CloudIndexSourceKey
  path: string
  optional: boolean
}

interface WorkspaceCloudIndexCache {
  records: Record<string, unknown>
  loadedAt: Partial<Record<CloudIndexSourceKey, number>>
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cacheableImageReference(value: unknown) {
  if (typeof value !== 'string') return undefined
  return /^(https?:|\/api\/)/i.test(value) ? value : undefined
}

function cacheableHistoryImageRecord(value: unknown) {
  const record = asObjectRecord(value)
  const assetId = typeof record.asset_id === 'string'
    ? record.asset_id
    : (typeof record.assetId === 'string' ? record.assetId : '')
  const original = assetVariantUrl(assetId, 'original')
  const preview = assetVariantUrl(assetId, 'preview')
  const thumb = assetVariantUrl(assetId, 'thumb')
  return {
    ...record,
    image: original || cacheableImageReference(record.image),
    thumbnail: thumb || cacheableImageReference(record.thumbnail),
    image_url: original || cacheableImageReference(record.image_url),
    imageUrl: original || cacheableImageReference(record.imageUrl),
    preview_url: preview || cacheableImageReference(record.preview_url),
    previewUrl: preview || cacheableImageReference(record.previewUrl),
    thumbnail_url: thumb || cacheableImageReference(record.thumbnail_url),
    thumbnailUrl: thumb || cacheableImageReference(record.thumbnailUrl),
  }
}

export function cacheableCloudIndexRecords(records: Record<string, unknown>) {
  const cached = { ...records }
  const taskPayload = asObjectRecord(records.workspaceTasks)
  if (Array.isArray(taskPayload.tasks)) {
    cached.workspaceTasks = {
      ...taskPayload,
      tasks: taskPayload.tasks.map(value => {
        const task = asObjectRecord(value)
        const meta = asObjectRecord(task.meta)
        const { preview_base64: _previewBase64, ...cacheableMeta } = meta
        return { ...task, meta: cacheableMeta }
      }),
    }
  }
  for (const key of ['imageHistory', 'sciFigHistory', 'posterHistory']) {
    if (Array.isArray(records[key])) {
      cached[key] = records[key].map(cacheableHistoryImageRecord)
    }
  }
  return cached
}

function loadWorkspaceCloudIndexCache(): WorkspaceCloudIndexCache {
  const cached = readPersistentCache<WorkspaceCloudIndexCache>(
    userScopedCacheKey(WORKSPACE_CLOUD_INDEX_CACHE_KEY),
    { records: {}, loadedAt: {} },
  ).value
  return {
    records: asObjectRecord(cached?.records),
    loadedAt: asObjectRecord(cached?.loadedAt) as Partial<Record<CloudIndexSourceKey, number>>,
  }
}

const CLOUD_INDEX_SOURCE_KEYS_BY_TAB: Record<WorkspaceTabKey, CloudIndexSourceKey[]> = {
  projects: ['workspaceProjects', 'workspaceTasks'],
  'canvas-flow': ['workspaceProjects', 'workspaceTasks'],
  image: ['imageHistory'],
  conversations: ['pptPresentations'],
  'sci-fig': ['sciFigHistory'],
  poster: ['posterHistory'],
}

function isCanvasFlowTask(task: WorkspaceTask) {
  return task.workflow_kind === 'canvas_flow'
}

function countLegacyWorkflowTasks(workflowTasks: WorkspaceTask[]) {
  return workflowTasks.filter(task => !isCanvasFlowTask(task)).length
}

function countCanvasFlowTasks(workflowTasks: WorkspaceTask[]) {
  return workflowTasks.filter(isCanvasFlowTask).length
}

function countConversationsByType(conversations: WorkspaceConversation[], type: WorkspaceConversation['type']) {
  return conversations.filter(conversation => conversation.type === type).length
}

function dedupeWorkflowTasks<T extends { id: string; updated_at?: string; created_at?: string }>(tasks: T[]) {
  const latestById = new Map<string, T>()
  tasks.forEach(task => {
    const id = String(task.id || '').trim()
    if (!id) return
    const existing = latestById.get(id)
    if (!existing) {
      latestById.set(id, task)
      return
    }
    const existingTime = Date.parse(existing.updated_at || existing.created_at || '')
    const nextTime = Date.parse(task.updated_at || task.created_at || '')
    if (!Number.isFinite(existingTime) || (Number.isFinite(nextTime) && nextTime >= existingTime)) {
      latestById.set(id, task)
    }
  })
  return Array.from(latestById.values())
}

function moduleCountsFromWorkspaceData(data: WorkspaceMirrorData): WorkspaceModuleCounts {
  const workflowTasks = data.workflowTasks as WorkspaceTask[]
  const conversations = data.conversations as WorkspaceConversation[]
  return {
    projects: countLegacyWorkflowTasks(workflowTasks),
    'canvas-flow': countCanvasFlowTasks(workflowTasks),
    image: countConversationsByType(conversations, 'image'),
    conversations: countConversationsByType(conversations, 'ppt'),
    'sci-fig': countConversationsByType(conversations, 'sci-fig'),
    poster: countConversationsByType(conversations, 'poster'),
  }
}

function nonNegativeCount(value: unknown): number | undefined {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined
}

function moduleCountsFromConversationCounts(value: unknown): WorkspaceModuleCounts {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const counts: WorkspaceModuleCounts = {}
  const ppt = nonNegativeCount(raw.ppt)
  const image = nonNegativeCount(raw.image)
  const sciFig = nonNegativeCount(raw['sci-fig'])
  const poster = nonNegativeCount(raw.poster)
  if (image !== undefined) counts.image = image
  if (ppt !== undefined) counts.conversations = ppt
  if (sciFig !== undefined) counts['sci-fig'] = sciFig
  if (poster !== undefined) counts.poster = poster
  return counts
}

function workflowTasksByProject<T extends { id: string; project_id?: string }>(workflowTasks: T[]) {
  return dedupeWorkflowTasks(workflowTasks).reduce<Record<string, T[]>>((grouped, task) => {
    const projectId = task.project_id || ''
    if (!projectId) return grouped
    grouped[projectId] = [...(grouped[projectId] ?? []), task]
    return grouped
  }, {})
}

function withoutDeletedWorkflowTasks(data: WorkspaceMirrorData): WorkspaceMirrorData {
  const uniqueTasks = dedupeWorkflowTasks(data.workflowTasks)
  const visibleTasks = filterDeletedHistoryRecords(
    'workspace-task',
    uniqueTasks,
    task => task.id,
  )
  if (visibleTasks.length === data.workflowTasks.length && uniqueTasks.length === data.workflowTasks.length) return data

  const deletedByProject = new Map<string, number>()
  const countedDeletedIds = new Set<string>()
  for (const task of data.workflowTasks) {
    if (!isHistoryDeleted('workspace-task', task.id) || countedDeletedIds.has(task.id)) continue
    countedDeletedIds.add(task.id)
    const projectId = task.project_id || ''
    if (projectId) deletedByProject.set(projectId, (deletedByProject.get(projectId) ?? 0) + 1)
  }

  return {
    ...data,
    projects: data.projects.map(project => ({
      ...project,
      task_count: Math.max(0, project.task_count - (deletedByProject.get(project.id) ?? 0)),
    })),
    workflowTasks: visibleTasks,
    tasksByProject: workflowTasksByProject(visibleTasks),
  }
}

function removeWorkflowTaskFromCloudRecords(
  records: Record<string, unknown>,
  projectId: string,
  taskId: string,
) {
  const next = { ...records }
  const taskPayload = asObjectRecord(records.workspaceTasks)
  if (Array.isArray(taskPayload.tasks)) {
    next.workspaceTasks = {
      ...taskPayload,
      tasks: taskPayload.tasks.filter(value => String(asObjectRecord(value).id || '') !== taskId),
    }
  }

  const projectPayload = asObjectRecord(records.workspaceProjects)
  if (Array.isArray(projectPayload.projects)) {
    next.workspaceProjects = {
      ...projectPayload,
      projects: projectPayload.projects.map(value => {
        const project = asObjectRecord(value)
        if (String(project.id || '') !== projectId) return value
        return {
          ...project,
          task_count: Math.max(0, Number(project.task_count || 0) - 1),
        }
      }),
    }
  }
  return next
}

function restoreWorkflowTaskToCloudRecords(
  records: Record<string, unknown>,
  projectId: string,
  task: WorkspaceTask,
) {
  const next = { ...records }
  const taskPayload = asObjectRecord(records.workspaceTasks)
  const cachedTasks = Array.isArray(taskPayload.tasks) ? taskPayload.tasks : []
  const taskWasMissing = !cachedTasks.some(value => String(asObjectRecord(value).id || '') === task.id)
  if (taskWasMissing) {
    next.workspaceTasks = { ...taskPayload, tasks: [task, ...cachedTasks] }
  }

  const projectPayload = asObjectRecord(records.workspaceProjects)
  if (Array.isArray(projectPayload.projects)) {
    next.workspaceProjects = {
      ...projectPayload,
      projects: projectPayload.projects.map(value => {
        const project = asObjectRecord(value)
        if (String(project.id || '') !== projectId) return value
        return taskWasMissing ? {
          ...project,
          task_count: Math.max(0, Number(project.task_count || 0)) + 1,
        } : value
      }),
    }
  }
  return next
}

type WorkflowGroupKey = 'two-days' | 'week' | 'month' | 'older'
type WorkflowTaskGroup = {
  key: WorkflowGroupKey
  label: string
  items: WorkspaceTask[]
  defaultCollapsed: boolean
}

function normalizeWorkspaceName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function workflowNameExists(rawName: string, tasks: WorkspaceTask[], excludeTaskId?: string) {
  const normalized = normalizeWorkspaceName(rawName)
  return tasks.some(task => task.id !== excludeTaskId && normalizeWorkspaceName(task.name) === normalized)
}

function nextWorkflowTaskName(tasks: WorkspaceTask[], lang: string) {
  const prefix = lang === 'zh' ? '工作流' : 'Workflow'
  const pattern = lang === 'zh' ? /^工作流\s+(\d+)$/ : /^Workflow\s+(\d+)$/i
  const used = new Set<number>()
  for (const task of tasks) {
    const match = task.name.trim().match(pattern)
    if (match) used.add(Number(match[1]))
  }
  let index = 1
  while (used.has(index)) index += 1
  return `${prefix} ${index}`
}

function TaskPreviewThumb({ src, fallbackSrc, fallbackColor, isDark }: { src: string; fallbackSrc?: string; fallbackColor: string; isDark: boolean }) {
  const [sourceIndex, setSourceIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const activeSrc = (sourceIndex === 0 ? src : fallbackSrc) || fallbackSrc || ''
  useEffect(() => {
    setSourceIndex(0)
    setFailed(false)
    setLoaded(false)
  }, [fallbackSrc, src])

  const iconColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(132,116,99,0.58)'

  if (!activeSrc || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center" style={{ background: fallbackColor, color: iconColor }}>
        <Icon name="image" className="text-[14px]" />
      </div>
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: fallbackColor }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ color: iconColor }}>
          <Icon name="image" className="text-[14px]" />
        </div>
      )}
      <img
        src={activeSrc}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        className="h-full w-full object-cover transition-opacity duration-150"
        style={{ opacity: loaded ? 1 : 0 }}
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (sourceIndex === 0 && src && fallbackSrc && fallbackSrc !== src) {
            setSourceIndex(1)
            setLoaded(false)
            return
          }
          setFailed(true)
        }}
      />
    </div>
  )
}

type WorkspaceTaskSnapshot = { layers: unknown[]; canvasImage?: string; workflowSnapshot?: unknown; gen_cards?: unknown[]; workspaceState?: unknown }
type CreatedWorkflowTask = { projectId: string; taskId: string; taskName: string }
type WorkflowTaskCreation = { intent: string; promise: Promise<CreatedWorkflowTask | null> }

interface WorkspaceDrawerProps {
  currentTaskId?: string | null
  initialTab?: WorkspaceTabKey
  /** Canvas-flow history belongs to the dedicated free-canvas surface. */
  hideCanvasFlowTab?: boolean
  onLoadTask: (task: WorkspaceTask, snapshot: WorkspaceTaskSnapshot) => void
  onLoadCanvasFlowTask?: (task: WorkspaceTask, snapshot: WorkspaceTaskSnapshot) => void
  onNewTask: (projectId: string, taskId: string, taskName: string) => void
  onOpenConversation?: (conversation: WorkspaceConversation) => void
  onTaskDeleted?: (projectId: string, taskId: string) => void
  onTaskRenamed?: (projectId: string, taskId: string, name: string) => void
  onRef?: (api: {
    createWorkflowTask: (workflowName: string, creationKey?: string) => Promise<{ projectId: string; taskId: string; taskName: string } | null>
    discardWorkflowTask: (taskId: string) => Promise<void>
    getWorkflowTasks: () => WorkspaceTask[]
    openProjects: () => void
  }) => void
}

async function apiFetch(path: string, init?: RequestInit) {
  return auth.fetchWithAuth(apiUrl(path), init)
}

function mirroredTaskSnapshotPayload(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const raw = snapshot as Record<string, unknown>
  return {
    layers: Array.isArray(raw.layers) ? raw.layers : [],
    canvasImage: typeof raw.canvas_image === 'string' ? raw.canvas_image : undefined,
    workflowSnapshot: raw.workflow_snapshot ?? null,
    gen_cards: Array.isArray(raw.gen_cards) ? raw.gen_cards : [],
    workspaceState: raw.workspace_state ?? null,
  }
}

export function WorkspaceDrawer({
  currentTaskId,
  initialTab = 'projects',
  hideCanvasFlowTab = false,
  onLoadTask,
  onLoadCanvasFlowTask,
  onNewTask,
  onOpenConversation,
  onTaskDeleted,
  onTaskRenamed,
  onRef,
}: WorkspaceDrawerProps) {
  const navigate = useNavigate()
  const T = useT()
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const brandMarkSrc = '/linggan-mark.svg?v=20260811-centered'
  const { confirmDialog, confirm } = useConfirm()
  const [initialCloudIndex] = useState(loadWorkspaceCloudIndexCache)
  const [initialCloudData] = useState(() => withoutDeletedWorkflowTasks(
    workspaceDataFromCloudRecords(initialCloudIndex.records),
  ))
  const initialVisibleConversations = useMemo(() => filterDeletedHistoryRecords(
    'conversation',
    filterDeletedHistoryRecords(
      'image-message',
      initialCloudData.conversations as WorkspaceConversation[],
      conversation => imageHistoryTombstoneId(conversation),
    ),
    conversation => conversation.conversationId || conversation.id,
  ), [initialCloudData.conversations])
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTabKey>(() => (
    hideCanvasFlowTab && initialTab === 'canvas-flow' ? 'projects' : initialTab
  ))
  const [projects, setProjects] = useState<WorkspaceProject[]>(initialCloudData.projects as WorkspaceProject[])
  const [conversations, setConversations] = useState<WorkspaceConversation[]>(initialVisibleConversations)
  const [workflowTasks, setWorkflowTasks] = useState<WorkspaceTask[]>(initialCloudData.workflowTasks as WorkspaceTask[])
  const [tasks, setTasks] = useState<Record<string, WorkspaceTask[]>>(initialCloudData.tasksByProject as Record<string, WorkspaceTask[]>)
  const [localTaskSnapshots, setLocalTaskSnapshots] = useState<Record<string, unknown>>(initialCloudData.taskSnapshots)
  const [moduleCounts, setModuleCounts] = useState<WorkspaceModuleCounts>(() => moduleCountsFromWorkspaceData({
    ...initialCloudData,
    conversations: initialVisibleConversations,
  }))
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [taskLoading, setTaskLoading] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [conversationListExpanded, setConversationListExpanded] = useState(false)
  const [collapsedWorkflowGroups, setCollapsedWorkflowGroups] = useState<Record<string, boolean>>({})
  const [newWorkflowDialogOpen, setNewWorkflowDialogOpen] = useState(false)
  const [newWorkflowName, setNewWorkflowName] = useState('')
  const [newWorkflowCreating, setNewWorkflowCreating] = useState(false)
  const taskLoadRequestIdRef = useRef(0)
  const taskLoadAbortRef = useRef<AbortController | null>(null)
  const workflowTaskCreationRef = useRef<WorkflowTaskCreation | null>(null)
  const createWorkflowTaskRef = useRef<(workflowName: string, creationKey?: string) => Promise<CreatedWorkflowTask | null>>(async () => null)
  const workflowTasksRef = useRef(workflowTasks)
  const cloudIndexRecordsRef = useRef<Record<string, unknown>>(initialCloudIndex.records)
  const cloudIndexSourceLoadedAtRef = useRef<Partial<Record<CloudIndexSourceKey, number>>>(initialCloudIndex.loadedAt)
  const [loadingCloudSources, setLoadingCloudSources] = useState<Set<CloudIndexSourceKey>>(() => new Set())
  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#062326' : '#2D2A26'})`
  const panelBg = `var(--app-bg, ${isDark ? '#09090b' : '#F5F0E6'})`
  const panelBorder = `var(--app-border, ${isDark ? '#27272a' : '#D1C7B8'})`
  const muted = `var(--app-muted, ${isDark ? '#71717a' : '#847463'})`
  const text = `var(--app-text, ${isDark ? '#e4e4e7' : '#2D2A26'})`
  const itemHover = `var(--app-panel-soft, ${isDark ? 'rgba(39,39,42,0.72)' : 'rgba(255,255,255,0.42)'})`
  const selectedBg = 'var(--app-primary-soft, rgba(82,82,91,0.12))'
  const softBg = `var(--app-panel-soft, ${isDark ? '#18181b' : '#EFE7D8'})`
  const searchBg = `var(--app-panel, ${isDark ? '#15171c' : '#fffaf4'})`
  const subtleText = `var(--app-muted, ${isDark ? '#a1a1aa' : '#5f574d'})`

  const [renamingTask, setRenamingTask] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSavingKey, setRenameSavingKey] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    workflowTasksRef.current = workflowTasks
  }, [workflowTasks])

  useEffect(() => () => taskLoadAbortRef.current?.abort(), [])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const applyWorkspaceMirrorData = useCallback((data: WorkspaceMirrorData | null) => {
    if (!data) return false
    const visibleData = withoutDeletedWorkflowTasks(data)
    setProjects(visibleData.projects as WorkspaceProject[])
    setWorkflowTasks(visibleData.workflowTasks as WorkspaceTask[])
    setTasks(visibleData.tasksByProject as Record<string, WorkspaceTask[]>)
    const visibleConversations = filterDeletedHistoryRecords(
      'conversation',
      filterDeletedHistoryRecords(
        'image-message',
        data.conversations as WorkspaceConversation[],
        conversation => imageHistoryTombstoneId(conversation),
      ),
      conversation => conversation.conversationId || conversation.id,
    )
    setConversations(visibleConversations)
    setModuleCounts(prev => ({
      ...prev,
      ...moduleCountsFromWorkspaceData({ ...visibleData, conversations: visibleConversations }),
    }))
    const snapshotCount = Object.keys(visibleData.taskSnapshots).length
    if (snapshotCount) {
      setLocalTaskSnapshots(prev => visibleData.partial ? { ...prev, ...visibleData.taskSnapshots } : visibleData.taskSnapshots)
    } else if (!visibleData.hasData) {
      setLocalTaskSnapshots({})
    }
    return visibleData.hasData
  }, [])

  const loadCloudWorkspaceIndex = useCallback(async (
    showLoading = false,
    force = false,
    targetTab: WorkspaceTabKey = activeTab,
    quiet = false,
  ): Promise<WorkspaceMirrorData | null> => {
    if (!auth.isLoggedIn()) return null
    if (showLoading) setLoading(true)
    if (!quiet) setApiError(null)

    const cloudSources: CloudIndexSource[] = [
      { key: 'workspaceProjects', path: '/api/workspace/projects', optional: false },
      { key: 'workspaceTasks', path: `/api/workspace/tasks?limit=${CLOUD_INDEX_LIMIT}&offset=0`, optional: false },
      { key: 'conversations', path: `/api/conversations?limit=${CLOUD_INDEX_LIMIT}&offset=0`, optional: false },
      { key: 'conversationCounts', path: '/api/conversations/counts', optional: true },
      { key: 'imageHistory', path: `/api/conversations/images/batch?limit=${IMAGE_HISTORY_INDEX_LIMIT}`, optional: false },
      { key: 'posterHistory', path: `/api/poster/history?limit=${CLOUD_INDEX_LIMIT}&offset=0`, optional: false },
      { key: 'sciFigHistory', path: `/api/sci-fig/history?limit=${CLOUD_INDEX_LIMIT}&offset=0`, optional: false },
      { key: 'pptPresentations', path: '/api/ppt/presentation/recent?limit=80', optional: false },
    ]
    const allSources = isDesktopLocalWorkspace()
      ? cloudSources.filter(source => source.key === 'workspaceProjects' || source.key === 'workspaceTasks')
      : cloudSources
    const coreSourceKeys = new Set<CloudIndexSourceKey>(['conversationCounts'])
    const requestedKeys = new Set<CloudIndexSourceKey>([
      ...coreSourceKeys,
      ...CLOUD_INDEX_SOURCE_KEYS_BY_TAB[targetTab],
    ])
    const now = Date.now()
    const sources = allSources.filter(source => (
      requestedKeys.has(source.key)
      && (force || now - (cloudIndexSourceLoadedAtRef.current[source.key] || 0) >= CLOUD_INDEX_REFRESH_MS)
    ))

    const applyCloudRecords = () => {
      const data = workspaceDataFromCloudRecords(cloudIndexRecordsRef.current)
      const hasListRecords = Object.keys(cloudIndexRecordsRef.current).some(key => key !== 'conversationCounts')
      if (data.hasData || hasListRecords) applyWorkspaceMirrorData(data)
      return data
    }

    if (!sources.length) {
      const cachedData = applyCloudRecords()
      if (showLoading) setLoading(false)
      return cachedData
    }

    let failed = false
    try {
      await Promise.all(sources.map(async source => {
        setLoadingCloudSources(prev => new Set(prev).add(source.key))
        try {
          const res = await apiFetch(source.path)
          if (!res.ok) {
            if (res.status !== 401 && !(source.optional && res.status === 404)) failed = true
            return
          }
          const payload = await res.json()
          cloudIndexRecordsRef.current = { ...cloudIndexRecordsRef.current, [source.key]: payload }
          cloudIndexSourceLoadedAtRef.current[source.key] = Date.now()
          writePersistentCache(
            userScopedCacheKey(WORKSPACE_CLOUD_INDEX_CACHE_KEY),
            {
              records: cacheableCloudIndexRecords(cloudIndexRecordsRef.current),
              loadedAt: cloudIndexSourceLoadedAtRef.current,
            } satisfies WorkspaceCloudIndexCache,
          )
          applyCloudRecords()

          if (source.key === 'conversationCounts') {
            const exactConversationCounts = moduleCountsFromConversationCounts(payload)
            delete exactConversationCounts.image
            if (Object.keys(exactConversationCounts).length) {
              setModuleCounts(prev => ({ ...prev, ...exactConversationCounts }))
            }
          }
        } catch {
          if (!source.optional) failed = true
        } finally {
          setLoadingCloudSources(prev => {
            const next = new Set(prev)
            next.delete(source.key)
            return next
          })
        }
      }))

      const data = applyCloudRecords()
      const hasListRecords = Object.keys(cloudIndexRecordsRef.current).some(key => key !== 'conversationCounts')
      const exactConversationCounts = moduleCountsFromConversationCounts(cloudIndexRecordsRef.current.conversationCounts)
      delete exactConversationCounts.image
      if (Object.keys(exactConversationCounts).length) {
        setModuleCounts(prev => ({ ...prev, ...exactConversationCounts }))
      }
      if (!data.hasData && failed && !hasListRecords && !Object.keys(exactConversationCounts).length) {
        if (!quiet) setApiError(lang === 'zh' ? '加载历史数量失败，请稍后重试' : 'Failed to load history counts. Please try again.')
      }
      return data
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [activeTab, applyWorkspaceMirrorData, lang])

  const loadProjects = useCallback(async (showLoading = true): Promise<WorkspaceProject[]> => {
    if (!auth.isLoggedIn()) return []
    if (showLoading) setLoading(true)
    setApiError(null)
    try {
      const res = await apiFetch('/api/workspace/projects')
      if (res.ok) {
        const data = await res.json()
        const nextProjects = (data.projects ?? []).filter((project: WorkspaceProject) => !isMobileOnlyProject(project))
        setProjects(nextProjects)
        setModuleCounts(prev => ({
          ...prev,
          projects: countLegacyWorkflowTasks(workflowTasks),
          'canvas-flow': countCanvasFlowTasks(workflowTasks),
        }))
        return nextProjects
      } else if (res.status !== 401) {
        const err = await res.json().catch(() => ({}))
        setApiError(err.detail ?? `加载失败 (${res.status})`)
      }
    } catch {
      setApiError('网络错误，请检查后端服务')
    } finally {
      if (showLoading) setLoading(false)
    }
    return []
  }, [workflowTasks])

  const loadWorkflowTasks = useCallback(async (showLoading = true): Promise<WorkspaceTask[]> => {
    if (!auth.isLoggedIn()) return []
    if (showLoading) setLoading(true)
    setApiError(null)
    try {
      const res = await apiFetch('/api/workspace/tasks')
      if (res.ok) {
        const data = await res.json() as { tasks?: WorkspaceTask[] }
        const nextTasks = dedupeWorkflowTasks(filterDeletedHistoryRecords(
          'workspace-task',
          Array.isArray(data.tasks) ? data.tasks : [],
          (task: WorkspaceTask) => task.id,
        ))
        setWorkflowTasks(nextTasks)
        setModuleCounts(prev => ({
          ...prev,
          projects: countLegacyWorkflowTasks(nextTasks),
          'canvas-flow': countCanvasFlowTasks(nextTasks),
        }))
        setTasks(workflowTasksByProject(nextTasks))
        return nextTasks
      } else if (res.status !== 401) {
        const err = await res.json().catch(() => ({}))
        setApiError(err.detail ?? `加载失败 (${res.status})`)
      }
    } catch {
      setApiError('加载工作流失败，请稍后重试')
    } finally {
      if (showLoading) setLoading(false)
    }
    return []
  }, [projects])

  useEffect(() => {
    if (open) {
      void loadCloudWorkspaceIndex(true, false, activeTab)
    }
  }, [open, loadCloudWorkspaceIndex])

  useEffect(() => {
    if (hideCanvasFlowTab && activeTab === 'canvas-flow') setActiveTab('projects')
  }, [activeTab, hideCanvasFlowTab])

  // 根据 activeTab 过滤对话列表
  const filteredConversations = conversations.filter(c => {
    if (activeTab === 'image') return c.type === 'image'
    if (activeTab === 'conversations') return c.type === 'ppt'
    if (activeTab === 'sci-fig') return c.type === 'sci-fig'
    if (activeTab === 'poster') return c.type === 'poster'
    return true
  })

  const ensureDefaultWorkflowProject = useCallback(async (): Promise<WorkspaceProject | null> => {
    let currentProjects = projects
    if (!currentProjects.length) {
      currentProjects = await loadProjects(false)
    }
    const existing = currentProjects.find(project => normalizeWorkspaceName(project.name) === normalizeWorkspaceName(DEFAULT_WORKFLOW_PROJECT_NAME))
    if (existing) return existing

    try {
      const res = await apiFetch('/api/workspace/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DEFAULT_WORKFLOW_PROJECT_NAME }),
      })
      if (!res.ok) {
        const reloaded = await loadProjects(false)
        return reloaded.find(project => normalizeWorkspaceName(project.name) === normalizeWorkspaceName(DEFAULT_WORKFLOW_PROJECT_NAME)) ?? null
      }
      const project = await res.json() as WorkspaceProject
      const withCount = { ...project, task_count: 0 }
      setProjects(prev => [withCount, ...prev])
      return withCount
    } catch {
      return null
    }
  }, [loadProjects, projects])

  const handleCreateWorkflow = useCallback(async (rawName: string) => {
    if (newWorkflowCreating) return
    const requestedName = rawName.trim().replace(/\s+/g, ' ')
    if (!requestedName) return
    setApiError(null)
    setNewWorkflowCreating(true)
    try {
      const created = await createWorkflowTaskRef.current(requestedName)
      if (created) {
        onNewTask(created.projectId, created.taskId, created.taskName)
        setNewWorkflowDialogOpen(false)
        setNewWorkflowName('')
      }
    } catch {
      setApiError('网络错误，请检查后端服务')
    } finally {
      setNewWorkflowCreating(false)
    }
  }, [newWorkflowCreating, onNewTask])

  const openNewWorkflowDialog = useCallback(() => {
    setNewWorkflowName(nextWorkflowTaskName(workflowTasks, lang))
    setNewWorkflowDialogOpen(true)
  }, [lang, workflowTasks])

  const createWorkflowTask = useCallback(async (workflowName: string, creationKey?: string): Promise<{ projectId: string; taskId: string; taskName: string } | null> => {
    const taskName = (workflowName || nextWorkflowTaskName(workflowTasksRef.current, lang)).trim().replace(/\s+/g, ' ')
    if (!taskName) return null
    const requestKey = creationKey?.trim() || ''
    const intent = requestKey ? `key:${requestKey}` : `name:${normalizeWorkspaceName(taskName)}`
    let active = workflowTaskCreationRef.current
    while (active) {
      if (active.intent === intent) return active.promise
      await active.promise
      active = workflowTaskCreationRef.current
    }
    if (workflowNameExists(taskName, workflowTasksRef.current)) {
      setApiError(lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
      return null
    }

    let resolvePending: (result: CreatedWorkflowTask | null) => void = () => {}
    const pending = new Promise<CreatedWorkflowTask | null>(resolve => {
      resolvePending = resolve
    })
    const creation: WorkflowTaskCreation = { intent, promise: pending }
    workflowTaskCreationRef.current = creation
    void (async () => {
      let result: CreatedWorkflowTask | null = null
      try {
        const project = await ensureDefaultWorkflowProject()
        if (!project || workflowNameExists(taskName, workflowTasksRef.current)) {
          if (workflowNameExists(taskName, workflowTasksRef.current)) {
            setApiError(lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
          }
          return
        }
        const taskRes = await apiFetch(`/api/workspace/projects/${project.id}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: taskName, creation_key: requestKey || `workspace:${crypto.randomUUID()}` }),
        })
        if (!taskRes.ok) {
          const err = await taskRes.json().catch(() => ({}))
          setApiError(taskRes.status === 409
            ? (lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
            : (err.detail ?? `新建失败 (${taskRes.status})`))
          return
        }
        const task = await taskRes.json() as WorkspaceTask
        const taskWithProject = { ...task, project_id: project.id }
        const nextWorkflowTasks = dedupeWorkflowTasks([taskWithProject, ...workflowTasksRef.current])
        workflowTasksRef.current = nextWorkflowTasks
        setWorkflowTasks(nextWorkflowTasks)
        setTasks(prev => ({ ...prev, [project.id]: dedupeWorkflowTasks([taskWithProject, ...(prev[project.id] ?? [])]) }))
        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, task_count: p.task_count + 1 } : p))
        setModuleCounts(prev => ({ ...prev, projects: (prev.projects ?? Math.max(0, nextWorkflowTasks.length - 1)) + 1 }))
        result = { projectId: project.id, taskId: task.id, taskName: task.name }
      } catch {
        result = null
      } finally {
        resolvePending(result)
        queueMicrotask(() => {
          if (workflowTaskCreationRef.current === creation) workflowTaskCreationRef.current = null
        })
      }
    })()
    return pending
  }, [ensureDefaultWorkflowProject, lang])

  useEffect(() => {
    createWorkflowTaskRef.current = createWorkflowTask
  }, [createWorkflowTask])

  const discardWorkflowTask = useCallback(async (taskId: string) => {
    const task = workflowTasks.find(item => item.id === taskId)
    const projectId = task?.project_id || ''
    const countKey: 'projects' | 'canvas-flow' = task && isCanvasFlowTask(task) ? 'canvas-flow' : 'projects'
    markHistoryDeleted('workspace-task', taskId)
    workflowTasksRef.current = workflowTasksRef.current.filter(item => item.id !== taskId)
    setWorkflowTasks(prev => prev.filter(item => item.id !== taskId))
    setTasks(prev => Object.fromEntries(
      Object.entries(prev).map(([id, items]) => [id, items.filter(item => item.id !== taskId)]),
    ))
    if (task && projectId) {
      setProjects(prev => prev.map(project => project.id === projectId
        ? { ...project, task_count: Math.max(0, project.task_count - 1) }
        : project))
    }
    if (task) {
      setModuleCounts(prev => ({ ...prev, [countKey]: Math.max(0, (prev[countKey] ?? 1) - 1) }))
    }
    try {
      const res = await apiFetch(`/api/workspace/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        unmarkHistoryDeleted('workspace-task', taskId)
        void loadWorkflowTasks(false)
      }
    } catch {
      unmarkHistoryDeleted('workspace-task', taskId)
      void loadWorkflowTasks(false)
    }
  }, [loadWorkflowTasks, workflowTasks])

  const openProjects = useCallback(() => {
    setActiveTab('projects')
    setOpen(true)
  }, [])

  const getWorkflowTasks = useCallback(() => workflowTasks, [workflowTasks])

  useEffect(() => {
    onRef?.({ createWorkflowTask, discardWorkflowTask, getWorkflowTasks, openProjects })
  }, [onRef, createWorkflowTask, discardWorkflowTask, getWorkflowTasks, openProjects])

  const dispatchLoadedTask = useCallback((task: WorkspaceTask, snapshot: WorkspaceTaskSnapshot) => {
    if (isCanvasFlowTask(task)) {
      if (onLoadCanvasFlowTask) onLoadCanvasFlowTask(task, snapshot)
      else navigate(`/canvas-flow?task=${encodeURIComponent(task.id)}`)
      return
    }
    onLoadTask(task, snapshot)
  }, [navigate, onLoadCanvasFlowTask, onLoadTask])

  const handleLoadTask = useCallback(async (task: WorkspaceTask) => {
    const requestId = ++taskLoadRequestIdRef.current
    taskLoadAbortRef.current?.abort()
    taskLoadAbortRef.current = null
    if (currentTaskId === task.id) {
      setOpen(false)
      return
    }
    setTaskLoading(task.id)
    setApiError(null)
    const mirroredSnapshot = isElectron() ? mirroredTaskSnapshotPayload(localTaskSnapshots[task.id]) : null
    if (mirroredSnapshot) {
      if (requestId !== taskLoadRequestIdRef.current) return
      dispatchLoadedTask(task, mirroredSnapshot as WorkspaceTaskSnapshot)
      setTaskLoading(null)
      setOpen(false)
      return
    }
    const ctrl = new AbortController()
    taskLoadAbortRef.current = ctrl
    const timeoutId = window.setTimeout(() => ctrl.abort(), 45000)
    try {
      const res = await apiFetch(`/api/workspace/tasks/${task.id}/snapshot`, { signal: ctrl.signal })
      if (requestId !== taskLoadRequestIdRef.current) return
      if (res.ok) {
        const snapshot = await res.json()
        if (requestId !== taskLoadRequestIdRef.current) return
        dispatchLoadedTask(task, {
          layers: snapshot.layers ?? [],
          canvasImage: snapshot.canvas_image,
          workflowSnapshot: snapshot.workflow_snapshot ?? null,
          gen_cards: snapshot.gen_cards ?? [],
          workspaceState: snapshot.workspace_state ?? null,
        })
        setOpen(false)
      } else if (res.status !== 401) {
        const err = await res.json().catch(() => ({}))
        setApiError(err.detail ?? `加载失败 (${res.status})`)
      }
    } catch (error) {
      if (requestId !== taskLoadRequestIdRef.current) return
      setApiError(error instanceof DOMException && error.name === 'AbortError'
        ? '打开工作流超时，请稍后重试'
        : '加载失败，请稍后重试')
    } finally {
      window.clearTimeout(timeoutId)
      if (requestId === taskLoadRequestIdRef.current) {
        taskLoadAbortRef.current = null
        setTaskLoading(current => current === task.id ? null : current)
      }
    }
  }, [currentTaskId, dispatchLoadedTask, localTaskSnapshots])

  const commitRenameTask = useCallback(async (projectId: string, taskId: string) => {
    const name = renameValue.trim()
    if (!name) { setRenamingTask(null); return }
    const previousName = (tasks[projectId] ?? []).find(task => task.id === taskId)?.name || ''
    if (name === previousName) { setRenamingTask(null); return }
    if (workflowNameExists(name, workflowTasks, taskId)) {
      setApiError(lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
      setTimeout(() => renameInputRef.current?.select(), 30)
      return
    }
    setRenameSavingKey(`task:${taskId}`)
    setApiError(null)
    try {
      const res = await apiFetch(`/api/workspace/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setApiError(res.status === 409
          ? (lang === 'zh' ? '工作流名称已存在，请换一个名称' : 'Workflow name already exists. Please choose another name.')
          : (err.detail ?? `重命名失败 (${res.status})`))
        return
      }
      setTasks(prev => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).map(t => t.id === taskId ? { ...t, name } : t),
      }))
      setWorkflowTasks(prev => prev.map(t => t.id === taskId ? { ...t, name } : t))
      onTaskRenamed?.(projectId, taskId, name)
      setRenamingTask(null)
    } catch {
      setApiError(lang === 'zh' ? '网络错误，工作流名称没有保存' : 'Network error. Workflow name was not saved.')
      setTimeout(() => renameInputRef.current?.select(), 30)
    } finally {
      setRenameSavingKey(null)
    }
  }, [renameValue, tasks, lang, onTaskRenamed, workflowTasks])

  const handleDeleteTask = useCallback(async (projectId: string, taskId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await confirm({
      title: lang === 'zh' ? '删除工作流' : 'Delete Workflow',
      message: lang === 'zh' ? '确认删除此工作流任务？此操作不可撤销。' : 'Delete this workflow task? This cannot be undone.',
      confirmText: lang === 'zh' ? '删除' : 'Delete',
      cancelText: lang === 'zh' ? '取消' : 'Cancel',
      danger: true,
    })
    if (!ok) return
    const deletedTask = workflowTasks.find(task => task.id === taskId)
    if (!deletedTask) return
    const deletedCountKey: 'projects' | 'canvas-flow' = isCanvasFlowTask(deletedTask) ? 'canvas-flow' : 'projects'
    const deletedCountFallback = deletedCountKey === 'canvas-flow'
      ? countCanvasFlowTasks(workflowTasks)
      : countLegacyWorkflowTasks(workflowTasks)

    const persistCloudRecords = (records: Record<string, unknown>) => {
      if (isElectron()) return
      writePersistentCache(
        userScopedCacheKey(WORKSPACE_CLOUD_INDEX_CACHE_KEY),
        {
          records: cacheableCloudIndexRecords(records),
          loadedAt: cloudIndexSourceLoadedAtRef.current,
        } satisfies WorkspaceCloudIndexCache,
      )
    }
    const rollback = () => {
      unmarkHistoryDeleted('workspace-task', taskId)
      if (!workflowTasksRef.current.some(task => task.id === taskId)) {
        workflowTasksRef.current = [deletedTask, ...workflowTasksRef.current]
      }
      setWorkflowTasks(prev => prev.some(task => task.id === taskId) ? prev : [deletedTask, ...prev])
      setTasks(prev => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).some(task => task.id === taskId)
          ? (prev[projectId] ?? [])
          : [deletedTask, ...(prev[projectId] ?? [])],
      }))
      setProjects(prev => prev.map(project => project.id === projectId
        ? { ...project, task_count: project.task_count + 1 }
        : project))
      setModuleCounts(prev => ({ ...prev, [deletedCountKey]: (prev[deletedCountKey] ?? Math.max(0, deletedCountFallback - 1)) + 1 }))
      cloudIndexRecordsRef.current = restoreWorkflowTaskToCloudRecords(
        cloudIndexRecordsRef.current,
        projectId,
        deletedTask,
      )
      persistCloudRecords(cloudIndexRecordsRef.current)
    }

    setApiError(null)
    markHistoryDeleted('workspace-task', taskId)
    workflowTasksRef.current = workflowTasksRef.current.filter(task => task.id !== taskId)
    setTasks(prev => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).filter(task => task.id !== taskId),
    }))
    setWorkflowTasks(prev => prev.filter(task => task.id !== taskId))
    setProjects(prev => prev.map(project => project.id === projectId
      ? { ...project, task_count: Math.max(0, project.task_count - 1) }
      : project))
    setModuleCounts(prev => ({ ...prev, [deletedCountKey]: Math.max(0, (prev[deletedCountKey] ?? deletedCountFallback) - 1) }))
    cloudIndexRecordsRef.current = removeWorkflowTaskFromCloudRecords(
      cloudIndexRecordsRef.current,
      projectId,
      taskId,
    )
    persistCloudRecords(cloudIndexRecordsRef.current)

    try {
      const res = await apiFetch(`/api/workspace/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        const err = await res.json().catch(() => ({}))
        rollback()
        setApiError(err.detail ?? `删除失败 (${res.status})`)
        return
      }
      onTaskDeleted?.(projectId, taskId)
    } catch {
      rollback()
      setApiError(lang === 'zh' ? '网络错误，工作流没有删除' : 'Network error. Workflow was not deleted.')
    }
  }, [lang, confirm, onTaskDeleted, workflowTasks])

  const query = searchQuery.trim().toLowerCase()
  const visibleWorkflowTasks = useMemo(() => {
    const tasksForTab = activeTab === 'canvas-flow'
      ? workflowTasks.filter(isCanvasFlowTask)
      : workflowTasks.filter(task => !isCanvasFlowTask(task))
    return query ? tasksForTab.filter(task => task.name.toLowerCase().includes(query)) : tasksForTab
  }, [activeTab, query, workflowTasks])
  const visibleConversations = useMemo(() => (
    query
      ? filteredConversations.filter(conversation => conversation.title.toLowerCase().includes(query))
      : filteredConversations
  ), [filteredConversations, query])
  const shownConversations = useMemo(() => (
    query || conversationListExpanded ? visibleConversations : visibleConversations.slice(0, COLLAPSED_CONVERSATION_LIMIT)
  ), [conversationListExpanded, query, visibleConversations])
  const hasActiveTabContent = activeTab === 'projects' || activeTab === 'canvas-flow'
    ? (projects.length > 0 || workflowTasks.length > 0)
    : visibleConversations.length > 0
  const activeCloudSourceLoading = !isElectron()
    && CLOUD_INDEX_SOURCE_KEYS_BY_TAB[activeTab].some(key => loadingCloudSources.has(key))
  const isBlockingContentLoading = isElectron()
    ? loading && !hasActiveTabContent
    : activeCloudSourceLoading && !hasActiveTabContent
  const workflowGroups = useMemo<WorkflowTaskGroup[]>(() => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const groups: WorkflowTaskGroup[] = [
      { key: 'two-days', label: lang === 'zh' ? '两天内' : 'Last 2 days', items: [], defaultCollapsed: false },
      { key: 'week', label: lang === 'zh' ? '一周内' : 'Last 7 days', items: [], defaultCollapsed: true },
      { key: 'month', label: lang === 'zh' ? '一个月内' : 'Last 30 days', items: [], defaultCollapsed: true },
      { key: 'older', label: lang === 'zh' ? '更早' : 'Older', items: [], defaultCollapsed: true },
    ]
    visibleWorkflowTasks.forEach(task => {
      const rawTime = task.meta?.saved_at || task.updated_at || task.created_at
      const parsed = Date.parse(rawTime)
      const age = Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY
      if (age < 2 * day) groups[0].items.push(task)
      else if (age < 7 * day) groups[1].items.push(task)
      else if (age < 30 * day) groups[2].items.push(task)
      else groups[3].items.push(task)
    })
    return groups.filter(group => group.items.length > 0)
  }, [lang, visibleWorkflowTasks])
  const formatTime = useCallback((value: string) => {
    const time = Date.parse(value)
    if (!Number.isFinite(time)) return ''
    const diff = Date.now() - time
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour
    if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
    return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }, [])

  const storageWorkspace = getStorageWorkspace()
  const storageWorkspaceLabel = storageWorkspace === 'local'
    ? (lang === 'zh' ? '仅显示本机记录' : 'Local records only')
    : (lang === 'zh' ? '仅显示云端记录' : 'Cloud records only')

  const handleRefreshCloudHistory = useCallback(async () => {
    if (isDesktopLocalWorkspace() || refreshing) return
    setRefreshing(true)
    try {
      await loadCloudWorkspaceIndex(false, true, activeTab)
    } finally {
      setRefreshing(false)
    }
  }, [activeTab, loadCloudWorkspaceIndex, refreshing])

  const handleOpenLocalWorkspaceDir = useCallback(() => {
    if (!isDesktopLocalWorkspace()) return
    const userId = auth.getUser()?.id
    void getElectronAPI()?.openLocalWorkspaceDir?.({ userId })
  }, [])

  const moduleDisplayCounts = useMemo<Required<WorkspaceModuleCounts>>(() => ({
    projects: moduleCounts.projects ?? countLegacyWorkflowTasks(workflowTasks),
    'canvas-flow': moduleCounts['canvas-flow'] ?? countCanvasFlowTasks(workflowTasks),
    image: moduleCounts.image ?? countConversationsByType(conversations, 'image'),
    conversations: moduleCounts.conversations ?? countConversationsByType(conversations, 'ppt'),
    'sci-fig': moduleCounts['sci-fig'] ?? countConversationsByType(conversations, 'sci-fig'),
    poster: moduleCounts.poster ?? countConversationsByType(conversations, 'poster'),
  }), [conversations, moduleCounts, workflowTasks])

  const moduleNav = [
    { key: 'projects' as const, icon: 'account_tree', label: lang === 'zh' ? '工作流' : 'Workflows', count: moduleDisplayCounts.projects },
    { key: 'canvas-flow' as const, icon: 'hub', label: lang === 'zh' ? '画布流' : 'Canvas flows', count: moduleDisplayCounts['canvas-flow'] },
    { key: 'image' as const, icon: 'auto_awesome', label: lang === 'zh' ? '文生图' : 'Images', count: moduleDisplayCounts.image },
    { key: 'conversations' as const, icon: 'slideshow', label: 'PPT', count: moduleDisplayCounts.conversations },
    { key: 'sci-fig' as const, icon: 'science', label: lang === 'zh' ? '科研图' : 'Research', count: moduleDisplayCounts['sci-fig'] },
    { key: 'poster' as const, icon: 'wall_art', label: lang === 'zh' ? '海报' : 'Poster', count: moduleDisplayCounts.poster },
  ]
  const visibleModuleNav = hideCanvasFlowTab
    ? moduleNav.filter(item => item.key !== 'canvas-flow')
    : moduleNav

  const switchSection = useCallback((key: typeof activeTab) => {
    setActiveTab(key)
    if (open) {
      void loadCloudWorkspaceIndex(false, false, key)
    }
  }, [loadCloudWorkspaceIndex, open])

  const renderTaskRow = (project: WorkspaceProject, task: WorkspaceTask) => {
    const previewSrc = getTaskPreview(task)
    const previewFallbackSrc = getTaskPreviewFallback(task)
    const loadingTask = taskLoading === task.id
    return (
      <div
        key={task.id}
        role="button"
        tabIndex={0}
        aria-current={currentTaskId === task.id ? 'true' : undefined}
        className="group mb-1 flex cursor-pointer items-center gap-2 rounded-xl border px-2 py-2.5 outline-none transition-all focus-visible:ring-2 focus-visible:ring-[var(--app-primary)]"
        style={{
          background: currentTaskId === task.id ? selectedBg : 'transparent',
          borderColor: currentTaskId === task.id ? accent : panelBorder,
          boxShadow: currentTaskId === task.id ? `0 0 0 1px color-mix(in srgb, ${accent} 13%, transparent)` : 'none',
          color: text,
        }}
        onClick={() => handleLoadTask({ ...task, project_id: project.id })}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          void handleLoadTask({ ...task, project_id: project.id })
        }}
        onMouseEnter={e => { if (currentTaskId !== task.id) e.currentTarget.style.background = itemHover }}
        onMouseLeave={e => { if (currentTaskId !== task.id) e.currentTarget.style.background = 'transparent' }}
      >
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border" style={{ borderColor: currentTaskId === task.id ? accent : panelBorder, background: softBg }}>
          <TaskPreviewThumb src={previewSrc} fallbackSrc={previewFallbackSrc} fallbackColor={softBg} isDark={isDark} />
        </div>
        {renamingTask === task.id ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={() => { if (!renameSavingKey) commitRenameTask(project.id, task.id) }}
            onKeyDown={e => {
              if (renameSavingKey) {
                e.stopPropagation()
                return
              }
              if (e.key === 'Enter') commitRenameTask(project.id, task.id)
              if (e.key === 'Escape') setRenamingTask(null)
              e.stopPropagation()
            }}
            onClick={e => e.stopPropagation()}
            disabled={renameSavingKey === `task:${task.id}`}
            autoFocus
            className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none"
            style={{ background: searchBg, borderColor: accent, color: text }}
          />
        ) : (
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[13px] font-extrabold"
              onDoubleClick={e => {
                e.stopPropagation()
                setRenamingTask(task.id)
                setRenameValue(task.name)
                setTimeout(() => renameInputRef.current?.select(), 50)
              }}
            >
              {task.name}
            </div>
            <div className="mt-1 flex items-center gap-1 truncate text-[10px] font-semibold" style={{ color: muted }}>
              <Icon name={isCanvasFlowTask(task) ? 'hub' : 'account_tree'} className="text-[12px]" />
              <span>{isCanvasFlowTask(task) ? (lang === 'zh' ? '画布流' : 'Canvas flow') : (lang === 'zh' ? '工作流' : 'Workflow')} · {task.meta?.saved_at ? formatTime(task.meta.saved_at) : formatTime(task.updated_at)}</span>
            </div>
          </div>
        )}
        {loadingTask ? (
          <Icon name="progress_activity" className="shrink-0 animate-spin text-[15px]" />
        ) : (
          <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button
              onClick={e => {
                e.stopPropagation()
                if (renameSavingKey) return
                setRenamingTask(task.id)
                setRenameValue(task.name)
                setTimeout(() => renameInputRef.current?.select(), 50)
              }}
              className="rounded p-1"
              style={{ color: muted }}
              title={T('rename')}
            >
              <Icon name="draw" className="text-[13px]" />
            </button>
            <button
              onClick={e => handleDeleteTask(project.id, task.id, e)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all"
              style={{
                color: '#ef4444',
                background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${isDark ? 'rgba(248,113,113,0.20)' : 'rgba(239,68,68,0.16)'}`,
              }}
              title={T('delete')}
            >
              <Icon name="delete" className="text-[18px]" />
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderWorkflowGroup = (group: WorkflowTaskGroup) => {
    const collapsed = !query && (collapsedWorkflowGroups[group.key] ?? group.defaultCollapsed)
    return (
      <div key={group.key} className="mb-2">
        <button
          type="button"
          onClick={() => setCollapsedWorkflowGroups(prev => ({ ...prev, [group.key]: !collapsed }))}
          className="mb-1 flex h-8 w-full items-center justify-between rounded-lg px-2 text-left transition-colors"
          style={{ color: subtleText, background: `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.34)'})` }}
          aria-expanded={!collapsed}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-black">
            <Icon name={collapsed ? 'chevron_right' : 'expand_more'} className="text-[15px]" />
            {group.label}
          </span>
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-black" style={{ background: softBg, color: muted }}>
            {group.items.length}
          </span>
        </button>
        {!collapsed && (
          <div>
            {group.items.map(task => renderTaskRow(
              projects.find(project => project.id === task.project_id) || {
                id: task.project_id || '',
                name: DEFAULT_WORKFLOW_PROJECT_NAME,
                is_archived: false,
                task_count: 0,
                created_at: task.created_at,
                updated_at: task.updated_at,
              },
              task,
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderConversationRow = (conv: WorkspaceConversation) => (
    <div
      key={conv.id}
      className="group mb-1 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2.5 transition-colors"
      onClick={() => {
        onOpenConversation?.(conv)
        setOpen(false)
      }}
      onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon name={conv.type === 'image' ? 'auto_awesome' : conv.type === 'ppt' ? 'slideshow' : conv.type === 'sci-fig' ? 'science' : 'wall_art'} className="shrink-0 text-[18px]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold" style={{ color: text }}>{conv.title}</div>
        <div className="text-[10px]" style={{ color: muted }}>
          {conv.message_count} 条消息 · {formatTime(conv.updated_at)}
        </div>
      </div>
      <button
        onClick={async e => {
          e.stopPropagation()
          const conversationId = conv.conversationId || conv.id
          const isImageMessage = conv.type === 'image' && Boolean(conversationId && conv.messageId)
          const tombstoneScope = isImageMessage ? 'image-message' as const : 'conversation' as const
          const tombstoneId = isImageMessage
            ? imageHistoryTombstoneId(conv)
            : conversationId
          const ok = await confirm({
            title: lang === 'zh' ? (isImageMessage ? '删除图片记录' : '删除对话') : (isImageMessage ? 'Delete image record' : 'Delete conversation'),
            message: lang === 'zh'
              ? (isImageMessage ? '确认删除这张生成图片记录？此操作不可撤销。' : '确认删除此对话？此操作不可撤销。')
              : (isImageMessage ? 'Delete this generated image record? This cannot be undone.' : 'Delete this conversation? This cannot be undone.'),
            confirmText: lang === 'zh' ? '删除' : 'Delete',
            cancelText: lang === 'zh' ? '取消' : 'Cancel',
            danger: true,
          })
          if (!ok) return
          markHistoryDeleted(tombstoneScope, tombstoneId)
          setConversations(prev => prev.filter(item => item.id !== conv.id))
          try {
            const deletePath = isImageMessage
              ? `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(conv.messageId as string)}`
              : `/api/conversations/${encodeURIComponent(conversationId)}`
            if (!isDesktopLocalWorkspace()) {
              const res = await apiFetch(deletePath, { method: 'DELETE' })
              if (!res.ok && res.status !== 404) {
                const err = await res.json().catch(() => ({}))
                unmarkHistoryDeleted(tombstoneScope, tombstoneId)
                setConversations(prev => prev.some(item => item.id === conv.id) ? prev : [conv, ...prev])
                setApiError(err.detail ?? `删除失败 (${res.status})`)
                return
              }
            }
            if (isImageMessage && Array.isArray(cloudIndexRecordsRef.current.imageHistory)) {
              cloudIndexRecordsRef.current = {
                ...cloudIndexRecordsRef.current,
                imageHistory: cloudIndexRecordsRef.current.imageHistory.filter(item => {
                  if (!item || typeof item !== 'object') return true
                  const record = item as Record<string, unknown>
                  return record.conversation_id !== conversationId || record.message_id !== conv.messageId
                }),
              }
            }
            const countKey = conv.type === 'image' ? 'image' : conv.type === 'ppt' ? 'conversations' : conv.type === 'sci-fig' ? 'sci-fig' : conv.type === 'poster' ? 'poster' : null
            if (countKey) {
              setModuleCounts(prev => ({ ...prev, [countKey]: Math.max(0, (prev[countKey] ?? countConversationsByType(conversations, conv.type)) - 1) }))
            }
          } catch {
            unmarkHistoryDeleted(tombstoneScope, tombstoneId)
            setConversations(prev => prev.some(item => item.id === conv.id) ? prev : [conv, ...prev])
            setApiError(lang === 'zh'
              ? (isImageMessage ? '网络错误，图片记录没有删除' : '网络错误，对话没有删除')
              : (isImageMessage ? 'Network error. The image record was not deleted.' : 'Network error. Conversation was not deleted.'))
          }
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-0 transition-all group-hover:opacity-100"
        style={{
          color: '#ef4444',
          background: isDark ? 'rgba(248,113,113,0.10)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${isDark ? 'rgba(248,113,113,0.20)' : 'rgba(239,68,68,0.16)'}`,
        }}
        title={T('delete')}
      >
        <Icon name="delete" className="text-[18px]" />
      </button>
    </div>
  )

  return (
    <>
      {confirmDialog}

      {newWorkflowDialogOpen && createPortal(
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45"
          role="dialog"
          aria-modal="true"
          aria-label={lang === 'zh' ? '新建工作流' : 'New Workflow'}
          onClick={() => setNewWorkflowDialogOpen(false)}
        >
          <div
            className="workflow-new-dialog w-[360px] max-w-[calc(100vw-24px)] rounded-xl border shadow-2xl"
            style={{ background: panelBg, borderColor: panelBorder, color: text }}
            onClick={e => e.stopPropagation()}
          >
            <div className="border-b px-4 py-3" style={{ borderColor: panelBorder }}>
              <div className="flex items-center gap-2 text-[13px] font-black">
                <Icon name="account_tree" className="text-[18px]" fill />
                {lang === 'zh' ? '新建工作流' : 'New Workflow'}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed" style={{ color: muted }}>
                {lang === 'zh'
                  ? '先给工作流命名。创建后可以导入外部图片，或从文生图历史选择图片作为节点。'
                  : 'Name the workflow first. After creating it, import an external image or pick one from image history.'}
              </p>
            </div>
            <div className="px-4 py-4">
              <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.08em]" style={{ color: muted }}>
                {lang === 'zh' ? '工作流名称' : 'Workflow name'}
              </label>
              <input
                autoFocus
                value={newWorkflowName}
                onChange={e => setNewWorkflowName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newWorkflowName.trim() && !newWorkflowCreating) void handleCreateWorkflow(newWorkflowName)
                  if (e.key === 'Escape') setNewWorkflowDialogOpen(false)
                }}
                disabled={newWorkflowCreating}
                className="h-10 w-full rounded-lg border px-3 text-[13px] font-bold outline-none"
                style={{ background: searchBg, borderColor: panelBorder, color: text }}
                placeholder={lang === 'zh' ? '例如：火系战犬工作流' : 'e.g. Fire hound workflow'}
              />
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setNewWorkflowDialogOpen(false)}
                  className="h-9 flex-1 rounded-lg border text-[12px] font-black"
                  style={{ borderColor: panelBorder, color: subtleText }}
                >
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => { if (newWorkflowName.trim()) void handleCreateWorkflow(newWorkflowName) }}
                  disabled={!newWorkflowName.trim() || newWorkflowCreating}
                  className="workflow-new-dialog__primary h-9 flex-1 rounded-lg text-[12px] font-black disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ background: accent, color: onAccent }}
                >
                  {newWorkflowCreating ? (lang === 'zh' ? '创建中' : 'Creating') : (lang === 'zh' ? '创建' : 'Create')}
                </button>
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      <button
        data-tour-id="workspace-trigger"
        onClick={() => setOpen(v => !v)}
        className="group flex h-10 items-center gap-2 rounded-xl border px-2.5 pr-3 transition-all hover:-translate-y-px"
        style={{
          borderColor: open ? accent : panelBorder,
          background: open ? selectedBg : `var(--app-panel, ${isDark ? '#111114' : '#F9F2E6'})`,
          boxShadow: open ? `0 0 0 1px color-mix(in srgb, ${accent} 13%, transparent)` : `0 1px 2px ${isDark ? 'rgba(0,0,0,0.28)' : 'rgba(45,42,38,0.08)'}`,
        }}
        title={lang === 'zh' ? '灵感中心' : 'LINGGAN'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
          <img src={brandMarkSrc} alt="" aria-hidden="true" className="h-7 w-7 object-contain" />
        </span>
        <span className="font-['Space_Grotesk'] text-[13px] font-black" style={{ color: text }}>
          {lang === 'zh' ? '灵感中心' : 'LINGGAN'}
        </span>
        <Icon name="keyboard_arrow_down" className={`text-[17px] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && <div className="fixed inset-0 z-[70] bg-black/10" onClick={() => setOpen(false)} />}

      {open && (
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={lang === 'zh' ? '灵感中心' : 'LINGGAN workspace'}
          className="fixed left-0 top-0 z-[80] flex h-screen w-[390px] max-w-[calc(100vw-16px)] border-r shadow-2xl"
          style={{ background: panelBg, borderColor: panelBorder, color: text }}
          onClick={e => e.stopPropagation()}
        >
          <div className="flex w-[132px] shrink-0 flex-col border-r px-2 py-3" style={{ borderColor: panelBorder, background: `var(--app-panel, ${isDark ? '#0d0d10' : '#EFE8DC'})` }}>
            <button
              onClick={() => setOpen(false)}
              className="mb-3 flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors"
              style={{ color: text }}
              onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              title={lang === 'zh' ? '关闭' : 'Close'}
            >
              <img src={brandMarkSrc} alt="" aria-hidden="true" className="h-6 w-6 object-contain" />
              {lang === 'zh' ? <BrandWordmark className="brand-wordmark--compact" /> : <span className="truncate text-[13px] font-black">LINGGAN</span>}
            </button>

            <nav className="space-y-1">
              {visibleModuleNav.map(item => {
                const active = activeTab === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => switchSection(item.key)}
                    className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-bold transition-colors"
                    style={{
                      background: active ? selectedBg : 'transparent',
                      color: active ? text : subtleText,
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = itemHover }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                  >
                    <Icon name={item.icon} className="shrink-0 text-[18px]" fill={active} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-[10px]" style={{ color: active ? accent : muted }}>{item.count}</span>
                  </button>
                )
              })}
            </nav>

            <div className="mt-auto space-y-1">
              <button
                onClick={() => { setOpen(false); navigate('/download') }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-bold transition-colors"
                style={{ color: subtleText }}
                onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <Icon name="desktop_windows" className="text-[18px]" />
                {lang === 'zh' ? '桌面端' : 'Desktop'}
              </button>
              <button
                onClick={() => { setOpen(false); navigate('/profile') }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-bold transition-colors"
                style={{ color: subtleText }}
                onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <Icon name="settings" className="text-[18px]" />
                {lang === 'zh' ? '设置' : 'Settings'}
              </button>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 py-3" style={{ borderColor: panelBorder }}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[15px] font-black">
                    {activeTab === 'projects' || activeTab === 'canvas-flow'
                      ? activeTab === 'canvas-flow'
                        ? (lang === 'zh' ? '画布流' : 'Canvas flows')
                        : (lang === 'zh' ? '工作流' : 'Workflows')
                      : visibleModuleNav.find(item => item.key === activeTab)?.label}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: muted }}>
                    {activeTab === 'projects' || activeTab === 'canvas-flow'
                      ? `${visibleWorkflowTasks.length} ${activeTab === 'canvas-flow' ? (lang === 'zh' ? '个画布流' : 'canvas flows') : (lang === 'zh' ? '个工作流' : 'workflows')}`
                      : `${visibleConversations.length} ${lang === 'zh' ? '条记录' : 'items'}`}
                  </div>
                  {isElectron() && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] font-bold" style={{ color: muted }}>
                      <Icon name={storageWorkspace === 'local' ? 'hard_drive' : 'cloud'} className="text-[12px]" />
                      <span className="truncate">{storageWorkspaceLabel}</span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(!isElectron() || storageWorkspace === 'cloud') && (
                    <button
                      type="button"
                      onClick={() => void handleRefreshCloudHistory()}
                      disabled={refreshing}
                      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-55"
                      style={{ color: refreshing ? accent : muted }}
                      onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      title={lang === 'zh' ? (refreshing ? '正在刷新历史' : '刷新历史') : (refreshing ? 'Refreshing history' : 'Refresh history')}
                      aria-label={lang === 'zh' ? '刷新历史' : 'Refresh history'}
                      aria-busy={refreshing}
                    >
                      <Icon name="refresh" className={`text-[17px] ${refreshing ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                  {isElectron() && storageWorkspace === 'local' && (
                    <button
                      onClick={handleOpenLocalWorkspaceDir}
                      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                      style={{ color: muted }}
                      onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      title={lang === 'zh' ? '打开本地工作区目录' : 'Open local workspace folder'}
                    >
                      <Icon name="folder_open" className="text-[17px]" />
                    </button>
                  )}
                  <button
                    onClick={() => setOpen(false)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
                    style={{ color: muted }}
                    onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    title={lang === 'zh' ? '关闭' : 'Close'}
                  >
                    <Icon name="close" className="text-[18px]" />
                  </button>
                </div>
              </div>

              <label className="flex h-9 items-center gap-2 rounded-lg border px-3" style={{ borderColor: panelBorder, background: searchBg }}>
                <Icon name="search" className="shrink-0 text-[17px]" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={activeTab === 'projects' || activeTab === 'canvas-flow'
                    ? activeTab === 'canvas-flow'
                      ? (lang === 'zh' ? '搜索画布流' : 'Search canvas flows')
                      : (lang === 'zh' ? '搜索工作流' : 'Search workflows')
                    : (lang === 'zh' ? '搜索记录' : 'Search records')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none placeholder:text-current"
                  style={{ color: text, opacity: searchQuery ? 1 : 0.72 }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{ color: muted }}
                  >
                    <Icon name="close" className="text-[14px]" />
                  </button>
                )}
              </label>
            </div>

            {apiError && (
              <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] text-red-400" style={{ borderColor: '#dc262655', background: isDark ? '#450a0a44' : '#fee2e2' }}>
                <Icon name="error" className="mt-0.5 shrink-0 text-[14px]" fill />
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{lang === 'zh' ? '操作失败' : 'Error'}</div>
                  <div className="break-words opacity-85">{apiError}</div>
                </div>
                <button onClick={() => setApiError(null)} className="shrink-0">
                  <Icon name="close" className="text-[14px]" />
                </button>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">
              {isBlockingContentLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px]" style={{ color: muted }}>
                  <Icon name="progress_activity" className="animate-spin text-[16px]" />
                  {T('loading')}
                </div>
              ) : activeTab === 'projects' || activeTab === 'canvas-flow' ? (
                <>
                  <div className="mb-2 flex items-center justify-between px-1">
                    <div className="text-[11px] font-black" style={{ color: muted }}>{activeTab === 'canvas-flow' ? (lang === 'zh' ? '画布流' : 'Canvas flows') : (lang === 'zh' ? '工作流' : 'Workflows')}</div>
                    <button
                      onClick={() => {
                        if (activeTab === 'canvas-flow') {
                          setOpen(false)
                          navigate('/canvas-flow')
                        } else {
                          openNewWorkflowDialog()
                        }
                      }}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-black"
                      style={{ color: accent, background: selectedBg }}
                    >
                      <Icon name="add" className="text-[14px]" />
                      {activeTab === 'canvas-flow' ? (lang === 'zh' ? '新建画布流' : 'New Canvas Flow') : (lang === 'zh' ? '新建工作流' : 'New Workflow')}
                    </button>
                  </div>

                  {visibleWorkflowTasks.length > 0 ? (
                    <>
                      {workflowGroups.map(renderWorkflowGroup)}
                    </>
                  ) : (
                    <div className="rounded-lg px-3 py-8 text-center text-[12px]" style={{ color: muted, background: softBg }}>
                      <Icon name={activeTab === 'canvas-flow' ? 'hub' : 'account_tree'} className="mx-auto mb-2 block text-[28px]" />
                      <div>{query ? (lang === 'zh' ? '没有匹配记录' : 'No matching records') : activeTab === 'canvas-flow' ? (lang === 'zh' ? '还没有画布流' : 'No canvas flows yet') : (lang === 'zh' ? '还没有工作流' : 'No workflows yet')}</div>
                      {!query && (
                        <button
                          onClick={() => {
                            if (activeTab === 'canvas-flow') {
                              setOpen(false)
                              navigate('/canvas-flow')
                            } else {
                              openNewWorkflowDialog()
                            }
                          }}
                          className="mx-auto mt-3 flex h-8 items-center gap-1.5 rounded-md px-3 text-[11px] font-black"
                          style={{ color: accent, background: selectedBg }}
                        >
                          <Icon name="add_circle" className="text-[15px]" fill />
                          {activeTab === 'canvas-flow' ? (lang === 'zh' ? '新建画布流' : 'New Canvas Flow') : (lang === 'zh' ? '新建工作流' : 'New Workflow')}
                        </button>
                      )}
                    </div>
                  )}

                </>
              ) : (
                <>
                  <div className="mb-2 px-1 text-[11px] font-bold" style={{ color: muted }}>
                    {lang === 'zh' ? '最近记录' : 'Recent'}
                  </div>
                  {visibleConversations.length > 0 ? (
                    <>
                      {shownConversations.map(renderConversationRow)}
                      {!query && visibleConversations.length > COLLAPSED_CONVERSATION_LIMIT && (
                        <button
                          onClick={() => setConversationListExpanded(v => !v)}
                          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors"
                          style={{ color: subtleText }}
                          onMouseEnter={e => { e.currentTarget.style.background = itemHover }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                        >
                          <Icon name={conversationListExpanded ? 'expand_less' : 'expand_more'} className="text-[16px]" />
                          {conversationListExpanded
                            ? (lang === 'zh' ? '收起显示' : 'Show less')
                            : (lang === 'zh' ? `展开显示 ${visibleConversations.length - COLLAPSED_CONVERSATION_LIMIT} 条` : `Show ${visibleConversations.length - COLLAPSED_CONVERSATION_LIMIT} more`)}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg px-3 py-8 text-center text-[12px]" style={{ color: muted, background: softBg }}>
                      <Icon name={activeTab === 'image' ? 'auto_awesome' : activeTab === 'sci-fig' ? 'science' : activeTab === 'poster' ? 'wall_art' : 'slideshow'} className="mx-auto mb-2 block text-[28px]" />
                      {query ? (lang === 'zh' ? '没有匹配记录' : 'No matching items') : (lang === 'zh' ? '暂无记录' : 'No records yet')}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </aside>
      )}
    </>
  )
}
