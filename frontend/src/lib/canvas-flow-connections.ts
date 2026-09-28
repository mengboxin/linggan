import type { CanvasFlowDocument } from './canvas-flow-document'
import { wouldCreateCanvasFlowCycle } from './canvas-flow-execution-planner'

export type CanvasFlowConnectionValidationCode =
  | 'invalid-endpoints'
  | 'duplicate'
  | 'cycle'
  | 'result-source-required'
  | 'result-single-input'

export type CanvasFlowConnectionValidation = {
  valid: boolean
  code: CanvasFlowConnectionValidationCode | null
}

type CanvasFlowConnectionCandidate = {
  source?: string | null
  target?: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

export function validateCanvasFlowConnection(
  document: Pick<CanvasFlowDocument, 'nodes' | 'edges'>,
  connection: CanvasFlowConnectionCandidate,
  ignoredEdgeId = '',
): CanvasFlowConnectionValidation {
  const source = connection.source || ''
  const target = connection.target || ''
  const nodesById = new Map(document.nodes.map(node => [node.id, node]))

  if (!source || !target || source === target || !nodesById.has(source) || !nodesById.has(target)) {
    return { valid: false, code: 'invalid-endpoints' }
  }

  const sourceHandle = connection.sourceHandle || 'output'
  const targetHandle = connection.targetHandle || 'input'
  const remainingEdges = ignoredEdgeId
    ? document.edges.filter(edge => edge.id !== ignoredEdgeId)
    : document.edges
  const sourceNode = nodesById.get(source)!
  const targetNode = nodesById.get(target)!

  if (remainingEdges.some(edge => (
    edge.source === source
    && edge.target === target
    && (edge.sourceHandle || 'output') === sourceHandle
    && (edge.targetHandle || 'input') === targetHandle
  ))) {
    return { valid: false, code: 'duplicate' }
  }

  if (targetNode.data.kind === 'result' && sourceNode.data.kind !== 'generator' && sourceNode.data.kind !== 'video-generator') {
    return { valid: false, code: 'result-source-required' }
  }
  if (targetNode.data.kind === 'result' && remainingEdges.some(edge => edge.target === target)) {
    return { valid: false, code: 'result-single-input' }
  }

  if (wouldCreateCanvasFlowCycle({ nodes: document.nodes, edges: remainingEdges }, source, target)) {
    return { valid: false, code: 'cycle' }
  }

  return { valid: true, code: null }
}
