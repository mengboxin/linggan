import { describe, expect, it } from 'vitest'
import { isCanvasFlowEdgeActive } from '../CanvasFlowEdge'
import type { CanvasFlowEdge, CanvasFlowNode } from '../../../lib/canvas-flow-document'

const promptNode: CanvasFlowNode = {
  id: 'prompt-1',
  type: 'canvasFlow',
  position: { x: 0, y: 0 },
  data: { kind: 'prompt', title: '提示词', status: 'idle' },
}

const generatorNode: CanvasFlowNode = {
  id: 'generator-1',
  type: 'canvasFlow',
  position: { x: 400, y: 0 },
  data: { kind: 'generator', title: '图片生成', status: 'running' },
}

const resultNode: CanvasFlowNode = {
  id: 'result-1',
  type: 'canvasFlow',
  position: { x: 800, y: 0 },
  data: { kind: 'result', title: '生成结果', status: 'idle' },
}

const inputEdge: CanvasFlowEdge = {
  id: 'edge-prompt-generator',
  source: promptNode.id,
  target: generatorNode.id,
}

const outputEdge: CanvasFlowEdge = {
  id: 'edge-generator-result',
  source: generatorNode.id,
  target: resultNode.id,
}

describe('isCanvasFlowEdgeActive', () => {
  it('activates both sides of a live image-generation node', () => {
    const nodes = [promptNode, generatorNode, resultNode]

    expect(isCanvasFlowEdgeActive(inputEdge, nodes)).toBe(true)
    expect(isCanvasFlowEdgeActive(outputEdge, nodes)).toBe(true)
  })

  it('stops packet animation once the connected generator is no longer live', () => {
    const idleGenerator = {
      ...generatorNode,
      data: { ...generatorNode.data, status: 'completed' as const },
    }

    expect(isCanvasFlowEdgeActive(inputEdge, [promptNode, idleGenerator, resultNode])).toBe(false)
  })
})
