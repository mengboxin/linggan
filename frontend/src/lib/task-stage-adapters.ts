import {
  latestAgentActivity,
  type AgentActivityStepInput,
  type CreativeModule,
} from './agent-activity'

export interface TaskStageCopy {
  stageLabel: string
  stageDetail: string
}

const STATUS_STAGE_COPY: Record<string, TaskStageCopy> = {
  queued: { stageLabel: '等待处理', stageDetail: '任务已经进入队列，正在等待可用算力。' },
  submitted: { stageLabel: '准备任务', stageDetail: '任务已经提交，正在准备所需素材和参数。' },
  running: { stageLabel: '正在生成', stageDetail: '正在处理当前创作任务。' },
  processing: { stageLabel: '正在生成', stageDetail: '正在处理当前创作任务。' },
  completed: { stageLabel: '整理结果', stageDetail: '生成已经完成，正在整理并保存结果。' },
  done: { stageLabel: '整理结果', stageDetail: '生成已经完成，正在整理并保存结果。' },
  failed: { stageLabel: '任务未完成', stageDetail: '任务暂未完成，可以查看详情后重试。' },
  cancelled: { stageLabel: '任务已取消', stageDetail: '已停止当前任务的后续处理。' },
  canceled: { stageLabel: '任务已取消', stageDetail: '已停止当前任务的后续处理。' },
}

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function taskStageFromStatus(
  status: unknown,
  message?: unknown,
  fallback: TaskStageCopy = STATUS_STAGE_COPY.running,
): TaskStageCopy {
  const normalizedStatus = clean(status).toLowerCase()
  const copy = STATUS_STAGE_COPY[normalizedStatus] || fallback
  const detail = clean(message)
  return {
    stageLabel: copy.stageLabel,
    stageDetail: detail || copy.stageDetail,
  }
}

export function taskStageFromAgentActivity(
  module: CreativeModule,
  steps: AgentActivityStepInput[] | undefined,
  status: unknown,
  message?: unknown,
): TaskStageCopy {
  const activity = latestAgentActivity(module, steps)
  if (activity) {
    return {
      stageLabel: activity.title,
      stageDetail: activity.detail,
    }
  }
  return taskStageFromStatus(status, message)
}
