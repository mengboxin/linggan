import { apiUrl, auth } from './auth'

export type ImageAssetRole = 'source' | 'reference'

export interface ImageAssetReference {
  asset_id: string
  role: ImageAssetRole
  index: number
}

interface ArchiveImageReferenceInput {
  image: string
  category: string
  taskId?: string
  itemId?: string
  prompt?: string
  modelId?: string
  role?: ImageAssetRole
  index?: number
}

const archiveCache = new Map<string, Promise<ImageAssetReference>>()
const MAX_ARCHIVE_CACHE_ENTRIES = 80

function trimArchiveCache() {
  while (archiveCache.size > MAX_ARCHIVE_CACHE_ENTRIES) {
    const oldest = archiveCache.keys().next().value
    if (!oldest) return
    archiveCache.delete(oldest)
  }
}

/**
 * Archive an uploaded image once and use its asset id everywhere afterwards.
 * This deliberately does not fall back to a preview URL or inline image at
 * submission time: all creative modules share the same server-owned original.
 */
export async function archiveImageReference(input: ArchiveImageReferenceInput): Promise<ImageAssetReference> {
  const image = input.image.trim()
  if (!image) throw new Error('参考图为空，无法提交')

  const role = input.role || 'reference'
  const index = role === 'source' ? 0 : Math.max(1, input.index || 1)
  const cacheKey = `${role}:${image}`
  const cached = archiveCache.get(cacheKey)
  if (cached) return cached

  const request = auth.fetchWithAuth(apiUrl('/api/assets/images'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: image,
      task_id: input.taskId || 'reference',
      item_id: input.itemId || `${input.category}-${role}-${index}`,
      prompt: input.prompt || '',
      model_id: input.modelId || '',
      category: input.category || 'reference',
    }),
  }).then(async response => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.detail || `参考图归档失败 (${response.status})`)
    }
    const payload = await response.json()
    const assetId = String(payload.asset_id || payload.assetId || '').trim()
    if (!assetId) throw new Error('参考图归档失败，未返回固定图片资产')
    return { asset_id: assetId, role, index }
  })

  archiveCache.set(cacheKey, request)
  trimArchiveCache()
  try {
    return await request
  } catch (error) {
    archiveCache.delete(cacheKey)
    throw error
  }
}
