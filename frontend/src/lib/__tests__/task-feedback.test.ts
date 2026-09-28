import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTaskFeedback, completeTaskFeedback, updateTaskFeedback } from '../task-feedback'
import { useTaskRegistry } from '../task-registry'
import { useTaskToastStore } from '../task-toast-store'

describe('task completion feedback', () => {
  beforeEach(() => {
    localStorage.clear()
    Reflect.deleteProperty(window, 'electronAPI')
    useTaskRegistry.setState({ tasks: [] })
    useTaskToastStore.setState({ toasts: [] })
  })

  it('only announces a completion when a live task reaches success', () => {
    completeTaskFeedback('ppt_generation', { id: 'history-ppt', jobId: 'history-ppt' })
    expect(useTaskToastStore.getState().toasts).toHaveLength(0)

    updateTaskFeedback('ppt_generation', 'running', { id: 'live-ppt', jobId: 'live-ppt' })
    completeTaskFeedback('ppt_generation', { id: 'live-ppt', jobId: 'live-ppt' })
    expect(useTaskToastStore.getState().toasts).toHaveLength(1)

    completeTaskFeedback('ppt_generation', { id: 'live-ppt', jobId: 'live-ppt' })
    expect(useTaskToastStore.getState().toasts).toHaveLength(1)
  })

  it('records stages and cancellation without sending imperative pet state', () => {
    const petSetState = vi.fn()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { petSetState },
    })

    updateTaskFeedback('canvas_flow_run', 'running', {
      id: 'canvas-run-1',
      stageLabel: '运行节点',
      stageDetail: '正在并发处理 2 个节点',
      groupId: 'canvas-1',
      targetPath: '/canvas-flow?task=canvas-1',
    })
    cancelTaskFeedback('canvas_flow_run', { id: 'canvas-run-1' })

    expect(useTaskRegistry.getState().tasks[0]).toMatchObject({
      status: 'cancelled',
      stageLabel: '运行节点',
      stageDetail: '正在并发处理 2 个节点',
      groupId: 'canvas-1',
      targetPath: '/canvas-flow?task=canvas-1',
    })
    expect(petSetState).not.toHaveBeenCalled()
  })
})
