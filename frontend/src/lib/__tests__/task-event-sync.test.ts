import { beforeEach, describe, expect, it } from 'vitest'
import { eventStream } from '../event-stream'
import { startTaskEventSync } from '../task-event-sync'
import { useTaskRegistry } from '../task-registry'

describe('task event sync', () => {
  beforeEach(() => {
    localStorage.clear()
    useTaskRegistry.setState({ tasks: [] })
  })

  it('keeps updating a registered task after its page subscriber is gone', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'image-1',
      jobId: 'image-1',
      taskType: 'image_generation',
      status: 'running',
      title: '生成海报主图',
    })
    const stop = startTaskEventSync()
    ;(eventStream as unknown as { dispatch: (event: string, data: unknown) => void }).dispatch('task_progress', {
      task_id: 'image-1', status: 'processing', progress: 52, message: '正在检查画面',
    })
    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      progress: 52,
      stageLabel: '正在生成',
      stageDetail: '正在检查画面',
    })
    stop()
  })

  it('maps cancellation to cancelled instead of failed', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'image-2', jobId: 'image-2', taskType: 'image_generation', status: 'running', title: '图片复现',
    })
    const stop = startTaskEventSync()
    ;(eventStream as unknown as { dispatch: (event: string, data: unknown) => void }).dispatch('task_failed', {
      task_id: 'image-2', status: 'cancelled', error: '用户取消',
    })
    expect(useTaskRegistry.getState().tasks[0].status).toBe('cancelled')
    stop()
  })
})
