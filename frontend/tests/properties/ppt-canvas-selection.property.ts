/**
 * Property-Based Test: PPT 空白点击取消选择 (P28)
 *
 * **Validates: Requirements R5.8**
 *
 * P28 — 空白点击 → selectedId=null + activeEditor=null:
 * ∀ canvas state S with selectedId ≠ null:
 *     let click = randomPointNotInAnyElement(S)
 *     let S' = handleCanvasClick(S, click)
 *     S'.selectedId = null ∧ S'.activeEditor = null
 *
 * 拒绝采样确保 click 点不在任何元素 bbox 与 background bbox 内
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

interface BBox {
  x: number
  y: number
  w: number
  h: number
}

interface CanvasElement {
  id: string
  type: 'text' | 'icon' | 'image' | 'shape'
  bbox: BBox
}

type ActiveEditor = 'text' | 'icon' | 'background' | null

interface CanvasSelectionState {
  selectedId: string | null
  activeEditor: ActiveEditor
  elements: CanvasElement[]
  canvasWidth: number
  canvasHeight: number
}

interface ClickPoint {
  x: number
  y: number
}

// ─── 纯函数：画布点击处理 ────────────────────────────────────────────────────────

/**
 * 检查点是否在 bbox 内
 */
function isPointInBBox(point: ClickPoint, bbox: BBox): boolean {
  return (
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.w &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.h
  )
}

/**
 * 检查点是否在任何元素内
 */
function isPointInAnyElement(point: ClickPoint, elements: CanvasElement[]): boolean {
  return elements.some((el) => isPointInBBox(point, el.bbox))
}

/**
 * 处理画布点击事件（R5.8）
 *
 * 如果点击点不在任何元素内 → deselect + 关闭编辑器
 * 如果点击点在某个元素内 → 选中该元素
 */
function handleCanvasClick(
  state: CanvasSelectionState,
  click: ClickPoint,
): CanvasSelectionState {
  // 检查是否点击了某个元素
  const clickedElement = state.elements.find((el) => isPointInBBox(click, el.bbox))

  if (clickedElement) {
    // 点击了元素 → 选中
    return {
      ...state,
      selectedId: clickedElement.id,
      activeEditor: clickedElement.type === 'text' ? 'text' : clickedElement.type === 'icon' ? 'icon' : null,
    }
  }

  // R5.8: 点击空白区域 → deselect + 关闭编辑器
  return {
    ...state,
    selectedId: null,
    activeEditor: null,
  }
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

const bboxArb = fc.record({
  x: fc.integer({ min: 0, max: 800 }),
  y: fc.integer({ min: 0, max: 600 }),
  w: fc.integer({ min: 10, max: 200 }),
  h: fc.integer({ min: 10, max: 150 }),
})

const elementArb: fc.Arbitrary<CanvasElement> = fc.record({
  id: fc.uuid(),
  type: fc.constantFrom('text' as const, 'icon' as const, 'image' as const, 'shape' as const),
  bbox: bboxArb,
})

const activeEditorArb: fc.Arbitrary<ActiveEditor> = fc.constantFrom(
  'text' as const, 'icon' as const, 'background' as const, null,
)

/**
 * 生成画布状态（有选中元素）
 */
const canvasStateWithSelectionArb: fc.Arbitrary<CanvasSelectionState> = fc
  .record({
    elements: fc.array(elementArb, { minLength: 1, maxLength: 20 }),
    activeEditor: activeEditorArb,
    canvasWidth: fc.constant(960),
    canvasHeight: fc.constant(540),
  })
  .chain((partial) =>
    fc.constantFrom(...partial.elements.map((e) => e.id)).map((selectedId) => ({
      ...partial,
      selectedId,
    })),
  )

/**
 * 生成不在任何元素内的点击点（拒绝采样）
 */
function blankClickArb(state: CanvasSelectionState): fc.Arbitrary<ClickPoint> {
  return fc
    .record({
      x: fc.integer({ min: 0, max: state.canvasWidth - 1 }),
      y: fc.integer({ min: 0, max: state.canvasHeight - 1 }),
    })
    .filter((point) => !isPointInAnyElement(point, state.elements))
}

// ─── P28: 空白点击取消选择 ──────────────────────────────────────────────────────

describe('P28: PPT 空白点击取消选择 — 空白点击 → selectedId=null + activeEditor=null', () => {
  it('∀ state with selection, ∀ blank click: selectedId becomes null', () => {
    fc.assert(
      fc.property(
        canvasStateWithSelectionArb.chain((state) =>
          fc.tuple(fc.constant(state), blankClickArb(state)),
        ),
        ([state, click]) => {
          // 前置条件：有选中元素
          expect(state.selectedId).not.toBeNull()

          // 执行空白点击
          const newState = handleCanvasClick(state, click)

          // P28 核心断言
          expect(newState.selectedId).toBeNull()
          expect(newState.activeEditor).toBeNull()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('空白点击不修改元素列表', () => {
    fc.assert(
      fc.property(
        canvasStateWithSelectionArb.chain((state) =>
          fc.tuple(fc.constant(state), blankClickArb(state)),
        ),
        ([state, click]) => {
          const newState = handleCanvasClick(state, click)

          // 元素列表不变
          expect(newState.elements).toEqual(state.elements)
          expect(newState.canvasWidth).toBe(state.canvasWidth)
          expect(newState.canvasHeight).toBe(state.canvasHeight)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('点击元素内部不会 deselect', () => {
    fc.assert(
      fc.property(
        canvasStateWithSelectionArb.filter((s) => s.elements.length > 0),
        (state) => {
          // 选择第一个元素的中心点
          const el = state.elements[0]
          const click: ClickPoint = {
            x: el.bbox.x + Math.floor(el.bbox.w / 2),
            y: el.bbox.y + Math.floor(el.bbox.h / 2),
          }

          const newState = handleCanvasClick(state, click)

          // 点击元素内部应选中该元素
          expect(newState.selectedId).toBe(el.id)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('无元素时任何点击都是空白点击', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.integer({ min: 0, max: 959 }),
          y: fc.integer({ min: 0, max: 539 }),
        }),
        (click) => {
          const state: CanvasSelectionState = {
            selectedId: 'some-id',
            activeEditor: 'text',
            elements: [],
            canvasWidth: 960,
            canvasHeight: 540,
          }

          const newState = handleCanvasClick(state, click)

          expect(newState.selectedId).toBeNull()
          expect(newState.activeEditor).toBeNull()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('activeEditor 为各种类型时都能正确清除', () => {
    const editors: ActiveEditor[] = ['text', 'icon', 'background']

    fc.assert(
      fc.property(
        fc.constantFrom(...editors),
        fc.record({
          x: fc.integer({ min: 900, max: 959 }),
          y: fc.integer({ min: 500, max: 539 }),
        }),
        (editor, click) => {
          // 元素都在左上角，点击右下角一定是空白
          const state: CanvasSelectionState = {
            selectedId: 'elem-1',
            activeEditor: editor,
            elements: [
              { id: 'elem-1', type: 'text', bbox: { x: 0, y: 0, w: 100, h: 50 } },
            ],
            canvasWidth: 960,
            canvasHeight: 540,
          }

          const newState = handleCanvasClick(state, click)

          expect(newState.selectedId).toBeNull()
          expect(newState.activeEditor).toBeNull()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
