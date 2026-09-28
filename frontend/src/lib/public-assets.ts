import { apiUrl } from './auth'

const CONFIGURED_PUBLIC_ASSET_BASE = String(import.meta.env.VITE_PUBLIC_ASSET_BASE_URL || '').trim()
const WORKER_PUBLIC_ASSET_BASE = '/public-assets'

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function publicAssetBaseUrl(configuredBase = CONFIGURED_PUBLIC_ASSET_BASE): string {
  if (configuredBase) return configuredBase.replace(/\/+$/, '')
  if (import.meta.env.PROD) return apiUrl(WORKER_PUBLIC_ASSET_BASE)
  return apiUrl('/api/system/public-assets')
}

export function publicAssetUrl(path: string, configuredBase = CONFIGURED_PUBLIC_ASSET_BASE): string {
  return joinUrl(publicAssetBaseUrl(configuredBase), path)
}
