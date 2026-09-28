import { apiUrl, auth } from './auth'

export interface ImageVariantSource {
  renderedB64?: string | null
  renderedUrl?: string | null
  previewUrl?: string | null
  imageUrl?: string | null
  thumbnailUrl?: string | null
}

function firstImageValue(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const MAX_STABLE_ASSET_URLS = 300
const stableAssetUrls = new Map<string, string>()

function rememberStableAssetUrl(identity: string, url: string) {
  if (!identity || !url) return
  stableAssetUrls.delete(identity)
  stableAssetUrls.set(identity, url)
  while (stableAssetUrls.size > MAX_STABLE_ASSET_URLS) {
    const oldest = stableAssetUrls.keys().next().value
    if (!oldest) break
    stableAssetUrls.delete(oldest)
  }
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('image read failed'))
    reader.readAsDataURL(file)
  })
}

export function displayImageSource(source?: ImageVariantSource | null): string {
  return firstImageValue(
    source?.previewUrl,
    source?.renderedUrl,
    source?.imageUrl,
    source?.renderedB64,
    source?.thumbnailUrl,
  )
}

export function thumbnailImageSource(source?: ImageVariantSource | null): string {
  return firstImageValue(
    source?.thumbnailUrl,
    source?.previewUrl,
    source?.renderedUrl,
    source?.imageUrl,
    source?.renderedB64,
  )
}

export function originalImageSource(source?: ImageVariantSource | null): string {
  return firstImageValue(
    source?.imageUrl,
    source?.renderedUrl,
    source?.renderedB64,
    source?.previewUrl,
    source?.thumbnailUrl,
  )
}

export function withAssetToken(url: string, forceFreshToken = false): string {
  if (!url) return url
  const raw = url.trim()
  const path = (() => {
    if (raw.startsWith('/api/assets/')) return raw
    try {
      const parsed = new URL(raw)
      return parsed.pathname.startsWith('/api/assets/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : ''
    } catch {
      return ''
    }
  })()
  if (!path) return url
  const identity = imageSourceIdentity(path)
  const cached = stableAssetUrls.get(identity)
  if (!forceFreshToken && cached) return cached
  const token = auth.getAccessToken()
  const absolute = apiUrl(path)
  const [base, hash = ''] = absolute.split('#')
  const target = new URL(base, window.location.origin)
  target.searchParams.delete('token')
  const cleanAbsolute = `${target.toString()}${hash ? `#${hash}` : ''}`
  if (!token) {
    rememberStableAssetUrl(identity, cleanAbsolute)
    return cleanAbsolute
  }
  const sep = cleanAbsolute.includes('?') ? '&' : '?'
  const tokenized = `${cleanAbsolute}${sep}token=${encodeURIComponent(token)}`
  rememberStableAssetUrl(identity, tokenized)
  return tokenized
}

/**
 * Asset access tokens and retry markers are transport details, not a different
 * image. This identity lets polling refresh metadata without remounting a
 * preview that has already loaded.
 */
const TRANSIENT_IMAGE_QUERY_PARAMS = new Set([
  '_asset_retry',
  'access_token',
  'auth_key',
  'auth_token',
  'expires',
  'expiry',
  'key-pair-id',
  'ossaccesskeyid',
  'policy',
  'sig',
  'sign',
  'signature',
  'token',
])

function isTransientImageQueryParam(name: string) {
  const normalized = name.toLowerCase()
  return TRANSIENT_IMAGE_QUERY_PARAMS.has(normalized)
    || normalized.startsWith('x-amz-')
    || normalized.startsWith('x-goog-')
    || normalized.startsWith('x-oss-')
}

export function imageSourceIdentity(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''

  try {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const parsed = new URL(raw, origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw
    for (const name of [...parsed.searchParams.keys()]) {
      if (isTransientImageQueryParam(name)) parsed.searchParams.delete(name)
    }
    parsed.searchParams.sort()
    const query = parsed.searchParams.toString()
    const pathIdentity = `${parsed.pathname}${query ? `?${query}` : ''}${parsed.hash || ''}`
    if (parsed.pathname.startsWith('/api/assets/') || raw.startsWith('/') || parsed.origin === origin) {
      return pathIdentity
    }
    return `${parsed.origin}${pathIdentity}`
  } catch {
    return raw
  }
}

export function isProtectedAssetImage(value?: string | null): boolean {
  const raw = (value || '').trim()
  if (!raw) return false
  if (raw.startsWith('/api/assets/')) return true
  try {
    const parsed = new URL(raw, window.location.origin)
    if (parsed.pathname.startsWith('/api/assets/')) return true
  } catch {
    return false
  }
  return false
}

export type ProtectedAssetVariant = 'original' | 'preview' | 'thumb'

export function assetVariantUrl(
  assetId?: string | null,
  variant: ProtectedAssetVariant = 'original',
): string {
  const id = (assetId || '').trim()
  return id ? `/api/assets/${encodeURIComponent(id)}/${variant}` : ''
}

export function protectedAssetVariantUrl(
  value?: string | null,
  variant: ProtectedAssetVariant = 'original',
): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const parsed = new URL(raw, origin)
    const match = parsed.pathname.match(/^\/api\/assets\/([^/?#]+)(?:\/[^/?#]+)?\/?$/)
    if (!match?.[1]) return ''
    return `/api/assets/${match[1]}/${variant}`
  } catch {
    return ''
  }
}

export async function refreshProtectedAssetImage(value?: string | null, attempt = 1): Promise<string> {
  if (!isProtectedAssetImage(value)) return imageSrc(value)
  const refreshedSession = await auth.refreshImageAccessToken().catch(() => false)
  if (!refreshedSession) return ''
  const refreshed = imageSrc(value, 'image/png', true)
  if (!refreshed) return ''
  try {
    const url = new URL(refreshed, window.location.origin)
    url.searchParams.set('_asset_retry', String(Math.max(1, attempt)))
    return url.toString()
  } catch {
    const separator = refreshed.includes('?') ? '&' : '?'
    return `${refreshed}${separator}_asset_retry=${Math.max(1, attempt)}`
  }
}

function inlineBase64ImageMime(value: string): string {
  if (value.length < 16 || (value.startsWith('/') && !value.startsWith('/9j/'))) return ''
  const sample = value.slice(0, 96).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sample)) return ''

  try {
    const encodedPrefix = sample.slice(0, 64)
    const decoded = atob(encodedPrefix.padEnd(Math.ceil(encodedPrefix.length / 4) * 4, '='))
    const byte = (index: number) => decoded.charCodeAt(index)
    const ascii = (start: number, length: number) => decoded.slice(start, start + length)

    if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) return 'image/jpeg'
    if (byte(0) === 0x89 && ascii(1, 3) === 'PNG') return 'image/png'
    if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
    if (ascii(0, 2) === 'BM') return 'image/bmp'
    if (
      (ascii(0, 4) === 'II*\u0000')
      || (byte(0) === 0x4d && byte(1) === 0x4d && byte(2) === 0x00 && byte(3) === 0x2a)
    ) return 'image/tiff'
    if (byte(0) === 0x00 && byte(1) === 0x00 && byte(2) === 0x01 && byte(3) === 0x00) return 'image/x-icon'
    if (ascii(4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 4))) return 'image/avif'
    if (decoded.trimStart().startsWith('<svg')) return 'image/svg+xml'
  } catch {
    return ''
  }
  return ''
}

export function imageSrc(value?: string | null, fallbackMime = 'image/png', forceFreshAssetToken = false): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (
    raw.startsWith('data:') ||
    raw.startsWith('file:') ||
    raw.startsWith('blob:')
  ) {
    return raw
  }
  const inlineMime = inlineBase64ImageMime(raw)
  if (inlineMime) return `data:${inlineMime};base64,${raw}`
  if (raw.startsWith('/api/assets/')) return withAssetToken(raw, forceFreshAssetToken)
  if (/^https?:\/\//i.test(raw) && raw.includes('/api/assets/')) return withAssetToken(raw, forceFreshAssetToken)
  if (raw.startsWith('/')) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  return `data:${fallbackMime};base64,${raw}`
}

export function isRemoteLikeImage(value?: string | null): boolean {
  const raw = (value || '').trim()
  return /^https?:\/\//i.test(raw) || raw.startsWith('/api/assets/')
}

export interface CanvasSafeImageSource {
  src: string
  release: () => void
}

/**
 * Remote images must be materialized as local Blob URLs before being drawn to
 * an exportable canvas. Loading them directly can taint the canvas even when
 * the same URL displays correctly in an <img> element.
 */
export async function canvasSafeImageSource(value?: string | null): Promise<CanvasSafeImageSource> {
  const resolved = imageSrc(value)
  if (!resolved) throw new Error('empty image source')
  if (!isRemoteLikeImage(resolved)) {
    return { src: resolved, release: () => {} }
  }

  let response: Response | null = null
  let failure: unknown = null
  try {
    response = await fetch(resolved)
    if (!response.ok) failure = new Error(`image fetch failed (${response.status})`)
  } catch (error) {
    failure = error
  }

  if ((!response || !response.ok) && isProtectedAssetImage(value)) {
    const refreshed = await refreshProtectedAssetImage(value)
    if (refreshed) {
      try {
        response = await fetch(refreshed)
        if (!response.ok) failure = new Error(`image fetch failed (${response.status})`)
      } catch (error) {
        failure = error
      }
    }
  }

  if (!response?.ok) {
    throw failure instanceof Error ? failure : new Error('image fetch failed')
  }
  const objectUrl = URL.createObjectURL(await response.blob())
  let released = false
  return {
    src: objectUrl,
    release: () => {
      if (released) return
      released = true
      URL.revokeObjectURL(objectUrl)
    },
  }
}

/**
 * Save a generated file. Electron owns the destination choice; browsers keep
 * their native download behavior.
 */
function filenameForImageBlob(filename: string, mimeType: string) {
  const extension = mimeType.includes('jpeg') ? 'jpg'
    : mimeType.includes('webp') ? 'webp'
      : mimeType.includes('avif') ? 'avif'
        : mimeType.includes('svg') ? 'svg'
          : mimeType.includes('png') ? 'png'
            : ''
  if (!extension) return filename
  return /\.(?:png|jpe?g|webp|avif|svg)$/i.test(filename)
    ? filename.replace(/\.(?:png|jpe?g|webp|avif|svg)$/i, `.${extension}`)
    : `${filename}.${extension}`
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const resolvedFilename = filenameForImageBlob(filename, blob.type)
  if (typeof window !== 'undefined' && window.electronAPI?.downloadFile) {
    const dataUrl = await fileToDataUrl(blob)
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const result = await window.electronAPI.downloadFile({
      data,
      filename: resolvedFilename,
      mimeType: blob.type || 'application/octet-stream',
    })
    if (!result.ok && !result.cancelled) {
      throw new Error(result.error || 'native image save failed')
    }
    return
  }

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = resolvedFilename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/**
 * Materialize remote images before downloading. This avoids signed or
 * cross-origin URLs opening in the current page and routes desktop saves
 * through Electron's native file picker.
 */
export async function downloadImageSource(value: string | null | undefined, filename: string): Promise<void> {
  const local = await canvasSafeImageSource(value)
  try {
    const response = await fetch(local.src)
    if (!response.ok) throw new Error(`image download failed (${response.status})`)
    await downloadBlob(await response.blob(), filename)
  } finally {
    local.release()
  }
}
