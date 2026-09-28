import { describe, expect, it } from 'vitest'

import { createPendingWorkflowPlan, reconcileWorkflowTaskNodes } from '../workflow-generation'
import type { CanvasNode } from '../workflow-store'

describe('workflow generation planning', () => {
  it('creates a visible recoverable node before the backend returns a task id', () => {
    const source: CanvasNode = {
      id: 'source',
      imageBase64: 'https://example.test/source.png',
      label: 'source',
      modelName: 'import',
      prompt: '',
      timestamp: 1,
      x: 10,
      y: 20,
      index: 1,
    }

    const plan = createPendingWorkflowPlan({
      existingNodes: [source],
      existingArrows: [],
      targetParent: source,
      outputCount: 1,
      modelId: 'image-model',
      prompt: 'replace the clothes',
      refImages: [],
      clientRequestId: 'request-1',
      now: () => 2,
      createId: (() => {
        const ids = ['pending-1', 'arrow-1']
        return () => ids.shift() || 'fallback'
      })(),
      language: 'en',
    })

    expect(plan.primaryNodeId).toBe('pending-1')
    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0]).toMatchObject({
      id: 'pending-1',
      parentId: 'source',
      loading: true,
      generationClientRequestId: 'request-1',
      generationVariantIndex: 0,
    })
    expect(plan.nodes[0].generationTaskId).toBeUndefined()
    expect(plan.arrows).toEqual([
      expect.objectContaining({ id: 'arrow-1', fromNodeId: 'source', toNodeId: 'pending-1' }),
    ])
  })

  it('reconciles a restored pending node with its completed backend task', () => {
    const pending = {
      id: 'pending-1',
      imageBase64: '',
      label: 'pending',
      modelName: 'image-model',
      prompt: 'edit request',
      timestamp: 2,
      x: 300,
      y: 0,
      index: 1.1,
      loading: true,
      generationTaskId: 'task-1',
      generationVariantIndex: 0,
    } satisfies CanvasNode

    const patches = reconcileWorkflowTaskNodes({
      nodes: [pending],
      taskId: 'task-1',
      status: 'completed',
      images: [{
        index: 0,
        b64: 'https://example.test/result.png',
        imageUrl: 'https://example.test/result.png',
        previewUrl: '',
        thumbnailUrl: '',
        assetId: 'asset-1',
      }],
      language: 'en',
    })

    expect(patches).toEqual([{
      nodeId: 'pending-1',
      patch: expect.objectContaining({
        loading: false,
        progress: 100,
        imageBase64: 'https://example.test/result.png',
        assetId: 'asset-1',
      }),
    }])
  })
})
