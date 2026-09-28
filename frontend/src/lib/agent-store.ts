/**
 * Agent Store — Zustand store 管理 Agent 编排状态
 *
 * 监听 SSE 事件 agent_plan / agent_step，更新 plan.sub_tasks 状态。
 *
 * @see Requirements: R7.3, R7.4, R7.5
 */

import { create } from 'zustand'

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export interface SubTaskState {
  sequence: number
  operation: string
  target: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'aborted'
  error?: string
  result?: unknown
  variantResults?: { variantIndex: number; status: string; result?: unknown }[]
}

export interface AgentPlanState {
  planId: string | null
  status: 'idle' | 'awaiting_confirm' | 'executing' | 'paused' | 'completed' | 'aborted'
  subTasks: SubTaskState[]
  instruction: string
}

interface AgentStore {
  plan: AgentPlanState
  setPlan: (plan: AgentPlanState) => void
  updateSubTask: (sequence: number, patch: Partial<SubTaskState>) => void
  reset: () => void
  handleSSEEvent: (event: { type: string; [key: string]: unknown }) => void
}

// ─── 初始状态 ────────────────────────────────────────────────────────────────────

const initialPlan: AgentPlanState = {
  planId: null,
  status: 'idle',
  subTasks: [],
  instruction: '',
}

// ─── Store ──────────────────────────────────────────────────────────────────────

export const useAgentStore = create<AgentStore>((set, get) => ({
  plan: initialPlan,

  setPlan: (plan) => set({ plan }),

  updateSubTask: (sequence, patch) =>
    set((state) => ({
      plan: {
        ...state.plan,
        subTasks: state.plan.subTasks.map((t) =>
          t.sequence === sequence ? { ...t, ...patch } : t,
        ),
      },
    })),

  reset: () => set({ plan: initialPlan }),

  handleSSEEvent: (event) => {
    const { type } = event
    const store = get()

    if (type === 'agent_plan_created') {
      const subTasks = (event.sub_tasks as { sequence: number; operation: string; target: string }[]) || []
      set({
        plan: {
          planId: event.plan_id as string,
          status: 'awaiting_confirm',
          subTasks: subTasks.map((t) => ({ ...t, status: 'pending' as const })),
          instruction: store.plan.instruction,
        },
      })
    } else if (type === 'agent_step') {
      const sequence = event.sub_task_id as number ?? event.sequence as number
      const status = event.status as SubTaskState['status']
      store.updateSubTask(sequence, {
        status,
        error: event.error as string | undefined,
        result: event.result as unknown,
      })
    } else if (type === 'agent_plan_done') {
      set((state) => ({
        plan: { ...state.plan, status: event.status as AgentPlanState['status'] },
      }))
    }
  },
}))
