import { create } from 'zustand'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface FeatureFlagState {
  /** Touch Edit 功能开关 */
  touchEdit: boolean
  /** Agent 编排器功能开关 */
  agentOrchestrator: boolean
  /** PPT 画布编辑器功能开关 */
  pptCanvas: boolean
  /** 是否已成功加载过 flag（区分首次加载失败与后续轮询失败） */
  loaded: boolean
  /** 最近一次错误信息，null 表示无错误 */
  error: string | null
}

export interface FeatureFlagActions {
  /** 设置 flag 状态（成功加载后调用） */
  setFlags: (flags: Pick<FeatureFlagState, 'touchEdit' | 'agentOrchestrator' | 'pptCanvas'>) => void
  /** 设置错误状态 */
  setError: (error: string | null) => void
  /** 重置为默认安全值 */
  resetToDefaults: () => void
}

export type FeatureFlagStore = FeatureFlagState & FeatureFlagActions

// ─── 默认安全值（R14.2：保守默认，所有 flag 为 false） ─────────────────────────

export const DEFAULT_FLAGS: Pick<FeatureFlagState, 'touchEdit' | 'agentOrchestrator' | 'pptCanvas'> = {
  touchEdit: false,
  agentOrchestrator: false,
  pptCanvas: false,
}

// ─── Store 实现 ────────────────────────────────────────────────────────────────

export const useFeatureFlagStore = create<FeatureFlagStore>((set) => ({
  // 初始状态：所有 flag 为 false
  ...DEFAULT_FLAGS,
  loaded: false,
  error: null,

  setFlags: (flags) =>
    set({
      touchEdit: flags.touchEdit,
      agentOrchestrator: flags.agentOrchestrator,
      pptCanvas: flags.pptCanvas,
      loaded: true,
      error: null,
    }),

  setError: (error) => set({ error }),

  resetToDefaults: () =>
    set({
      ...DEFAULT_FLAGS,
      loaded: false,
      error: null,
    }),
}))
