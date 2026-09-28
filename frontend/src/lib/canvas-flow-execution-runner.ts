import type { CanvasFlowExecutionStep } from './canvas-flow-execution-planner'

export type CanvasFlowStepOutcome = {
  status: 'completed' | 'failed' | 'stopped'
  error?: string
}

export interface CanvasFlowExecutionProgress {
  completed: number
  total: number
  succeeded: number
  failed: number
  skipped: number
  activeNodeIds: string[]
  issueNodeIds: string[]
  messages: string[]
}

export interface CanvasFlowExecutionResult extends CanvasFlowExecutionProgress {
  status: 'completed' | 'stopped'
}

interface ExecuteCanvasFlowPlanOptions {
  initialSkipped?: number
  initialMessages?: string[]
  maxConcurrency?: number
  shouldContinue?: () => boolean
  nodeTitle?: (nodeId: string) => string
  onProgress?: (progress: CanvasFlowExecutionProgress) => void
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function executionStepId(step: CanvasFlowExecutionStep) {
  return step.stepId || step.nodeId
}

function dependencyStepIds(step: CanvasFlowExecutionStep) {
  return step.dependencyStepIds ?? step.dependencyNodeIds
}

function uniqueNodeIds(steps: CanvasFlowExecutionStep[]) {
  return [...new Set(steps.map(step => step.nodeId))]
}

/** Runs dependency-ready invocations with one concurrency limit shared by the whole plan. */
export async function executeCanvasFlowPlan(
  steps: CanvasFlowExecutionStep[],
  executeStep: (step: CanvasFlowExecutionStep) => Promise<CanvasFlowStepOutcome>,
  options: ExecuteCanvasFlowPlanOptions = {},
): Promise<CanvasFlowExecutionResult> {
  const shouldContinue = options.shouldContinue || (() => true)
  const maxConcurrency = Number.isFinite(options.maxConcurrency)
    ? Math.max(1, Math.floor(Number(options.maxConcurrency)))
    : 4
  const pending = new Map(steps.map(step => [executionStepId(step), step]))
  const succeededStepIds = new Set<string>()
  const failedStepIds = new Set<string>()
  const issueNodeIds = new Set<string>()
  const messages = [...(options.initialMessages || [])]
  let completed = 0
  let succeeded = 0
  let failed = 0
  let skipped = options.initialSkipped || 0

  const snapshot = (activeNodeIds: string[] = []): CanvasFlowExecutionProgress => ({
    completed,
    total: steps.length,
    succeeded,
    failed,
    skipped,
    activeNodeIds,
    issueNodeIds: [...issueNodeIds],
    messages: [...messages],
  })
  const emit = (activeSteps: CanvasFlowExecutionStep[] = []) => options.onProgress?.(snapshot(uniqueNodeIds(activeSteps)))
  const titleOf = (nodeId: string) => options.nodeTitle?.(nodeId) || nodeId

  while (pending.size > 0) {
    if (!shouldContinue()) return { status: 'stopped', ...snapshot() }

    let skippedDependency = true
    while (skippedDependency) {
      skippedDependency = false
      for (const [stepId, step] of pending) {
        if (!dependencyStepIds(step).some(dependencyId => failedStepIds.has(dependencyId))) continue
        pending.delete(stepId)
        failedStepIds.add(stepId)
        issueNodeIds.add(step.nodeId)
        completed += 1
        skipped += 1
        messages.push(`已跳过“${titleOf(step.nodeId)}”：上游节点运行失败`)
        skippedDependency = true
      }
    }

    if (pending.size === 0) break
    const ready = [...pending.values()]
      .filter(step => dependencyStepIds(step).every(dependencyId => succeededStepIds.has(dependencyId)))
      .slice(0, maxConcurrency)
    if (ready.length === 0) {
      for (const [stepId, step] of pending) {
        failedStepIds.add(stepId)
        issueNodeIds.add(step.nodeId)
        completed += 1
        failed += 1
        messages.push(`“${titleOf(step.nodeId)}”的依赖关系无法推进`)
      }
      pending.clear()
      break
    }

    ready.forEach(step => pending.delete(executionStepId(step)))
    emit(ready)
    const outcomes = await Promise.all(ready.map(async step => {
      try {
        return { step, outcome: await executeStep(step) }
      } catch (error) {
        return {
          step,
          outcome: {
            status: 'failed' as const,
            error: errorMessage(error, `节点 ${step.nodeId} 运行失败`),
          },
        }
      }
    }))

    outcomes.forEach(({ step, outcome }) => {
      const stepId = executionStepId(step)
      completed += 1
      if (outcome.status === 'completed') {
        succeededStepIds.add(stepId)
        succeeded += 1
        return
      }
      failedStepIds.add(stepId)
      issueNodeIds.add(step.nodeId)
      failed += 1
      messages.push(outcome.error || (outcome.status === 'stopped'
        ? `节点“${titleOf(step.nodeId)}”已停止`
        : `节点 ${step.nodeId} 运行失败`))
    })
    emit()
  }

  return { status: shouldContinue() ? 'completed' : 'stopped', ...snapshot() }
}
