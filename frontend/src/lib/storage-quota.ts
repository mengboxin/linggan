import { apiUrl, auth } from './auth'

export interface StorageSummary {
  unlimited: boolean
  used_bytes: number
  large_asset_warning_bytes: number
  retention: {
    web_history_days: number
    expiry_notice_days: number
    export_days: number
    temporary_days: number
  }
  breakdown: {
    images: { bytes: number; count: number; expiring_count: number }
    ppt_files?: { bytes: number; count: number; expiring_count: number }
    ppt_slides?: { bytes: number; count: number; expiring_count: number }
    ppt_uploads: { bytes: number; count: number; expiring_count: number }
    sources?: Record<string, { bytes: number; count: number; expiring_count: number }>
  }
}

export async function fetchStorageSummary(): Promise<StorageSummary> {
  const res = await auth.fetchWithAuth(apiUrl('/api/storage/summary'))
  if (!res.ok) throw new Error('Failed to load storage summary')
  return res.json()
}

export function formatStorageBytes(value: number): string {
  const size = Number(value || 0)
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${size} B`
}
