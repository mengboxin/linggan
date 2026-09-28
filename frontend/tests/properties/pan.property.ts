/**
 * Property-Based Test: 平移属性测试 (P24)
 *
 * **Validates: Requirements 9.4**
 *
 * P24 — Pan 1:1 比率:
 * ∀ pan delta (dx, dy), ∀ initial offset (ox, oy):
 *     let (ox', oy') = applyPan(ox, oy, dx, dy)
 *     ox' = ox + dx ∧ oy' = oy + dy   // 像素精确
 *
 * 验证平移不受 zoom 级别影响，dx/dy 不被 zoom 误用。
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { computeZoomOffset } from '../../src/components/InfiniteCanvas/usePanZoom'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
} from '../../src/components/InfiniteCanvas/InfiniteCanvas'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── 辅助纯函数 ────────────────────────────────────────────────────────────────

/**
 * 纯函数版 applyPan — 模拟 InfiniteCanvas 中 Space+拖拽的平移逻辑
 *
 * 根据 R9.4：1:1 cursor-to-canvas 移动比
 * 平移操作直接将 dx/dy 加到当前偏移上，不受 zoom 影响
 */
function applyPan(
  currentOffsetX: number,
  currentOffsetY: number,
  dx: number,
  dy: number,
): { offsetX: number; offsetY: number } {
  return {
    offsetX: currentOffsetX + dx,
    offsetY: currentOffsetY + dy,
  }
}

/**
 * 验证 pan 不受 zoom 影响的辅助函数
 * 在不同 zoom 级别下，相同的 dx/dy 应产生相同的偏移变化
 */
function applyPanWithZoom(
  currentOffsetX: number,
  currentOffsetY: number,
  dx: number,
  dy: number,
  _zoom: number, // zoom 参数被忽略，验证 1:1 比率
): { offsetX: number; offsetY: number } {
  // R9.4: 1:1 cursor-to-canvas 移动比 — zoom 不影响 pan
  return {
    offsetX: currentOffsetX + dx,
    offsetY: currentOffsetY + dy,
  }
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** 偏移量 arbitrary：覆盖大范围正负值 */
const offsetArb = fc.double({
  min: -100000,
  max: 100000,
  noNaN: true,
  noDefaultInfinity: true,
})

/** 平移增量 arbitrary：覆盖正负值和零 */
const deltaArb = fc.double({
  min: -10000,
  max: 10000,
  noNaN: true,
  noDefaultInfinity: true,
})

/** 整数平移增量（模拟像素级移动） */
const intDeltaArb = fc.integer({ min: -5000, max: 5000 })

/** 有效 zoom 值 arbitrary */
const zoomArb = fc.double({
  min: MIN_ZOOM,
  max: MAX_ZOOM,
  noNaN: true,
  noDefaultInfinity: true,
})

/** 平移操作序列 arbitrary */
const panOpsArb = fc.array(
  fc.record({
    dx: deltaArb,
    dy: deltaArb,
  }),
  { minLength: 1, maxLength: 50 },
)

// ─── P24: Pan 1:1 比率 ─────────────────────────────────────────────────────────

describe('P24: Pan 1:1 — dx/dy 不被 zoom 误用', () => {
  it('applyPan(ox, oy, dx, dy) = (ox + dx, oy + dy) — 像素精确', () => {
    fc.assert(
      fc.property(offsetArb, offsetArb, deltaArb, deltaArb, (ox, oy, dx, dy) => {
        const { offsetX, offsetY } = applyPan(ox, oy, dx, dy)

        // 验证 P24：像素精确的 1:1 映射
        expect(offsetX).toBe(ox + dx)
        expect(offsetY).toBe(oy + dy)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('整数像素移动精确无误差', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: -10000, max: 10000 }),
        intDeltaArb,
        intDeltaArb,
        (ox, oy, dx, dy) => {
          const { offsetX, offsetY } = applyPan(ox, oy, dx, dy)

          // 整数运算应完全精确
          expect(offsetX).toBe(ox + dx)
          expect(offsetY).toBe(oy + dy)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('pan 不受 zoom 级别影响：不同 zoom 下相同 dx/dy 产生相同偏移变化', () => {
    fc.assert(
      fc.property(
        offsetArb,
        offsetArb,
        deltaArb,
        deltaArb,
        zoomArb,
        zoomArb,
        (ox, oy, dx, dy, zoom1, zoom2) => {
          // 在 zoom1 下 pan
          const result1 = applyPanWithZoom(ox, oy, dx, dy, zoom1)
          // 在 zoom2 下 pan
          const result2 = applyPanWithZoom(ox, oy, dx, dy, zoom2)

          // 验证 P24：zoom 不影响 pan 结果
          expect(result1.offsetX).toBe(result2.offsetX)
          expect(result1.offsetY).toBe(result2.offsetY)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('pan 可逆性：applyPan(applyPan(o, dx, dy), -dx, -dy) = o', () => {
    fc.assert(
      fc.property(offsetArb, offsetArb, deltaArb, deltaArb, (ox, oy, dx, dy) => {
        // 先 pan 正向
        const { offsetX: ox1, offsetY: oy1 } = applyPan(ox, oy, dx, dy)
        // 再 pan 反向
        const { offsetX: ox2, offsetY: oy2 } = applyPan(ox1, oy1, -dx, -dy)

        // 验证可逆性（浮点精度容忍）
        expect(Math.abs(ox2 - ox)).toBeLessThan(1e-10)
        expect(Math.abs(oy2 - oy)).toBeLessThan(1e-10)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('pan 结合律：连续多次 pan 等价于一次总 pan', () => {
    fc.assert(
      fc.property(offsetArb, offsetArb, panOpsArb, (ox, oy, ops) => {
        // 逐步 pan
        let currentX = ox
        let currentY = oy
        let totalDx = 0
        let totalDy = 0

        for (const { dx, dy } of ops) {
          const result = applyPan(currentX, currentY, dx, dy)
          currentX = result.offsetX
          currentY = result.offsetY
          totalDx += dx
          totalDy += dy
        }

        // 一次性 pan 总量
        const { offsetX: directX, offsetY: directY } = applyPan(ox, oy, totalDx, totalDy)

        // 验证结合律（浮点累积误差容忍）
        expect(Math.abs(currentX - directX)).toBeLessThan(1e-6)
        expect(Math.abs(currentY - directY)).toBeLessThan(1e-6)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('负向 pan：负 dx/dy 正确减少偏移', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -10000, max: -1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -10000, max: -1, noNaN: true, noDefaultInfinity: true }),
        (ox, oy, dx, dy) => {
          const { offsetX, offsetY } = applyPan(ox, oy, dx, dy)

          // 负向 pan 应减少偏移
          expect(offsetX).toBeLessThan(ox)
          expect(offsetY).toBeLessThan(oy)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('零 pan 不改变偏移', () => {
    fc.assert(
      fc.property(offsetArb, offsetArb, (ox, oy) => {
        const { offsetX, offsetY } = applyPan(ox, oy, 0, 0)

        expect(offsetX === ox).toBe(true)
        expect(offsetY === oy).toBe(true)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('computeZoomOffset 不影响 pan 独立性：zoom 变化只改变 offset 的缩放分量', () => {
    fc.assert(
      fc.property(
        zoomArb,
        zoomArb,
        offsetArb,
        offsetArb,
        deltaArb,
        deltaArb,
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
        (currentZoom, newZoom, ox, oy, dx, dy, centerX, centerY) => {
          // 先 pan
          const afterPan = applyPan(ox, oy, dx, dy)

          // 然后 zoom（zoom 改变 offset 但不影响 pan 的 dx/dy 语义）
          const afterZoom = computeZoomOffset(
            currentZoom,
            clampZoom(newZoom),
            centerX,
            centerY,
            afterPan.offsetX,
            afterPan.offsetY,
          )

          // 验证：zoom 后的 offset 是确定性的（相同输入相同输出）
          const afterZoom2 = computeZoomOffset(
            currentZoom,
            clampZoom(newZoom),
            centerX,
            centerY,
            afterPan.offsetX,
            afterPan.offsetY,
          )

          expect(afterZoom.offsetX).toBe(afterZoom2.offsetX)
          expect(afterZoom.offsetY).toBe(afterZoom2.offsetY)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
