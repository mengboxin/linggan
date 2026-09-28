import { describe, expect, it } from 'vitest'
import {
  planCanvasFlowExecution,
  wouldCreateCanvasFlowCycle,
} from '../canvas-flow-execution-planner'
import {
  createCanvasFlowDocument,
  createCanvasFlowNode,
  type CanvasFlowDocument,
  type CanvasFlowNode,
} from '../canvas-flow-document'

function generator(id: string, overrides: Partial<CanvasFlowNode['data']> = {}) {
  return createCanvasFlowNode('generator', { x: 0, y: 0 }, {
    prompt: `${id} prompt`,
    modelId: 'image-model',
    ...overrides,
  }, id)
}

function graph(nodes: CanvasFlowNode[], connections: Array<[string, string]>) {
  const document = createCanvasFlowDocument('Execution planner test')
  document.nodes = nodes
  document.edges = connections.map(([source, target], index) => ({
    id: `edge-${index}`,
    source,
    target,
  }))
  return document
}

describe('canvas flow execution planner', () => {
  it('orders every runnable generator after its upstream generator', () => {
    const first = generator('first')
    const firstResult = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      imageUrl: '/api/assets/first/original',
    }, 'first-result')
    const second = generator('second')
    const document = graph(
      [second, firstResult, first],
      [['first', 'first-result'], ['first-result', 'second']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['first', 'second'])
    expect(plan.steps[1].dependencyNodeIds).toEqual(['first'])
    expect(plan.validationErrors).toEqual([])
  })

  it('skips generators with a fresh connected result during smart runs', () => {
    const completed = generator('completed', {
      status: 'completed',
      taskId: 'task-completed',
      stale: false,
    })
    const result = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      status: 'completed',
      taskId: 'task-completed',
      imageUrl: '/api/assets/completed/original',
      stale: false,
    }, 'completed-result')
    const document = graph([completed, result], [['completed', 'completed-result']])

    const smartPlan = planCanvasFlowExecution(document, { mode: 'all' })
    const forcedPlan = planCanvasFlowExecution(document, { mode: 'force-all' })

    expect(smartPlan.canRun).toBe(false)
    expect(smartPlan.steps).toEqual([])
    expect(smartPlan.skippedNodes).toContainEqual(expect.objectContaining({
      nodeId: 'completed',
      reason: 'up-to-date',
    }))
    expect(smartPlan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'all-up-to-date',
      blocking: true,
    }))
    expect(forcedPlan.canRun).toBe(true)
    expect(forcedPlan.steps.map(step => step.nodeId)).toEqual(['completed'])
  })

  it('plans a video generator with duration and video result media', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'A short drama shot' }, 'prompt')
    const video = createCanvasFlowNode('video-generator', { x: 360, y: 0 }, {
      modelId: 'grok-imagine-video-1.5',
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 8,
    }, 'video')
    const document = graph([prompt, video], [['prompt', 'video']])

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({
      nodeId: 'video',
      modelId: 'grok-imagine-video-1.5',
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 8,
      prompt: 'A short drama shot',
    })
  })

  it('runs a stale downstream node without rerunning its fresh upstream generator', () => {
    const upstream = generator('upstream', {
      status: 'completed',
      taskId: 'task-upstream',
      stale: false,
    })
    const upstreamResult = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      status: 'completed',
      taskId: 'task-upstream',
      imageUrl: '/api/assets/upstream/original',
      stale: false,
    }, 'upstream-result')
    const downstream = generator('downstream', {
      status: 'completed',
      stale: true,
    })
    const document = graph(
      [upstream, upstreamResult, downstream],
      [['upstream', 'upstream-result'], ['upstream-result', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['downstream'])
    expect(plan.steps[0].dependencyNodeIds).toEqual([])
    expect(plan.validationErrors).toEqual([])
  })

  it('never submits a paused generator but lets downstream use its matching fresh result', () => {
    const paused = generator('paused', {
      paused: true,
      status: 'completed',
      taskId: 'task-paused',
      stale: false,
    })
    const pausedResult = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      status: 'completed',
      taskId: 'task-paused',
      imageUrl: '/api/assets/paused/original',
      stale: false,
    }, 'paused-result')
    const downstream = generator('downstream')
    const document = graph(
      [paused, pausedResult, downstream],
      [['paused', 'paused-result'], ['paused-result', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'force-all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['downstream'])
    expect(plan.steps[0].referenceNodeIds).toContain('paused-result')
    expect(plan.steps[0].dependencyNodeIds).toEqual([])
    expect(plan.skippedNodes).toContainEqual(expect.objectContaining({
      nodeId: 'paused',
      reason: 'paused',
    }))
  })

  it('blocks downstream when a paused generator has no task-matched fresh result', () => {
    const paused = generator('paused', {
      paused: true,
      status: 'completed',
      taskId: 'task-current',
      stale: false,
    })
    const mismatchedResult = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      status: 'completed',
      taskId: 'task-old',
      imageUrl: '/api/assets/paused/old-result',
      stale: false,
    }, 'mismatched-result')
    const downstream = generator('downstream')
    const document = graph(
      [paused, mismatchedResult, downstream],
      [['paused', 'mismatched-result'], ['mismatched-result', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'force-all' })

    expect(plan.canRun).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.skippedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'paused', reason: 'paused' }),
      expect.objectContaining({ nodeId: 'downstream', reason: 'blocked-by-dependency' }),
    ]))
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'upstream-not-runnable',
      nodeId: 'downstream',
      nodeIds: ['paused'],
    }))
  })

  it('plans only the selected node and its downstream branch', () => {
    const selected = generator('selected')
    const selectedResult = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      imageUrl: '/api/assets/selected/original',
    }, 'selected-result')
    const downstream = generator('downstream')
    const other = generator('other')
    const document = graph(
      [other, downstream, selectedResult, selected],
      [['selected', 'selected-result'], ['selected-result', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, {
      mode: 'selected-branch',
      selectedNodeIds: ['selected'],
    })

    expect(plan.steps.map(step => step.nodeId)).toEqual(['selected', 'downstream'])
    expect(plan.skippedNodes).toContainEqual(expect.objectContaining({
      nodeId: 'other',
      reason: 'outside-scope',
    }))
  })

  it('runs only the selected generator without pulling in either side of the branch', () => {
    const upstream = generator('upstream', { status: 'completed', taskId: 'task-upstream' })
    const upstreamResult = createCanvasFlowNode('result', { x: 0, y: 0 }, {
      status: 'completed',
      taskId: 'task-upstream',
      imageUrl: '/api/assets/upstream/original',
    }, 'upstream-result')
    const selected = generator('selected')
    const downstream = generator('downstream')
    const document = graph(
      [upstream, upstreamResult, selected, downstream],
      [['upstream', 'upstream-result'], ['upstream-result', 'selected'], ['selected', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, {
      mode: 'selected-generator',
      selectedNodeId: 'selected',
    })

    expect(plan.steps.map(step => step.nodeId)).toEqual(['selected'])
    expect(plan.steps[0].dependencyNodeIds).toEqual([])
  })

  it('does not let a selected node silently consume a stale upstream result', () => {
    const upstream = generator('upstream', { status: 'completed', stale: true })
    const staleResult = createCanvasFlowNode('result', { x: 360, y: 0 }, {
      status: 'completed',
      imageUrl: '/api/assets/stale/original',
      stale: true,
    }, 'stale-result')
    const selected = generator('selected')
    const document = graph(
      [upstream, staleResult, selected],
      [['upstream', 'stale-result'], ['stale-result', 'selected']],
    )

    const plan = planCanvasFlowExecution(document, {
      mode: 'selected-generator',
      selectedNodeId: 'selected',
    })

    expect(plan.canRun).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'stale-upstream',
      nodeId: 'selected',
      nodeIds: expect.arrayContaining(['upstream', 'stale-result']),
    }))
  })

  it('rejects a cycle in the execution scope and describes the cycle', () => {
    const first = generator('first')
    const second = generator('second')
    const document = graph([first, second], [['first', 'second'], ['second', 'first']])

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'cycle-detected',
      blocking: true,
      nodeIds: expect.arrayContaining(['first', 'second']),
    }))
  })

  it('does not let an unrelated cycle block a selected branch', () => {
    const selected = generator('selected', { status: 'completed' })
    const cycleFirst = generator('cycle-first')
    const cycleSecond = generator('cycle-second')
    const document = graph(
      [cycleFirst, selected, cycleSecond],
      [['cycle-first', 'cycle-second'], ['cycle-second', 'cycle-first']],
    )

    const plan = planCanvasFlowExecution(document, {
      mode: 'selected-branch',
      selectedNodeIds: ['selected'],
    })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['selected'])
    expect(plan.validationErrors).toEqual([])
  })

  it('ignores a cycle made only of non-executable nodes', () => {
    const runnable = generator('runnable')
    const firstNote = createCanvasFlowNode('note', { x: 0, y: 0 }, {}, 'first-note')
    const secondNote = createCanvasFlowNode('note', { x: 0, y: 0 }, {}, 'second-note')
    const document = graph(
      [firstNote, runnable, secondNote],
      [['first-note', 'second-note'], ['second-note', 'first-note']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['runnable'])
  })

  it('skips invalid and active generators while preserving runnable work', () => {
    const good = generator('good')
    const missingPrompt = generator('missing-prompt', { prompt: '' })
    const missingModel = generator('missing-model', { modelId: '' })
    const active = generator('active', { status: 'running' })
    const note = createCanvasFlowNode('note', { x: 0, y: 0 }, {}, 'note')
    const document = graph([missingPrompt, active, note, good, missingModel], [])
    document.settings.modelId = ''

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['good'])
    expect(plan.validationErrors.map(error => error.code)).toEqual(expect.arrayContaining([
      'missing-prompt',
      'missing-model',
      'generator-active',
    ]))
    expect(plan.skippedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'missing-prompt', reason: 'invalid' }),
      expect.objectContaining({ nodeId: 'missing-model', reason: 'invalid' }),
      expect.objectContaining({ nodeId: 'active', reason: 'already-running' }),
      expect.objectContaining({ nodeId: 'note', reason: 'not-executable' }),
    ]))
  })

  it('does not run downstream generators when an in-scope dependency is invalid', () => {
    const invalidUpstream = generator('invalid-upstream', { prompt: '' })
    const downstream = generator('downstream')
    const independent = generator('independent')
    const document = graph(
      [downstream, independent, invalidUpstream],
      [['invalid-upstream', 'downstream']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(true)
    expect(plan.steps.map(step => step.nodeId)).toEqual(['independent'])
    expect(plan.skippedNodes).toContainEqual(expect.objectContaining({
      nodeId: 'downstream',
      reason: 'blocked-by-dependency',
    }))
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'upstream-not-runnable',
      nodeId: 'downstream',
      nodeIds: ['invalid-upstream'],
    }))
  })

  it('adds a blocking error when validation leaves no executable steps', () => {
    const document = graph([
      generator('missing-prompt', { prompt: '' }),
      generator('active', { status: 'running' }),
    ], [])

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(false)
    expect(plan.steps).toEqual([])
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'no-executable-generator',
      blocking: true,
    }))
  })

  it('marks generators in a cyclic execution scope as invalid instead of outside scope', () => {
    const document = graph(
      [generator('first'), generator('second')],
      [['first', 'second'], ['second', 'first']],
    )

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.skippedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'first', reason: 'invalid' }),
      expect.objectContaining({ nodeId: 'second', reason: 'invalid' }),
    ]))
  })

  it('uses document settings and connected prompt nodes as generator defaults', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'Connected prompt' }, 'prompt')
    const target = generator('target', {
      prompt: '',
      modelId: '',
      aspectRatio: '',
      resolution: '',
      quality: '',
    })
    const document = graph([target, prompt], [['prompt', 'target']])
    document.settings = {
      modelId: 'default-model',
      aspectRatio: '16:9',
      resolution: '2k',
      quality: 'high',
    }

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.steps[0]).toMatchObject({
      nodeId: 'target',
      prompt: 'Connected prompt',
      modelId: 'default-model',
      aspectRatio: '16:9',
      resolution: '2k',
      quality: 'high',
      promptNodeIds: ['prompt'],
    })
  })

  it('returns clear selection errors instead of silently planning the wrong node', () => {
    const prompt = createCanvasFlowNode('prompt', { x: 0, y: 0 }, { prompt: 'Prompt' }, 'prompt')
    const document = graph([prompt], [])

    const wrongKind = planCanvasFlowExecution(document, {
      mode: 'selected-generator',
      selectedNodeId: 'prompt',
    })
    const missing = planCanvasFlowExecution(document, {
      mode: 'selected-branch',
      selectedNodeIds: ['missing'],
    })

    expect(wrongKind.canRun).toBe(false)
    expect(wrongKind.validationErrors[0]).toMatchObject({ code: 'selection-not-generator', blocking: true })
    expect(missing.canRun).toBe(false)
    expect(missing.validationErrors[0]).toMatchObject({ code: 'selection-not-found', blocking: true })
  })

  it('reports an empty executable graph', () => {
    const document = graph([
      createCanvasFlowNode('note', { x: 0, y: 0 }, {}, 'note'),
    ], [])

    const plan = planCanvasFlowExecution(document, { mode: 'all' })

    expect(plan.canRun).toBe(false)
    expect(plan.validationErrors).toContainEqual(expect.objectContaining({
      code: 'no-executable-generator',
      blocking: true,
    }))
  })

  it('plans one invocation per result and smart-runs only stale result slots', () => {
    const source = generator('source', { status: 'failed' })
    const fresh = createCanvasFlowNode('result', { x: 360, y: -120 }, {
      status: 'completed',
      imageUrl: '/api/assets/fresh/original',
      stale: false,
    }, 'fresh-result')
    const stale = createCanvasFlowNode('result', { x: 360, y: 120 }, {
      status: 'failed',
      stale: true,
    }, 'stale-result')
    const document = graph([source, fresh, stale], [
      ['source', 'fresh-result'],
      ['source', 'stale-result'],
    ])

    const smart = planCanvasFlowExecution(document, { mode: 'all' })
    const forced = planCanvasFlowExecution(document, { mode: 'force-all' })

    expect(smart.steps).toHaveLength(1)
    expect(smart.steps[0]).toMatchObject({
      stepId: 'result:stale-result',
      nodeId: 'source',
      resultNodeId: 'stale-result',
      dependencyStepIds: [],
    })
    expect(forced.steps.map(step => step.stepId)).toEqual([
      'result:fresh-result',
      'result:stale-result',
    ])
  })

  it('creates one stable implicit invocation for a generator without a result card', () => {
    const document = graph([generator('source')], [])

    const plan = planCanvasFlowExecution(document, { mode: 'force-all' })

    expect(plan.steps).toEqual([
      expect.objectContaining({
        stepId: 'implicit:source',
        nodeId: 'source',
        resultNodeId: '',
        dependencyStepIds: [],
      }),
    ])
  })

  it('isolates an explicit result branch from sibling result invocations', () => {
    const source = generator('source')
    const firstResult = createCanvasFlowNode('result', { x: 360, y: -120 }, {}, 'first-result')
    const secondResult = createCanvasFlowNode('result', { x: 360, y: 120 }, {}, 'second-result')
    const downstream = generator('downstream')
    const document = graph([source, firstResult, secondResult, downstream], [
      ['source', 'first-result'],
      ['source', 'second-result'],
      ['first-result', 'downstream'],
    ])

    const plan = planCanvasFlowExecution(document, { mode: 'force-all' })
    const downstreamStep = plan.steps.find(step => step.nodeId === 'downstream')

    expect(downstreamStep).toMatchObject({
      stepId: 'implicit:downstream',
      dependencyNodeIds: ['source'],
      dependencyStepIds: ['result:first-result'],
    })
  })

  it('makes a direct generator dependency wait for every required output invocation', () => {
    const source = generator('source')
    const firstResult = createCanvasFlowNode('result', { x: 360, y: -120 }, {}, 'first-result')
    const secondResult = createCanvasFlowNode('result', { x: 360, y: 120 }, {}, 'second-result')
    const downstream = generator('downstream')
    const document = graph([source, firstResult, secondResult, downstream], [
      ['source', 'first-result'],
      ['source', 'second-result'],
      ['source', 'downstream'],
    ])

    const plan = planCanvasFlowExecution(document, { mode: 'force-all' })
    const downstreamStep = plan.steps.find(step => step.nodeId === 'downstream')

    expect(downstreamStep?.dependencyStepIds).toEqual([
      'result:first-result',
      'result:second-result',
    ])
  })
})

describe('wouldCreateCanvasFlowCycle', () => {
  it('detects a back edge and a self edge without rejecting a forward edge', () => {
    const document: Pick<CanvasFlowDocument, 'nodes' | 'edges'> = graph(
      [generator('first'), generator('second'), generator('third')],
      [['first', 'second'], ['second', 'third']],
    )

    expect(wouldCreateCanvasFlowCycle(document, 'third', 'first')).toBe(true)
    expect(wouldCreateCanvasFlowCycle(document, 'second', 'second')).toBe(true)
    expect(wouldCreateCanvasFlowCycle(document, 'first', 'third')).toBe(false)
    expect(wouldCreateCanvasFlowCycle(document, 'missing', 'first')).toBe(false)
  })
})
