/**
 * Property-Based Test: PPT 进度 reducer (P20)
 *
 * **Validates: Requirements R6.1**
 *
 * P20 — 进度序列单调非减 + 终值 ≤ 100:
 * ∀ event sequence es:
 *     let states = reduce(es)
 *     ∀ i: states[i].progress ≤ states[i+1].progress
 *     ∧ ∀ s ∈ states: s.progress ≤ 100
 *
 * reducer 丢弃乱序事件（progress 小于当前值的事件被忽略）
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

type PPTStep = 'optimize_theme' | 'generate_outline' | 'generate_slides' | 'build_pptx' | 'done'

interface PPTProgressEvent {
  step: PPTStep
  progress: number
  status: 'running' | 'done' | 'error'
}

interface PPTProgressState {
  step: PPTStep
  progress: number
  status: 'running' | 'done' | 'error'
}

// ─── 纯函数：PPT 进度 reducer ────────────────────────────────────────────────────

/**
 * PPT 进度 reducer — 丢弃乱序事件
 *
 * 规则：
 * 1. 新事件的 progress 必须 >= 当前 progress（否则丢弃）
 * 2. progress 上限为 100
 * 3. status='done' 时 progress 固定为 100
 */
function pptProgressReducer(state: PPTProgressState, event: PPTProgressEvent): PPTProgressState {
  // 丢弃乱序事件（progress 小于当前值）
  if (event.progress < state.progress) {
    return state
  }

  // 上限 100
  const clampedProgress = Math.min(100, event.progress)

  // done 状态固定 100
  if (event.status === 'done') {
    return { step: event.step, progress: 100, status: 'done' }
  }

  return {
    step: event.step,
    progress: clampedProgress,
    status: event.status,
  }
}

/**
 * 对事件序列应用 reducer，返回所有中间状态
 */
function reduceEvents(events: PPTProgressEvent[]): PPTProgressState[] {
  const initial: PPTProgressState = { step: 'optimize_theme', progress: 0, status: 'running' }
  const states: PPTProgressState[] = [initial]

  let current = initial
  for (const event of events) {
    current = pptProgressReducer(current, event)
    states.push(current)
  }

  return states
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

const stepArb: fc.Arbitrary<PPTStep> = fc.constantFrom(
  'optimize_theme', 'generate_outline', 'generate_slides', 'build_pptx', 'done',
)

const statusArb = fc.constantFrom('running' as const, 'done' as const, 'error' as const)

/** 生成合法的进度事件（progress 0-120，允许超出以测试 clamp） */
const progressEventArb: fc.Arbitrary<PPTProgressEvent> = fc.record({
  step: stepArb,
  progress: fc.integer({ min: 0, max: 120 }),
  status: statusArb,
})

/** 生成乱序事件序列（包含正常和乱序事件） */
const eventSequenceArb = fc.array(progressEventArb, { minLength: 1, maxLength: 50 })

// ─── P20: 进度序列单调非减 + 终值 ≤ 100 ─────────────────────────────────────────

describe('P20: PPT 进度 reducer — 进度序列单调非减 + 终值 ≤ 100', () => {
  it('∀ event sequence: reducer 输出的 progress 序列单调非减', () => {
    fc.assert(
      fc.property(eventSequenceArb, (events) => {
        const states = reduceEvents(events)

        for (let i = 0; i < states.length - 1; i++) {
          expect(states[i + 1].progress).toBeGreaterThanOrEqual(states[i].progress)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('∀ event sequence: 所有状态的 progress ≤ 100', () => {
    fc.assert(
      fc.property(eventSequenceArb, (events) => {
        const states = reduceEvents(events)

        for (const state of states) {
          expect(state.progress).toBeLessThanOrEqual(100)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('∀ event sequence: progress ≥ 0', () => {
    fc.assert(
      fc.property(eventSequenceArb, (events) => {
        const states = reduceEvents(events)

        for (const state of states) {
          expect(state.progress).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('乱序事件被丢弃：progress 小于当前值的事件不改变状态', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 100 }),
        fc.integer({ min: 0, max: 49 }),
        (currentProgress, lowerProgress) => {
          const state: PPTProgressState = {
            step: 'generate_slides',
            progress: currentProgress,
            status: 'running',
          }
          const event: PPTProgressEvent = {
            step: 'optimize_theme',
            progress: lowerProgress,
            status: 'running',
          }

          const newState = pptProgressReducer(state, event)

          // 乱序事件应被丢弃，状态不变
          expect(newState).toEqual(state)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })

  it('status=done 时 progress 固定为 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        stepArb,
        (currentProgress, eventProgress, step) => {
          const state: PPTProgressState = {
            step: 'generate_slides',
            progress: currentProgress,
            status: 'running',
          }
          const event: PPTProgressEvent = {
            step,
            progress: Math.max(currentProgress, eventProgress), // 确保不乱序
            status: 'done',
          }

          const newState = pptProgressReducer(state, event)

          expect(newState.progress).toBe(100)
          expect(newState.status).toBe('done')
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
