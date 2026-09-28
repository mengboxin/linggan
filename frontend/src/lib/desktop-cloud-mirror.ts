interface LegacyDesktopCloudMirrorSnapshot {
  syncedAt?: string
  partial?: boolean
  records?: Record<string, unknown>
  assets?: {
    items?: unknown[]
  }
}

const TEXT_TO_IMAGE_HISTORY_SOURCES = new Set([
  'web', 'web-bottom', 'desktop', 'mobile',
])

export interface MirroredWorkspaceProject {
  id: string
  name: string
  description?: string
  is_archived: boolean
  task_count: number
  created_at: string
  updated_at: string
}

export interface MirroredWorkspaceTask {
  id: string
  project_id?: string
  name: string
  status: string
  workflow_kind?: 'image_edit' | 'canvas_flow'
  meta?: Record<string, unknown>
  created_at: string
  updated_at: string
  source_width?: number
  source_height?: number
}

export interface MirroredConversation {
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

export interface WorkspaceMirrorData {
  projects: MirroredWorkspaceProject[]
  workflowTasks: MirroredWorkspaceTask[]
  tasksByProject: Record<string, MirroredWorkspaceTask[]>
  conversations: MirroredConversation[]
  taskSnapshots: Record<string, unknown>
  hasData: boolean
  partial?: boolean
  syncedAt?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : []
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function recordTime(value: unknown) {
  const parsed = Date.parse(asString(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function assetMapFromSnapshot(snapshot?: LegacyDesktopCloudMirrorSnapshot | null): Record<string, string> {
  const items = Array.isArray(snapshot?.assets?.items) ? snapshot.assets.items : []
  const map: Record<string, string> = {}
  for (const item of items) {
    const record = asRecord(item)
    const original = asString(record.original)
    const localUrl = asString(record.localUrl)
    if (original && localUrl) map[original] = localUrl
  }
  return map
}

function localizeMirrorValue(value: unknown, assetMap: Record<string, string>): unknown {
  if (typeof value === 'string') return assetMap[value] || value
  if (Array.isArray(value)) return value.map(item => localizeMirrorValue(item, assetMap))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      next[key] = localizeMirrorValue(item, assetMap)
    }
    return next
  }
  return value
}

function recordsFromMirrorSnapshot(snapshot?: LegacyDesktopCloudMirrorSnapshot | null): Record<string, unknown> {
  const records = asRecord(snapshot?.records)
  const assetMap = assetMapFromSnapshot(snapshot)
  if (!Object.keys(assetMap).length) return records
  return asRecord(localizeMirrorValue(records, assetMap))
}

function normalizeProject(item: Record<string, unknown>): MirroredWorkspaceProject | null {
  const id = asString(item.id)
  if (!id) return null
  return {
    id,
    name: asString(item.name, '未命名项目'),
    description: asString(item.description) || undefined,
    is_archived: Boolean(item.is_archived),
    task_count: Number(item.task_count || 0),
    created_at: asString(item.created_at),
    updated_at: asString(item.updated_at, asString(item.created_at)),
  }
}

function normalizeTask(item: Record<string, unknown>): MirroredWorkspaceTask | null {
  const id = asString(item.id)
  if (!id) return null
  return {
    id,
    project_id: asString(item.project_id) || undefined,
    name: asString(item.name, '未命名工作流'),
    status: asString(item.status, 'active'),
    workflow_kind: item.workflow_kind === 'canvas_flow' ? 'canvas_flow' : 'image_edit',
    meta: asRecord(item.meta),
    created_at: asString(item.created_at),
    updated_at: asString(item.updated_at, asString(item.created_at)),
    source_width: typeof item.source_width === 'number' ? item.source_width : undefined,
    source_height: typeof item.source_height === 'number' ? item.source_height : undefined,
  }
}

function normalizeConversation(
  item: Record<string, unknown>,
  type: MirroredConversation['type'],
  fallbackTitle: string,
): MirroredConversation | null {
  const id = asString(item.conversation_id) || asString(item.id)
  if (!id) return null
  const updated = asString(item.updated_at, asString(item.created_at))
  return {
    id,
    title: asString(item.title, asString(item.name, fallbackTitle)),
    type,
    message_count: Number(item.message_count || 0),
    created_at: asString(item.created_at, updated),
    updated_at: updated,
    conversationId: asString(item.conversation_id, id),
    messageId: asString(item.message_id) || undefined,
    assetId: asString(item.asset_id) || undefined,
    image: asString(item.image) || undefined,
    imageUrl: asString(item.image_url) || undefined,
    previewUrl: asString(item.preview_url) || undefined,
    thumbnailUrl: asString(item.thumbnail_url) || undefined,
    status: asString(item.status) || undefined,
  }
}

function normalizeImageHistoryRecord(item: Record<string, unknown>): MirroredConversation | null {
  const conversationId = asString(item.conversation_id)
  const messageId = asString(item.message_id)
  const source = asString(item.source)
  if (!conversationId || !messageId || !TEXT_TO_IMAGE_HISTORY_SOURCES.has(source)) return null

  // Image history is message based. Keeping the source timestamp here prevents
  // opening an old image from moving it into a newer date group.
  const createdAt = asString(item.created_at, asString(item.updated_at))
  return {
    id: `image:${conversationId}:${messageId}`,
    title: asString(item.prompt, asString(item.conversation_title, '文生图')),
    type: 'image',
    message_count: 1,
    created_at: createdAt,
    updated_at: createdAt,
    conversationId,
    messageId,
    assetId: asString(item.asset_id) || undefined,
    image: asString(item.image) || undefined,
    imageUrl: asString(item.image_url) || undefined,
    previewUrl: asString(item.preview_url) || undefined,
    thumbnailUrl: asString(item.thumbnail_url || item.thumbnail) || undefined,
    status: asString(item.status) || undefined,
  }
}

function mergeConversations(items: MirroredConversation[]) {
  const merged = new Map<string, MirroredConversation>()
  for (const item of items) {
    const prev = merged.get(item.id)
    if (!prev || recordTime(item.updated_at) >= recordTime(prev.updated_at)) {
      merged.set(item.id, { ...prev, ...item, title: item.title || prev?.title || '' })
    }
  }
  return Array.from(merged.values()).sort((a, b) => recordTime(b.updated_at) - recordTime(a.updated_at))
}

function mergeWorkflowTasks(items: MirroredWorkspaceTask[]) {
  const merged = new Map<string, MirroredWorkspaceTask>()
  for (const item of items) {
    const previous = merged.get(item.id)
    if (!previous || recordTime(item.updated_at) >= recordTime(previous.updated_at)) {
      merged.set(item.id, { ...previous, ...item })
    }
  }
  return Array.from(merged.values()).sort((a, b) => recordTime(b.updated_at) - recordTime(a.updated_at))
}

export function workspaceDataFromCloudRecords(recordsInput?: Record<string, unknown> | null, syncedAt?: string): WorkspaceMirrorData {
  const records = asRecord(recordsInput)
  const projects = asArray(asRecord(records.workspaceProjects).projects).map(normalizeProject).filter(Boolean) as MirroredWorkspaceProject[]
  const workflowTasks = mergeWorkflowTasks(
    asArray(asRecord(records.workspaceTasks).tasks).map(normalizeTask).filter(Boolean) as MirroredWorkspaceTask[],
  )
  const taskSnapshots = asRecord(records.taskSnapshots)
  const tasksByProject = workflowTasks.reduce<Record<string, MirroredWorkspaceTask[]>>((acc, task) => {
    const projectId = task.project_id || ''
    if (!projectId) return acc
    acc[projectId] = [...(acc[projectId] || []), task]
    return acc
  }, {})

  const baseConversations = asArray(records.conversations)
    .map(item => {
      const type = asString(item.type) as MirroredConversation['type']
      if (!['ppt', 'sci-fig', 'poster', 'paper', 'image'].includes(type)) return null
      if (type === 'image') return null
      return normalizeConversation(item, type, '历史记录')
    })
    .filter(Boolean) as MirroredConversation[]
  const pptConversations = asArray(asRecord(records.pptPresentations).items)
    .map(item => normalizeConversation(item, 'ppt', 'PPT'))
    .filter(Boolean) as MirroredConversation[]
  const posterConversations = asArray(records.posterHistory)
    .map(item => normalizeConversation(item, 'poster', '海报生成'))
    .filter(Boolean) as MirroredConversation[]
  const sciFigConversations = asArray(records.sciFigHistory)
    .map(item => normalizeConversation(item, 'sci-fig', '科研绘图'))
    .filter(Boolean) as MirroredConversation[]
  const imageConversations = asArray(records.imageHistory)
    .map(normalizeImageHistoryRecord)
    .filter(Boolean) as MirroredConversation[]

  const conversations = mergeConversations([
    ...baseConversations,
    ...pptConversations,
    ...posterConversations,
    ...sciFigConversations,
    ...imageConversations,
  ])

  return {
    projects,
    workflowTasks,
    tasksByProject,
    conversations,
    taskSnapshots,
    hasData: projects.length > 0 || workflowTasks.length > 0 || conversations.length > 0,
    syncedAt,
  }
}

export function workspaceDataFromCloudMirrorSnapshot(snapshot?: LegacyDesktopCloudMirrorSnapshot | null): WorkspaceMirrorData {
  const data = workspaceDataFromCloudRecords(recordsFromMirrorSnapshot(snapshot), snapshot?.syncedAt)
  data.partial = Boolean(snapshot?.partial)
  return data
}
