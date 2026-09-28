import { executeCanvasFlowPlan, type CanvasFlowStepOutcome } from '../canvas-flow-execution-runner'
import type { CanvasFlowExecutionStep } from '../canvas-flow-execution-planner'

function step(nodeId: string, dependencyStepIds: string[] = [], stepId = nodeId): CanvasFlowExecutionStep {
  return {
    stepId,
    nodeId,
    resultNodeId: '',
    dependencyStepIds,
    dependencyNodeIds: dependencyStepIds,
    prompt: `${nodeId} prompt`,
    promptNodeIds: [],
    referenceNodeIds: [],
    modelId: 'image-model',
    aspectRatio: '1:1',
    resolution: '1k',
    quality: 'auto',
  }
}

function deferredOutcome() {
  let resolve!: (outcome: CanvasFlowStepOutcome) => void
  const promise = new Promise<CanvasFlowStepOutcome>(next => { resolve = next })
  return { promise, resolve }
}

describe('executeCanvasFlowPlan', () => {
  it('starts sibling nodes together only after their shared dependency completes', async () => {
    const shared = deferredOutcome()
    const first = deferredOutcome()
    const second = deferredOutcome()
    const started: string[] = []
    const execution = executeCanvasFlowPlan([
      step('shared'),
      step('first', ['shared']),
      step('second', ['shared']),
    ], candidate => {
      started.push(candidate.nodeId)
      return candidate.nodeId === 'shared' ? shared.promise : candidate.nodeId === 'first' ? first.promise : second.promise
    })

    expect(started).toEqual(['shared'])
    shared.resolve({ status: 'completed' })
    await vi.waitFor(() => expect(started).toEqual(['shared', 'first', 'second']))

    first.resolve({ status: 'completed' })
    second.resolve({ status: 'completed' })
    await expect(execution).resolves.toMatchObject({ status: 'completed', succeeded: 3, failed: 0, skipped: 0 })
  })

  it('keeps an independent branch running and skips only descendants of a failed node', async () => {
    const executed: string[] = []
    const result = await executeCanvasFlowPlan([
      step('failed-root'),
      step('healthy-root'),
      step('blocked-child', ['failed-root']),
      step('healthy-child', ['healthy-root']),
    ], async candidate => {
      executed.push(candidate.nodeId)
      if (candidate.nodeId === 'failed-root') return { status: 'failed', error: 'boom' }
      return { status: 'completed' }
    })

    expect(executed).toEqual(['failed-root', 'healthy-root', 'healthy-child'])
    expect(result).toMatchObject({ status: 'completed', completed: 4, succeeded: 2, failed: 1, skipped: 1 })
    expect(result.issueNodeIds).toEqual(expect.arrayContaining(['failed-root', 'blocked-child']))
    expect(result.messages).toEqual(expect.arrayContaining(['boom', expect.stringContaining('blocked-child')]))
  })

  it('isolates a failed result invocation from a successful sibling branch', async () => {
    const executed: string[] = []
    const result = await executeCanvasFlowPlan([
      step('producer', [], 'result:first'),
      step('producer', [], 'result:second'),
      step('first-child', ['result:first']),
      step('second-child', ['result:second']),
    ], async candidate => {
      executed.push(candidate.stepId || candidate.nodeId)
      if (candidate.stepId === 'result:second') return { status: 'failed', error: 'second output failed' }
      return { status: 'completed' }
    })

    expect(executed).toEqual(['result:first', 'result:second', 'first-child'])
    expect(result).toMatchObject({ completed: 4, succeeded: 2, failed: 1, skipped: 1 })
    expect(result.issueNodeIds).toEqual(expect.arrayContaining(['producer', 'second-child']))
    expect(result.issueNodeIds.filter(nodeId => nodeId === 'producer')).toHaveLength(1)
  })

  it('deduplicates active generator ids when several result invocations run together', async () => {
    const first = deferredOutcome()
    const second = deferredOutcome()
    const progress: string[][] = []
    const execution = executeCanvasFlowPlan([
      step('producer', [], 'result:first'),
      step('producer', [], 'result:second'),
    ], candidate => candidate.stepId === 'result:first' ? first.promise : second.promise, {
      onProgress: update => progress.push(update.activeNodeIds),
    })

    expect(progress[0]).toEqual(['producer'])
    first.resolve({ status: 'completed' })
    second.resolve({ status: 'completed' })
    await execution
  })

  it('uses one bounded concurrency pool across all ready invocations', async () => {
    let active = 0
    let peak = 0
    const candidates = Array.from({ length: 7 }, (_, index) => step(`node-${index}`))

    const result = await executeCanvasFlowPlan(candidates, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { status: 'completed' }
    })

    expect(peak).toBe(4)
    expect(result.succeeded).toBe(7)
  })

  it('honors a caller-provided concurrency limit', async () => {
    let active = 0
    let peak = 0
    const candidates = Array.from({ length: 5 }, (_, index) => step(`node-${index}`))

    await executeCanvasFlowPlan(candidates, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { status: 'completed' }
    }, { maxConcurrency: 2 })

    expect(peak).toBe(2)
  })
})
