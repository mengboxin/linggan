import { storageScopedLocalKey } from './storage-workspace'

export const DEFAULT_ACTIVE_JOB_TTL_MS = 2 * 60 * 60 * 1000

export interface ActiveJobRecord {
  jobId: string
  timestamp: number
  [key: string]: unknown
}

export function saveActiveJobRecord<T extends { jobId: string }>(key: string, payload: T) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageScopedLocalKey(key), JSON.stringify({ ...payload, timestamp: Date.now() }))
  } catch {
    // Active-job restore is best-effort; the live UI state still owns the current run.
  }
}

export function readActiveJobRecord<T extends ActiveJobRecord>(
  key: string,
  maxAgeMs = DEFAULT_ACTIVE_JOB_TTL_MS,
): T | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const scopedKey = storageScopedLocalKey(key)
    const raw = localStorage.getItem(scopedKey)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.jobId !== 'string') {
      localStorage.removeItem(scopedKey)
      return null
    }
    const timestamp = Number(parsed.timestamp || 0)
    if (!timestamp || Date.now() - timestamp > maxAgeMs) {
      localStorage.removeItem(scopedKey)
      return null
    }
    return { ...parsed, timestamp } as T
  } catch {
    localStorage.removeItem(storageScopedLocalKey(key))
    return null
  }
}

export function clearActiveJobRecord(key: string, jobId?: string | null) {
  if (typeof localStorage === 'undefined') return
  if (!jobId) {
    localStorage.removeItem(storageScopedLocalKey(key))
    return
  }
  try {
    const scopedKey = storageScopedLocalKey(key)
    const raw = localStorage.getItem(scopedKey)
    if (!raw) {
      localStorage.removeItem(scopedKey)
      return
    }
    const parsed = JSON.parse(raw)
    if (parsed?.jobId === jobId) localStorage.removeItem(scopedKey)
  } catch {
    localStorage.removeItem(storageScopedLocalKey(key))
  }
}
