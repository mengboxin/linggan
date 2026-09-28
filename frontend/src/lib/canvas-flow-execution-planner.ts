import {
  canvasFlowResultHasMedia,
  canvasFlowUpstreamNodes,
  isCanvasFlowProducerKind,
  resolveCanvasFlowGeneratorInputs,
  type CanvasFlowDocument,
  type CanvasFlowNode,
  type CanvasFlowNodeStatus,
} from './canvas-flow-document'

/** `selected-branch` starts at the selection and follows outgoing edges. */
export type CanvasFlowExecutionRequest =
  | { mode: 'all' }
  | { mode: 'force-all' }
  | { mode: 'selected-branch'; selectedNodeIds: string[] }
  | { mode: 'selected-generator'; selectedNodeId: string }

export type CanvasFlowExecutionScope = CanvasFlowExecutionRequest['mode']

export type CanvasFlowExecutionValidationCode =
  | 'selection-required'
  | 'selection-not-found'
  | 'selection-not-generator'
  | 'no-executable-generator'
  | 'cycle-detected'
  | 'missing-prompt'
  | 'missing-model'
  | 'generator-active'
  | 'upstream-not-runnable'
  | 'stale-upstream'
  | 'all-up-to-date'

export interface CanvasFlowExecutionValidationError {
  code: CanvasFlowExecutionValidationCode
  message: string
  blocking: boolean
  nodeId?: string
  nodeIds?: string[]
}

export type CanvasFlowExecutionSkipReason =
  | 'not-executable'
  | 'outside-scope'
  | 'paused'
  | 'already-running'
  | 'up-to-date'
  | 'blocked-by-dependency'
  | 'invalid'

export interface CanvasFlowExecutionSkippedNode {
  nodeId: string
  reason: CanvasFlowExecutionSkipReason
  message: string
}

export interface CanvasFlowExecutionStep {
  /** Unique execution identity. Result-backed steps use the result node id. */
  stepId?: string
  nodeId: string
  /** Empty only for the single implicit output of a generator without a result node. */
  resultNodeId?: string
  /** Invocation-level dependencies; falls back to dependencyNodeIds for legacy callers. */
  dependencyStepIds?: string[]
  dependencyNodeIds: string[]
  prompt: string
  promptNodeIds: string[]
  referenceNodeIds: string[]
  modelId: string
  aspectRatio: string
  resolution: string
  quality: string
  duration?: number
}

export interface CanvasFlowExecutionPlan {
  mode: CanvasFlowExecutionRequest['mode']
  canRun: boolean
  steps: CanvasFlowExecutionStep[]
  skippedNodes: CanvasFlowExecutionSkippedNode[]
  validationErrors: CanvasFlowExecutionValidationError[]
}

interface GraphIndex {
  nodesById: Map<string, CanvasFlowNode>
  nodeOrder: Map<string, number>
  outgoing: Map<string, string[]>
  incoming: Map<string, string[]>
}

const ACTIVE_GENERATOR_STATUSES = new Set<CanvasFlowNodeStatus>(['submitting', 'queued', 'running'])

function pushUnique(map: Map<string, string[]>, key: string, value: string) {
  const values = map.get(key) || []
  if (!values.includes(value)) values.push(value)
  map.set(key, values)
}

function indexGraph(document: Pick<CanvasFlowDocument, 'nodes' | 'edges'>): GraphIndex {
  const nodesById = new Map(document.nodes.map(node => [node.id, node]))
  const nodeOrder = new Map(document.nodes.map((node, index) => [node.id, index]))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  document.edges.forEach(edge => {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return
    pushUnique(outgoing, edge.source, edge.target)
    pushUnique(incoming, edge.target, edge.source)
  })

  return { nodesById, nodeOrder, outgoing, incoming }
}

function reachableNodeIds(startIds: Iterable<string>, adjacency: Map<string, string[]>) {
  const reachable = new Set<string>()
  const queue = [...startIds]
  while (queue.length > 0) {
    const nodeId = queue.shift()
    if (!nodeId || reachable.has(nodeId)) continue
    reachable.add(nodeId)
    queue.push(...(adjacency.get(nodeId) || []))
  }
  return reachable
}

function scopeGeneratorIds(
  graph: GraphIndex,
  request: CanvasFlowExecutionRequest,
): { generatorIds: Set<string>; errors: CanvasFlowExecutionValidationError[] } {
  if (request.mode === 'all' || request.mode === 'force-all') {
    return {
      generatorIds: new Set(
        [...graph.nodesById.values()]
          .filter(node => isCanvasFlowProducerKind(node.data.kind))
          .map(node => node.id),
      ),
      errors: [],
    }
  }

  if (request.mode === 'selected-generator') {
    const selectedId = request.selectedNodeId.trim()
    if (!selectedId) {
      return {
        generatorIds: new Set(),
        errors: [{
          code: 'selection-required',
          message: '请先选择一个生成节点。',
          blocking: true,
        }],
      }
    }
    const selected = graph.nodesById.get(selectedId)
    if (!selected) {
      return {
        generatorIds: new Set(),
        errors: [{
          code: 'selection-not-found',
          message: '所选节点已不存在，请重新选择后再运行。',
          blocking: true,
          nodeId: selectedId,
        }],
      }
    }
    if (selected.data.kind !== 'generator' && selected.data.kind !== 'video-generator') {
      return {
        generatorIds: new Set(),
        errors: [{
          code: 'selection-not-generator',
          message: `“${selected.data.title}”不是生成节点，无法单独运行。`,
          blocking: true,
          nodeId: selectedId,
        }],
      }
    }
    return { generatorIds: new Set([selectedId]), errors: [] }
  }

  const selectedIds = [...new Set(request.selectedNodeIds.map(id => id.trim()).filter(Boolean))]
  if (selectedIds.length === 0) {
    return {
      generatorIds: new Set(),
      errors: [{
        code: 'selection-required',
        message: '请先选择分支的起始节点。',
        blocking: true,
      }],
    }
  }
  const missingIds = selectedIds.filter(id => !graph.nodesById.has(id))
  if (missingIds.length > 0) {
    return {
      generatorIds: new Set(),
      errors: [{
        code: 'selection-not-found',
        message: '部分所选节点已不存在，请重新选择后再运行。',
        blocking: true,
        nodeIds: missingIds,
      }],
    }
  }

  const downstreamIds = reachableNodeIds(selectedIds, graph.outgoing)
  return {
    generatorIds: new Set(
      [...downstreamIds].filter(id => {
        const kind = graph.nodesById.get(id)?.data.kind
        return isCanvasFlowProducerKind(kind)
      }),
    ),
    errors: [],
  }
}

function generatorHasFreshOutput(
  graph: GraphIndex,
  node: CanvasFlowNode,
) {
  const resultTargets = (graph.outgoing.get(node.id) || [])
    .map(targetId => graph.nodesById.get(targetId))
    .filter((target): target is CanvasFlowNode => target?.data.kind === 'result')
  if (resultTargets.length === 0) return false
  return resultTargets.every(result => resultHasFreshOutput(result, node))
}

function resultHasFreshOutput(result: CanvasFlowNode, producer?: CanvasFlowNode) {
  const hasFreshImage = result.data.kind === 'result'
    && result.data.status === 'completed'
    && !result.data.stale
    && canvasFlowResultHasMedia(result.data)
  if (!hasFreshImage) return false
  const legacyProducerTaskId = String(producer?.data.taskId || '')
  return !legacyProducerTaskId || String(result.data.taskId || '') === legacyProducerTaskId
}

function generatorHasActiveOutput(graph: GraphIndex, node: CanvasFlowNode) {
  return (graph.outgoing.get(node.id) || []).some(targetId => {
    const target = graph.nodesById.get(targetId)
    return target?.data.kind === 'result' && ACTIVE_GENERATOR_STATUSES.has(target.data.status || 'idle')
  })
}

function canvasFlowExecutionStepId(generatorNodeId: string, resultNodeId: string) {
  return resultNodeId ? `result:${resultNodeId}` : `implicit:${generatorNodeId}`
}

function findCycle(graph: GraphIndex, relevantNodeIds: Set<string>) {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []

  const visit = (nodeId: string): string[] | null => {
    state.set(nodeId, 1)
    stack.push(nodeId)
    for (const targetId of graph.outgoing.get(nodeId) || []) {
      if (!relevantNodeIds.has(targetId)) continue
      if (state.get(targetId) === 1) {
        const cycleStart = stack.indexOf(targetId)
        return [...stack.slice(cycleStart), targetId]
      }
      if (!state.has(targetId)) {
        const cycle = visit(targetId)
        if (cycle) return cycle
      }
    }
    stack.pop()
    state.set(nodeId, 2)
    return null
  }

  const orderedIds = [...relevantNodeIds].sort((left, right) => (
    (graph.nodeOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (graph.nodeOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
  ))
  for (const nodeId of orderedIds) {
    if (state.has(nodeId)) continue
    const cycle = visit(nodeId)
    if (cycle) return cycle
  }
  return null
}

function topologicalNodeIds(graph: GraphIndex, relevantNodeIds: Set<string>) {
  const indegree = new Map<string, number>([...relevantNodeIds].map(id => [id, 0]))
  relevantNodeIds.forEach(sourceId => {
    for (const targetId of graph.outgoing.get(sourceId) || []) {
      if (relevantNodeIds.has(targetId)) indegree.set(targetId, (indegree.get(targetId) || 0) + 1)
    }
  })
  const orderOf = (nodeId: string) => graph.nodeOrder.get(nodeId) ?? Number.MAX_SAFE_INTEGER
  const queue = [...relevantNodeIds]
    .filter(id => indegree.get(id) === 0)
    .sort((left, right) => orderOf(left) - orderOf(right))
  const ordered: string[] = []

  while (queue.length > 0) {
    const sourceId = queue.shift()!
    ordered.push(sourceId)
    for (const targetId of graph.outgoing.get(sourceId) || []) {
      if (!relevantNodeIds.has(targetId)) continue
      const nextIndegree = (indegree.get(targetId) || 0) - 1
      indegree.set(targetId, nextIndegree)
      if (nextIndegree === 0) {
        queue.push(targetId)
        queue.sort((left, right) => orderOf(left) - orderOf(right))
      }
    }
  }
  return ordered
}

function skippedNode(node: CanvasFlowNode, reason: CanvasFlowExecutionSkipReason, message: string) {
  return { nodeId: node.id, reason, message } satisfies CanvasFlowExecutionSkippedNode
}

function emptyPlan(
  mode: CanvasFlowExecutionRequest['mode'],
  document: Pick<CanvasFlowDocument, 'nodes'>,
  validationErrors: CanvasFlowExecutionValidationError[],
  scopedGeneratorIds: Set<string> = new Set(),
): CanvasFlowExecutionPlan {
  return {
    mode,
    canRun: false,
    steps: [],
    skippedNodes: document.nodes.map(node => {
      if (node.data.kind !== 'generator' && node.data.kind !== 'video-generator') {
        return skippedNode(node, 'not-executable', '该节点只提供输入或说明，不需要单独执行。')
      }
      if (node.data.paused) {
        return skippedNode(node, 'paused', '该生成节点已暂停，不会在本次运行中提交。')
      }
      if (scopedGeneratorIds.has(node.id)) {
        return skippedNode(node, 'invalid', '该生成节点所在的执行范围无法运行。')
      }
      return skippedNode(node, 'outside-scope', '该生成节点不在本次运行范围内。')
    }),
    validationErrors,
  }
}

export function planCanvasFlowExecution(
  document: Pick<CanvasFlowDocument, 'nodes' | 'edges' | 'settings'>,
  request: CanvasFlowExecutionRequest,
): CanvasFlowExecutionPlan {
  const graph = indexGraph(document)
  const scope = scopeGeneratorIds(graph, request)
  if (scope.errors.some(error => error.blocking)) return emptyPlan(request.mode, document, scope.errors)
  if (scope.generatorIds.size === 0) {
    return emptyPlan(request.mode, document, [{
      code: 'no-executable-generator',
      message: request.mode === 'selected-branch'
        ? '所选节点的下游没有生成节点。'
        : '当前画布中没有可运行的生成节点。',
      blocking: true,
    }])
  }

  const relevantNodeIds = reachableNodeIds(scope.generatorIds, graph.incoming)
  const cycle = findCycle(graph, relevantNodeIds)
  if (cycle) {
    const cycleTitles = cycle.map(id => graph.nodesById.get(id)?.data.title || id)
    return emptyPlan(request.mode, document, [{
      code: 'cycle-detected',
      message: `工作流存在环路：${cycleTitles.join(' -> ')}。请断开其中一条连线后再运行。`,
      blocking: true,
      nodeIds: cycle,
    }], scope.generatorIds)
  }

  const validationErrors: CanvasFlowExecutionValidationError[] = []
  const skippedNodes: CanvasFlowExecutionSkippedNode[] = []
  const runnableIds = new Set<string>()
  const freshGeneratorIds = new Set(
    document.nodes
      .filter(node => (node.data.kind === 'generator' || node.data.kind === 'video-generator') && generatorHasFreshOutput(graph, node))
      .map(node => node.id),
  )
  const resolvedInputs = new Map<string, ReturnType<typeof resolveCanvasFlowGeneratorInputs>>()

  document.nodes.forEach(node => {
    if (node.data.kind !== 'generator' && node.data.kind !== 'video-generator') {
      skippedNodes.push(skippedNode(node, 'not-executable', '该节点只提供输入或说明，不需要单独执行。'))
      return
    }
    if (!scope.generatorIds.has(node.id)) {
      skippedNodes.push(skippedNode(node, 'outside-scope', '该生成节点不在本次运行范围内。'))
      return
    }
    if (node.data.paused) {
      skippedNodes.push(skippedNode(node, 'paused', '该生成节点已暂停，不会在本次运行中提交。'))
      return
    }
    if (ACTIVE_GENERATOR_STATUSES.has(node.data.status || 'idle') || generatorHasActiveOutput(graph, node)) {
      validationErrors.push({
        code: 'generator-active',
        message: `生成节点“${node.data.title}”正在运行，本次不会重复提交。`,
        blocking: false,
        nodeId: node.id,
      })
      skippedNodes.push(skippedNode(node, 'already-running', '节点已有进行中的任务。'))
      return
    }
    if (request.mode === 'all' && generatorHasFreshOutput(graph, node)) {
      skippedNodes.push(skippedNode(node, 'up-to-date', '节点已有最新结果，本次智能运行无需重复提交。'))
      return
    }

    const inputs = resolveCanvasFlowGeneratorInputs(document, node.id)
    resolvedInputs.set(node.id, inputs)
    const upstreamNodes = canvasFlowUpstreamNodes(document, node.id)
    const staleUpstreamGeneratorIds = upstreamNodes
      .filter(upstream => (
        (upstream.data.kind === 'generator' || upstream.data.kind === 'video-generator')
        && !scope.generatorIds.has(upstream.id)
        && !freshGeneratorIds.has(upstream.id)
      ))
      .map(upstream => upstream.id)
    const usableResultIds = new Set(
      inputs.referenceNodes.filter(reference => reference.data.kind === 'result').map(reference => reference.id),
    )
    const producersWithUsableResults = new Set(
      [...usableResultIds].flatMap(resultId => graph.incoming.get(resultId) || []),
    )
    const staleReferenceIds = upstreamNodes
      .filter(reference => {
        if (reference.data.kind !== 'result' || usableResultIds.has(reference.id)) return false
        const hasImage = canvasFlowResultHasMedia(reference.data)
        if (!hasImage) return false
        const producerIds = (graph.incoming.get(reference.id) || [])
          .filter(sourceId => {
            const kind = graph.nodesById.get(sourceId)?.data.kind
            return isCanvasFlowProducerKind(kind)
          })
        if (producerIds.some(sourceId => scope.generatorIds.has(sourceId))) return false
        return producerIds.length === 0
          || !producerIds.some(sourceId => producersWithUsableResults.has(sourceId))
      })
      .map(reference => reference.id)
    if (staleUpstreamGeneratorIds.length > 0 || staleReferenceIds.length > 0) {
      const nodeIds = [...new Set([...staleUpstreamGeneratorIds, ...staleReferenceIds])]
      validationErrors.push({
        code: 'stale-upstream',
        message: `生成节点“${node.data.title}”连接了需要重新运行的上游结果，请先运行上游分支或使用智能运行。`,
        blocking: false,
        nodeId: node.id,
        nodeIds,
      })
      skippedNodes.push(skippedNode(node, 'blocked-by-dependency', '上游结果已过期或尚未生成。'))
      return
    }
    let valid = true
    if (!inputs.prompt.trim()) {
      valid = false
      validationErrors.push({
        code: 'missing-prompt',
        message: `生成节点“${node.data.title}”缺少提示词，请连接提示词节点或填写节点提示词。`,
        blocking: false,
        nodeId: node.id,
      })
    }
    if (!String(node.data.modelId || document.settings.modelId || '').trim()) {
      valid = false
      validationErrors.push({
        code: 'missing-model',
        message: `生成节点“${node.data.title}”没有选择生成模型。`,
        blocking: false,
        nodeId: node.id,
      })
    }
    if (!valid) {
      skippedNodes.push(skippedNode(node, 'invalid', '节点配置不完整。'))
      return
    }
    runnableIds.add(node.id)
  })

  const orderedScopedGeneratorIds = topologicalNodeIds(graph, relevantNodeIds)
    .filter(nodeId => scope.generatorIds.has(nodeId))
  orderedScopedGeneratorIds.forEach(nodeId => {
    if (!runnableIds.has(nodeId)) return
    const blockedDependencyIds = canvasFlowUpstreamNodes(document, nodeId)
      .filter(upstream => (
        (upstream.data.kind === 'generator' || upstream.data.kind === 'video-generator')
        && scope.generatorIds.has(upstream.id)
        && !runnableIds.has(upstream.id)
        && !freshGeneratorIds.has(upstream.id)
      ))
      .map(upstream => upstream.id)
    if (blockedDependencyIds.length === 0) return
    runnableIds.delete(nodeId)
    const node = graph.nodesById.get(nodeId)!
    validationErrors.push({
      code: 'upstream-not-runnable',
      message: `生成节点“${node.data.title}”的上游节点无法运行，本次已跳过。`,
      blocking: false,
      nodeId,
      nodeIds: blockedDependencyIds,
    })
    skippedNodes.push(skippedNode(node, 'blocked-by-dependency', '上游生成节点无法运行。'))
  })

  const orderedGeneratorIds = orderedScopedGeneratorIds.filter(nodeId => runnableIds.has(nodeId))
  const stepsByGeneratorId = new Map<string, CanvasFlowExecutionStep[]>()
  const stepsWithoutDependencies = orderedGeneratorIds.flatMap(nodeId => {
    const node = graph.nodesById.get(nodeId)!
    const inputs = resolvedInputs.get(nodeId)!
    const upstreamGeneratorIds = new Set(
      canvasFlowUpstreamNodes(document, nodeId)
        .filter(upstream => (upstream.data.kind === 'generator' || upstream.data.kind === 'video-generator') && runnableIds.has(upstream.id))
        .map(upstream => upstream.id),
    )
    const connectedResults = (graph.outgoing.get(nodeId) || [])
      .map(targetId => graph.nodesById.get(targetId))
      .filter((target): target is CanvasFlowNode => target?.data.kind === 'result')
    const resultTargets = request.mode === 'all'
      ? connectedResults.filter(result => !resultHasFreshOutput(result, node))
      : connectedResults
    const invocationTargets: Array<CanvasFlowNode | null> = connectedResults.length === 0
      ? [null]
      : resultTargets
    const generatorSteps = invocationTargets.map(result => ({
      stepId: canvasFlowExecutionStepId(nodeId, result?.id || ''),
      nodeId,
      resultNodeId: result?.id || '',
      dependencyStepIds: [],
      dependencyNodeIds: orderedGeneratorIds.filter(id => upstreamGeneratorIds.has(id)),
      prompt: inputs.prompt,
      promptNodeIds: inputs.promptNodes.map(promptNode => promptNode.id),
      referenceNodeIds: inputs.referenceNodes.map(referenceNode => referenceNode.id),
      modelId: String(node.data.modelId || document.settings.modelId || '').trim(),
      aspectRatio: String(node.data.aspectRatio || document.settings.aspectRatio || (node.data.kind === 'video-generator' ? '16:9' : '1:1')),
      resolution: String(node.data.resolution || document.settings.resolution || (node.data.kind === 'video-generator' ? '720p' : '1k')),
      quality: String(node.data.quality || document.settings.quality || 'auto'),
      duration: node.data.kind === 'video-generator' ? Number(node.data.duration || 6) : undefined,
    } satisfies CanvasFlowExecutionStep))
    stepsByGeneratorId.set(nodeId, generatorSteps)
    return generatorSteps
  })
  const steps = stepsWithoutDependencies.map(step => {
    const upstreamNodes = canvasFlowUpstreamNodes(document, step.nodeId)
    const explicitResultIdsByProducer = new Map<string, Set<string>>()
    upstreamNodes.forEach(upstream => {
      if (upstream.data.kind !== 'result') return
      for (const producerId of graph.incoming.get(upstream.id) || []) {
        if (!stepsByGeneratorId.has(producerId)) continue
        const resultIds = explicitResultIdsByProducer.get(producerId) || new Set<string>()
        resultIds.add(upstream.id)
        explicitResultIdsByProducer.set(producerId, resultIds)
      }
    })

    const dependencyStepIds: string[] = []
    for (const producerId of step.dependencyNodeIds) {
      const producerSteps = stepsByGeneratorId.get(producerId) || []
      const explicitResultIds = explicitResultIdsByProducer.get(producerId)
      const requiredSteps = explicitResultIds?.size
        ? producerSteps.filter(candidate => Boolean(candidate.resultNodeId && explicitResultIds.has(candidate.resultNodeId)))
        : producerSteps
      requiredSteps.forEach(candidate => {
        const dependencyStepId = candidate.stepId || candidate.nodeId
        if (!dependencyStepIds.includes(dependencyStepId)) dependencyStepIds.push(dependencyStepId)
      })
    }
    return { ...step, dependencyStepIds }
  })

  if (steps.length === 0) {
    const scopedGeneratorNodes = document.nodes.filter(node => (
      (node.data.kind === 'generator' || node.data.kind === 'video-generator') && scope.generatorIds.has(node.id)
    ))
    const allPaused = scopedGeneratorNodes.length > 0 && scopedGeneratorNodes.every(node => node.data.paused)
    const allUpToDate = !allPaused
      && request.mode === 'all'
      && freshGeneratorIds.size === scope.generatorIds.size
      && scope.generatorIds.size > 0
    validationErrors.push({
      code: allUpToDate ? 'all-up-to-date' : 'no-executable-generator',
      message: allPaused
        ? '本次运行范围内的生成节点均已暂停，请先恢复至少一个节点。'
        : allUpToDate
          ? '所有生成节点都已有最新结果；如需再次生成，请选择“强制重新运行全部”。'
          : '本次运行范围内没有配置完整且可执行的生成节点。',
      blocking: true,
    })
  }

  return {
    mode: request.mode,
    canRun: steps.length > 0 && !validationErrors.some(error => error.blocking),
    steps,
    skippedNodes,
    validationErrors,
  }
}

export function wouldCreateCanvasFlowCycle(
  document: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  sourceId: string,
  targetId: string,
) {
  const graph = indexGraph(document)
  if (!graph.nodesById.has(sourceId) || !graph.nodesById.has(targetId)) return false
  if (sourceId === targetId) return true
  return reachableNodeIds([targetId], graph.outgoing).has(sourceId)
}
