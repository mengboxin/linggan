import { describe, expect, it } from 'vitest'
import { createCanvasFlowDocument, createCanvasFlowNode } from '../canvas-flow-document'
import { validateCanvasFlowConnection } from '../canvas-flow-connections'

function connectionDocument() {
  return {
    ...createCanvasFlowDocument('Connection editing'),
    nodes: [
      createCanvasFlowNode('prompt', { x: 0, y: 0 }, {}, 'node-a'),
      createCanvasFlowNode('generator', { x: 320, y: 0 }, {}, 'node-b'),
      createCanvasFlowNode('result', { x: 640, y: 0 }, {}, 'node-c'),
      createCanvasFlowNode('generator', { x: 640, y: 320 }, {}, 'node-d'),
    ],
    edges: [
      { id: 'edge-a-b', source: 'node-a', target: 'node-b', sourceHandle: 'output', targetHandle: 'input' },
      { id: 'edge-b-c', source: 'node-b', target: 'node-c', sourceHandle: 'output', targetHandle: 'input' },
    ],
  }
}

describe('validateCanvasFlowConnection', () => {
  it('allows moving an existing edge endpoint while ignoring that edge during validation', () => {
    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-a', target: 'node-d', sourceHandle: 'output', targetHandle: 'input' },
      'edge-a-b',
    )).toEqual({ valid: true, code: null })
  })

  it('rejects a reconnection that would create a directed cycle', () => {
    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-c', target: 'node-b', sourceHandle: 'output', targetHandle: 'input' },
      'edge-a-b',
    )).toEqual({ valid: false, code: 'cycle' })
  })

  it('rejects a duplicate connection but permits reconnecting an edge to its current endpoints', () => {
    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-b', target: 'node-c', sourceHandle: 'output', targetHandle: 'input' },
      'edge-a-b',
    )).toEqual({ valid: false, code: 'duplicate' })

    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-a', target: 'node-b', sourceHandle: 'output', targetHandle: 'input' },
      'edge-a-b',
    )).toEqual({ valid: true, code: null })
  })

  it('keeps result nodes bound to one generator output', () => {
    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-a', target: 'node-c', sourceHandle: 'output', targetHandle: 'input' },
    )).toEqual({ valid: false, code: 'result-source-required' })

    expect(validateCanvasFlowConnection(
      connectionDocument(),
      { source: 'node-d', target: 'node-c', sourceHandle: 'output', targetHandle: 'input' },
    )).toEqual({ valid: false, code: 'result-single-input' })
  })
})
