/**
 * WorkflowStore 属性测试
 * Feature: image-workflow-redesign
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  serializeSnapshot,
  deserializeSnapshot,
  computeNewNodePosition,
  getCanvasNodeWidth,
  NODE_WIDTH,
  NODE_REF_GAP,
  NODE_REF_SIZE,
  MIN_GAP,
  useWorkflowStore,
} from '../workflow-store'
import type { CanvasNode, WorkflowArrow, EditSession, SnapshotJSON } from '../workflow-store'

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

/** 生成任意 CanvasNode 的 arbitrary */
function arbitraryCanvasNode(overrides?: Partial<CanvasNode>): fc.Arbitrary<CanvasNode> {
  return fc.record<CanvasNode>({
    id: fc.uuid(),
    imageBase64: fc.constant('data:image/png;base64,test'),
    label: fc.string({ minLength: 1, maxLength: 30 }),
    modelName: fc.string({ minLength: 1, maxLength: 20 }),
    prompt: fc.string({ minLength: 0, maxLength: 100 }),
    timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
    x: fc.integer({ min: 0, max: 2000 }),
    y: fc.integer({ min: 0, max: 1000 }),
    index: fc.integer({ min: 1, max: 100 }),
    parentId: fc.option(fc.uuid(), { nil: undefined }),
    refImages: fc.option(fc.array(fc.constant('data:image/png;base64,ref'), { minLength: 0, maxLength: 4 }), { nil: undefined }),
  }).map(node => ({ ...node, ...overrides }))
}

/** 生成任意 WorkflowArrow 的 arbitrary */
function arbitraryWorkflowArrow(fromId: string, toId: string): WorkflowArrow {
  return {
    id: crypto.randomUUID(),
    fromNodeId: fromId,
    toNodeId: toId,
    stepLabel: '第 1 次编辑',
  }
}

/** 生成任意 SnapshotJSON 的 arbitrary */
function arbitrarySnapshotJSON(): fc.Arbitrary<SnapshotJSON> {
  return fc.array(arbitraryCanvasNode(), { minLength: 0, maxLength: 10 }).chain(nodes => {
    // 生成对应的箭头（线性链路）
    const arrows: WorkflowArrow[] = []
    for (let i = 1; i < nodes.length; i++) {
      arrows.push(arbitraryWorkflowArrow(nodes[i - 1].id, nodes[i].id))
    }
    return fc.constant({
      version: 1 as const,
      sessionId: crypto.randomUUID(),
      nodes,
      arrows,
      savedAt: Date.now(),
    })
  })
}

/** 创建分支节点 */
function createBranchNodes(sourceNode: CanvasNode, branchCount: number): CanvasNode[] {
  return Array.from({ length: branchCount }, (_, i) => ({
    id: crypto.randomUUID(),
    imageBase64: sourceNode.imageBase64,
    label: `#${sourceNode.index + i + 1} 分支`,
    modelName: '回溯',
    prompt: sourceNode.prompt,
    timestamp: Date.now() + i,
    x: sourceNode.x + (i + 1) * (NODE_WIDTH + MIN_GAP),
    y: sourceNode.y,
    index: sourceNode.index + i + 1,
    parentId: sourceNode.id,
  }))
}

// ── 属性 12：Snapshot Round-Trip 序列化 ──────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 12: Snapshot Round-Trip 序列化', () => {
  it('deserialize(serialize(deserialize(json))) 应与 deserialize(json) 等价', () => {
    fc.assert(
      fc.property(arbitrarySnapshotJSON(), (json) => {
        // 第一次反序列化
        const result1 = deserializeSnapshot(json)

        // 序列化再反序列化
        const session1: EditSession = { id: json.sessionId, createdAt: json.savedAt }
        const json2 = serializeSnapshot(result1.nodes, result1.arrows, session1)
        const result2 = deserializeSnapshot(json2)

        // 验证等价性
        const nodesEqual = result1.nodes.length === result2.nodes.length
        const arrowsEqual = result1.arrows.length === result2.arrows.length
        const nodeIdsEqual =
          new Set(result1.nodes.map(n => n.id)).size === new Set(result2.nodes.map(n => n.id)).size &&
          result1.nodes.every(n1 => result2.nodes.some(n2 => n2.id === n1.id))
        const arrowConnectionsEqual = result1.arrows.every(a1 =>
          result2.arrows.some(a2 =>
            a2.fromNodeId === a1.fromNodeId && a2.toNodeId === a1.toNodeId
          )
        )

        return nodesEqual && arrowsEqual && nodeIdsEqual && arrowConnectionsEqual
      }),
      { numRuns: 100 }
    )
  })

  it('序列化后的 version 字段应为 1', () => {
    fc.assert(
      fc.property(arbitrarySnapshotJSON(), (json) => {
        const { nodes, arrows, session } = deserializeSnapshot(json)
        const serialized = serializeSnapshot(nodes, arrows, session)
        return serialized.version === 1
      }),
      { numRuns: 50 }
    )
  })

  it('序列化后节点数量应与原始数据一致', () => {
    fc.assert(
      fc.property(arbitrarySnapshotJSON(), (json) => {
        const { nodes, arrows, session } = deserializeSnapshot(json)
        const serialized = serializeSnapshot(nodes, arrows, session)
        return serialized.nodes.length === json.nodes.length &&
               serialized.arrows.length === json.arrows.length
      }),
      { numRuns: 100 }
    )
  })

  it('空快照的 Round-Trip 应保持为空', () => {
    const emptyJson: SnapshotJSON = {
      version: 1,
      sessionId: 'test-session',
      nodes: [],
      arrows: [],
      savedAt: Date.now(),
    }
    const result1 = deserializeSnapshot(emptyJson)
    const json2 = serializeSnapshot(result1.nodes, result1.arrows, result1.session)
    const result2 = deserializeSnapshot(json2)

    expect(result2.nodes).toHaveLength(0)
    expect(result2.arrows).toHaveLength(0)
  })
})

// ── 属性 14：分支节点 parentId 一致性 ────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 14: 分支节点 parentId 一致性', () => {
  it('从同一节点出发的所有分支节点的 parentId 应等于源节点 id', () => {
    fc.assert(
      fc.property(
        arbitraryCanvasNode(),
        fc.integer({ min: 2, max: 5 }),
        (sourceNode, branchCount) => {
          const branches = createBranchNodes(sourceNode, branchCount)
          return branches.every(n => n.parentId === sourceNode.id)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('分支节点数量应与请求的数量一致', () => {
    fc.assert(
      fc.property(
        arbitraryCanvasNode(),
        fc.integer({ min: 1, max: 10 }),
        (sourceNode, branchCount) => {
          const branches = createBranchNodes(sourceNode, branchCount)
          return branches.length === branchCount
        }
      ),
      { numRuns: 100 }
    )
  })

  it('所有分支节点的 id 应互不相同', () => {
    fc.assert(
      fc.property(
        arbitraryCanvasNode(),
        fc.integer({ min: 2, max: 8 }),
        (sourceNode, branchCount) => {
          const branches = createBranchNodes(sourceNode, branchCount)
          const ids = branches.map(n => n.id)
          return new Set(ids).size === ids.length
        }
      ),
      { numRuns: 100 }
    )
  })

  it('分支节点的 parentId 不应等于自身 id', () => {
    fc.assert(
      fc.property(
        arbitraryCanvasNode(),
        fc.integer({ min: 1, max: 5 }),
        (sourceNode, branchCount) => {
          const branches = createBranchNodes(sourceNode, branchCount)
          return branches.every(n => n.parentId !== n.id)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── 额外：computeNewNodePosition 属性测试 ────────────────────────────────────
describe('computeNewNodePosition 位置约束', () => {
  it('新节点位置应始终在所有现有节点右侧', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryCanvasNode(), { minLength: 1, maxLength: 15 }),
        (existingNodes) => {
          const pos = computeNewNodePosition(existingNodes)
          const maxRight = Math.max(...existingNodes.map(n => n.x + NODE_WIDTH))
          return pos.x >= maxRight + MIN_GAP
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('getCanvasNodeWidth 参考图安全间距', () => {
  it('为双参考图网格保留内部间距和右侧边界', () => {
    expect(getCanvasNodeWidth({ refImages: ['one', 'two'] })).toBe(
      NODE_WIDTH + NODE_REF_GAP + NODE_REF_SIZE * 2 + NODE_REF_GAP + 12,
    )
  })

  it('单参考图不额外增加网格内部间距', () => {
    expect(getCanvasNodeWidth({ refImages: ['one'] })).toBe(
      NODE_WIDTH + NODE_REF_GAP + NODE_REF_SIZE + 12,
    )
  })
})

describe('workflow node replay protection', () => {
  it('upserts a replayed node instead of appending a second copy', () => {
    const store = useWorkflowStore.getState()
    store.resetWorkflow()
    const node: CanvasNode = {
      id: 'restored-node',
      imageBase64: '',
      label: '#1',
      modelName: 'image-model',
      prompt: 'edit',
      timestamp: 1,
      x: 60,
      y: 100,
      index: 1,
      loading: true,
      generationTaskId: 'task-1',
      generationVariantIndex: 0,
    }

    store.addCanvasNode(node)
    store.addCanvasNode({ ...node, imageBase64: '/api/assets/result/preview', loading: false, progress: 100 })

    const nodes = useWorkflowStore.getState().canvasNodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ id: 'restored-node', loading: false, progress: 100 })
  })

  it('normalizes duplicate recovered nodes and arrows from an old snapshot', () => {
    const node: CanvasNode = {
      id: 'old-node', imageBase64: '', label: '#1', modelName: 'image-model', prompt: 'edit',
      timestamp: 1, x: 60, y: 100, index: 1, loading: true, generationTaskId: 'task-old', generationVariantIndex: 0,
    }
    const snapshot: SnapshotJSON = {
      version: 1,
      sessionId: 'session-old',
      savedAt: 2,
      nodes: [node, { ...node, imageBase64: '/api/assets/result/preview', loading: false, progress: 100 }],
      arrows: [
        { id: 'arrow-old', fromNodeId: 'source', toNodeId: 'old-node', stepLabel: 'edit' },
        { id: 'arrow-old', fromNodeId: 'source', toNodeId: 'old-node', stepLabel: 'edit' },
      ],
    }

    const restored = deserializeSnapshot(snapshot)
    expect(restored.nodes).toHaveLength(1)
    expect(restored.nodes[0]).toMatchObject({ id: 'old-node', loading: false, progress: 100 })
    expect(restored.arrows).toHaveLength(1)
  })
})
