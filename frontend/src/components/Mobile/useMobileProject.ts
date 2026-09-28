import { useCallback } from 'react'

export interface MobileProjectInfo {
  projectId: string | null
  taskId: string | null
  projectName: string
}

/**
 * 移动端专用项目 hook
 * 移动端生成记录归属文生图/对话历史，不再自动创建图片编辑工作流项目。
 */
export function useMobileProject() {
  const createTask = useCallback(async (taskName: string): Promise<string | null> => {
    void taskName
    return null
  }, [])

  return {
    projectId: null,
    taskId: null,
    projectName: '',
    ready: true,
    createTask,
  }
}
