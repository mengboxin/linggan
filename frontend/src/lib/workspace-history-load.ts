export function workspaceHistoryForSnapshot<TCard>(snapshotCards?: TCard[]) {
  const cards = Array.isArray(snapshotCards) ? snapshotCards : []
  return {
    cards,
    selectedCard: cards[cards.length - 1] ?? null,
  }
}

export function workspaceReplacementForSnapshot<TLayer, TCard>(snapshot: {
  layers?: TLayer[]
  canvasImage?: string
  cards?: TCard[]
}) {
  const history = workspaceHistoryForSnapshot(snapshot.cards)
  return {
    layers: Array.isArray(snapshot.layers) ? snapshot.layers : [],
    canvasImage: typeof snapshot.canvasImage === 'string' && snapshot.canvasImage ? snapshot.canvasImage : null,
    ...history,
  }
}

type WorkspaceRestoreBinding = { taskId?: string; taskName?: string } | null | undefined

export function workspaceRestoreTarget(explicit: WorkspaceRestoreBinding, remembered: WorkspaceRestoreBinding) {
  const requestedTaskId = explicit?.taskId?.trim() || ''
  if (requestedTaskId) {
    return { taskId: requestedTaskId, taskName: explicit?.taskName?.trim() || '' }
  }
  const rememberedTaskId = remembered?.taskId?.trim() || ''
  if (!rememberedTaskId) return null
  return { taskId: rememberedTaskId, taskName: remembered?.taskName?.trim() || '' }
}
