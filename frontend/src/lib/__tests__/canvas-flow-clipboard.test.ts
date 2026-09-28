import { describe, expect, it } from 'vitest'
import { createCanvasFlowNode } from '../canvas-flow-document'
import {
  CANVAS_FLOW_CLIPBOARD_KIND,
  CANVAS_FLOW_CLIPBOARD_VERSION,
  parseCanvasFlowClipboard,
  serializeCanvasFlowClipboard,
} from '../canvas-flow-clipboard'

describe('serializeCanvasFlowClipboard', () => {
  it('serializes only selected nodes and internal edges with portable runtime state', () => {
    const imageBase64 = 'data:image/png;base64,QUJDRA=='
    const prompt = {
      ...createCanvasFlowNode('prompt', { x: 10, y: 20 }, { prompt: 'cinematic station' }, 'prompt'),
      selected: true,
      measured: { width: 300, height: 210 },
    }
    const generator = {
      ...createCanvasFlowNode('generator', { x: 380, y: 20 }, {
        prompt: 'keep this prompt',
        modelId: 'image-2',
        taskId: 'task-running',
        clientRequestId: 'request-running',
        cancelRequested: true,
        submissionStarted: true,
        status: 'running',
        progress: 48,
        stale: true,
        error: 'old error',
        updatedAt: 123,
      }, 'generator'),
      selected: true,
      dragging: true,
    }
    const result = {
      ...createCanvasFlowNode('result', { x: 760, y: 20 }, {
        imageBase64,
        imageUrl: '/api/assets/result/original',
        previewUrl: '/api/assets/result/preview',
        thumbnailUrl: '/api/assets/result/thumbnail',
        assetId: 'result-asset',
        taskId: 'task-completed',
        clientRequestId: 'request-completed',
        cancelRequested: false,
        submissionStarted: false,
        status: 'completed',
        progress: 100,
        stale: false,
        updatedAt: 456,
      }, 'result'),
      selected: true,
    }
    const outside = createCanvasFlowNode('note', { x: 1100, y: 20 }, { text: 'outside' }, 'outside')
    const serialized = serializeCanvasFlowClipboard({
      nodes: [prompt, generator, result, outside],
      edges: [
        { id: 'prompt-generator', source: prompt.id, target: generator.id },
        { id: 'generator-result', source: generator.id, target: result.id },
        { id: 'result-outside', source: result.id, target: outside.id },
      ],
    })

    expect(serialized).not.toBeNull()
    const payload = JSON.parse(serialized!) as Record<string, any>
    expect(payload).toMatchObject({
      kind: CANVAS_FLOW_CLIPBOARD_KIND,
      version: CANVAS_FLOW_CLIPBOARD_VERSION,
    })
    expect(payload.nodes.map((node: { id: string }) => node.id)).toEqual(['prompt', 'generator', 'result'])
    expect(payload.edges.map((edge: { id: string }) => edge.id)).toEqual(['prompt-generator', 'generator-result'])

    const copiedGenerator = payload.nodes.find((node: { id: string }) => node.id === 'generator')
    expect(copiedGenerator.data).toMatchObject({
      prompt: 'keep this prompt',
      modelId: 'image-2',
      status: 'idle',
    })
    expect(copiedGenerator).not.toHaveProperty('selected')
    expect(copiedGenerator).not.toHaveProperty('measured')
    expect(copiedGenerator).not.toHaveProperty('dragging')
    for (const key of [
      'taskId',
      'clientRequestId',
      'cancelRequested',
      'submissionStarted',
      'progress',
      'stale',
      'error',
      'updatedAt',
    ]) expect(copiedGenerator.data).not.toHaveProperty(key)

    const copiedResult = payload.nodes.find((node: { id: string }) => node.id === 'result')
    expect(copiedResult.data).toMatchObject({
      imageBase64,
      imageUrl: '/api/assets/result/original',
      previewUrl: '/api/assets/result/preview',
      thumbnailUrl: '/api/assets/result/thumbnail',
      assetId: 'result-asset',
      status: 'completed',
    })
    expect(copiedResult.data).not.toHaveProperty('taskId')
    expect(copiedResult.data).not.toHaveProperty('clientRequestId')
    expect(generator.data).toMatchObject({ taskId: 'task-running', status: 'running', progress: 48 })
  })

  it('accepts an explicit selection and returns null for an empty selection', () => {
    const first = createCanvasFlowNode('note', { x: 0, y: 0 }, { text: 'first' }, 'first')
    const second = createCanvasFlowNode('note', { x: 300, y: 0 }, { text: 'second' }, 'second')
    const graph = {
      nodes: [first, second],
      edges: [{ id: 'first-second', source: first.id, target: second.id }],
    }

    const serialized = serializeCanvasFlowClipboard(graph, ['second'])

    expect(parseCanvasFlowClipboard(serialized!)?.nodes.map(node => node.id)).toEqual(['second'])
    expect(serializeCanvasFlowClipboard(graph)).toBeNull()
    expect(serializeCanvasFlowClipboard(graph, [])).toBeNull()
  })
})

describe('parseCanvasFlowClipboard', () => {
  function validPayload() {
    const first = { ...createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'hello' }, 'first'), selected: true }
    const second = { ...createCanvasFlowNode('generator', { x: 360, y: 0 }, {}, 'second'), selected: true }
    return JSON.parse(serializeCanvasFlowClipboard({
      nodes: [first, second],
      edges: [{ id: 'first-second', source: first.id, target: second.id }],
    })!) as Record<string, any>
  }

  it('round-trips a valid Linggan node subgraph', () => {
    const parsed = parseCanvasFlowClipboard(JSON.stringify(validPayload()))

    expect(parsed?.nodes.map(node => node.id)).toEqual(['first', 'second'])
    expect(parsed?.edges).toEqual([
      expect.objectContaining({ id: 'first-second', source: 'first', target: 'second' }),
    ])
  })

  it('rejects unrelated text, invalid JSON, and other Linggan document kinds or versions', () => {
    const payload = validPayload()

    expect(parseCanvasFlowClipboard('plain text')).toBeNull()
    expect(parseCanvasFlowClipboard('{')).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify({ ...payload, kind: 'canvas_flow' }))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify({ ...payload, version: 2 }))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify({ ...payload, nodes: 'not-an-array' }))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify({ ...payload, nodes: [] }))).toBeNull()
  })

  it('rejects malformed nodes, duplicate IDs, and dangling or malformed edges', () => {
    const payload = validPayload()
    const malformedPosition = structuredClone(payload)
    malformedPosition.nodes[0].position.x = '0'
    const malformedData = structuredClone(payload)
    malformedData.nodes[0].data.status = 123
    const duplicateNode = structuredClone(payload)
    duplicateNode.nodes[1].id = duplicateNode.nodes[0].id
    const danglingEdge = structuredClone(payload)
    danglingEdge.edges[0].target = 'missing'
    const duplicateEdge = structuredClone(payload)
    duplicateEdge.edges.push({ ...duplicateEdge.edges[0] })

    expect(parseCanvasFlowClipboard(JSON.stringify(malformedPosition))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(malformedData))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(duplicateNode))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(danglingEdge))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(duplicateEdge))).toBeNull()
  })

  it('enforces node and edge count limits', () => {
    const payload = validPayload()
    const tooManyNodes = {
      ...payload,
      nodes: Array.from({ length: 501 }, (_, index) => ({
        ...payload.nodes[0],
        id: `node-${index}`,
        position: { x: index, y: 0 },
        data: { ...payload.nodes[0].data },
        style: { ...payload.nodes[0].style },
      })),
      edges: [],
    }
    const tooManyEdges = {
      ...payload,
      edges: Array.from({ length: 1001 }, (_, index) => ({
        ...payload.edges[0],
        id: `edge-${index}`,
      })),
    }

    expect(parseCanvasFlowClipboard(JSON.stringify(tooManyNodes))).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(tooManyEdges))).toBeNull()
  })

  it('enforces the 48MB inline-image ceiling and allows callers to lower the budget', () => {
    const payload = validPayload()
    payload.nodes[0].data.imageBase64 = `data:image/png;base64,${'A'.repeat(80)}`

    expect(parseCanvasFlowClipboard(JSON.stringify(payload), { maxInlineImageBytes: 40 })).toBeNull()
    expect(parseCanvasFlowClipboard(JSON.stringify(payload), { maxInlineImageBytes: Number.POSITIVE_INFINITY })).not.toBeNull()
  })
})
