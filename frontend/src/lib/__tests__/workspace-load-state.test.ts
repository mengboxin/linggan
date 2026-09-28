import { describe, expect, it } from 'vitest'

import {
  workspaceHistoryForSnapshot,
  workspaceReplacementForSnapshot,
  workspaceRestoreTarget,
} from '../workspace-history-load'

describe('workspaceHistoryForSnapshot', () => {
  it('clears history and its selection when the opened workspace snapshot is empty', () => {
    const loaded = workspaceHistoryForSnapshot([])

    expect(loaded.cards).toEqual([])
    expect(loaded.selectedCard).toBeNull()
  })

  it('replaces every workspace surface when the opened snapshot is empty', () => {
    const loaded = workspaceReplacementForSnapshot({
      layers: undefined,
      canvasImage: undefined,
      cards: undefined,
    })

    expect(loaded).toEqual({
      layers: [],
      canvasImage: null,
      cards: [],
      selectedCard: null,
    })
  })

  it('opens the explicitly requested history task instead of the last local binding', () => {
    expect(workspaceRestoreTarget(
      { taskId: 'requested-task', taskName: '选中的记录' },
      { taskId: 'last-task', taskName: '上次记录' },
    )).toEqual({ taskId: 'requested-task', taskName: '选中的记录' })
  })
})
