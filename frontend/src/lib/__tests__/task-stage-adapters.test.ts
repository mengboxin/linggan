import { describe, expect, it } from 'vitest'
import { taskStageFromAgentActivity, taskStageFromStatus } from '../task-stage-adapters'

describe('task stage adapters', () => {
  it('uses a user-facing PPT agent stage when one is available', () => {
    expect(taskStageFromAgentActivity('ppt', [
      { name: 'intent_planning', status: 'completed', progress: 18 },
      { name: 'direct_svg_2', status: 'running', progress: 46 },
    ], 'running')).toMatchObject({
      stageLabel: '制作第 2 页可编辑页面',
    })
  })

  it('falls back to a stable stage and keeps a server message as detail', () => {
    expect(taskStageFromStatus('queued', '前方还有 2 个任务')).toEqual({
      stageLabel: '等待处理',
      stageDetail: '前方还有 2 个任务',
    })
  })

  it('does not expose an unknown internal status as user-facing copy', () => {
    expect(taskStageFromStatus('provider_internal_retry')).toEqual({
      stageLabel: '正在生成',
      stageDetail: '正在处理当前创作任务。',
    })
  })
})
