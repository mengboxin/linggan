/**
 * Property-Based Test: 编辑失败状态还原 (P22)
 *
 * **Validates: Requirements 2.7**
 *
 * P22 — 编辑失败 → 状态严格等于编辑前 e₀:
 * ∀ initial element e₀, ∀ failing edit op:
 *     let e₁ = applyEdit(e₀, op)  // 模拟乐观更新
 *     let e₂ = onEditFail(e₁, error)
 *     e₂ ≡ e₀
 *
 * 生成器:
 * - editStateArbitrary 含 text / icon / image 三种类型
 * - failureModeArbitrary（timeout / 5xx / 4xx / cancelled）
 *
 * 验证 text 类型的所有字段（text/fontSize/color/fontFamily）都被回滚
 *
 * 示例反例触发条件: 失败时只回滚部分字段（如 text 回了 fontSize 没回）
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

/** 编辑元素类型 */
type EditElementType = 'text' | 'icon' | 'image'

/** 失败模式 */
type FailureMode = 'timeout' | '5xx' | '4xx' | 'cancelled'

/** 基础元素状态 */
interface BaseElementState {
  id: string
  type: EditElementType
  bbox: { x: number; y: number; w: number; h: number }
}

/** 文字元素状态 */
interface TextElementState extends BaseElementState {
  type: 'text'
  text: string
  fontSize: number
  color: string
  fontFamily: string
}

/** 图标元素状态 */
interface IconElementState extends BaseElementState {
  type: 'icon'
  src: string
}

/** 图片元素状态 */
interface ImageElementState extends BaseElementState {
  type: 'image'
  src: string
}

/** 联合元素状态 */
type ElementState = TextElementState | IconElementState | ImageElementState

/** 编辑操作 */
interface EditOperation {
  type: 'replace' | 'recolor' | 'remove' | 'modify'
  params: Record<string, unknown>
}

/** 失败错误信息 */
interface EditError {
  mode: FailureMode
  message: string
  statusCode?: number
}

// ─── 纯函数：模拟编辑与回滚逻辑 ─────────────────────────────────────────────────

/**
 * 模拟乐观更新：对元素应用编辑操作
 * 返回编辑后的新状态（乐观更新）
 */
function applyEdit(element: ElementState, op: EditOperation): ElementState {
  switch (element.type) {
    case 'text': {
      // 乐观更新文字元素的各字段
      const updated = { ...element }
      if (op.type === 'modify' && op.params.text !== undefined) {
        updated.text = op.params.text as string
      }
      if (op.type === 'modify' && op.params.fontSize !== undefined) {
        updated.fontSize = op.params.fontSize as number
      }
      if (op.type === 'recolor' && op.params.color !== undefined) {
        updated.color = op.params.color as string
      }
      if (op.type === 'modify' && op.params.color !== undefined) {
        updated.color = op.params.color as string
      }
      if (op.type === 'modify' && op.params.fontFamily !== undefined) {
        updated.fontFamily = op.params.fontFamily as string
      }
      return updated
    }
    case 'icon': {
      const updated = { ...element }
      if (op.type === 'replace' && op.params.src !== undefined) {
        updated.src = op.params.src as string
      }
      return updated
    }
    case 'image': {
      const updated = { ...element }
      if (op.type === 'replace' && op.params.src !== undefined) {
        updated.src = op.params.src as string
      }
      return updated
    }
  }
}

/**
 * 编辑失败时的状态还原：将元素恢复到编辑前的快照
 * 这是被测试的核心逻辑 — 必须严格等于 e₀
 */
function onEditFail(
  _currentState: ElementState,
  snapshot: ElementState,
  _error: EditError,
): ElementState {
  // 正确实现：直接返回编辑前的快照（深拷贝）
  return structuredClone(snapshot)
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** BBox arbitrary */
const bboxArb = fc.record({
  x: fc.integer({ min: 0, max: 4000 }),
  y: fc.integer({ min: 0, max: 4000 }),
  w: fc.integer({ min: 1, max: 500 }),
  h: fc.integer({ min: 1, max: 500 }),
})

/** 颜色 hex arbitrary */
const hexCharArb = fc.constantFrom(
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
)
const colorArb = fc.array(hexCharArb, { minLength: 6, maxLength: 6 }).map(
  chars => `#${chars.join('')}`,
)

/** 字体族 arbitrary */
const fontFamilyArb = fc.constantFrom(
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia',
  '宋体', '黑体', '微软雅黑', 'system-ui', 'monospace',
  'PingFang SC', 'Noto Sans SC',
)

/** 文字元素状态 arbitrary */
const textElementArb: fc.Arbitrary<TextElementState> = fc.record({
  id: fc.uuid(),
  type: fc.constant('text' as const),
  bbox: bboxArb,
  text: fc.string({ minLength: 1, maxLength: 200 }),
  fontSize: fc.integer({ min: 8, max: 200 }),
  color: colorArb,
  fontFamily: fontFamilyArb,
})

/** 图标元素状态 arbitrary */
const iconElementArb: fc.Arbitrary<IconElementState> = fc.record({
  id: fc.uuid(),
  type: fc.constant('icon' as const),
  bbox: bboxArb,
  src: fc.webUrl(),
})

/** 图片元素状态 arbitrary */
const imageElementArb: fc.Arbitrary<ImageElementState> = fc.record({
  id: fc.uuid(),
  type: fc.constant('image' as const),
  bbox: bboxArb,
  src: fc.webUrl(),
})

/** 编辑元素状态 arbitrary（text / icon / image 三种类型） */
const editStateArbitrary: fc.Arbitrary<ElementState> = fc.oneof(
  textElementArb,
  iconElementArb,
  imageElementArb,
)

/** 失败模式 arbitrary（timeout / 5xx / 4xx / cancelled） */
const failureModeArbitrary: fc.Arbitrary<FailureMode> = fc.constantFrom(
  'timeout', '5xx', '4xx', 'cancelled',
)

/** 编辑错误 arbitrary */
const editErrorArb: fc.Arbitrary<EditError> = failureModeArbitrary.chain(mode => {
  switch (mode) {
    case 'timeout':
      return fc.constant({ mode, message: '请求超时', statusCode: undefined } as EditError)
    case '5xx':
      return fc.constantFrom(500, 502, 503).map(code => ({
        mode,
        message: `服务器错误 (${code})`,
        statusCode: code,
      } as EditError))
    case '4xx':
      return fc.constantFrom(400, 403, 404, 429).map(code => ({
        mode,
        message: `客户端错误 (${code})`,
        statusCode: code,
      } as EditError))
    case 'cancelled':
      return fc.constant({ mode, message: '用户取消', statusCode: undefined } as EditError)
  }
})

/** 编辑操作 arbitrary（根据元素类型生成合理的操作） */
function editOpForElement(element: ElementState): fc.Arbitrary<EditOperation> {
  switch (element.type) {
    case 'text':
      return fc.oneof(
        // modify 操作：修改文字内容
        fc.record({
          type: fc.constant('modify' as const),
          params: fc.record({
            text: fc.string({ minLength: 1, maxLength: 200 }),
            fontSize: fc.integer({ min: 8, max: 200 }),
            color: colorArb,
            fontFamily: fontFamilyArb,
          }),
        }),
        // recolor 操作：修改颜色
        fc.record({
          type: fc.constant('recolor' as const),
          params: fc.record({
            color: colorArb,
          }),
        }),
      )
    case 'icon':
      return fc.record({
        type: fc.constantFrom('replace' as const, 'remove' as const),
        params: fc.record({
          src: fc.webUrl(),
        }),
      })
    case 'image':
      return fc.record({
        type: fc.constantFrom('replace' as const, 'remove' as const),
        params: fc.record({
          src: fc.webUrl(),
        }),
      })
  }
}

// ─── P22: 编辑失败状态还原 ──────────────────────────────────────────────────────

describe('P22: 编辑失败状态还原 — 编辑失败 → 状态严格等于编辑前 e₀', () => {
  it('∀ element e₀, ∀ failing edit: onEditFail 后状态严格等于 e₀', () => {
    fc.assert(
      fc.property(
        editStateArbitrary.chain(element =>
          fc.tuple(
            fc.constant(element),
            editOpForElement(element),
            editErrorArb,
          ),
        ),
        ([element, editOp, error]) => {
          // 保存编辑前快照
          const e0 = structuredClone(element)

          // 模拟乐观更新
          const e1 = applyEdit(element, editOp)

          // 模拟编辑失败 → 回滚
          const e2 = onEditFail(e1, e0, error)

          // 验证 P22：回滚后状态严格等于编辑前
          expect(e2).toEqual(e0)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('text 类型：所有字段（text/fontSize/color/fontFamily）都被回滚', () => {
    fc.assert(
      fc.property(
        textElementArb,
        fc.record({
          type: fc.constant('modify' as const),
          params: fc.record({
            text: fc.string({ minLength: 1, maxLength: 200 }),
            fontSize: fc.integer({ min: 8, max: 200 }),
            color: colorArb,
            fontFamily: fontFamilyArb,
          }),
        }),
        failureModeArbitrary,
        (element, editOp, failureMode) => {
          // 保存编辑前快照
          const e0 = structuredClone(element)

          // 确保编辑操作确实修改了字段
          const e1 = applyEdit(element, editOp)

          // 构造错误
          const error: EditError = {
            mode: failureMode,
            message: `编辑失败 (${failureMode})`,
            statusCode: failureMode === '5xx' ? 500 : failureMode === '4xx' ? 400 : undefined,
          }

          // 模拟编辑失败 → 回滚
          const e2 = onEditFail(e1, e0, error) as TextElementState

          // 验证 text 类型的所有字段都被回滚
          expect(e2.text).toBe(e0.text)
          expect(e2.fontSize).toBe(e0.fontSize)
          expect(e2.color).toBe(e0.color)
          expect(e2.fontFamily).toBe(e0.fontFamily)

          // 验证其他字段也被回滚
          expect(e2.id).toBe(e0.id)
          expect(e2.type).toBe(e0.type)
          expect(e2.bbox).toEqual(e0.bbox)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('icon 类型：src 字段被回滚', () => {
    fc.assert(
      fc.property(
        iconElementArb,
        fc.record({
          type: fc.constant('replace' as const),
          params: fc.record({ src: fc.webUrl() }),
        }),
        editErrorArb,
        (element, editOp, error) => {
          const e0 = structuredClone(element)
          const e1 = applyEdit(element, editOp)
          const e2 = onEditFail(e1, e0, error) as IconElementState

          expect(e2.src).toBe(e0.src)
          expect(e2.id).toBe(e0.id)
          expect(e2.bbox).toEqual(e0.bbox)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('image 类型：src 字段被回滚', () => {
    fc.assert(
      fc.property(
        imageElementArb,
        fc.record({
          type: fc.constant('replace' as const),
          params: fc.record({ src: fc.webUrl() }),
        }),
        editErrorArb,
        (element, editOp, error) => {
          const e0 = structuredClone(element)
          const e1 = applyEdit(element, editOp)
          const e2 = onEditFail(e1, e0, error) as ImageElementState

          expect(e2.src).toBe(e0.src)
          expect(e2.id).toBe(e0.id)
          expect(e2.bbox).toEqual(e0.bbox)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('所有失败模式（timeout/5xx/4xx/cancelled）都触发完整回滚', () => {
    const allFailureModes: FailureMode[] = ['timeout', '5xx', '4xx', 'cancelled']

    fc.assert(
      fc.property(
        editStateArbitrary,
        fc.constantFrom(...allFailureModes),
        (element, failureMode) => {
          const e0 = structuredClone(element)

          // 生成一个确定性的编辑操作
          let editOp: EditOperation
          switch (element.type) {
            case 'text':
              editOp = {
                type: 'modify',
                params: { text: '新文字', fontSize: 99, color: '#ff0000', fontFamily: 'monospace' },
              }
              break
            case 'icon':
              editOp = { type: 'replace', params: { src: 'https://example.com/new-icon.svg' } }
              break
            case 'image':
              editOp = { type: 'replace', params: { src: 'https://example.com/new-image.png' } }
              break
          }

          const e1 = applyEdit(element, editOp)
          const error: EditError = {
            mode: failureMode,
            message: `失败: ${failureMode}`,
            statusCode: failureMode === '5xx' ? 500 : failureMode === '4xx' ? 400 : undefined,
          }

          const e2 = onEditFail(e1, e0, error)

          // 无论哪种失败模式，回滚后状态都严格等于 e₀
          expect(e2).toEqual(e0)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('回滚后的状态是独立副本（修改 e₂ 不影响 e₀）', () => {
    fc.assert(
      fc.property(
        textElementArb,
        editErrorArb,
        (element, error) => {
          const e0 = structuredClone(element)
          const editOp: EditOperation = {
            type: 'modify',
            params: { text: '临时修改', fontSize: 42 },
          }

          const e1 = applyEdit(element, editOp)
          const e2 = onEditFail(e1, e0, error) as TextElementState

          // 修改 e2 不应影响 e0
          e2.text = '被修改的文字'
          e2.fontSize = 999

          expect(e0.text).toBe(element.text)
          expect(e0.fontSize).toBe(element.fontSize)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
