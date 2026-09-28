/**
 * Property-Based Test: Feature flag 默认安全 (P18)
 *
 * **Validates: Requirements 14.2**
 *
 * 形式化定义:
 * ∀ flag fetch result r ∈ {success, network_error, parse_error, 5xx, 4xx}:
 *     r ≠ success → flagState.touch_edit = false
 *                 ∧ flagState.agent = false
 *                 ∧ flagState.ppt_canvas = false
 *                 ∧ uiVariant = 'legacy'
 *
 * 同时验证成功路径任意 boolean 组合下 UI 切换正确。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { useFeatureFlagStore, DEFAULT_FLAGS } from '../../src/stores/feature-flag-store'
import { fetchFeatureFlags } from '../../src/lib/feature-flags'
import { auth } from '../../src/lib/auth'

// ─── 配置 ──────────────────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 200

function authenticateTestUser() {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, type: 'access' })}.signature`
  auth.save(accessToken, 'feature-flags-refresh', {
    id: 'feature-flags-user',
    email: 'feature-flags@example.com',
    displayName: 'Feature Flags',
    role: 'user',
  })
}

// ─── 辅助类型 ──────────────────────────────────────────────────────────────────

type ErrorScenario = 'network_error' | 'parse_error' | 'server_500' | 'server_404' | 'server_401'

// ─── 辅助函数：根据 flag 状态推导 uiVariant ─────────────────────────────────────

function deriveUiVariant(flags: { touchEdit: boolean; agentOrchestrator: boolean; pptCanvas: boolean }): string {
  // 当所有 flag 为 false 时，UI 应为 legacy 模式
  if (!flags.touchEdit && !flags.agentOrchestrator && !flags.pptCanvas) {
    return 'legacy'
  }
  return 'upgraded'
}

// ─── Mock fetch 工厂 ────────────────────────────────────────────────────────────

/**
 * 创建模拟 fetch 失败场景的 mock 函数。
 * fetchFeatureFlags → auth.fetchWithAuth → globalThis.fetch
 */
function createErrorFetchMock(scenario: ErrorScenario): typeof globalThis.fetch {
  return async (): Promise<Response> => {
    switch (scenario) {
      case 'network_error':
        throw new TypeError('Failed to fetch')
      case 'parse_error':
        // 返回 200 但 JSON 结构不符合预期
        return new Response(JSON.stringify({ invalid: 'structure' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      case 'server_500':
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      case 'server_404':
        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      case 'server_401':
        // 注意：auth.fetchWithAuth 收到 401 会尝试 refresh token
        // refresh 也会失败（因为 fetch 被 mock），最终返回 401 Response
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
    }
  }
}

function createSuccessFetchMock(flags: { touch_edit: boolean; agent_orchestrator: boolean; ppt_canvas: boolean }): typeof globalThis.fetch {
  return async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        touch_edit: flags.touch_edit,
        agent_orchestrator: flags.agent_orchestrator,
        ppt_canvas: flags.ppt_canvas,
        user_id: 'test-user-123',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

const errorScenarioArb: fc.Arbitrary<ErrorScenario> = fc.oneof(
  fc.constant<ErrorScenario>('network_error'),
  fc.constant<ErrorScenario>('parse_error'),
  fc.constant<ErrorScenario>('server_500'),
  fc.constant<ErrorScenario>('server_404'),
  fc.constant<ErrorScenario>('server_401'),
)

const successFlagsArb = fc.record({
  touch_edit: fc.boolean(),
  agent_orchestrator: fc.boolean(),
  ppt_canvas: fc.boolean(),
})

// ─── 测试 ──────────────────────────────────────────────────────────────────────

describe('P18: Feature flag 默认安全', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // 重置 store 到初始状态
    useFeatureFlagStore.getState().resetToDefaults()
    // 抑制 jsdom 中 redirectToLogin 触发的 "Not implemented: navigation" 警告
    Object.defineProperty(window, 'location', {
      value: { ...window.location, replace: vi.fn(), href: '' },
      writable: true,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('失败场景：任意错误类型下 fetchFeatureFlags 返回 null 或 unauthorized，flag 全为 false 且 uiVariant=legacy', async () => {
    await fc.assert(
      fc.asyncProperty(errorScenarioArb, async (scenario) => {
        authenticateTestUser()
        // 重置 store
        useFeatureFlagStore.getState().resetToDefaults()

        // Mock globalThis.fetch
        globalThis.fetch = createErrorFetchMock(scenario)

        // 调用 fetchFeatureFlags
        const result = await fetchFeatureFlags()

        // 验证：非成功结果应为 null 或 'unauthorized'
        expect(result === null || result === 'unauthorized').toBe(true)

        // 模拟 useFeatureFlags hook 中的逻辑：首次失败时设置默认值
        const store = useFeatureFlagStore.getState()
        if (!store.loaded) {
          useFeatureFlagStore.getState().setFlags(DEFAULT_FLAGS)
        }

        // 验证 P18：所有 flag 为 false
        const state = useFeatureFlagStore.getState()
        expect(state.touchEdit).toBe(false)
        expect(state.agentOrchestrator).toBe(false)
        expect(state.pptCanvas).toBe(false)

        // 验证 uiVariant = 'legacy'
        const variant = deriveUiVariant(state)
        expect(variant).toBe('legacy')
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('成功场景：任意 boolean 组合下 flag 正确反映服务端响应', async () => {
    await fc.assert(
      fc.asyncProperty(successFlagsArb, async (flags) => {
        authenticateTestUser()
        // 重置 store
        useFeatureFlagStore.getState().resetToDefaults()

        // Mock globalThis.fetch 返回成功响应
        globalThis.fetch = createSuccessFetchMock(flags)

        // 调用 fetchFeatureFlags
        const result = await fetchFeatureFlags()

        // 验证：成功结果应为有效对象
        expect(result).not.toBeNull()
        expect(result).not.toBe('unauthorized')

        // 模拟 hook 中的逻辑：成功时设置 flag
        if (result !== null && result !== 'unauthorized') {
          useFeatureFlagStore.getState().setFlags({
            touchEdit: Boolean(result.touch_edit),
            agentOrchestrator: Boolean(result.agent_orchestrator),
            pptCanvas: Boolean(result.ppt_canvas),
          })
        }

        // 验证：store 中的 flag 与服务端响应一致
        const state = useFeatureFlagStore.getState()
        expect(state.touchEdit).toBe(flags.touch_edit)
        expect(state.agentOrchestrator).toBe(flags.agent_orchestrator)
        expect(state.pptCanvas).toBe(flags.ppt_canvas)

        // 验证 UI variant 正确切换
        const variant = deriveUiVariant(state)
        if (flags.touch_edit || flags.agent_orchestrator || flags.ppt_canvas) {
          expect(variant).toBe('upgraded')
        } else {
          expect(variant).toBe('legacy')
        }
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('成功后再失败：已加载的 flag 保持不变（保守策略）', async () => {
    await fc.assert(
      fc.asyncProperty(
        successFlagsArb,
        errorScenarioArb,
        async (initialFlags, errorScenario) => {
          authenticateTestUser()
          // 重置 store
          useFeatureFlagStore.getState().resetToDefaults()

          // 第一步：成功加载 flag
          globalThis.fetch = createSuccessFetchMock(initialFlags)
          const successResult = await fetchFeatureFlags()
          if (successResult !== null && successResult !== 'unauthorized') {
            useFeatureFlagStore.getState().setFlags({
              touchEdit: Boolean(successResult.touch_edit),
              agentOrchestrator: Boolean(successResult.agent_orchestrator),
              pptCanvas: Boolean(successResult.ppt_canvas),
            })
          }

          // 确认已加载
          expect(useFeatureFlagStore.getState().loaded).toBe(true)

          // 第二步：后续轮询失败
          globalThis.fetch = createErrorFetchMock(errorScenario)
          const failResult = await fetchFeatureFlags()

          // 模拟 hook 逻辑：已加载时失败不重置 flag（R14.2 保守策略）
          if (failResult === null || failResult === 'unauthorized') {
            const store = useFeatureFlagStore.getState()
            if (!store.loaded) {
              useFeatureFlagStore.getState().setFlags(DEFAULT_FLAGS)
            }
            useFeatureFlagStore.getState().setError('获取 feature flags 失败')
          }

          // 验证：flag 保持之前成功加载的值不变
          const state = useFeatureFlagStore.getState()
          expect(state.touchEdit).toBe(initialFlags.touch_edit)
          expect(state.agentOrchestrator).toBe(initialFlags.agent_orchestrator)
          expect(state.pptCanvas).toBe(initialFlags.ppt_canvas)
          expect(state.loaded).toBe(true)
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
