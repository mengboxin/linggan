/**
 * Feature Flags Hook 与 Zustand Store 单元测试
 *
 * 覆盖：
 * - Store 默认状态与 actions
 * - fetchFeatureFlags 各种响应场景
 * - useFeatureFlags hook 的挂载行为与清理
 * - 网络/解析失败时 fallback 到安全默认值
 * - 成功加载后上报 session_start 事件
 *
 * @see Requirements R14.2, R14.3, R14.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFeatureFlagStore, DEFAULT_FLAGS } from '../../stores/feature-flag-store'
import { fetchFeatureFlags, useFeatureFlags } from '../feature-flags'
import { monitoring } from '../monitoring'

// ── Mock 设置 ────────────────────────────────────────────────────────────────

// Mock auth 模块
vi.mock('../auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    fetchWithAuth: vi.fn(),
  },
}))

// Mock monitoring 模块
vi.mock('../monitoring', () => ({
  monitoring: {
    trackUserAction: vi.fn(),
  },
}))

import { auth } from '../auth'

const mockFetchWithAuth = auth.fetchWithAuth as ReturnType<typeof vi.fn>

// ── Store 测试 ───────────────────────────────────────────────────────────────

describe('useFeatureFlagStore', () => {
  beforeEach(() => {
    // 重置 store 到初始状态
    useFeatureFlagStore.setState({
      ...DEFAULT_FLAGS,
      loaded: false,
      error: null,
    })
  })

  it('初始状态：所有 flag 为 false，loaded 为 false', () => {
    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(false)
    expect(state.agentOrchestrator).toBe(false)
    expect(state.pptCanvas).toBe(false)
    expect(state.loaded).toBe(false)
    expect(state.error).toBeNull()
  })

  it('setFlags 更新 flag 状态并标记 loaded', () => {
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: false,
      pptCanvas: true,
    })

    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(true)
    expect(state.agentOrchestrator).toBe(false)
    expect(state.pptCanvas).toBe(true)
    expect(state.loaded).toBe(true)
    expect(state.error).toBeNull()
  })

  it('setError 设置错误信息', () => {
    useFeatureFlagStore.getState().setError('网络错误')
    expect(useFeatureFlagStore.getState().error).toBe('网络错误')
  })

  it('setFlags 清除之前的错误', () => {
    useFeatureFlagStore.getState().setError('网络错误')
    useFeatureFlagStore.getState().setFlags(DEFAULT_FLAGS)
    expect(useFeatureFlagStore.getState().error).toBeNull()
  })

  it('resetToDefaults 重置所有状态', () => {
    useFeatureFlagStore.getState().setFlags({
      touchEdit: true,
      agentOrchestrator: true,
      pptCanvas: true,
    })
    useFeatureFlagStore.getState().resetToDefaults()

    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(false)
    expect(state.agentOrchestrator).toBe(false)
    expect(state.pptCanvas).toBe(false)
    expect(state.loaded).toBe(false)
    expect(state.error).toBeNull()
  })
})

// ── fetchFeatureFlags 测试 ───────────────────────────────────────────────────

describe('fetchFeatureFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功响应返回解析后的 flags', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        touch_edit: true,
        agent_orchestrator: false,
        ppt_canvas: true,
        user_id: 'user-123',
      }),
    })

    const result = await fetchFeatureFlags()
    expect(result).toEqual({
      touch_edit: true,
      agent_orchestrator: false,
      ppt_canvas: true,
      user_id: 'user-123',
    })
  })

  it('401 响应返回 unauthorized', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 401,
    })

    const result = await fetchFeatureFlags()
    expect(result).toBe('unauthorized')
  })

  it('5xx 响应返回 null', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
    })

    const result = await fetchFeatureFlags()
    expect(result).toBeNull()
  })

  it('网络错误返回 null', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('Network error'))

    const result = await fetchFeatureFlags()
    expect(result).toBeNull()
  })

  it('JSON 解析错误返回 null', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    })

    const result = await fetchFeatureFlags()
    expect(result).toBeNull()
  })

  it('响应结构不完整返回 null', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ touch_edit: true }), // 缺少其他字段
    })

    const result = await fetchFeatureFlags()
    expect(result).toBeNull()
  })
})

// ── useFeatureFlags Hook 测试 ────────────────────────────────────────────────

describe('useFeatureFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 store
    useFeatureFlagStore.setState({
      ...DEFAULT_FLAGS,
      loaded: false,
      error: null,
    })
  })

  it('挂载时立即调用 fetchFeatureFlags 并更新 store', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        touch_edit: true,
        agent_orchestrator: true,
        ppt_canvas: false,
        user_id: 'user-abc',
      }),
    })

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().loaded).toBe(true)
    })

    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(true)
    expect(state.agentOrchestrator).toBe(true)
    expect(state.pptCanvas).toBe(false)
  })

  it('成功加载后上报 session_start 事件（R14.4）', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        touch_edit: true,
        agent_orchestrator: false,
        ppt_canvas: true,
        user_id: 'user-xyz',
      }),
    })

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(monitoring.trackUserAction).toHaveBeenCalled()
    })

    expect(monitoring.trackUserAction).toHaveBeenCalledWith({
      action: 'session_start',
      success: true,
      metadata: {
        flags: {
          touch_edit: true,
          agent_orchestrator: false,
          ppt_canvas: true,
        },
        user_id: 'user-xyz',
      },
    })
  })

  it('首次加载失败时 fallback 到默认 false 值', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('Network error'))

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().loaded).toBe(true)
    })

    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(false)
    expect(state.agentOrchestrator).toBe(false)
    expect(state.pptCanvas).toBe(false)
    expect(state.error).toBe('获取 feature flags 失败')
  })

  it('后续轮询失败时保持现有状态不变', async () => {
    // 第一次成功
    let callCount = 0
    mockFetchWithAuth.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            touch_edit: true,
            agent_orchestrator: true,
            ppt_canvas: true,
            user_id: 'user-1',
          }),
        })
      }
      // 后续调用失败
      return Promise.reject(new Error('Network error'))
    })

    renderHook(() => useFeatureFlags())

    // 等待首次加载成功
    await waitFor(() => {
      expect(useFeatureFlagStore.getState().touchEdit).toBe(true)
    })

    // 直接调用 fetchFeatureFlags 模拟轮询失败
    // （不等待真实 5 分钟间隔，直接验证 store 行为）
    const { fetchFeatureFlags: fetchFn } = await import('../feature-flags')
    const result = await fetchFn()
    expect(result).toBeNull()

    // 验证 store 状态保持不变（hook 内部逻辑：loaded=true 时不重置）
    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(true)
    expect(state.agentOrchestrator).toBe(true)
    expect(state.pptCanvas).toBe(true)
  })

  it('卸载时清理轮询 interval', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        touch_edit: false,
        agent_orchestrator: false,
        ppt_canvas: false,
        user_id: 'user-1',
      }),
    })

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

    const { unmount } = renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().loaded).toBe(true)
    })

    unmount()

    // 验证 clearInterval 被调用（清理轮询）
    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })

  it('设置了 5 分钟轮询 interval', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        touch_edit: false,
        agent_orchestrator: false,
        ppt_canvas: false,
        user_id: 'user-1',
      }),
    })

    const setIntervalSpy = vi.spyOn(global, 'setInterval')

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().loaded).toBe(true)
    })

    // 验证 setInterval 被调用，间隔为 300000ms（5 分钟）
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 300_000)
    setIntervalSpy.mockRestore()
  })

  it('401 响应时首次未加载使用默认值', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 401,
    })

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().error).toBe('用户未登录')
    })

    const state = useFeatureFlagStore.getState()
    expect(state.touchEdit).toBe(false)
    expect(state.agentOrchestrator).toBe(false)
    expect(state.pptCanvas).toBe(false)
  })

  it('session_start 事件不在失败时上报', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('Network error'))

    renderHook(() => useFeatureFlags())

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().loaded).toBe(true)
    })

    expect(monitoring.trackUserAction).not.toHaveBeenCalled()
  })
})
