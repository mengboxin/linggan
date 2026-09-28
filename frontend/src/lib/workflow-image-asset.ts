import type { CanvasNode } from './workflow-store'

export type WorkflowAssetVariant = 'original' | 'preview' | 'thumb'

export interface CanonicalWorkflowImage {
  assetId: string
  imageBase64: string
  imageUrl: string
  previewUrl: string
  thumbnailUrl: string
  thumbnailBase64: string
}

export function workflowAssetVariantUrl(
  assetId?: string | null,
  variant: WorkflowAssetVariant = 'original',
): string {
  const id = (assetId || '').trim()
  return id ? `/api/assets/${id}/${variant}` : ''
}

export function workflowAssetIdFromUrl(value?: string | null): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw, window.location.origin)
    const match = parsed.pathname.match(/^\/api\/assets\/([^/?#]+)\/(?:original|preview|thumb|thumbnail)$/)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

export function canonicalWorkflowImage(assetId?: string | null): CanonicalWorkflowImage | null {
  const id = (assetId || '').trim()
  if (!id) return null
  const imageUrl = workflowAssetVariantUrl(id, 'original')
  return {
    assetId: id,
    // Kept for backwards-compatible consumers. It is a stable original URL, never inline data.
    imageBase64: imageUrl,
    imageUrl,
    previewUrl: workflowAssetVariantUrl(id, 'preview'),
    thumbnailUrl: workflowAssetVariantUrl(id, 'thumb'),
    thumbnailBase64: workflowAssetVariantUrl(id, 'thumb'),
  }
}

export function workflowNodeAssetUrl(
  node?: Pick<CanvasNode, 'assetId'> | null,
  variant: WorkflowAssetVariant = 'original',
): string {
  return workflowAssetVariantUrl(node?.assetId, variant)
}

/**
 * A single import source for pre-canonical snapshots. This is intentionally
 * migration-only: normal rendering and model submission must use assetId.
 */
export function legacyWorkflowNodeImportSource(node?: Partial<CanvasNode> | null): string {
  if (!node) return ''
  return (
    node.imageBase64 ||
    node.imageUrl ||
    node.previewUrl ||
    node.thumbnailUrl ||
    node.localImageUrl ||
    node.thumbnailBase64 ||
    ''
  ).trim()
}

export function workflowNodeDisplayUrl(node?: CanvasNode | null): string {
  return workflowNodeAssetUrl(node, 'preview') || legacyWorkflowNodeImportSource(node)
}

export function workflowNodeOriginalUrl(node?: CanvasNode | null): string {
  return workflowNodeAssetUrl(node, 'original')
}
