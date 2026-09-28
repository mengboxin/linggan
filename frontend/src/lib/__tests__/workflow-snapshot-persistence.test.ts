import { describe, expect, it } from 'vitest'

import { prepareWorkflowSnapshotForPersistence } from '../workflow-snapshot-persistence'
import type { SnapshotJSON } from '../workflow-store'

describe('workflow snapshot persistence', () => {
  it('keeps submitted loading nodes and their task identity across refreshes', () => {
    const snapshot: SnapshotJSON = {
      version: 1,
      sessionId: 'session-1',
      savedAt: 1,
      nodes: [
        {
          id: 'source',
          imageBase64: 'https://example.test/source.png',
          label: 'source',
          modelName: 'import',
          prompt: '',
          timestamp: 1,
          x: 0,
          y: 0,
          index: 1,
        },
        {
          id: 'pending',
          imageBase64: '',
          label: 'pending',
          modelName: 'image-model',
          prompt: 'edit request',
          timestamp: 2,
          x: 300,
          y: 0,
          index: 1.1,
          parentId: 'source',
          loading: true,
          progress: 10,
          generationTaskId: 'task-1',
          generationVariantIndex: 0,
        },
      ],
      arrows: [
        { id: 'arrow-1', fromNodeId: 'source', toNodeId: 'pending', stepLabel: 'edit' },
      ],
    }

    const persisted = prepareWorkflowSnapshotForPersistence(snapshot)

    expect(persisted?.nodes.map(node => node.id)).toEqual(['source', 'pending'])
    expect(persisted?.arrows.map(arrow => arrow.id)).toEqual(['arrow-1'])
    expect(persisted?.nodes[1]?.generationTaskId).toBe('task-1')
  })
})
