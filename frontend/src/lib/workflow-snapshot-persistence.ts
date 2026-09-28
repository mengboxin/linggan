import type { SnapshotJSON } from './workflow-store'

export function prepareWorkflowSnapshotForPersistence(snapshot: SnapshotJSON | null): SnapshotJSON | null {
  if (!snapshot) return null
  return {
    ...snapshot,
    nodes: snapshot.nodes.map(node => ({ ...node })),
    arrows: snapshot.arrows.map(arrow => ({ ...arrow })),
  }
}
