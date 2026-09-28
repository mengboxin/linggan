import { create } from 'zustand'

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export type TaskType =
  | 'image_generation'
  | 'ppt_generation'
  | 'poster_generation'
  | 'sci_fig_generation'
  | 'layer_edit'
  | 'segmentation'
  | 'prompt_analysis'
  | 'image_recreation'
  | 'canvas_flow_run'
  | 'canvas_node_generation'
  | 'paper_generation'
  | 'presentation_conversion'
export type TaskToastStatus = 'success' | 'failed'

export interface TaskToast {
  id: string
  taskType: TaskType
  status?: TaskToastStatus
  title?: string
  message: string
  icon: string
  dedupeKey?: string
  onClick?: () => void
  createdAt: number
}

// ─── 消息常量 ──────────────────────────────────────────────────────────────────

export const TASK_MESSAGES: Record<TaskType, string> = {
  image_generation: '已完成，点击查看结果',
  ppt_generation: '已完成，点击查看结果',
  poster_generation: '已完成，点击查看结果',
  sci_fig_generation: '已完成，点击查看结果',
  layer_edit: '已完成，点击查看结果',
  segmentation: '已完成，点击查看结果',
  prompt_analysis: '分析已完成，点击查看结果',
  image_recreation: '复现已完成，点击查看结果',
  canvas_flow_run: '画布流已完成，点击查看结果',
  canvas_node_generation: '节点生成已完成，点击查看结果',
  paper_generation: '论文创作已完成，点击查看结果',
  presentation_conversion: '演示文稿转换已完成，点击查看结果',
}

export const TASK_ICONS: Record<TaskType, string> = {
  image_generation: 'auto_awesome',
  ppt_generation: 'slideshow',
  poster_generation: 'wall_art',
  sci_fig_generation: 'science',
  layer_edit: 'layers',
  segmentation: 'content_cut',
  prompt_analysis: 'image_search',
  image_recreation: 'auto_awesome',
  canvas_flow_run: 'account_tree',
  canvas_node_generation: 'hub',
  paper_generation: 'article',
  presentation_conversion: 'slideshow',
}

export const TASK_MODULE_LABELS: Record<TaskType, string> = {
  image_generation: '图像生成',
  ppt_generation: 'PPT 生成',
  poster_generation: '海报生成',
  sci_fig_generation: '科研图生成',
  layer_edit: '图片编辑',
  segmentation: '图像分割',
  prompt_analysis: '灵感反推',
  image_recreation: '图片复现',
  canvas_flow_run: '画布流运行',
  canvas_node_generation: '画布节点生成',
  paper_generation: '论文创作',
  presentation_conversion: '演示文稿转换',
}

// ─── Store ─────────────────────────────────────────────────────────────────────

const MAX_TOASTS = 3
const DEDUP_WINDOW_MS = 2000

interface TaskToastState {
  toasts: TaskToast[]
  show: (toast: Omit<TaskToast, 'id' | 'createdAt'>) => void
  dismiss: (id: string) => void
  dismissAll: () => void
}

export const useTaskToastStore = create<TaskToastState>((set, get) => ({
  toasts: [],

  show: (toast) => {
    const now = Date.now()
    const existing = get().toasts

    // 去重：同一任务类型在 DEDUP_WINDOW_MS 内不重复弹出
    const duplicate = existing.find((item) => {
      if (now - item.createdAt >= DEDUP_WINDOW_MS) return false
      if (toast.dedupeKey || item.dedupeKey) return item.dedupeKey === toast.dedupeKey
      return item.taskType === toast.taskType && item.status === toast.status && item.message === toast.message
    })
    if (duplicate) return

    const newToast: TaskToast = {
      ...toast,
      id: crypto.randomUUID(),
      createdAt: now,
    }

    const updated = [newToast, ...existing].slice(0, MAX_TOASTS)
    set({ toasts: updated })
  },

  dismiss: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  dismissAll: () => {
    set({ toasts: [] })
  },
}))
