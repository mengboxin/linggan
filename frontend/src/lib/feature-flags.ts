import { useEffect, useRef } from 'react'
import { apiUrl, auth } from './auth'
import { useFeatureFlagStore, DEFAULT_FLAGS } from '../stores/feature-flag-store'
import { monitoring } from './monitoring'

// ─── 常量 ──────────────────────────────────────────────────────────────────────

/** 轮询间隔：5 分钟 */
const POLL_INTERVAL_MS = 300_000

// ─── API 响应类型 ──────────────────────────────────────────────────────────────

interface FlagsApiResponse {
  touch_edit: boolean
  agent_orchestrator: boolean
  ppt_canvas: boolean
  user_id: string
}

// ─── 核心 fetch 逻辑（可独立测试） ─────────────────────────────────────────────

/**
 * 从后端获取 feature flags。
 * 网络/解析失败时返回 null，401 时返回 'unauthorized'。
 */
export async function fetchFeatureFlags(): Promise<FlagsApiResponse | null | 'unauthorized'> {
  try {
    const res = await auth.fetchWithAuth(apiUrl('/api/system/flags'))

    // 401 → 用户未登录，不重试
    if (res.status === 401) {
      return 'unauthorized'
    }

    // 5xx → 返回 null，下次轮询重试
    if (!res.ok) {
      return null
    }

    const data: unknown = await res.json()

    // 验证响应结构
    if (
      data !== null &&
      typeof data === 'object' &&
      'touch_edit' in data &&
      'agent_orchestrator' in data &&
      'ppt_canvas' in data
    ) {
      return data as FlagsApiResponse
    }

    // JSON 解析成功但结构不符 → 视为解析失败
    return null
  } catch {
    // 网络错误 → fallback
    return null
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useFeatureFlags hook
 *
 * - 组件挂载时立即调用 /api/system/flags
 * - 每 5 分钟轮询一次
 * - 网络/解析失败时 fallback 到 { touch_edit: false, agent_orchestrator: false, ppt_canvas: false }
 * - 成功加载后上报 session_start 事件到 monitoring
 *
 * Requirements: R14.2, R14.3, R14.4
 */
export function useFeatureFlags() {
  const store = useFeatureFlagStore()
  const hasReportedSession = useRef(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadFlags = async () => {
      const result = await fetchFeatureFlags()

      if (cancelled) return

      if (result === 'unauthorized') {
        // 用户未登录：使用默认值，不重试
        if (!store.loaded) {
          useFeatureFlagStore.getState().setFlags(DEFAULT_FLAGS)
        }
        useFeatureFlagStore.getState().setError('用户未登录')
        return
      }

      if (result === null) {
        // 网络/解析失败
        if (!useFeatureFlagStore.getState().loaded) {
          // 首次加载失败：使用默认 false 值
          useFeatureFlagStore.getState().setFlags(DEFAULT_FLAGS)
        }
        // 后续轮询失败：保持现有状态不变（R14.2 保守策略）
        useFeatureFlagStore.getState().setError('获取 feature flags 失败')
        return
      }

      // 成功：更新 store
      const flags = {
        touchEdit: Boolean(result.touch_edit),
        agentOrchestrator: Boolean(result.agent_orchestrator),
        pptCanvas: Boolean(result.ppt_canvas),
      }
      useFeatureFlagStore.getState().setFlags(flags)

      // 上报 session_start 事件（仅首次成功时上报，R14.4）
      if (!hasReportedSession.current) {
        hasReportedSession.current = true
        monitoring.trackUserAction({
          action: 'session_start',
          success: true,
          metadata: {
            flags: {
              touch_edit: result.touch_edit,
              agent_orchestrator: result.agent_orchestrator,
              ppt_canvas: result.ppt_canvas,
            },
            user_id: result.user_id,
          },
        })
      }
    }

    // 启动时立即加载
    loadFlags()

    // 设置 5 分钟轮询
    intervalRef.current = setInterval(loadFlags, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return store
}
