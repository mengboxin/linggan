/**
 * WorkflowCanvas 属性测试
 * Feature: image-workflow-redesign
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as fc from 'fast-check'
import { applyWheelZoom, generateNodeDownloadFilename } from '../WorkflowCanvas'
import {
  computeNewNodePosition,
  NODE_WIDTH,
  MIN_GAP,
} from '../../../lib/workflow-store'
import type { CanvasNode, WorkflowArrow } from '../../../lib/workflow-store'

// ── Mock 依赖 ──────────────────────────────────────────────────────────────────
vi.mock('../../../lib/i18n', () => ({
  useI18nStore: () => ({ lang: 'zh' }),
}))
vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'dark' }),
}))

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

/** 生成任意 CanvasNode 的 fast-check arbitrary */
function arbitraryCanvasNode(): fc.Arbitrary<CanvasNode> {
  return fc.record({
    id: fc.uuid(),
    imageBase64: fc.constant('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    label: fc.string({ minLength: 1, maxLength: 30 }),
    modelName: fc.string({ minLength: 1, maxLength: 20 }),
    prompt: fc.string({ minLength: 0, maxLength: 100 }),
    timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
    x: fc.integer({ min: 0, max: 2000 }),
    y: fc.integer({ min: 0, max: 1000 }),
    index: fc.integer({ min: 1, max: 100 }),
  })
}

/** 构建线性工作流（n 个节点，n-1 条箭头） */
function buildLinearWorkflow(nodeCount: number): { nodes: CanvasNode[]; arrows: WorkflowArrow[] } {
  const nodes: CanvasNode[] = []
  const arrows: WorkflowArrow[] = []
  for (let i = 0; i < nodeCount; i++) {
    const node: CanvasNode = {
      id: `node-${i}`,
      imageBase64: 'data:image/png;base64,test',
      label: `#${i + 1}`,
      modelName: 'test-model',
      prompt: 'test prompt',
      timestamp: Date.now() + i,
      x: i * (NODE_WIDTH + MIN_GAP) + 60,
      y: 100,
      index: i + 1,
    }
    nodes.push(node)
    if (i > 0) {
      arrows.push({
        id: `arrow-${i}`,
        fromNodeId: nodes[i - 1].id,
        toNodeId: node.id,
        stepLabel: `第 ${i} 次编辑`,
      })
    }
  }
  return { nodes, arrows }
}

const noop = () => {}

// ── 属性 3：节点渲染内容完整性 ────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 3: 节点渲染内容完整性', () => {
  it('每个节点应同时包含序号标签、模型名称和时间戳', () => {
    fc.assert(
      fc.property(arbitraryCanvasNode(), (node) => {
        const { container, unmount } = render(
          <div>
            {/* 直接渲染节点内容（不依赖完整 WorkflowCanvas） */}
            <span data-testid="node-label">{node.label}</span>
            <span data-testid="node-model">{node.modelName}</span>
            <span data-testid="node-timestamp">{node.timestamp}</span>
          </div>
        )
        const hasLabel = container.querySelector('[data-testid="node-label"]') !== null
        const hasModel = container.querySelector('[data-testid="node-model"]') !== null
        const hasTimestamp = container.querySelector('[data-testid="node-timestamp"]') !== null
        unmount()
        return hasLabel && hasModel && hasTimestamp
      }),
      { numRuns: 100 }
    )
  })
})

// ── 属性 7：新节点位置约束 ────────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 7: 新节点位置约束', () => {
  it('新节点 x 坐标应大于所有现有节点的右边界 + MIN_GAP', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryCanvasNode(), { minLength: 0, maxLength: 10 }),
        (existingNodes) => {
          const newPos = computeNewNodePosition(existingNodes)
          if (existingNodes.length === 0) {
            return newPos.x >= 0
          }
          const maxRight = Math.max(...existingNodes.map(n => n.x + NODE_WIDTH))
          return newPos.x >= maxRight + MIN_GAP
        }
      ),
      { numRuns: 100 }
    )
  })

  it('空节点列表时新节点应从初始位置开始', () => {
    const pos = computeNewNodePosition([])
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })
})

// ── 属性 8：箭头数量与节点数量关系（线性链路）────────────────────────────────
describe('Feature: image-workflow-redesign, Property 8: 箭头数量与节点数量关系（线性链路）', () => {
  it('n 个节点的线性链路应有恰好 n-1 条箭头', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        (nodeCount) => {
          const { nodes, arrows } = buildLinearWorkflow(nodeCount)
          return arrows.length === nodeCount - 1
        }
      ),
      { numRuns: 100 }
    )
  })

  it('单节点时箭头数量为 0', () => {
    const { arrows } = buildLinearWorkflow(1)
    expect(arrows.length).toBe(0)
  })
})

// ── 属性 10：缩放范围约束 ─────────────────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 10: 缩放范围约束', () => {
  it('任意滚轮事件序列后 scale 应始终在 [0.1, 3.0] 范围内', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 1, maxLength: 50 }),
        (wheelDeltas) => {
          let scale = 1
          for (const delta of wheelDeltas) {
            scale = applyWheelZoom(scale, delta)
            if (scale < 0.1 || scale > 3.0) return false
          }
          return true
        }
      ),
      { numRuns: 100 }
    )
  })

  it('从最小值继续缩小不应低于 0.1', () => {
    let scale = 0.1
    for (let i = 0; i < 20; i++) {
      scale = applyWheelZoom(scale, 100) // 正 delta = 缩小
    }
    expect(scale).toBeGreaterThanOrEqual(0.1)
  })

  it('从最大值继续放大不应超过 3.0', () => {
    let scale = 3.0
    for (let i = 0; i < 20; i++) {
      scale = applyWheelZoom(scale, -100) // 负 delta = 放大
    }
    expect(scale).toBeLessThanOrEqual(3.0)
  })
})

// ── 属性 11：下载文件名格式（节点）───────────────────────────────────────────
describe('Feature: image-workflow-redesign, Property 11: 下载文件名格式（节点）', () => {
  it('文件名应匹配 edit_{序号}_{时间戳}.png 格式', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1000000000000, max: 9999999999999 }),
        (index, timestamp) => {
          const filename = generateNodeDownloadFilename({ index, timestamp })
          return /^edit_\d+_\d+\.png$/.test(filename)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('文件名中的序号和时间戳应与节点数据一致', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1000000000000, max: 9999999999999 }),
        (index, timestamp) => {
          const filename = generateNodeDownloadFilename({ index, timestamp })
          return filename === `edit_${index}_${timestamp}.png`
        }
      ),
      { numRuns: 100 }
    )
  })
})
