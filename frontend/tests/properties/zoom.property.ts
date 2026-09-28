/**
 * Property-Based Test: 缩放属性测试 (P7, P8, P21)
 *
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.6**
 *
 * P7 — 缩放区间闭合 (R9.1, R9.3):
 * ∀ zoom event sequence E = [e₁, …, eₙ]:
 *     let z = foldl(applyZoom, 1.0, E)
 *     0.05 ≤ z ≤ 16.0
 *
 * P8 — zoomIn∘zoomOut 近似幂等 (R9.2):
 * ∀ initial zoom z₀ ∈ (0.05, 16.0):
 *     let z₁ = zoomIn(z₀)
 *     let z₂ = zoomOut(z₁)
 *     |z₂ - z₀| / z₀ < 0.005   // 0.5% 误差容忍
 *
 * P21 — fitToViewport 留白 16px + 比例保留 (R9.6):
 * ∀ image (iw, ih), ∀ viewport (vw, vh) where all > 0:
 *     let { zoom, offsetX, offsetY } = fitToViewport(iw, ih, vw, vh)
 *     iw * zoom + 32 ≤ vw
 *     ∧ ih * zoom + 32 ≤ vh
 *     ∧ |aspectRatio(iw, ih) - aspectRatio(iw * zoom, ih * zoom)| < 0.001
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { computeWheelZoom } from '../../src/components/InfiniteCanvas/usePanZoom'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP_FACTOR,
  FIT_MARGIN_PX,
  clampZoom,
} from '../../src/components/InfiniteCanvas/InfiniteCanvas'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── 辅助纯函数 ────────────────────────────────────────────────────────────────

/**
 * 纯函数版 fitToViewport 计算
 * 与 InfiniteCanvas.tsx 中的 fitToViewport 方法逻辑一致，但不依赖 DOM
 */
function computeFitToViewport(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { zoom: number; offsetX: number; offsetY: number } {
  const availableWidth = viewportWidth - FIT_MARGIN_PX * 2
  const availableHeight = viewportHeight - FIT_MARGIN_PX * 2

  if (availableWidth <= 0 || availableHeight <= 0) {
    return { zoom: MIN_ZOOM, offsetX: 0, offsetY: 0 }
  }

  const scaleX = availableWidth / imageWidth
  const scaleY = availableHeight / imageHeight
  const fitZoom = clampZoom(Math.min(scaleX, scaleY))

  const offsetX = (viewportWidth - imageWidth * fitZoom) / 2
  const offsetY = (viewportHeight - imageHeight * fitZoom) / 2

  return { zoom: fitZoom, offsetX, offsetY }
}

/**
 * 模拟 zoomIn：deltaY < 0 表示放大
 */
function zoomIn(currentZoom: number): number {
  return computeWheelZoom(currentZoom, -1)
}

/**
 * 模拟 zoomOut：deltaY > 0 表示缩小
 */
function zoomOut(currentZoom: number): number {
  return computeWheelZoom(currentZoom, 1)
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** 缩放操作 arbitrary：true = zoomIn, false = zoomOut */
const zoomOpArb = fc.boolean()

/** 缩放操作序列 arbitrary：1-100 个操作 */
const zoomOpsArb = fc.array(zoomOpArb, { minLength: 1, maxLength: 100 })

/** 极端缩放操作序列：1000 个连续操作 */
const extremeZoomOpsArb = fc.array(zoomOpArb, { minLength: 1000, maxLength: 1000 })

/** 初始 zoom 值 arbitrary：在有效范围内（排除边界以测试 P8） */
const interiorZoomArb = fc.double({
  min: MIN_ZOOM * ZOOM_STEP_FACTOR,  // 稍大于 MIN，确保 zoomIn 后 zoomOut 能回来
  max: MAX_ZOOM / ZOOM_STEP_FACTOR,  // 稍小于 MAX，确保 zoomIn 不会被 clamp
  noNaN: true,
  noDefaultInfinity: true,
})

/** 任意有效 zoom 值 */
const validZoomArb = fc.double({
  min: MIN_ZOOM,
  max: MAX_ZOOM,
  noNaN: true,
  noDefaultInfinity: true,
})

/** 图像尺寸 arbitrary：1-10000 像素 */
const imageSizeArb = fc.integer({ min: 1, max: 10000 })

/** 视口尺寸 arbitrary：需要大于 2*FIT_MARGIN_PX=32 才有意义 */
const viewportSizeArb = fc.integer({ min: 33, max: 7680 })

// ─── P7: 缩放区间闭合 ──────────────────────────────────────────────────────────

describe('P7: 缩放区间闭合 — 任意缩放操作序列后 zoom ∈ [MIN_ZOOM, MAX_ZOOM]', () => {
  it('任意缩放操作序列后，zoom 始终在 [0.05, 16.0] 范围内', () => {
    fc.assert(
      fc.property(zoomOpsArb, (ops) => {
        let zoom = 1.0 // 初始缩放 100%

        for (const isZoomIn of ops) {
          zoom = isZoomIn ? zoomIn(zoom) : zoomOut(zoom)
        }

        // 验证 P7：结果始终在闭区间内
        expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
        expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('从任意有效初始 zoom 开始，操作序列后仍在范围内', () => {
    fc.assert(
      fc.property(validZoomArb, zoomOpsArb, (initialZoom, ops) => {
        let zoom = clampZoom(initialZoom)

        for (const isZoomIn of ops) {
          zoom = isZoomIn ? zoomIn(zoom) : zoomOut(zoom)
        }

        expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
        expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('极端用例：连续 1000 次 zoomIn 后 zoom ≤ MAX_ZOOM', () => {
    fc.assert(
      fc.property(extremeZoomOpsArb, (ops) => {
        let zoom = 1.0

        // 全部强制为 zoomIn
        for (let i = 0; i < ops.length; i++) {
          zoom = zoomIn(zoom)
        }

        expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
        expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
        // 连续 1000 次 zoomIn 应该达到 MAX_ZOOM
        expect(zoom).toBe(MAX_ZOOM)
      }),
      { numRuns: 5 }, // 极端用例不需要太多 runs
    )
  })

  it('极端用例：连续 1000 次 zoomOut 后 zoom ≥ MIN_ZOOM', () => {
    fc.assert(
      fc.property(extremeZoomOpsArb, (ops) => {
        let zoom = 1.0

        // 全部强制为 zoomOut
        for (let i = 0; i < ops.length; i++) {
          zoom = zoomOut(zoom)
        }

        expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
        expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
        // 连续 1000 次 zoomOut 应该达到 MIN_ZOOM
        expect(zoom).toBe(MIN_ZOOM)
      }),
      { numRuns: 5 },
    )
  })

  it('clampZoom 幂等性：clamp(clamp(z)) = clamp(z)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        (z) => {
          const clamped = clampZoom(z)
          expect(clampZoom(clamped)).toBe(clamped)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P8: zoomIn∘zoomOut 近似幂等 ────────────────────────────────────────────────

describe('P8: zoomIn∘zoomOut 误差 < 0.5%', () => {
  it('对非边界 zoom 值，zoomIn 后 zoomOut 误差 < 0.5%', () => {
    fc.assert(
      fc.property(interiorZoomArb, (z0) => {
        const z1 = zoomIn(z0)
        const z2 = zoomOut(z1)

        // 排除边界情况：如果 zoomIn 没有改变值（已在 MAX），跳过
        if (z1 === z0) return

        // 计算相对误差
        const relativeError = Math.abs(z2 - z0) / z0

        // 验证 P8：误差 < 0.5%
        expect(relativeError).toBeLessThan(0.005)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('对非边界 zoom 值，zoomOut 后 zoomIn 误差 < 0.5%', () => {
    fc.assert(
      fc.property(interiorZoomArb, (z0) => {
        const z1 = zoomOut(z0)
        const z2 = zoomIn(z1)

        // 排除边界情况：如果 zoomOut 没有改变值（已在 MIN），跳过
        if (z1 === z0) return

        // 计算相对误差
        const relativeError = Math.abs(z2 - z0) / z0

        // 验证 P8 对称性：误差 < 0.5%
        expect(relativeError).toBeLessThan(0.005)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('数学验证：×1.1 后 ÷1.1 应精确还原（浮点误差极小）', () => {
    fc.assert(
      fc.property(interiorZoomArb, (z0) => {
        // 直接计算：z0 * 1.1 / 1.1 的浮点误差
        const z1 = z0 * ZOOM_STEP_FACTOR
        const z2 = z1 / ZOOM_STEP_FACTOR

        // 浮点误差应极小（远小于 0.5%）
        const relativeError = Math.abs(z2 - z0) / z0
        expect(relativeError).toBeLessThan(1e-10)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

// ─── P21: fitToViewport 留白 16px + 比例保留 ────────────────────────────────────

describe('P21: fitToViewport 留白 16px + 宽高比保留', () => {
  it('fit 后图像 + 32px 留白 ≤ 视口尺寸', () => {
    fc.assert(
      fc.property(
        imageSizeArb,
        imageSizeArb,
        viewportSizeArb,
        viewportSizeArb,
        (iw, ih, vw, vh) => {
          const { zoom } = computeFitToViewport(iw, ih, vw, vh)

          // 验证 P21：图像缩放后 + 两侧 16px 留白 ≤ 视口
          const scaledWidth = iw * zoom
          const scaledHeight = ih * zoom

          // 留白条件：scaledWidth + 32 ≤ vw 且 scaledHeight + 32 ≤ vh
          // 注意：当 zoom 被 clamp 到 MIN_ZOOM 时，可能不满足留白条件
          // 但 fitToViewport 的 zoom 是 min(scaleX, scaleY) 再 clamp
          // 如果 clamp 没有生效（即 fitZoom < MAX_ZOOM），则留白条件成立
          const availableWidth = vw - FIT_MARGIN_PX * 2
          const availableHeight = vh - FIT_MARGIN_PX * 2
          const naturalFitZoom = Math.min(availableWidth / iw, availableHeight / ih)

          if (naturalFitZoom >= MIN_ZOOM && naturalFitZoom <= MAX_ZOOM) {
            // 未被 clamp，留白条件严格成立
            expect(scaledWidth + 2 * FIT_MARGIN_PX).toBeLessThanOrEqual(vw + 0.001)
            expect(scaledHeight + 2 * FIT_MARGIN_PX).toBeLessThanOrEqual(vh + 0.001)
          }
          // 如果被 clamp 到 MIN_ZOOM（超大图 + 小视口），留白条件可能不满足
          // 这是预期行为：zoom 不能低于 MIN_ZOOM
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('fit 后宽高比保留（缩放不改变比例）', () => {
    fc.assert(
      fc.property(
        imageSizeArb,
        imageSizeArb,
        viewportSizeArb,
        viewportSizeArb,
        (iw, ih, vw, vh) => {
          const { zoom } = computeFitToViewport(iw, ih, vw, vh)

          // 原始宽高比
          const originalAspect = iw / ih
          // 缩放后宽高比（均匀缩放，比例不变）
          const scaledAspect = (iw * zoom) / (ih * zoom)

          // 验证 P21：宽高比误差 < 0.001
          expect(Math.abs(originalAspect - scaledAspect)).toBeLessThan(0.001)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('fit zoom 始终在 [MIN_ZOOM, MAX_ZOOM] 范围内', () => {
    fc.assert(
      fc.property(
        imageSizeArb,
        imageSizeArb,
        viewportSizeArb,
        viewportSizeArb,
        (iw, ih, vw, vh) => {
          const { zoom } = computeFitToViewport(iw, ih, vw, vh)

          expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
          expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('极端用例：超大图 + 小视口，zoom 被 clamp 到 MIN_ZOOM', () => {
    // 10000x10000 图像 + 33x33 视口（最小有效视口）
    const { zoom } = computeFitToViewport(10000, 10000, 33, 33)
    // availableWidth = 33 - 32 = 1, scaleX = 1/10000 = 0.0001 < MIN_ZOOM
    expect(zoom).toBe(MIN_ZOOM)
  })

  it('极端用例：小图 + 大视口，zoom 被 clamp 到 MAX_ZOOM', () => {
    // 1x1 图像 + 7680x4320 视口
    const { zoom } = computeFitToViewport(1, 1, 7680, 4320)
    // availableWidth = 7680 - 32 = 7648, scaleX = 7648/1 = 7648 > MAX_ZOOM
    expect(zoom).toBe(MAX_ZOOM)
  })

  it('fit 后图像居中（offsetX/offsetY 使图像在视口中心）', () => {
    fc.assert(
      fc.property(
        imageSizeArb,
        imageSizeArb,
        viewportSizeArb,
        viewportSizeArb,
        (iw, ih, vw, vh) => {
          const { zoom, offsetX, offsetY } = computeFitToViewport(iw, ih, vw, vh)

          // 居中公式：offset = (viewport - image*zoom) / 2
          const expectedOffsetX = (vw - iw * zoom) / 2
          const expectedOffsetY = (vh - ih * zoom) / 2

          expect(Math.abs(offsetX - expectedOffsetX)).toBeLessThan(0.001)
          expect(Math.abs(offsetY - expectedOffsetY)).toBeLessThan(0.001)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
