export interface CachedImageLoad {
  naturalAspect?: string
}

const MAX_CACHED_IMAGES = 200
const MAX_CACHE_KEY_LENGTH = 4096
const loadedImages = new Map<string, CachedImageLoad>()

function cacheKey(src?: string | null) {
  const value = (src || '').trim()
  if (!value || value.length > MAX_CACHE_KEY_LENGTH || value.startsWith('data:')) return ''
  return imageSourceIdentity(value)
}

export function getCachedImageLoad(src?: string | null): CachedImageLoad | undefined {
  const key = cacheKey(src)
  if (!key) return undefined
  const cached = loadedImages.get(key)
  if (!cached) return undefined
  loadedImages.delete(key)
  loadedImages.set(key, cached)
  return cached
}

export function cacheImageLoad(src: string, value: CachedImageLoad = {}) {
  const key = cacheKey(src)
  if (!key) return
  loadedImages.delete(key)
  loadedImages.set(key, value)
  while (loadedImages.size > MAX_CACHED_IMAGES) {
    const oldest = loadedImages.keys().next().value
    if (!oldest) break
    loadedImages.delete(oldest)
  }
}

export function forgetCachedImageLoad(src?: string | null) {
  const key = cacheKey(src)
  if (key) loadedImages.delete(key)
}
import { imageSourceIdentity } from './image-url'
