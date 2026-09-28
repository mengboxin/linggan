import { beforeEach, describe, expect, it } from 'vitest'

import { useTaskToastStore } from '../task-toast-store'

describe('task toast concurrency deduplication', () => {
  beforeEach(() => {
    useTaskToastStore.getState().dismissAll()
  })

  it('keeps completion feedback for separate jobs of the same module', () => {
    const show = useTaskToastStore.getState().show
    show({
      taskType: 'image_generation',
      status: 'success',
      title: '图像生成完成',
      message: '已完成，点击查看结果',
      icon: 'auto_awesome',
      dedupeKey: 'job-1',
    })
    show({
      taskType: 'image_generation',
      status: 'success',
      title: '图像生成完成',
      message: '已完成，点击查看结果',
      icon: 'auto_awesome',
      dedupeKey: 'job-2',
    })

    expect(useTaskToastStore.getState().toasts).toHaveLength(2)
  })

  it('drops a duplicate feedback event for the same job', () => {
    const show = useTaskToastStore.getState().show
    const toast = {
      taskType: 'poster_generation' as const,
      status: 'success' as const,
      title: '海报生成完成',
      message: '已完成，点击查看结果',
      icon: 'wall_art',
      dedupeKey: 'poster-job-1',
    }
    show(toast)
    show(toast)

    expect(useTaskToastStore.getState().toasts).toHaveLength(1)
  })
})
