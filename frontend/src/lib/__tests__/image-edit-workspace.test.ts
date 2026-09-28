import { describe, expect, it } from 'vitest'

import {
  filterImageEditWorkflowTargets,
  findImageEditWorkflowTarget,
  shouldAutoRestoreDesktopLocalProject,
  shouldClearImageEditWorkspaceAfterDelete,
  shouldShowImageEditHome,
} from '../image-edit-workspace'

describe('image-edit workflow import targets', () => {
  const tasks = [
    { id: 'image-edit-1', workflow_kind: 'image_edit', name: '图片编辑工作流' },
    { id: 'legacy-1', name: '旧版图片编辑工作流' },
    { id: 'canvas-1', workflow_kind: 'canvas_flow', name: '画布流' },
    { id: 'other-1', workflow_kind: 'unknown_future_kind', name: '其它工作流' },
  ]

  it('only exposes image-edit and legacy image-edit records as import targets', () => {
    expect(filterImageEditWorkflowTargets(tasks).map(task => task.id)).toEqual([
      'image-edit-1',
      'legacy-1',
    ])
  })

  it('rejects a canvas-flow id even when it is supplied outside the selection list', () => {
    expect(findImageEditWorkflowTarget(tasks, 'canvas-1')).toBeUndefined()
    expect(findImageEditWorkflowTarget(tasks, 'image-edit-1')?.id).toBe('image-edit-1')
  })
})

describe('image-edit workspace delete recovery', () => {
  it('clears the open workspace when the deleted task is the active one', () => {
    expect(shouldClearImageEditWorkspaceAfterDelete({
      deletedTaskId: 'task-1',
      currentTaskId: 'task-1',
    })).toBe(true)

    expect(shouldClearImageEditWorkspaceAfterDelete({
      deletedTaskId: 'local-1',
      localProjectId: 'local-1',
    })).toBe(true)

    expect(shouldClearImageEditWorkspaceAfterDelete({
      deletedTaskId: 'task-2',
      currentTaskId: 'task-1',
      localProjectId: 'local-1',
    })).toBe(false)
  })

  it('returns to the image-edit home after the active workspace is cleared', () => {
    expect(shouldShowImageEditHome({
      canvasNodeCount: 0,
      currentTaskId: null,
      localProjectId: null,
    })).toBe(true)

    expect(shouldShowImageEditHome({
      canvasNodeCount: 2,
      currentTaskId: null,
      localProjectId: null,
    })).toBe(false)
  })

  it('does not immediately restore another desktop local project after delete', () => {
    expect(shouldAutoRestoreDesktopLocalProject({
      currentTaskId: null,
      localProjectId: null,
      hasLayers: false,
      suppressAutoRestore: true,
    })).toBe(false)

    expect(shouldAutoRestoreDesktopLocalProject({
      currentTaskId: null,
      localProjectId: null,
      hasLayers: false,
      suppressAutoRestore: false,
    })).toBe(true)
  })
})
