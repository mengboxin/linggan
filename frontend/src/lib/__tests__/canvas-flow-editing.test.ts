import { describe, expect, it } from 'vitest'
import { createCanvasFlowDocument, createCanvasFlowNode } from '../canvas-flow-document'
import {
  canvasFlowEdgeNeighborhood,
  canvasFlowGraphSnapshotSignature,
  canvasFlowLayoutSignature,
  createCanvasFlowExportFilename,
  duplicateCanvasFlowSelection,
  layoutCanvasFlowNodes,
} from '../canvas-flow-editing'

describe('duplicateCanvasFlowSelection', () => {
  it('copies selected nodes and their internal edges with clean interaction and generator runtime state', () => {
    const prompt = {
      ...createCanvasFlowNode('prompt', { x: 10, y: 20 }, { prompt: '雨夜车站' }, 'prompt'),
      selected: true,
      measured: { width: 300, height: 210 },
    }
    const reference = {
      ...createCanvasFlowNode('image', { x: 10, y: 280 }, {
        imageUrl: '/api/assets/reference/original',
        previewUrl: '/api/assets/reference/preview',
        assetId: 'reference',
      }, 'reference'),
      selected: true,
      measured: { width: 320, height: 300 },
    }
    const generator = {
      ...createCanvasFlowNode('generator', { x: 400, y: 120 }, {
        prompt: '保留节点自己的提示词',
        modelId: 'image-2',
        taskId: 'task-running',
        clientRequestId: 'request-running',
        status: 'running',
        progress: 63,
        error: '旧错误',
      }, 'generator'),
      selected: true,
      measured: { width: 320, height: 240 },
      dragging: true,
    }
    const result = {
      ...createCanvasFlowNode('result', { x: 800, y: 120 }, {
        imageUrl: '/api/assets/result/original',
        thumbnailUrl: '/api/assets/result/thumb',
        assetId: 'result',
        taskId: 'task-completed',
        status: 'completed',
        progress: 100,
      }, 'result'),
      selected: true,
      measured: { width: 340, height: 340 },
    }
    const outside = createCanvasFlowNode('note', { x: 1100, y: 120 }, { text: '不复制' }, 'outside')
    const document = createCanvasFlowDocument('复制测试')
    document.nodes = [prompt, reference, generator, result, outside]
    document.edges = [
      { id: 'prompt-generator', source: prompt.id, target: generator.id, selected: true },
      { id: 'reference-generator', source: reference.id, target: generator.id },
      { id: 'generator-result', source: generator.id, target: result.id },
      { id: 'result-outside', source: result.id, target: outside.id },
    ]

    const duplicated = duplicateCanvasFlowSelection(document, { offset: { x: 64, y: 32 } })

    expect(duplicated.duplicatedNodes).toHaveLength(4)
    expect(duplicated.duplicatedEdges).toHaveLength(3)
    expect(duplicated.edges).toHaveLength(7)
    expect(duplicated.nodeIdMap).toEqual({
      prompt: 'prompt-copy',
      reference: 'reference-copy',
      generator: 'generator-copy',
      result: 'result-copy',
    })
    expect(duplicated.duplicatedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'prompt-copy', target: 'generator-copy' }),
      expect.objectContaining({ source: 'reference-copy', target: 'generator-copy' }),
      expect.objectContaining({ source: 'generator-copy', target: 'result-copy' }),
    ]))
    expect(duplicated.duplicatedEdges.some(edge => edge.target === outside.id)).toBe(false)

    const promptCopy = duplicated.duplicatedNodes.find(node => node.id === 'prompt-copy')!
    const referenceCopy = duplicated.duplicatedNodes.find(node => node.id === 'reference-copy')!
    const generatorCopy = duplicated.duplicatedNodes.find(node => node.id === 'generator-copy')!
    const resultCopy = duplicated.duplicatedNodes.find(node => node.id === 'result-copy')!
    expect(promptCopy).toMatchObject({ position: { x: 74, y: 52 }, data: { prompt: '雨夜车站' } })
    expect(referenceCopy.data).toMatchObject({
      imageUrl: '/api/assets/reference/original',
      previewUrl: '/api/assets/reference/preview',
      assetId: 'reference',
    })
    expect(generatorCopy.data).toMatchObject({
      prompt: '保留节点自己的提示词',
      modelId: 'image-2',
      status: 'idle',
    })
    expect(generatorCopy.data).not.toHaveProperty('taskId')
    expect(generatorCopy.data).not.toHaveProperty('clientRequestId')
    expect(generatorCopy.data).not.toHaveProperty('progress')
    expect(generatorCopy.data).not.toHaveProperty('error')
    expect(generatorCopy).not.toHaveProperty('selected')
    expect(generatorCopy).not.toHaveProperty('measured')
    expect(generatorCopy).not.toHaveProperty('dragging')
    expect(resultCopy.data).toMatchObject({
      imageUrl: '/api/assets/result/original',
      thumbnailUrl: '/api/assets/result/thumb',
      assetId: 'result',
      taskId: 'task-completed',
      status: 'completed',
      progress: 100,
    })

    expect(generator.data).toMatchObject({ taskId: 'task-running', status: 'running', progress: 63 })
    expect(document.nodes).toHaveLength(5)
    expect(document.edges).toHaveLength(4)
  })

  it('accepts explicit selection and resolves generated ID collisions without randomness', () => {
    const document = createCanvasFlowDocument('稳定 ID')
    document.nodes = [
      createCanvasFlowNode('note', { x: 0, y: 0 }, {}, 'note'),
      createCanvasFlowNode('note', { x: 200, y: 0 }, {}, 'note-copy'),
    ]

    const duplicated = duplicateCanvasFlowSelection(document, {
      selectedNodeIds: ['note'],
      createId: () => 'note-copy',
    })

    expect(duplicated.duplicatedNodes[0].id).toBe('note-copy-2')
  })

  it('returns the original arrays when the selection is empty', () => {
    const document = createCanvasFlowDocument('空选择')
    const duplicated = duplicateCanvasFlowSelection(document, { selectedNodeIds: [] })

    expect(duplicated.nodes).toBe(document.nodes)
    expect(duplicated.edges).toBe(document.edges)
    expect(duplicated.duplicatedNodes).toEqual([])
    expect(duplicated.nodeIdMap).toEqual({})
  })
})

describe('canvasFlowGraphSnapshotSignature', () => {
  it('ignores interaction state, measured layout, array order, and object key insertion order', () => {
    const first = createCanvasFlowNode('prompt', { x: 10, y: 20 }, { prompt: '海边日落' }, 'first')
    const second = createCanvasFlowNode('generator', { x: 400, y: 20 }, { modelId: 'image-2' }, 'second')
    const graphA = {
      nodes: [
        { ...first, selected: true, measured: { width: 300, height: 210 }, dragging: true },
        second,
      ],
      edges: [{ id: 'edge', source: first.id, target: second.id, selected: true }],
    }
    const graphB = {
      nodes: [
        { ...second, measured: { width: 999, height: 999 }, selected: true, resizing: true },
        { ...first, selected: false, dragging: false },
      ],
      edges: [{ target: second.id, source: first.id, id: 'edge', selected: false }],
    }

    expect(canvasFlowGraphSnapshotSignature(graphB)).toBe(canvasFlowGraphSnapshotSignature(graphA))
  })

  it('changes when editable graph content changes', () => {
    const node = createCanvasFlowNode('prompt', { x: 10, y: 20 }, { prompt: '海边日落' }, 'first')
    const before = canvasFlowGraphSnapshotSignature({ nodes: [node], edges: [] })
    const moved = canvasFlowGraphSnapshotSignature({
      nodes: [{ ...node, position: { x: 11, y: 20 } }],
      edges: [],
    })
    const edited = canvasFlowGraphSnapshotSignature({
      nodes: [{ ...node, data: { ...node.data, prompt: '雪山日出' } }],
      edges: [],
    })

    expect(moved).not.toBe(before)
    expect(edited).not.toBe(before)
  })

  it('uses a bounded full-image fingerprint and detects changes between the old sample points', () => {
    const firstImage = `data:image/png;base64,${'A'.repeat(20_000)}`
    const changedIndex = 50
    const secondImage = `${firstImage.slice(0, changedIndex)}B${firstImage.slice(changedIndex + 1)}`
    const firstNode = createCanvasFlowNode('image', { x: 0, y: 0 }, { imageBase64: firstImage }, 'image')
    const secondNode = { ...firstNode, data: { ...firstNode.data, imageBase64: secondImage } }

    const firstSignature = canvasFlowGraphSnapshotSignature({ nodes: [firstNode], edges: [] })
    const secondSignature = canvasFlowGraphSnapshotSignature({ nodes: [secondNode], edges: [] })

    expect(firstSignature.length).toBeLessThan(2_000)
    expect(secondSignature).not.toBe(firstSignature)
  })

  it('invalidates the fingerprint cache when a node data object is mutated in place', () => {
    const firstImage = `data:image/png;base64,${'A'.repeat(20_000)}`
    const changedIndex = 50
    const secondImage = `${firstImage.slice(0, changedIndex)}B${firstImage.slice(changedIndex + 1)}`
    const node = createCanvasFlowNode('image', { x: 0, y: 0 }, { imageBase64: firstImage }, 'image')
    const firstSignature = canvasFlowGraphSnapshotSignature({ nodes: [node], edges: [] })

    node.data.imageBase64 = secondImage

    expect(canvasFlowGraphSnapshotSignature({ nodes: [node], edges: [] })).not.toBe(firstSignature)
  })
})

describe('createCanvasFlowExportFilename', () => {
  it('preserves readable Chinese while removing unsafe filename characters', () => {
    expect(createCanvasFlowExportFilename('  城市 / 夜景：方案?.json  '))
      .toBe('城市 夜景 方案.canvas-flow.json')
  })

  it('has deterministic fallbacks for empty and reserved Windows names', () => {
    expect(createCanvasFlowExportFilename('***')).toBe('canvas-flow.canvas-flow.json')
    expect(createCanvasFlowExportFilename('CON')).toBe('canvas-flow-CON.canvas-flow.json')
    expect(createCanvasFlowExportFilename('项目.canvas-flow.json')).toBe('项目.canvas-flow.json')
  })
})

describe('canvasFlowEdgeNeighborhood', () => {
  it('highlights the directed chain through a clicked edge and ignores a side branch', () => {
    const edges = [
      { id: 'topic-script', source: 'topic', target: 'script' },
      { id: 'script-board', source: 'script', target: 'board' },
      { id: 'board-shot', source: 'board', target: 'shot' },
      { id: 'style-other', source: 'style', target: 'other' },
    ]
    const neighborhood = canvasFlowEdgeNeighborhood(edges, 'script-board')
    expect([...neighborhood.nodeIds].sort()).toEqual(['board', 'script', 'shot', 'topic'])
    expect([...neighborhood.edgeIds].sort()).toEqual(['board-shot', 'script-board', 'topic-script'])
    expect(neighborhood.nodeIds.has('style')).toBe(false)
    expect(neighborhood.edgeIds.has('style-other')).toBe(false)
  })
})

describe('layoutCanvasFlowNodes', () => {
  it('places dependencies from left to right and stacks siblings without overlap', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 400, y: 300 }, {}, 'prompt')
    const reference = createCanvasFlowNode('image', { x: 50, y: 900 }, {}, 'reference')
    const generator = createCanvasFlowNode('generator', { x: 80, y: 40 }, {}, 'generator')
    const result = createCanvasFlowNode('result', { x: 20, y: 10 }, {}, 'result')
    const arranged = layoutCanvasFlowNodes({
      nodes: [prompt, reference, generator, result],
      edges: [
        { id: 'prompt-generator', source: 'prompt', target: 'generator' },
        { id: 'reference-generator', source: 'reference', target: 'generator' },
        { id: 'generator-result', source: 'generator', target: 'result' },
      ],
    })
    const byId = new Map(arranged.map(node => [node.id, node]))

    expect(byId.get('generator')!.position.x).toBeGreaterThan(byId.get('prompt')!.position.x)
    expect(byId.get('result')!.position.x).toBeGreaterThan(byId.get('generator')!.position.x)
    expect(byId.get('reference')!.position.y).toBeGreaterThan(byId.get('prompt')!.position.y)
  })

  it('uses live node dimensions before measured and styled sizes after a resize', () => {
    const resized = {
      ...createCanvasFlowNode('prompt', { x: 20, y: 30 }, {}, 'resized'),
      width: 640,
      height: 420,
      measured: { width: 360, height: 240 },
      style: { width: 280, height: 190 },
    }
    const sibling = createCanvasFlowNode('image', { x: 800, y: 800 }, {}, 'sibling')
    const generator = createCanvasFlowNode('generator', { x: 60, y: 40 }, {}, 'generator')
    const arranged = layoutCanvasFlowNodes({
      nodes: [resized, sibling, generator],
      edges: [
        { id: 'resized-generator', source: resized.id, target: generator.id },
        { id: 'sibling-generator', source: sibling.id, target: generator.id },
      ],
    })
    const byId = new Map(arranged.map(node => [node.id, node]))

    expect(byId.get('sibling')!.position.y).toBeGreaterThanOrEqual(
      byId.get('resized')!.position.y + resized.height + 48,
    )
    expect(byId.get('generator')!.position.x).toBeGreaterThanOrEqual(
      byId.get('resized')!.position.x + resized.width + 120,
    )
  })

  it('produces the same layout signature when automatic arrangement is already satisfied', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, {}, 'prompt')
    const generator = createCanvasFlowNode('generator', { x: 420, y: 0 }, {}, 'generator')
    const nodes = [prompt, generator]
    const arranged = layoutCanvasFlowNodes({
      nodes,
      edges: [{ id: 'prompt-generator', source: prompt.id, target: generator.id }],
    })

    expect(canvasFlowLayoutSignature(arranged)).toBe(canvasFlowLayoutSignature(nodes))
  })
})
