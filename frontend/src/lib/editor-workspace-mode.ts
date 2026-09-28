import type { EditorMode } from './editor-store'

export function resolveWorkspaceRestoreMode({
  requestedRouteMode,
  workflowKind,
  hasWorkflowSnapshot,
  hasLayers,
  hasGenerationCards,
}: {
  requestedRouteMode: EditorMode | null
  workflowKind?: 'image_edit' | 'canvas_flow'
  hasWorkflowSnapshot: boolean
  hasLayers: boolean
  hasGenerationCards: boolean
}): EditorMode | null {
  if (requestedRouteMode === 'IMAGE_EDIT' || workflowKind === 'image_edit') return 'IMAGE_EDIT'
  if (hasWorkflowSnapshot || hasLayers) return 'IMAGE_EDIT'
  if (hasGenerationCards) return 'TEXT_TO_IMAGE'
  return requestedRouteMode
}
