import {
  computeChildY,
  computeNewNodePosition,
  getCanvasNodeWidth,
  NODE_HEIGHT,
  type CanvasNode,
  type WorkflowArrow,
} from './workflow-store'

export interface PendingWorkflowPlan {
  primaryNodeId: string
  nodes: CanvasNode[]
  arrows: WorkflowArrow[]
}

export interface WorkflowGenerationImage {
  index: number
  b64: string
  imageUrl: string
  previewUrl: string
  thumbnailUrl: string
  assetId: string
}

interface ReconcileWorkflowTaskOptions {
  nodes: CanvasNode[]
  taskId: string
  status: string
  images?: WorkflowGenerationImage[]
  progress?: number
  message?: string
  error?: string
  language: 'zh' | 'en'
}

export interface WorkflowNodePatch {
  nodeId: string
  patch: Partial<CanvasNode>
}

interface PendingWorkflowPlanOptions {
  existingNodes: CanvasNode[]
  existingArrows: WorkflowArrow[]
  targetParent: CanvasNode | null
  outputCount: number
  modelId: string
  prompt: string
  refImages: string[]
  clientRequestId: string
  language: 'zh' | 'en'
  now?: () => number
  createId?: () => string
}

export function createPendingWorkflowPlan({
  existingNodes,
  existingArrows,
  targetParent,
  outputCount,
  modelId,
  prompt,
  refImages,
  clientRequestId,
  language,
  now = Date.now,
  createId = () => crypto.randomUUID(),
}: PendingWorkflowPlanOptions): PendingWorkflowPlan {
  const count = Math.max(1, Math.min(3, Math.round(outputCount || 1)))
  const nodes: CanvasNode[] = []
  const arrows: WorkflowArrow[] = []
  const rootPosition = targetParent ? null : computeNewNodePosition(existingNodes)
  const childArrows = targetParent
    ? existingArrows.filter(arrow => arrow.fromNodeId === targetParent.id)
    : []
  const existingChildIds = childArrows.map(arrow => arrow.toNodeId)
  const existingChildren = existingNodes.filter(node => existingChildIds.includes(node.id))

  for (let index = 0; index < count; index += 1) {
    const nodeId = createId()
    const childCount = childArrows.length + 1 + index
    const nodeIndex = targetParent
      ? parseFloat(`${targetParent.index}.${childCount}`)
      : index + 1
    const x = targetParent
      ? targetParent.x + getCanvasNodeWidth(targetParent) + 80
      : rootPosition!.x
    const y = targetParent
      ? computeChildY(
          targetParent,
          childCount,
          [...existingChildren, ...nodes],
          existingNodes,
          existingArrows,
        )
      : rootPosition!.y + index * (NODE_HEIGHT + 40)

    nodes.push({
      id: nodeId,
      imageBase64: '',
      label: targetParent
        ? `#${nodeIndex}${count > 1 ? ` · ${index + 1}` : ''}`
        : (count > 1 ? `发散 ${index + 1}` : '分支1'),
      modelName: modelId,
      prompt,
      role: 'assistant',
      promptType: 'edit',
      timestamp: now(),
      x,
      y,
      index: nodeIndex,
      branchLabel: targetParent?.branchLabel || (count > 1 ? `发散 ${index + 1}` : '分支1'),
      parentId: targetParent?.id,
      refImages,
      loading: true,
      progress: 5,
      loadingLabel: count > 1
        ? (language === 'zh' ? `正在提交发散创意 ${index + 1}/${count}...` : `Submitting variation ${index + 1}/${count}...`)
        : (language === 'zh' ? '正在提交生成任务...' : 'Submitting generation task...'),
      generationClientRequestId: clientRequestId,
      generationVariantIndex: index,
    })

    if (targetParent) {
      arrows.push({
        id: createId(),
        fromNodeId: targetParent.id,
        toNodeId: nodeId,
        stepLabel: count > 1 ? `发散 ${index + 1}` : `第 ${childCount} 次编辑`,
      })
    }
  }

  return { primaryNodeId: nodes[0].id, nodes, arrows }
}

export function reconcileWorkflowTaskNodes({
  nodes,
  taskId,
  status,
  images = [],
  progress,
  message,
  error,
  language,
}: ReconcileWorkflowTaskOptions): WorkflowNodePatch[] {
  const taskNodes = nodes.filter(node => node.generationTaskId === taskId)

  if (status === 'completed') {
    return taskNodes.map((node, position) => {
      const variantIndex = node.generationVariantIndex ?? position
      const image = images.find(item => item.index === variantIndex) || images[position]
      if (!image) {
        const missingMessage = language === 'zh' ? '生成完成但没有返回对应图片' : 'Generation completed without this image'
        return {
          nodeId: node.id,
          patch: {
            loading: false,
            progress: 100,
            error: missingMessage,
            loadingLabel: missingMessage,
          },
        }
      }
      return {
        nodeId: node.id,
        patch: {
          imageBase64: image.b64,
          imageUrl: image.imageUrl || undefined,
          previewUrl: image.previewUrl || undefined,
          thumbnailUrl: image.thumbnailUrl || undefined,
          assetId: image.assetId || undefined,
          loading: false,
          progress: 100,
          error: undefined,
          loadingLabel: '',
          timestamp: Date.now(),
        },
      }
    })
  }

  if (status === 'failed') {
    const failureMessage = error || (language === 'zh' ? '生成失败' : 'Generation failed')
    return taskNodes.map(node => ({
      nodeId: node.id,
      patch: {
        loading: false,
        progress: 100,
        error: failureMessage,
        loadingLabel: failureMessage,
      },
    }))
  }

  const runningMessage = message || (language === 'zh' ? '正在生成图片...' : 'Generating image...')
  return taskNodes.map(node => ({
    nodeId: node.id,
    patch: {
      loading: true,
      progress: typeof progress === 'number' ? progress : (node.progress || 10),
      error: undefined,
      loadingLabel: runningMessage,
    },
  }))
}
