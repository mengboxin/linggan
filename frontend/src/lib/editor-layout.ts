export function isImageEditLayerToolboxVisible(
  view: 'canvas' | 'workflow',
  canvasMode: 'smart' | 'layers',
): boolean {
  return view === 'canvas' && canvasMode === 'layers'
}

export function isImageEditRightWorkspaceVisible(
  view: 'canvas' | 'workflow',
  canvasMode: 'smart' | 'layers',
): boolean {
  return view === 'canvas' && canvasMode === 'layers'
}

export function isImageEditLeftSidebarVisible(
  view: 'canvas' | 'workflow',
  canvasMode: 'smart' | 'layers',
): boolean {
  return view === 'workflow' || isImageEditLayerToolboxVisible(view, canvasMode)
}

export function isImageEditWorkflowActionPanelVisible(
  view: 'canvas' | 'workflow',
  nodeCount: number,
): boolean {
  return view === 'workflow' && nodeCount > 0
}

export function shouldReserveImageEditComposerSpace(
  view: 'canvas' | 'workflow',
  canvasMode: 'smart' | 'layers',
): boolean {
  // Both retouch and layer canvases are full-bleed; the composer is a floating overlay.
  return false
}
