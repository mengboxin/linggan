import { auth } from './auth'
import { storageWorkspaceCacheScope } from './storage-workspace'

interface PersistentCacheEnvelope<T> {
  version: 1
  savedAt: number
  value: T
}

export interface PersistentCacheValue<T> {
  value: T
  savedAt: number
}

export function userScopedCacheKey(baseKey: string) {
  const base = `${baseKey}:${auth.getUser?.()?.id || 'anonymous'}`
  const scope = storageWorkspaceCacheScope()
  return scope ? `${base}:${scope}` : base
}

export function readPersistentCache<T>(key: string, fallback: T): PersistentCacheValue<T> {
  if (typeof window === 'undefined') return { value: fallback, savedAt: 0 }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { value: fallback, savedAt: 0 }
    const parsed = JSON.parse(raw) as PersistentCacheEnvelope<T> | T
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as PersistentCacheEnvelope<T>).version === 1
      && 'value' in parsed
    ) {
      const envelope = parsed as PersistentCacheEnvelope<T>
      return {
        value: envelope.value,
        savedAt: Number.isFinite(envelope.savedAt) ? envelope.savedAt : 0,
      }
    }
    return { value: parsed as T, savedAt: 0 }
  } catch {
    return { value: fallback, savedAt: 0 }
  }
}

export function writePersistentCache<T>(key: string, value: T, savedAt = Date.now()) {
  if (typeof window === 'undefined') return false
  try {
    const envelope: PersistentCacheEnvelope<T> = { version: 1, savedAt, value }
    localStorage.setItem(key, JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}
