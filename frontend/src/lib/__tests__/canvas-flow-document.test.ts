import { describe, expect, it, vi } from 'vitest'
import {
  canAppendCanvasFlowInlineImages,
  createPortableCanvasFlowDocument,
  canvasFlowPreview,
  canvasFlowInlineImageBytes,
  canvasFlowPersistenceSignature,
  canvasFlowSnapshotPayload,
  createCanvasFlowDocument,
  createCanvasFlowNode,
  ensureCanvasFlowResultEdge,
  extendCanvasFlowGraph,
  findCanvasFlowConnectedResultNodeId,
  markCanvasFlowDownstreamStale,
  parseCanvasFlowDocument,
  parseCanvasFlowSnapshot,
  reconcileCanvasFlowSavedImages,
  resolveCanvasFlowGeneratorInputs,
  serializeCanvasFlowDocument,
  upsertCanvasFlowResultNode,
} from '../canvas-flow-document'

describe('canvas flow document', () => {
  it('round trips a versioned graph and removes invalid edges', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'node-id' })
    const prompt = createCanvasFlowNode('prompt', { x: 10, y: 20 }, { prompt: '一座雨夜车站' }, 'prompt-1')
    const result = createCanvasFlowNode('result', { x: 420, y: 20 }, { imageUrl: '/api/assets/a/original' }, 'result-1')
    const document = createCanvasFlowDocument('雨夜车站')
    document.nodes = [prompt, result]
    document.edges = [
      { id: 'valid', source: prompt.id, target: result.id },
      { id: 'dangling', source: prompt.id, target: 'missing' },
    ]

    const restored = parseCanvasFlowDocument(JSON.parse(JSON.stringify(serializeCanvasFlowDocument(document))))

    expect(restored?.title).toBe('雨夜车站')
    expect(restored?.nodes).toHaveLength(2)
    expect(restored?.edges.map(edge => edge.id)).toEqual(['valid'])
  })

  it('preserves a generator pause across serialization and parsing', () => {
    const document = createCanvasFlowDocument('Paused workflow')
    document.nodes = [
      createCanvasFlowNode('generator', { x: 0, y: 0 }, { paused: true }, 'paused-generator'),
    ]

    const restored = parseCanvasFlowDocument(JSON.parse(JSON.stringify(serializeCanvasFlowDocument(document))))

    expect(restored?.nodes[0].data.paused).toBe(true)
  })

  it('persists the live XYFlow resize dimensions instead of the initial style size', () => {
    const document = createCanvasFlowDocument('Resized workflow')
    const resized = createCanvasFlowNode('image', { x: 0, y: 0 }, {}, 'resized-image')
    resized.width = 480
    resized.height = 450
    document.nodes = [resized]

    const restored = parseCanvasFlowDocument(JSON.parse(JSON.stringify(serializeCanvasFlowDocument(document))))

    expect(restored?.nodes[0].style).toMatchObject({ width: 480, height: 450 })
  })

  it('removes cloud execution state from a portable workflow document', () => {
    const document = createCanvasFlowDocument('Portable workflow')
    document.nodes = [
      createCanvasFlowNode('generator', { x: 0, y: 0 }, {
        status: 'running',
        taskId: 'task-from-source-record',
        clientRequestId: 'request-from-source-record',
        progress: 64,
        error: 'transient transport error',
      }, 'generator'),
      createCanvasFlowNode('result', { x: 360, y: 0 }, {
        status: 'completed',
        taskId: 'task-from-source-record',
        imageUrl: '/api/assets/result/original',
        progress: 100,
      }, 'result'),
    ]

    const portable = createPortableCanvasFlowDocument(document)

    expect(portable.nodes[0].data).toMatchObject({
      status: 'idle',
      progress: 0,
      error: '',
    })
    expect(portable.nodes[0].data.taskId).toBeUndefined()
    expect(portable.nodes[0].data.clientRequestId).toBeUndefined()
    expect(portable.nodes[1].data).toMatchObject({
      status: 'completed',
      progress: 100,
      imageUrl: '/api/assets/result/original',
    })
    expect(portable.nodes[1].data.taskId).toBeUndefined()
  })

  it('restores from a workspace snapshot and exposes the latest result preview', () => {
    const document = createCanvasFlowDocument('产品海报')
    document.nodes = [
      createCanvasFlowNode('image', { x: 0, y: 0 }, { previewUrl: '/api/assets/ref/preview' }, 'ref'),
      createCanvasFlowNode('result', { x: 360, y: 0 }, { thumbnailUrl: '/api/assets/out/thumb' }, 'out'),
    ]
    const payload = canvasFlowSnapshotPayload(document)

    expect(parseCanvasFlowSnapshot(payload)?.nodes).toHaveLength(2)
    expect(canvasFlowPreview(document)).toBe('/api/assets/out/thumb')
    expect(payload.workflow_snapshot.kind).toBe('canvas_flow')
  })

  it('preserves an asset-backed result and derives its preview after restoring the workspace', () => {
    const document = createCanvasFlowDocument('Asset-backed canvas')
    document.nodes = [
      createCanvasFlowNode('result', { x: 360, y: 0 }, { assetId: 'asset-restored-result' }, 'result'),
    ]

    const restored = parseCanvasFlowSnapshot(canvasFlowSnapshotPayload(document))

    expect(restored?.nodes[0].data.assetId).toBe('asset-restored-result')
    expect(canvasFlowPreview(restored!)).toBe('/api/assets/asset-restored-result/preview')
  })

  it('does not treat a legacy image-edit snapshot as a canvas flow document', () => {
    expect(parseCanvasFlowSnapshot({ workflow_snapshot: { nodes: [], arrows: [] } })).toBeNull()
  })

  it('replays a completed generation without duplicating its result node or edge', () => {
    const generator = createCanvasFlowNode('generator', { x: 100, y: 80 }, { taskId: 'task-1', status: 'running' }, 'generator-1')
    const result = { imageUrl: '/api/assets/result/original' }

    const once = upsertCanvasFlowResultNode([generator], generator.id, 'task-1', result)
    const twice = upsertCanvasFlowResultNode(once, generator.id, 'task-1', result)
    const edgesOnce = ensureCanvasFlowResultEdge([], generator.id, 'task-1')
    const edgesTwice = ensureCanvasFlowResultEdge(edgesOnce, generator.id, 'task-1')

    expect(twice.filter(node => node.id === 'result-task-1')).toHaveLength(1)
    expect(edgesTwice).toHaveLength(1)
    expect(upsertCanvasFlowResultNode([], generator.id, 'task-1', result)).toEqual([])
  })

  it('resolves prompt and image inputs through connected upstream nodes', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: '雨夜车站' }, 'prompt')
    const image = createCanvasFlowNode('image', { x: 0, y: 200 }, { imageUrl: '/api/assets/ref/original' }, 'image')
    const generator = createCanvasFlowNode('generator', { x: 360, y: 80 }, {}, 'generator')
    const document = createCanvasFlowDocument('连接测试')
    document.nodes = [prompt, image, generator]
    document.edges = [
      { id: 'prompt-edge', source: prompt.id, target: generator.id },
      { id: 'image-edge', source: image.id, target: generator.id },
    ]

    const inputs = resolveCanvasFlowGeneratorInputs(document, generator.id)

    expect(inputs.prompt).toBe('雨夜车站')
    expect(inputs.referenceNodes.map(node => node.id)).toEqual(['image'])
  })

  it('uses connected note text as a generator prompt', () => {
    const note = createCanvasFlowNode('note', { x: 0, y: 0 }, { text: '  雨后的玻璃温室  ' }, 'note')
    const generator = createCanvasFlowNode('generator', { x: 360, y: 0 }, {}, 'generator')
    const document = createCanvasFlowDocument('文字块提示词')
    document.nodes = [note, generator]
    document.edges = [{ id: 'note-generator', source: note.id, target: generator.id }]

    const inputs = resolveCanvasFlowGeneratorInputs(document, generator.id)

    expect(inputs.prompt).toBe('雨后的玻璃温室')
    expect(inputs.promptNodes.map(node => node.id)).toEqual(['note'])
  })

  it('uses a connected upstream generator result as a reference for a directly connected generator', () => {
    const upstream = createCanvasFlowNode('generator', { x: 0, y: 0 }, {
      status: 'completed',
      taskId: 'upstream-task',
    }, 'upstream')
    const upstreamResult = createCanvasFlowNode('result', { x: 360, y: 180 }, {
      assetId: 'upstream-result-asset',
      status: 'completed',
      taskId: 'upstream-task',
    }, 'upstream-result')
    const downstream = createCanvasFlowNode('generator', { x: 720, y: 0 }, { prompt: '改成清晨光线' }, 'downstream')
    const document = createCanvasFlowDocument('生成器直连')
    document.nodes = [upstream, upstreamResult, downstream]
    document.edges = [
      { id: 'generator-generator', source: upstream.id, target: downstream.id },
      { id: 'generator-result', source: upstream.id, target: upstreamResult.id },
    ]

    const inputs = resolveCanvasFlowGeneratorInputs(document, downstream.id)

    expect(inputs.referenceNodes.map(node => node.id)).toEqual(['upstream-result'])
    expect(inputs.referenceNodes[0].data.assetId).toBe('upstream-result-asset')
  })

  it('uses a completed image result as the only video reference instead of its source image', () => {
    const sourceImage = createCanvasFlowNode('image', { x: 0, y: 180 }, {
      assetId: 'source-image-asset',
    }, 'source-image')
    const imageGenerator = createCanvasFlowNode('generator', { x: 340, y: 180 }, {
      status: 'completed',
      taskId: 'image-task',
    }, 'image-generator')
    const imageResult = createCanvasFlowNode('result', { x: 680, y: 180 }, {
      assetId: 'image-result-asset',
      status: 'completed',
      taskId: 'image-task',
    }, 'image-result')
    const prompt = createCanvasFlowNode('prompt', { x: 680, y: 0 }, {
      prompt: '让画面轻微运动',
    }, 'video-prompt')
    const videoGenerator = createCanvasFlowNode('video-generator', { x: 1020, y: 80 }, {}, 'video-generator')
    const document = createCanvasFlowDocument('图生视频引用链')
    document.nodes = [sourceImage, imageGenerator, imageResult, prompt, videoGenerator]
    document.edges = [
      { id: 'source-image-generator', source: sourceImage.id, target: imageGenerator.id },
      { id: 'image-generator-result', source: imageGenerator.id, target: imageResult.id },
      { id: 'image-result-video', source: imageResult.id, target: videoGenerator.id },
      { id: 'prompt-video', source: prompt.id, target: videoGenerator.id },
    ]

    const inputs = resolveCanvasFlowGeneratorInputs(document, videoGenerator.id)

    expect(inputs.prompt).toBe('让画面轻微运动')
    expect(inputs.referenceNodes.map(node => node.id)).toEqual(['image-result'])
  })

  it('keeps a completed fan-out result usable when a sibling makes the generator aggregate fail', () => {
    const upstream = createCanvasFlowNode('generator', { x: 0, y: 0 }, {
      status: 'failed',
      taskId: '',
    }, 'upstream')
    const successfulResult = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      assetId: 'successful-branch-asset',
      status: 'completed',
      taskId: 'successful-branch-task',
      stale: false,
    }, 'successful-result')
    const downstream = createCanvasFlowNode('generator', { x: 720, y: 0 }, { prompt: '继续成功分支' }, 'downstream')
    const document = createCanvasFlowDocument('部分成功分支')
    document.nodes = [upstream, successfulResult, downstream]
    document.edges = [
      { id: 'upstream-result', source: upstream.id, target: successfulResult.id },
      { id: 'result-downstream', source: successfulResult.id, target: downstream.id },
    ]

    const inputs = resolveCanvasFlowGeneratorInputs(document, downstream.id)

    expect(inputs.referenceNodes.map(node => node.id)).toEqual(['successful-result'])
  })

  it('ignores stale and task-mismatched outputs when a generator has multiple results', () => {
    const upstream = createCanvasFlowNode('generator', { x: 0, y: 0 }, {
      status: 'completed',
      taskId: 'latest-task',
    }, 'upstream')
    const fresh = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      imageUrl: '/api/assets/latest/original',
      status: 'completed',
      taskId: 'latest-task',
      stale: false,
    }, 'fresh-result')
    const stale = createCanvasFlowNode('result', { x: 360, y: 240 }, {
      imageUrl: '/api/assets/old/original',
      status: 'completed',
      taskId: 'old-task',
      stale: true,
    }, 'stale-result')
    const mismatched = createCanvasFlowNode('result', { x: 360, y: 480 }, {
      imageUrl: '/api/assets/mismatch/original',
      status: 'completed',
      taskId: 'other-task',
      stale: false,
    }, 'mismatched-result')
    const downstream = createCanvasFlowNode('generator', { x: 760, y: 0 }, { prompt: 'Continue' }, 'downstream')
    const document = createCanvasFlowDocument('Multiple outputs')
    document.nodes = [upstream, fresh, stale, mismatched, downstream]
    document.edges = [
      { id: 'upstream-fresh', source: upstream.id, target: fresh.id },
      { id: 'upstream-stale', source: upstream.id, target: stale.id },
      { id: 'upstream-mismatch', source: upstream.id, target: mismatched.id },
      { id: 'fresh-downstream', source: fresh.id, target: downstream.id },
      { id: 'stale-downstream', source: stale.id, target: downstream.id },
      { id: 'mismatch-downstream', source: mismatched.id, target: downstream.id },
    ]

    const inputs = resolveCanvasFlowGeneratorInputs(document, downstream.id)

    expect(inputs.referenceNodes.map(node => node.id)).toEqual(['fresh-result'])
  })

  it('marks downstream generation stale while preserving existing result images', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: '旧提示词' }, 'prompt')
    const firstGenerator = createCanvasFlowNode('generator', { x: 320, y: 0 }, {
      status: 'completed',
      taskId: 'first-task',
      clientRequestId: 'first-request',
      progress: 100,
    }, 'first-generator')
    const firstResult = createCanvasFlowNode('result', { x: 680, y: 0 }, {
      imageUrl: '/api/assets/first/original',
      assetId: 'first-asset',
      status: 'completed',
      taskId: 'first-task',
    }, 'first-result')
    const secondGenerator = createCanvasFlowNode('generator', { x: 1040, y: 0 }, {
      status: 'completed',
      taskId: 'second-task',
      clientRequestId: 'second-request',
      progress: 100,
    }, 'second-generator')
    const secondResult = createCanvasFlowNode('result', { x: 1400, y: 0 }, {
      imageUrl: '/api/assets/second/original',
      assetId: 'second-asset',
      status: 'completed',
      taskId: 'second-task',
    }, 'second-result')
    const nodes = [prompt, firstGenerator, firstResult, secondGenerator, secondResult]
    const edges = [
      { id: 'prompt-first', source: prompt.id, target: firstGenerator.id },
      { id: 'first-output', source: firstGenerator.id, target: firstResult.id },
      { id: 'first-second', source: firstResult.id, target: secondGenerator.id },
      { id: 'second-output', source: secondGenerator.id, target: secondResult.id },
    ]

    const staleNodes = markCanvasFlowDownstreamStale(nodes, edges, [prompt.id])
    const staleById = new Map(staleNodes.map(node => [node.id, node]))

    expect(staleById.get('first-generator')?.data).toMatchObject({
      status: 'idle',
      stale: true,
      taskId: '',
      clientRequestId: '',
      progress: 0,
    })
    expect(staleById.get('second-generator')?.data).toMatchObject({
      status: 'idle',
      stale: true,
      taskId: '',
      clientRequestId: '',
      progress: 0,
    })
    expect(staleById.get('first-result')?.data).toMatchObject({
      stale: true,
      imageUrl: '/api/assets/first/original',
      assetId: 'first-asset',
      taskId: 'first-task',
    })
    expect(staleById.get('second-result')?.data).toMatchObject({
      stale: true,
      imageUrl: '/api/assets/second/original',
      assetId: 'second-asset',
      taskId: 'second-task',
    })
  })

  it('does not mark a never-run idle generator stale', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'Changed' }, 'prompt')
    const idle = createCanvasFlowNode('generator', { x: 320, y: 0 }, { status: 'idle' }, 'idle')

    const nodes = markCanvasFlowDownstreamStale(
      [prompt, idle],
      [{ id: 'prompt-idle', source: prompt.id, target: idle.id }],
      [prompt.id],
    )

    expect(nodes.find(node => node.id === idle.id)?.data).toMatchObject({ status: 'idle' })
    expect(nodes.find(node => node.id === idle.id)?.data.stale).not.toBe(true)
  })

  it('marks an existing result itself stale when its generator input is removed or replaced', () => {
    const result = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      imageUrl: '/api/assets/result/original',
      status: 'completed',
      taskId: 'task-result',
    }, 'result')

    const [staleResult] = markCanvasFlowDownstreamStale([result], [], [result.id])

    expect(staleResult.data).toMatchObject({
      stale: true,
      imageUrl: '/api/assets/result/original',
      taskId: 'task-result',
    })
  })

  it('replaces saved inline images and ignores runtime progress in the autosave signature', () => {
    const inline = 'data:image/png;base64,AAAA'
    const current = createCanvasFlowDocument('保存测试')
    current.nodes = [
      createCanvasFlowNode('image', { x: 0, y: 0 }, { imageBase64: inline }, 'image'),
      createCanvasFlowNode('generator', { x: 360, y: 0 }, { status: 'running', progress: 10 }, 'generator'),
    ]
    const persisted = parseCanvasFlowDocument(JSON.parse(JSON.stringify(current)))!
    persisted.nodes[0].data.imageBase64 = '/api/assets/ref/original'
    persisted.nodes[0].data.previewUrl = '/api/assets/ref/preview'

    const reconciled = reconcileCanvasFlowSavedImages(current, current, persisted)
    const before = canvasFlowPersistenceSignature(reconciled)
    reconciled.nodes[1].data.progress = 80
    reconciled.nodes[1].data.updatedAt = Date.now()

    expect(reconciled.nodes[0].data.imageBase64).toBe('/api/assets/ref/original')
    expect(canvasFlowPersistenceSignature(reconciled)).toBe(before)
  })

  it('extends a source node with one positioned node and one explicit output-to-input edge', () => {
    const source = createCanvasFlowNode('prompt', { x: 100, y: 160 }, { prompt: '一座风暴中的城市' }, 'source')
    const occupied = createCanvasFlowNode('image', { x: 540, y: 160 }, {}, 'occupied')

    const extended = extendCanvasFlowGraph({
      nodes: [source, occupied],
      edges: [],
      sourceId: source.id,
      kind: 'generator',
      nodeId: 'generator-2',
    })

    expect(extended.createdNode?.id).toBe('generator-2')
    expect(extended.createdNode?.data.kind).toBe('generator')
    expect(extended.nodes).toHaveLength(3)
    expect(extended.createdNode?.position.x).toBeGreaterThan(source.position.x)
    expect(extended.createdNode?.position.y).not.toBe(occupied.position.y)
    expect(extended.edges).toEqual([
      expect.objectContaining({
        source: source.id,
        target: 'generator-2',
        sourceHandle: 'output',
        targetHandle: 'input',
      }),
    ])
  })

  it('inserts a new upstream node and connects its output into the current input', () => {
    const target = createCanvasFlowNode('generator', { x: 520, y: 160 }, {}, 'target')
    const occupied = createCanvasFlowNode('image', { x: 80, y: 160 }, {}, 'occupied')

    const extended = extendCanvasFlowGraph({
      nodes: [target, occupied],
      edges: [],
      sourceId: target.id,
      kind: 'prompt',
      nodeId: 'prompt-before',
      direction: 'before',
    })

    expect(extended.createdNode?.position.x).toBeLessThan(target.position.x)
    expect(extended.createdNode?.position.y).not.toBe(occupied.position.y)
    expect(extended.edges).toEqual([
      expect.objectContaining({
        source: 'prompt-before',
        target: target.id,
        sourceHandle: 'output',
        targetHandle: 'input',
      }),
    ])
  })

  it('does not mutate a graph when the extension source no longer exists', () => {
    const document = createCanvasFlowDocument('空画布')
    const extended = extendCanvasFlowGraph({
      nodes: document.nodes,
      edges: document.edges,
      sourceId: 'missing',
      kind: 'note',
      nodeId: 'note-1',
    })

    expect(extended).toEqual({ nodes: [], edges: [], createdNode: null })
  })

  it('reuses an explicitly connected preview node for a completed generation', () => {
    const generator = createCanvasFlowNode('generator', { x: 100, y: 80 }, { taskId: 'task-2', status: 'running' }, 'generator-2')
    const preview = createCanvasFlowNode('result', { x: 560, y: 120 }, { title: '主预览' }, 'preview-1')
    const edges = [{
      id: 'manual-preview-edge',
      source: generator.id,
      target: preview.id,
      sourceHandle: 'output',
      targetHandle: 'input',
    }]
    const previewId = findCanvasFlowConnectedResultNodeId([generator, preview], edges, generator.id)

    const nodes = upsertCanvasFlowResultNode(
      [generator, preview],
      generator.id,
      'task-2',
      { imageUrl: '/api/assets/result-2/original' },
      previewId,
    )
    const nextEdges = ensureCanvasFlowResultEdge(edges, generator.id, 'task-2', previewId)

    expect(previewId).toBe(preview.id)
    expect(nodes.filter(node => node.data.kind === 'result')).toHaveLength(1)
    expect(nodes.find(node => node.id === preview.id)).toMatchObject({
      position: preview.position,
      data: {
        title: '主预览',
        imageUrl: '/api/assets/result-2/original',
        status: 'completed',
      },
    })
    expect(nextEdges).toEqual(edges)
  })

  it('finds a non-overlapping extension position in a densely occupied lane', () => {
    const source = createCanvasFlowNode('prompt', { x: 100, y: 160 }, {}, 'dense-source')
    const occupied = Array.from({ length: 32 }, (_, index) => createCanvasFlowNode(
      'image',
      { x: 540, y: -1800 + index * 280 },
      {},
      `occupied-${index}`,
    ))

    const extended = extendCanvasFlowGraph({
      nodes: [source, ...occupied],
      edges: [],
      sourceId: source.id,
      kind: 'generator',
      nodeId: 'dense-result',
    })
    const created = extended.createdNode!
    const width = Number(created.style?.width || 0)
    const height = Number(created.style?.height || 0)
    const overlaps = occupied.some(node => {
      const nodeWidth = Number(node.style?.width || 0)
      const nodeHeight = Number(node.style?.height || 0)
      return !(
        created.position.x + width + 40 <= node.position.x
        || node.position.x + nodeWidth + 40 <= created.position.x
        || created.position.y + height + 40 <= node.position.y
        || node.position.y + nodeHeight + 40 <= created.position.y
      )
    })

    expect(overlaps).toBe(false)
  })

  it('can exclude a replaced image when enforcing the canvas inline-image budget', () => {
    const first = createCanvasFlowNode('image', { x: 0, y: 0 }, { imageBase64: 'data:image/png;base64,AAAA' }, 'first')
    const second = createCanvasFlowNode('image', { x: 360, y: 0 }, { imageBase64: 'data:image/png;base64,BBBBBBBB' }, 'second')

    expect(canvasFlowInlineImageBytes([first, second])).toBeGreaterThan(canvasFlowInlineImageBytes([first, second], 'first'))
    expect(canvasFlowInlineImageBytes([first, second], 'first')).toBe(canvasFlowInlineImageBytes([second]))
  })

  it('checks appended inline images against the existing canvas total', () => {
    const existing = createCanvasFlowNode('image', { x: 0, y: 0 }, {
      imageBase64: `data:image/png;base64,${'A'.repeat(80)}`,
    }, 'existing')
    const appended = createCanvasFlowNode('image', { x: 360, y: 0 }, {
      imageBase64: `data:image/png;base64,${'B'.repeat(40)}`,
    }, 'appended')
    const combinedBytes = canvasFlowInlineImageBytes([existing]) + canvasFlowInlineImageBytes([appended])

    expect(canAppendCanvasFlowInlineImages([existing], [appended], combinedBytes)).toBe(true)
    expect(canAppendCanvasFlowInlineImages([existing], [appended], combinedBytes - 1)).toBe(false)
  })

  it('counts and deduplicates inline images stored in every accepted image field', () => {
    const shared = `data:image/png;base64,${'A'.repeat(80)}`
    const preview = `data:image/webp;base64,${'B'.repeat(40)}`
    const node = createCanvasFlowNode('image', { x: 0, y: 0 }, {
      imageBase64: shared,
      imageUrl: shared,
      previewUrl: preview,
      thumbnailUrl: '/api/assets/image/thumbnail',
    }, 'image')
    const raw = createCanvasFlowNode('image', { x: 0, y: 0 }, {
      imageBase64: 'C'.repeat(60),
    }, 'raw')

    expect(canvasFlowInlineImageBytes([node])).toBe(
      Math.ceil(shared.length * 0.75) + Math.ceil(preview.length * 0.75),
    )
    expect(canvasFlowInlineImageBytes([raw])).toBe(Math.ceil(60 * 0.75))
  })
})
