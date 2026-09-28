/**
 * 任务队列与 SSE 事件相关类型定义
 * 覆盖队列任务数据结构、Server-Sent Events 联合类型
 *
 * @see Requirements: R8.3
 */

import type { SubTask } from './agent'

/** 队列中的任务实体 */
export interface QueueTask {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  /** 进度百分比 0-100 */
  progress: number
  /** 创建时间戳（毫秒） */
  createdAt: number
  /** 使用的模型名称 */
  modelName?: string
  /** 消耗的信用值 */
  cost?: number
}

/** SSE 推送事件联合类型 */
export type SSEEvent =
  | { type: 'task_progress'; task_id: string; progress: number; phase?: string }
  | { type: 'task_complete'; task_id: string; result_summary: string }
  | { type: 'task_failed'; task_id: string; error: string }
  | { type: 'agent_plan'; plan_id: string; sub_tasks: SubTask[] }
  | { type: 'agent_step'; plan_id: string; sub_task: SubTask }
  | { type: 'ppt_progress'; job_id: string; step: string; percent: number }
  | { type: 'ppt_slide_ready'; job_id: string; index: number; thumb_url: string }
  | { type: 'ppt_slide_error'; job_id: string; index: number; reason: string }
