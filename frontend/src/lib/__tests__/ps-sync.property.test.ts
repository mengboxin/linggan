/**
 * PS Sync 纯函数属性测试
 *
 * 测试 Store 更新逻辑的纯函数，验证正确性属性。
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  applyLayerUpdate,
  applyOrderChange,
  applyLayerAdd,
  applyLayerDelete,
} from '../ps-sync'
import type { Layer } from '../editor-store'

// ─── 辅助生成器 ─────────────────────────────────────────────────────────────────

/** 生成有效的 Layer 对象 */
const layerArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  imageBase64: fc.string({ minLength: 1, maxLength: 100 }),
  visible: fc.boolean(),
  opacity: fc.double({ min: 0, max: 1, noNaN: true }),
}) as fc.Arbitrary<Layer>

/** 生成具有唯一 ID 的图层数组 */
const uniqueLayersArb = fc
  .array(layerArb, { minLength: 1, maxLength: 20 })
  .map(layers => {
    // 确保 ID 唯一
    const seen = new Set<string>()
    return layers.filter(l => {
      if (seen.has(l.id)) return false
      seen.add(l.id)
      return true
    })
  })
  .filter(layers => layers.length >= 1)

// ─── Property 7: Store update on layer-updated message ──────────────────────────

describe('Feature: ps-uxp-layer-sync, Property 7: Store update on layer-updated message', () => {
  /**
   * Validates: Requirements 3.3
   *
   * 对于任何包含目标 platformId 的图层数组和新的 imageBase64，
   * 应用更新后：
   * 1. 目标图层的 imageBase64 被替换为新值
   * 2. 其他所有图层保持不变
   */
  it('仅更新目标图层的 imageBase64，其他图层不变', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb,
        fc.string({ minLength: 1, maxLength: 200 }),
        (layers, newImageBase64) => {
          // 随机选择一个目标图层
          const targetIndex = Math.floor(Math.random() * layers.length)
          const targetId = layers[targetIndex].id

          const result = applyLayerUpdate(layers, targetId, newImageBase64)

          // 结果长度不变
          expect(result.length).toBe(layers.length)

          // 目标图层的 imageBase64 被更新
          const updatedTarget = result.find(l => l.id === targetId)
          expect(updatedTarget).toBeDefined()
          expect(updatedTarget!.imageBase64).toBe(newImageBase64)

          // 目标图层的其他属性不变
          const originalTarget = layers[targetIndex]
          expect(updatedTarget!.id).toBe(originalTarget.id)
          expect(updatedTarget!.name).toBe(originalTarget.name)
          expect(updatedTarget!.visible).toBe(originalTarget.visible)
          expect(updatedTarget!.opacity).toBe(originalTarget.opacity)

          // 其他图层完全不变
          for (let i = 0; i < layers.length; i++) {
            if (layers[i].id !== targetId) {
              const resultLayer = result.find(l => l.id === layers[i].id)
              expect(resultLayer).toEqual(layers[i])
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('目标 platformId 不存在时，所有图层不变', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb,
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 200 }),
        (layers, nonExistentId, newImageBase64) => {
          // 确保 ID 不在图层中
          fc.pre(!layers.some(l => l.id === nonExistentId))

          const result = applyLayerUpdate(layers, nonExistentId, newImageBase64)

          // 所有图层不变
          expect(result).toEqual(layers)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 11: Store reorder on order-changed message ────────────────────────

describe('Feature: ps-uxp-layer-sync, Property 11: Store reorder on order-changed message', () => {
  /**
   * Validates: Requirements 5.3
   *
   * 对于任何有效的 order-changed 消息（包含所有现有图层 ID 的排列），
   * 应用重排后：
   * 1. 图层集合不变（无新增或删除）
   * 2. 图层顺序与 orderedIds 一致
   */
  it('重排后图层集合不变且顺序正确', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb.chain(layers => {
          // 生成 layers 的 ID 排列
          const ids = layers.map(l => l.id)
          return fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length })
            .map(shuffledIds => ({ layers, orderedIds: shuffledIds }))
        }),
        ({ layers, orderedIds }) => {
          const result = applyOrderChange(layers, orderedIds)

          // 图层数量不变
          expect(result.length).toBe(layers.length)

          // 图层集合不变（相同的 ID 集合）
          const originalIds = new Set(layers.map(l => l.id))
          const resultIds = new Set(result.map(l => l.id))
          expect(resultIds).toEqual(originalIds)

          // 顺序与 orderedIds 一致
          for (let i = 0; i < orderedIds.length; i++) {
            expect(result[i].id).toBe(orderedIds[i])
          }

          // 每个图层的内容不变
          for (const layer of layers) {
            const resultLayer = result.find(l => l.id === layer.id)
            expect(resultLayer).toEqual(layer)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 12: Layer insertion at correct position ───────────────────────────

describe('Feature: ps-uxp-layer-sync, Property 12: Layer insertion at correct position', () => {
  /**
   * Validates: Requirements 6.2
   *
   * 对于任何 N 个图层的 Store 和任何有效插入位置 P (0 ≤ P ≤ N)，
   * 插入新图层后：
   * 1. 结果有 N+1 个图层
   * 2. 新图层在索引 P 处
   * 3. 其他图层保持相对顺序
   */
  it('新图层插入到正确位置，其他图层保持相对顺序', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb,
        layerArb,
        fc.nat(),
        (layers, newLayer, rawPosition) => {
          // 确保新图层 ID 不与现有图层冲突
          fc.pre(!layers.some(l => l.id === newLayer.id))

          // 将 position 限制在有效范围内
          const position = rawPosition % (layers.length + 1)

          const result = applyLayerAdd(layers, newLayer, position)

          // 结果有 N+1 个图层
          expect(result.length).toBe(layers.length + 1)

          // 新图层在索引 position 处
          expect(result[position].id).toBe(newLayer.id)
          expect(result[position]).toEqual(newLayer)

          // 其他图层保持相对顺序
          const otherLayers = result.filter(l => l.id !== newLayer.id)
          expect(otherLayers.length).toBe(layers.length)
          for (let i = 0; i < layers.length; i++) {
            expect(otherLayers[i]).toEqual(layers[i])
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 13: Layer deletion removes from store and map ─────────────────────

describe('Feature: ps-uxp-layer-sync, Property 13: Layer deletion removes from store and map', () => {
  /**
   * Validates: Requirements 6.4
   *
   * 对于任何包含目标图层的 Store，删除后：
   * 1. Store 中不再包含该图层
   * 2. 其他图层保持不变
   * 3. 结果长度为 N-1
   */
  it('删除后 store 中不存在该图层，其他图层不变', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb,
        (layers) => {
          // 随机选择一个要删除的图层
          const targetIndex = Math.floor(Math.random() * layers.length)
          const targetId = layers[targetIndex].id

          const result = applyLayerDelete(layers, targetId)

          // 结果长度为 N-1
          expect(result.length).toBe(layers.length - 1)

          // 目标图层不在结果中
          expect(result.find(l => l.id === targetId)).toBeUndefined()

          // 其他图层保持不变且相对顺序不变
          const expectedOthers = layers.filter(l => l.id !== targetId)
          expect(result).toEqual(expectedOthers)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('删除不存在的图层时，store 不变', () => {
    fc.assert(
      fc.property(
        uniqueLayersArb,
        fc.uuid(),
        (layers, nonExistentId) => {
          // 确保 ID 不在图层中
          fc.pre(!layers.some(l => l.id === nonExistentId))

          const result = applyLayerDelete(layers, nonExistentId)

          // 所有图层不变
          expect(result).toEqual(layers)
        },
      ),
      { numRuns: 100 },
    )
  })
})
