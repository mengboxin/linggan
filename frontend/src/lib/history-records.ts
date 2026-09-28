import { storageScopedLocalKey } from './storage-workspace'

const HISTORY_TOMBSTONES_STORAGE_KEY = 'pixelscribe.history.tombstones.v1'
const HISTORY_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const HISTORY_TOMBSTONE_LIMIT = 600

export type HistoryTombstoneScope = 'conversation' | 'image-message' | 'workspace-task' | 'ppt-upload'

interface HistoryTombstone {
  scope: HistoryTombstoneScope
  id: string
  deletedAt: number
}

export interface ImageHistoryIdentity {
  id?: string | null
  taskId?: string | null
  conversationId?: string | null
  messageId?: string | null
  assetId?: string | null
  imageUrl?: string | null
  previewUrl?: string | null
  thumbnailUrl?: string | null
  imageBase64?: string | null
}

function readHistoryTombstones(): HistoryTombstone[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageScopedLocalKey(HISTORY_TOMBSTONES_STORAGE_KEY)) || '[]')
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - HISTORY_TOMBSTONE_TTL_MS
    return parsed
      .filter((item): item is HistoryTombstone => (
        item
        && typeof item === 'object'
        && typeof item.scope === 'string'
        && typeof item.id === 'string'
        && typeof item.deletedAt === 'number'
        && item.deletedAt >= cutoff
      ))
      .slice(-HISTORY_TOMBSTONE_LIMIT)
  } catch {
    return []
  }
}

function writeHistoryTombstones(items: HistoryTombstone[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      storageScopedLocalKey(HISTORY_TOMBSTONES_STORAGE_KEY),
      JSON.stringify(items.slice(-HISTORY_TOMBSTONE_LIMIT)),
    )
  } catch {
    // The server remains authoritative when local storage is unavailable.
  }
}

function tombstoneKey(scope: HistoryTombstoneScope, id: string) {
  return `${scope}:${id}`
}

export function markHistoryDeleted(scope: HistoryTombstoneScope, id: string) {
  const normalizedId = String(id || '').trim()
  if (!normalizedId) return
  const next = readHistoryTombstones().filter(item => tombstoneKey(item.scope, item.id) !== tombstoneKey(scope, normalizedId))
  next.push({ scope, id: normalizedId, deletedAt: Date.now() })
  writeHistoryTombstones(next)
}

export function unmarkHistoryDeleted(scope: HistoryTombstoneScope, id: string) {
  const normalizedId = String(id || '').trim()
  if (!normalizedId) return
  writeHistoryTombstones(
    readHistoryTombstones().filter(item => tombstoneKey(item.scope, item.id) !== tombstoneKey(scope, normalizedId)),
  )
}

export function isHistoryDeleted(scope: HistoryTombstoneScope, id: string) {
  const normalizedId = String(id || '').trim()
  if (!normalizedId) return false
  const key = tombstoneKey(scope, normalizedId)
  return readHistoryTombstones().some(item => tombstoneKey(item.scope, item.id) === key)
}

export function filterDeletedHistoryRecords<T>(
  scope: HistoryTombstoneScope,
  records: T[],
  getId: (record: T) => string,
) {
  const deleted = new Set(
    readHistoryTombstones()
      .filter(item => item.scope === scope)
      .map(item => item.id),
  )
  if (!deleted.size) return records
  return records.filter(record => !deleted.has(String(getId(record) || '').trim()))
}

export function imageHistoryTombstoneId(record: ImageHistoryIdentity) {
  const conversationId = String(record.conversationId || '').trim()
  const messageId = String(record.messageId || '').trim()
  if (conversationId && messageId) return `${conversationId}:${messageId}`
  return String(record.id || record.assetId || '').trim()
}

export function imageHistoryRecordKey(record: ImageHistoryIdentity) {
  const taskId = String(record.taskId || '').trim()
  if (taskId) return `task:${taskId}`
  const assetId = String(record.assetId || '').trim()
  if (assetId) return `asset:${assetId}`
  const conversationId = String(record.conversationId || '').trim()
  const messageId = String(record.messageId || '').trim()
  if (conversationId && messageId) return `message:${conversationId}:${messageId}`
  const id = String(record.id || '').trim()
  if (id) return `id:${id}`
  return `image:${String(record.imageUrl || record.previewUrl || record.thumbnailUrl || record.imageBase64 || '').trim()}`
}

export function sameImageHistoryRecord(a?: ImageHistoryIdentity | null, b?: ImageHistoryIdentity | null) {
  if (!a || !b) return false
  const aTaskId = String(a.taskId || '').trim()
  const bTaskId = String(b.taskId || '').trim()
  if (aTaskId && bTaskId) return aTaskId === bTaskId

  const aAssetId = String(a.assetId || '').trim()
  const bAssetId = String(b.assetId || '').trim()
  if (aAssetId && bAssetId) return aAssetId === bAssetId

  const aConversationId = String(a.conversationId || '').trim()
  const bConversationId = String(b.conversationId || '').trim()
  const aMessageId = String(a.messageId || '').trim()
  const bMessageId = String(b.messageId || '').trim()
  if (aConversationId && bConversationId && aMessageId && bMessageId) {
    return aConversationId === bConversationId && aMessageId === bMessageId
  }

  const aId = String(a.id || '').trim()
  const bId = String(b.id || '').trim()
  if (aId && bId) return aId === bId
  return imageHistoryRecordKey(a) === imageHistoryRecordKey(b)
}

type MergeableImageHistoryRecord = ImageHistoryIdentity & {
  status?: string
  imageLoading?: boolean
  error?: string
}

/** Merge a server refresh into a local card without keeping stale terminal state. */
export function mergeImageHistoryRecords<
  T extends MergeableImageHistoryRecord,
  R extends MergeableImageHistoryRecord,
>(local: T, remote: R): T {
  const remoteStatus = String(remote.status || '').trim()
  const terminal = remoteStatus === 'completed' || remoteStatus === 'failed'
  return {
    ...local,
    ...remote,
    id: local.id || remote.id,
    taskId: local.taskId || remote.taskId,
    status: remoteStatus || local.status,
    imageLoading: terminal ? false : (remote.imageLoading ?? local.imageLoading),
    error: remoteStatus === 'failed'
      ? (remote.error || local.error)
      : remoteStatus === 'completed'
        ? undefined
        : (remote.error ?? local.error),
  } as T
}

export function dedupeImageHistoryRecords<T extends MergeableImageHistoryRecord>(records: T[]): T[] {
  const byIdentity = new Map<string, T>()
  records.forEach(record => {
    const key = imageHistoryRecordKey(record)
    const existing = byIdentity.get(key)
    if (!existing) {
      byIdentity.set(key, record)
      return
    }
    const existingStatus = String(existing.status || '')
    const nextStatus = String(record.status || '')
    if (existingStatus === 'completed' && nextStatus === 'failed') return
    if (existingStatus === 'failed' && nextStatus === 'completed') {
      byIdentity.set(key, mergeImageHistoryRecords(existing, record))
      return
    }
    const existingCreatedAt = Number((existing as { createdAt?: number }).createdAt || 0)
    const nextCreatedAt = Number((record as { createdAt?: number }).createdAt || 0)
    if (nextCreatedAt >= existingCreatedAt) byIdentity.set(key, record)
  })
  return Array.from(byIdentity.values())
}

export function clearHistoryTombstonesForTests() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(storageScopedLocalKey(HISTORY_TOMBSTONES_STORAGE_KEY))
}
