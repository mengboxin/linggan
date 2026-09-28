import { beforeEach, describe, expect, it } from 'vitest'
import { auth } from '../auth'
import { useTaskRegistry } from '../task-registry'

describe('task registry lifecycle', () => {
  beforeEach(() => {
    auth.clear()
    window.localStorage.clear()
    useTaskRegistry.setState({ tasks: [] })
  })

  it('resets progress when a completed task starts a new active phase', () => {
    const registry = useTaskRegistry.getState()
    registry.upsertTask({
      id: 'poster-job-1',
      taskType: 'poster_generation',
      status: 'success',
      title: 'Poster',
      progress: 100,
    })

    useTaskRegistry.getState().upsertTask({
      id: 'poster-job-1',
      taskType: 'poster_generation',
      status: 'running',
      title: 'Poster refinement',
      progress: 15,
    })

    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'poster-job-1',
      status: 'running',
      progress: 15,
    })
  })

  it('trusts a lower numeric progress value when an active task enters a new stage', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'multi-stage-job',
      taskType: 'ppt_generation',
      status: 'running',
      title: 'Rendering',
      progress: 80,
    })
    useTaskRegistry.getState().upsertTask({
      id: 'multi-stage-job',
      taskType: 'ppt_generation',
      status: 'running',
      title: 'Packaging',
      progress: 10,
    })

    expect(useTaskRegistry.getState().tasks[0].progress).toBe(10)
  })

  it('keeps a running task hidden after later progress updates', () => {
    const registry = useTaskRegistry.getState()
    registry.upsertTask({
      id: 'ppt-job-1',
      taskType: 'ppt_generation',
      status: 'running',
      title: 'PPT',
      progress: 20,
    })
    useTaskRegistry.getState().dismissTask('ppt-job-1')

    useTaskRegistry.getState().upsertTask({
      id: 'ppt-job-1',
      taskType: 'ppt_generation',
      status: 'running',
      title: 'PPT',
      progress: 30,
    })

    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'ppt-job-1',
      dismissed: true,
      progress: 30,
    })
  })

  it('moves a temporary task to its server identity without duplicating it', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'temporary-task',
      taskType: 'image_recreation',
      status: 'running',
      title: 'Recreate',
      progress: 5,
      stageLabel: '提交任务',
      groupId: 'prompt-1',
    })

    useTaskRegistry.getState().rekeyTask('temporary-task', 'server-task', {
      jobId: 'server-task',
      progress: 12,
      stageLabel: '生成画面',
    })

    expect(useTaskRegistry.getState().tasks).toHaveLength(1)
    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'server-task',
      jobId: 'server-task',
      progress: 12,
      stageLabel: '生成画面',
      groupId: 'prompt-1',
    })
  })

  it('marks an active task as cancelled while retaining its progress context', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'canvas-run-1',
      taskType: 'canvas_flow_run',
      status: 'running',
      title: 'Canvas run',
      progress: 40,
      stageDetail: '2 / 5 nodes complete',
    })

    useTaskRegistry.getState().cancelTask('canvas-run-1', { message: 'Stopped by user' })

    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'canvas-run-1',
      status: 'cancelled',
      progress: 40,
      message: 'Stopped by user',
      stageDetail: '2 / 5 nodes complete',
    })
  })

  it('stores friendly messages when an existing task fails', () => {
    useTaskRegistry.getState().upsertTask({
      id: 'image-job-503',
      taskType: 'image_generation',
      status: 'running',
      title: 'Image',
      message: '正在生成图片',
    })

    useTaskRegistry.getState().upsertTask({
      id: 'image-job-503',
      taskType: 'image_generation',
      status: 'failed',
      title: 'Image',
      message: 'Responses image_generation failed (503): Service temporarily unavailable',
    })

    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      id: 'image-job-503',
      status: 'failed',
      message: 'AI 服务暂时繁忙或网关不可用，请稍后重试。',
    })
  })

  it('isolates persisted tasks between signed-in users', () => {
    auth.save('token-a', 'refresh-a', {
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'A',
      role: 'user',
    })
    useTaskRegistry.getState().upsertTask({
      id: 'task-a',
      taskType: 'image_generation',
      status: 'running',
      title: 'A task',
    })

    auth.save('token-b', 'refresh-b', {
      id: 'user-b',
      email: 'b@example.com',
      displayName: 'B',
      role: 'user',
    })
    expect(useTaskRegistry.getState().tasks).toEqual([])

    useTaskRegistry.getState().upsertTask({
      id: 'task-b',
      taskType: 'ppt_generation',
      status: 'waiting',
      title: 'B task',
    })
    auth.save('token-a', 'refresh-a', {
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'A',
      role: 'user',
    })

    expect(useTaskRegistry.getState().tasks.map(task => task.id)).toEqual(['task-a'])
  })
})
