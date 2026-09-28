import { describe, expect, it, vi } from 'vitest'
import { shouldDiscardCreatedWorkflowTask, workflowBindingCreationKey } from '../workflow-task-binding'

describe('shouldDiscardCreatedWorkflowTask', () => {
  it('keeps a task manually bound while automatic binding was pending', () => {
    expect(shouldDiscardCreatedWorkflowTask({
      requestedBindingEpoch: 4,
      currentBindingEpoch: 5,
      currentTaskId: 'shared-task',
      createdTaskId: 'shared-task',
    })).toBe(false)
  })

  it('discards only an obsolete unbound task', () => {
    expect(shouldDiscardCreatedWorkflowTask({
      requestedBindingEpoch: 4,
      currentBindingEpoch: 5,
      currentTaskId: 'manual-task',
      createdTaskId: 'automatic-task',
    })).toBe(true)
  })

  it('retains the creation key while an unbound workspace retries', () => {
    const createKey = vi.fn(() => 'image-edit-auto:stable')
    expect(workflowBindingCreationKey(null, createKey)).toBe('image-edit-auto:stable')
    expect(workflowBindingCreationKey('image-edit-auto:stable', createKey)).toBe('image-edit-auto:stable')
    expect(createKey).toHaveBeenCalledTimes(1)
  })
})
