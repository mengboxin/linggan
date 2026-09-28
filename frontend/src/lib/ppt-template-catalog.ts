import { apiUrl, auth } from './auth'

export interface PPTTemplateOption {
  id: string
  name: string
  description: string
  preview_url: string
  tags: string[]
  palette: string[]
  fonts: string[]
  layout_count: number
  localized_name?: string
  localized_description?: string
  localized_tags?: string[]
  layout_previews?: PPTLayoutPreview[]
  capabilities: string[]
  source: {
    project: string
    url: string
    revision: string
    license: string
    attribution?: string
  }
}

export interface PPTLayoutPreview {
  id: string
  description: string
  localized_description?: string
  element_types: Record<string, number>
  image_frames: Array<{
    x?: number
    y?: number
    width?: number
    height?: number
    fit?: string
  }>
  canvas_width: number
  canvas_height: number
}

export async function loadPptTemplateCatalog(): Promise<PPTTemplateOption[]> {
  try {
    const response = await auth.fetchWithAuth(apiUrl('/api/ppt/templates'))
    if (!response.ok) return []
    const payload = await response.json()
    return Array.isArray(payload?.items) ? payload.items as PPTTemplateOption[] : []
  } catch {
    return []
  }
}
