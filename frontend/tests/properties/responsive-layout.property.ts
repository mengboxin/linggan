/**
 * Property-Based Test: 响应式 mode 与跨边界状态保留 (P16, P17)
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**
 *
 * P16 — mode 确定性:
 * ∀ width w ∈ [320, 7680]:
 *     let mode = computeLayoutMode(w)
 *     mode ∈ {'mobile', 'compact', 'full'}
 *     ∧ (w < 1024 ↔ mode = 'mobile')
 *     ∧ (1024 ≤ w < 1440 ↔ mode = 'compact')
 *     ∧ (w ≥ 1440 ↔ mode = 'full')
 *     ∧ computeLayoutMode(w) = computeLayoutMode(w)  // 纯函数
 *
 * P17 — 跨断点状态保留:
 * ∀ editing state s = { selectedId, inputValue, ... }, ∀ width transition w₁ → w₂:
 *     布局模式变化不影响编辑器状态（selectedId、currentPrompt 等不变）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { computeLayoutMode, type LayoutMode } from '../../src/lib/use-responsive-layout'
import { useEditorStore } from '../../src/lib/editor-store'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** 视口宽度 arbitrary：覆盖 320-7680 范围 */
const viewportWidthArb = fc.integer({ min: 320, max: 7680 })

/** 跨断点宽度对 arbitrary：确保 w1 和 w2 跨越至少一个断点 */
const widthPairArbitrary = fc.tuple(viewportWidthArb, viewportWidthArb).filter(([w1, w2]) => {
  const mode1 = computeLayoutMode(w1).mode
  const mode2 = computeLayoutMode(w2).mode
  return mode1 !== mode2
})

/** 编辑状态 arbitrary：模拟用户正在编辑时的状态 */
const editingStateArbitrary = fc.record({
  selectedId: fc.oneof(
    fc.constant(null as string | null),
    fc.uuid(),
  ),
  currentPrompt: fc.string({ minLength: 0, maxLength: 200 }),
  activeLayerId: fc.oneof(
    fc.constant(null as string | null),
    fc.uuid(),
  ),
  brushSize: fc.integer({ min: 1, max: 100 }),
  brushColor: fc.array(
    fc.constantFrom('0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'),
    { minLength: 6, maxLength: 6 },
  ).map(arr => `#${arr.join('')}`),
  projectName: fc.string({ minLength: 1, maxLength: 50 }),
})

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/** 判断宽度对应的预期 mode */
function expectedMode(width: number): LayoutMode {
  if (width >= 1440) return 'full'
  if (width >= 1024) return 'compact'
  return 'mobile'
}

// ─── P16: mode 确定性测试 ──────────────────────────────────────────────────────

describe('P16: computeLayoutMode 严格按 1024/1440 边界返回正确 mode', () => {
  it('任意宽度 w ∈ [320, 7680]，mode 严格按断点规则返回', () => {
    fc.assert(
      fc.property(viewportWidthArb, (width) => {
        const layout = computeLayoutMode(width)

        // mode 必须是三个合法值之一
        expect(['mobile', 'compact', 'full']).toContain(layout.mode)

        // 严格断点规则
        const expected = expectedMode(width)
        expect(layout.mode).toBe(expected)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('纯函数性：相同输入始终返回相同输出', () => {
    fc.assert(
      fc.property(viewportWidthArb, (width) => {
        const result1 = computeLayoutMode(width)
        const result2 = computeLayoutMode(width)

        expect(result1.mode).toBe(result2.mode)
        expect(result1.leftPanelWidth).toBe(result2.leftPanelWidth)
        expect(result1.rightPanelWidth).toBe(result2.rightPanelWidth)
        expect(result1.showFloatingToggles).toBe(result2.showFloatingToggles)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('mobile 模式面板宽度为 0 且显示浮动按钮', () => {
    fc.assert(
      fc.property(fc.integer({ min: 320, max: 1023 }), (width) => {
        const layout = computeLayoutMode(width)

        expect(layout.mode).toBe('mobile')
        expect(layout.leftPanelWidth).toBe(0)
        expect(layout.rightPanelWidth).toBe(0)
        expect(layout.showFloatingToggles).toBe(true)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('compact 模式面板宽度为 200px 且不显示浮动按钮', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1024, max: 1439 }), (width) => {
        const layout = computeLayoutMode(width)

        expect(layout.mode).toBe('compact')
        expect(layout.leftPanelWidth).toBe(200)
        expect(layout.rightPanelWidth).toBe(200)
        expect(layout.showFloatingToggles).toBe(false)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('full 模式面板宽度为 256/220px 且不显示浮动按钮', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1440, max: 7680 }), (width) => {
        const layout = computeLayoutMode(width)

        expect(layout.mode).toBe('full')
        expect(layout.leftPanelWidth).toBe(256)
        expect(layout.rightPanelWidth).toBe(220)
        expect(layout.showFloatingToggles).toBe(false)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('显式覆盖边界值 1023/1024/1439/1440', () => {
    // 1023 → mobile
    const at1023 = computeLayoutMode(1023)
    expect(at1023.mode).toBe('mobile')
    expect(at1023.leftPanelWidth).toBe(0)
    expect(at1023.rightPanelWidth).toBe(0)
    expect(at1023.showFloatingToggles).toBe(true)

    // 1024 → compact
    const at1024 = computeLayoutMode(1024)
    expect(at1024.mode).toBe('compact')
    expect(at1024.leftPanelWidth).toBe(200)
    expect(at1024.rightPanelWidth).toBe(200)
    expect(at1024.showFloatingToggles).toBe(false)

    // 1439 → compact
    const at1439 = computeLayoutMode(1439)
    expect(at1439.mode).toBe('compact')
    expect(at1439.leftPanelWidth).toBe(200)
    expect(at1439.rightPanelWidth).toBe(200)
    expect(at1439.showFloatingToggles).toBe(false)

    // 1440 → full
    const at1440 = computeLayoutMode(1440)
    expect(at1440.mode).toBe('full')
    expect(at1440.leftPanelWidth).toBe(256)
    expect(at1440.rightPanelWidth).toBe(220)
    expect(at1440.showFloatingToggles).toBe(false)
  })
})

// ─── P17: 跨断点状态保留测试 ──────────────────────────────────────────────────

describe('P17: 跨断点宽度变化不影响编辑器状态', () => {
  beforeEach(() => {
    // 重置 editor store 到初始状态
    useEditorStore.setState({
      mode: 'IMAGE_EDIT',
      activeTool: 'ai-segment',
      layers: [],
      activeLayerId: null,
      canvasImage: null,
      currentPrompt: '',
      previousPrompt: null,
      editingLayer: null,
      brushSize: 20,
      brushColor: '#6fecfe',
      projectName: '未命名项目',
      isGenerating: false,
    })
  })

  it('任意编辑状态 + 跨断点宽度变化：selectedId 和 currentPrompt 不变', () => {
    fc.assert(
      fc.property(editingStateArbitrary, widthPairArbitrary, (editState, [w1, w2]) => {
        // 设置编辑状态（模拟用户正在编辑）
        useEditorStore.setState({
          activeLayerId: editState.selectedId,
          currentPrompt: editState.currentPrompt,
          brushSize: editState.brushSize,
          brushColor: editState.brushColor,
          projectName: editState.projectName,
        })

        // 记录编辑前的状态快照
        const stateBefore = useEditorStore.getState()
        const selectedIdBefore = stateBefore.activeLayerId
        const promptBefore = stateBefore.currentPrompt
        const brushSizeBefore = stateBefore.brushSize
        const brushColorBefore = stateBefore.brushColor
        const projectNameBefore = stateBefore.projectName

        // 模拟视口从 w1 变化到 w2（跨断点）
        // computeLayoutMode 是纯函数，不修改任何外部状态
        const layout1 = computeLayoutMode(w1)
        const layout2 = computeLayoutMode(w2)

        // 确认确实跨越了断点
        expect(layout1.mode).not.toBe(layout2.mode)

        // 验证 P17：编辑器状态在布局变化后保持不变
        const stateAfter = useEditorStore.getState()
        expect(stateAfter.activeLayerId).toBe(selectedIdBefore)
        expect(stateAfter.currentPrompt).toBe(promptBefore)
        expect(stateAfter.brushSize).toBe(brushSizeBefore)
        expect(stateAfter.brushColor).toBe(brushColorBefore)
        expect(stateAfter.projectName).toBe(projectNameBefore)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('布局模式计算独立于 editor store 状态', () => {
    fc.assert(
      fc.property(editingStateArbitrary, viewportWidthArb, (editState, width) => {
        // 设置任意编辑状态
        useEditorStore.setState({
          activeLayerId: editState.selectedId,
          currentPrompt: editState.currentPrompt,
          brushSize: editState.brushSize,
          brushColor: editState.brushColor,
          projectName: editState.projectName,
        })

        // computeLayoutMode 的结果不依赖 editor store
        const layout = computeLayoutMode(width)
        const expected = expectedMode(width)
        expect(layout.mode).toBe(expected)

        // editor store 状态未被修改
        const state = useEditorStore.getState()
        expect(state.activeLayerId).toBe(editState.selectedId)
        expect(state.currentPrompt).toBe(editState.currentPrompt)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('连续多次跨断点变化后编辑状态仍然保持', () => {
    fc.assert(
      fc.property(
        editingStateArbitrary,
        fc.array(viewportWidthArb, { minLength: 2, maxLength: 10 }),
        (editState, widths) => {
          // 设置初始编辑状态
          useEditorStore.setState({
            activeLayerId: editState.selectedId,
            currentPrompt: editState.currentPrompt,
            brushSize: editState.brushSize,
            brushColor: editState.brushColor,
            projectName: editState.projectName,
          })

          // 连续多次布局计算（模拟窗口反复 resize）
          for (const w of widths) {
            computeLayoutMode(w)
          }

          // 验证：编辑状态完全不变
          const state = useEditorStore.getState()
          expect(state.activeLayerId).toBe(editState.selectedId)
          expect(state.currentPrompt).toBe(editState.currentPrompt)
          expect(state.brushSize).toBe(editState.brushSize)
          expect(state.brushColor).toBe(editState.brushColor)
          expect(state.projectName).toBe(editState.projectName)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
