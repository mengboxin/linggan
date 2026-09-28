/**
 * Property-Based Test: 命中测试属性 (P1, P2, P19)
 *
 * **Validates: Requirements 1.2, 1.6**
 *
 * P1 — Hit-test 安全性（bbox-only 模式下，命中结果的点必须在该 mask 的 bbox 内）:
 * ∀ point p, ∀ masks M:
 *     let result = hitTest(M, p.x, p.y)
 *     result != null → pointInBBox(p.x, p.y, M.find(m => m.id === result).bbox)
 *
 * P2 — Hit-test 优先最小面积元素:
 * ∀ point p, ∀ masks M:
 *     let candidates = M.filter(m => pointInBBox(p.x, p.y, m.bbox))
 *     candidates.length > 0 → hitTest(M, p.x, p.y) === id of argmin(bboxArea(m.bbox)) for m in candidates
 *
 * P19 — bbox 有效性（hitTest 返回的 mask 的 bbox 必须有正面积且非负坐标）:
 * ∀ mask m returned by hitTest:
 *     m.bbox.w > 0 ∧ m.bbox.h > 0 ∧ m.bbox.x >= 0 ∧ m.bbox.y >= 0
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { hitTest, pointInBBox, bboxArea } from '../../src/lib/touch-edit-store'
import type { ElementMask, BBox, ElementCategory } from '../../src/lib/types/touch-edit'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** 元素类别 arbitrary */
const categoryArb: fc.Arbitrary<ElementCategory> = fc.constantFrom(
  'person', 'object', 'text', 'background', 'icon', 'shape',
)

/** 有效 BBox arbitrary：正面积且非负坐标 */
const validBBoxArb: fc.Arbitrary<BBox> = fc.record({
  x: fc.integer({ min: 0, max: 4096 }),
  y: fc.integer({ min: 0, max: 4096 }),
  w: fc.integer({ min: 1, max: 2048 }),
  h: fc.integer({ min: 1, max: 2048 }),
})

/** 单个 ElementMask arbitrary（有效 bbox） */
const elementMaskArb: fc.Arbitrary<ElementMask> = fc.record({
  id: fc.uuid(),
  category: categoryArb,
  maskBase64: fc.constantFrom(
    '',                    // 空蒙版
    'AAAA',               // 全空（alpha=0）
    '////',               // 全满（alpha=255）
    'iVBORw0KGgo=',       // 模拟圆形蒙版 base64
    'UkVQRUFU',           // 模拟棋盘蒙版 base64
    'Qk9VTkRBUlk=',      // 模拟边界点蒙版 base64
  ),
  bbox: validBBoxArb,
  confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
})

/** ElementMask 数组 arbitrary：0-30 个元素 */
const masksArb = fc.array(elementMaskArb, { minLength: 0, maxLength: 30 })

/** 非空 ElementMask 数组 arbitrary：1-30 个元素 */
const nonEmptyMasksArb = fc.array(elementMaskArb, { minLength: 1, maxLength: 30 })

/** 画布坐标点 arbitrary */
const pointArb = fc.record({
  x: fc.integer({ min: 0, max: 6144 }),
  y: fc.integer({ min: 0, max: 6144 }),
})

/**
 * 生成保证命中的测试数据：点在至少一个 mask 的 bbox 内
 * 用于测试 P2（确保有候选时的行为）
 */
const pointInMaskArb = nonEmptyMasksArb.chain(masks => {
  // 从 masks 中随机选一个，生成在其 bbox 内的点
  const maskIndex = fc.integer({ min: 0, max: masks.length - 1 })
  return maskIndex.map(idx => {
    const mask = masks[idx]
    return { masks, mask }
  })
}).chain(({ masks, mask }) => {
  // 生成在 mask.bbox 内的点
  const x = fc.integer({ min: mask.bbox.x, max: mask.bbox.x + mask.bbox.w })
  const y = fc.integer({ min: mask.bbox.y, max: mask.bbox.y + mask.bbox.h })
  return fc.record({ x, y }).map(point => ({ masks, point }))
})

/**
 * 生成嵌套 bbox 场景：多个 mask 的 bbox 互相包含
 * 用于测试 P2（小面积优先）
 */
const nestedMasksArb: fc.Arbitrary<{ masks: ElementMask[]; point: { x: number; y: number } }> =
  fc.record({
    baseX: fc.integer({ min: 0, max: 1000 }),
    baseY: fc.integer({ min: 0, max: 1000 }),
    baseW: fc.integer({ min: 100, max: 2000 }),
    baseH: fc.integer({ min: 100, max: 2000 }),
    count: fc.integer({ min: 2, max: 10 }),
  }).chain(({ baseX, baseY, baseW, baseH, count }) => {
    // 生成 count 个嵌套 bbox，每个比前一个小
    const masks: ElementMask[] = []
    for (let i = 0; i < count; i++) {
      const shrink = i * Math.floor(Math.min(baseW, baseH) / (count * 2 + 1))
      const bbox: BBox = {
        x: baseX + shrink,
        y: baseY + shrink,
        w: Math.max(1, baseW - shrink * 2),
        h: Math.max(1, baseH - shrink * 2),
      }
      masks.push({
        id: `nested-${i}`,
        category: 'object',
        maskBase64: '',
        bbox,
        confidence: 0.9,
      })
    }
    // 生成在最内层 bbox 内的点（确保所有 mask 都是候选）
    const innerMask = masks[masks.length - 1]
    const x = fc.integer({ min: innerMask.bbox.x, max: innerMask.bbox.x + innerMask.bbox.w })
    const y = fc.integer({ min: innerMask.bbox.y, max: innerMask.bbox.y + innerMask.bbox.h })
    return fc.record({ x, y }).map(point => ({ masks, point }))
  })

// ─── P1: Hit-test 安全性 ────────────────────────────────────────────────────────

describe('P1: Hit-test 安全性 — 命中结果的点必须在该 mask 的 bbox 内', () => {
  it('∀ point, ∀ masks: hitTest 返回非 null 时，点在返回 mask 的 bbox 内', () => {
    fc.assert(
      fc.property(masksArb, pointArb, (masks, point) => {
        const result = hitTest(masks, point.x, point.y)

        if (result !== null) {
          // 找到命中的 mask
          const hitMask = masks.find(m => m.id === result)
          expect(hitMask).toBeDefined()
          // 验证 P1：点在命中 mask 的 bbox 内
          expect(pointInBBox(point.x, point.y, hitMask!.bbox)).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('空 masks 列表时，hitTest 始终返回 null', () => {
    fc.assert(
      fc.property(pointArb, (point) => {
        const result = hitTest([], point.x, point.y)
        expect(result).toBeNull()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('点在所有 mask bbox 外时，hitTest 返回 null', () => {
    fc.assert(
      fc.property(nonEmptyMasksArb, (masks) => {
        // 选择一个保证在所有 bbox 外的点
        const maxRight = Math.max(...masks.map(m => m.bbox.x + m.bbox.w))
        const maxBottom = Math.max(...masks.map(m => m.bbox.y + m.bbox.h))
        const outsidePoint = { x: maxRight + 100, y: maxBottom + 100 }

        const result = hitTest(masks, outsidePoint.x, outsidePoint.y)
        expect(result).toBeNull()
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P2: Hit-test 优先最小面积 ──────────────────────────────────────────────────

describe('P2: Hit-test 优先最小面积 — 嵌套 mask 时返回面积最小的候选', () => {
  it('∀ point, ∀ masks: 有候选时返回面积最小的 mask', () => {
    fc.assert(
      fc.property(pointInMaskArb, ({ masks, point }) => {
        const result = hitTest(masks, point.x, point.y)

        // 计算所有候选（点在其 bbox 内的 mask）
        const candidates = masks.filter(m => pointInBBox(point.x, point.y, m.bbox))

        if (candidates.length > 0) {
          expect(result).not.toBeNull()

          // 找到面积最小的候选
          const minArea = Math.min(...candidates.map(m => bboxArea(m.bbox)))
          const smallestCandidate = candidates.find(m => bboxArea(m.bbox) === minArea)

          // 验证 P2：hitTest 返回面积最小的候选
          expect(result).toBe(smallestCandidate!.id)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('嵌套 bbox 场景：始终返回最内层（面积最小）的 mask', () => {
    fc.assert(
      fc.property(nestedMasksArb, ({ masks, point }) => {
        const result = hitTest(masks, point.x, point.y)

        // 所有 mask 的 bbox 都包含该点（嵌套设计）
        const candidates = masks.filter(m => pointInBBox(point.x, point.y, m.bbox))
        expect(candidates.length).toBeGreaterThan(0)

        // 找到面积最小的候选
        const minArea = Math.min(...candidates.map(m => bboxArea(m.bbox)))
        const smallestCandidate = candidates.find(m => bboxArea(m.bbox) === minArea)

        // 验证返回最小面积的 mask
        expect(result).toBe(smallestCandidate!.id)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('单个 mask 且点在 bbox 内时，直接返回该 mask', () => {
    fc.assert(
      fc.property(elementMaskArb, (mask) => {
        // 生成在 bbox 内的点
        const point = {
          x: mask.bbox.x + Math.floor(mask.bbox.w / 2),
          y: mask.bbox.y + Math.floor(mask.bbox.h / 2),
        }

        const result = hitTest([mask], point.x, point.y)
        expect(result).toBe(mask.id)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('面积相同的多个候选时，返回排序后的第一个（稳定性）', () => {
    fc.assert(
      fc.property(
        validBBoxArb,
        fc.array(fc.uuid(), { minLength: 2, maxLength: 5 }),
        (bbox, ids) => {
          // 创建多个相同 bbox 的 mask
          const masks: ElementMask[] = ids.map(id => ({
            id,
            category: 'object' as ElementCategory,
            maskBase64: '',
            bbox: { ...bbox },
            confidence: 0.9,
          }))

          const point = {
            x: bbox.x + Math.floor(bbox.w / 2),
            y: bbox.y + Math.floor(bbox.h / 2),
          }

          const result = hitTest(masks, point.x, point.y)
          // 应该返回某个有效 id
          expect(ids).toContain(result)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P19: bbox 有效性 ───────────────────────────────────────────────────────────

describe('P19: bbox 有效性 — hitTest 返回的 mask 的 bbox 必须有效', () => {
  it('∀ point, ∀ masks（有效 bbox）: hitTest 返回的 mask 的 bbox 满足 w>0, h>0, x>=0, y>=0', () => {
    fc.assert(
      fc.property(masksArb, pointArb, (masks, point) => {
        const result = hitTest(masks, point.x, point.y)

        if (result !== null) {
          const hitMask = masks.find(m => m.id === result)
          expect(hitMask).toBeDefined()

          // 验证 P19：bbox 有效性
          expect(hitMask!.bbox.w).toBeGreaterThan(0)
          expect(hitMask!.bbox.h).toBeGreaterThan(0)
          expect(hitMask!.bbox.x).toBeGreaterThanOrEqual(0)
          expect(hitMask!.bbox.y).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('bbox 面积始终为正数', () => {
    fc.assert(
      fc.property(masksArb, pointArb, (masks, point) => {
        const result = hitTest(masks, point.x, point.y)

        if (result !== null) {
          const hitMask = masks.find(m => m.id === result)
          expect(hitMask).toBeDefined()

          // 面积 = w * h > 0（因为 w > 0 且 h > 0）
          expect(bboxArea(hitMask!.bbox)).toBeGreaterThan(0)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('边界点测试：点恰好在 bbox 边界上时仍可命中', () => {
    fc.assert(
      fc.property(elementMaskArb, fc.constantFrom('topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'center'), (mask, corner) => {
        let point: { x: number; y: number }

        switch (corner) {
          case 'topLeft':
            point = { x: mask.bbox.x, y: mask.bbox.y }
            break
          case 'topRight':
            point = { x: mask.bbox.x + mask.bbox.w, y: mask.bbox.y }
            break
          case 'bottomLeft':
            point = { x: mask.bbox.x, y: mask.bbox.y + mask.bbox.h }
            break
          case 'bottomRight':
            point = { x: mask.bbox.x + mask.bbox.w, y: mask.bbox.y + mask.bbox.h }
            break
          case 'center':
            point = {
              x: mask.bbox.x + Math.floor(mask.bbox.w / 2),
              y: mask.bbox.y + Math.floor(mask.bbox.h / 2),
            }
            break
        }

        const result = hitTest([mask], point.x, point.y)
        // 边界点应该命中
        expect(result).toBe(mask.id)

        // 验证 P19：命中的 mask bbox 有效
        expect(mask.bbox.w).toBeGreaterThan(0)
        expect(mask.bbox.h).toBeGreaterThan(0)
        expect(mask.bbox.x).toBeGreaterThanOrEqual(0)
        expect(mask.bbox.y).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})
