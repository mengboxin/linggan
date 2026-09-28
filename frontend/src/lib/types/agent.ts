/**
 * Agent 编排相关类型定义
 * 覆盖子任务操作类型、子任务数据结构、计划状态
 *
 * @see Requirements: R7.1
 */

/** Agent 子任务支持的操作类型 */
export type SubTaskOperation =
  | 'segment'
  | 'inpaint_replace'
  | 'inpaint_recolor'
  | 'inpaint_remove'
  | 'text_edit'
  | 'icon_swap'
  | 'generate'
  | 'compose'

/** Agent 计划的生命周期状态 */
export type AgentPlanStatus =
  | 'planning'
  | 'awaiting_confirm'
  | 'executing'
  | 'paused'
  | 'done'
  | 'aborted'

/** Agent 分解后的单个子任务 */
export interface SubTask {
  /** 执行序号，1-20 */
  sequence: number
  /** 操作类型 */
  operation: SubTaskOperation
  /** 目标元素 id 或描述 */
  target: string
  /** 操作参数 */
  params: Record<string, unknown>
  /** 子任务执行状态 */
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  /** 已重试次数，上限 3 */
  retries: number
  /** 执行结果 */
  result?: unknown
  /** 失败错误信息 */
  error?: string
}
