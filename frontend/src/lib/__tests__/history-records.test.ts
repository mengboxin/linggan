import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearHistoryTombstonesForTests,
  dedupeImageHistoryRecords,
  filterDeletedHistoryRecords,
  imageHistoryTombstoneId,
  mergeImageHistoryRecords,
  markHistoryDeleted,
  sameImageHistoryRecord,
} from '../history-records'

describe('history deletion tombstones', () => {
  beforeEach(() => {
    clearHistoryTombstonesForTests()
  })

  it('keeps a deleted conversation out of a later stale refresh', () => {
    markHistoryDeleted('conversation', 'conversation-1')

    const records = filterDeletedHistoryRecords(
      'conversation',
      [{ id: 'conversation-1' }, { id: 'conversation-2' }],
      record => record.id,
    )

    expect(records).toEqual([{ id: 'conversation-2' }])
  })

  it('filters every visual card backed by the same deleted image message', () => {
    const deletedId = imageHistoryTombstoneId({
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })
    markHistoryDeleted('image-message', deletedId)

    const records = filterDeletedHistoryRecords(
      'image-message',
      [
        { id: 'variant-1', conversationId: 'conversation-1', messageId: 'message-1' },
        { id: 'variant-2', conversationId: 'conversation-1', messageId: 'message-1' },
        { id: 'variant-3', conversationId: 'conversation-1', messageId: 'message-2' },
      ],
      imageHistoryTombstoneId,
    )

    expect(records.map(record => record.id)).toEqual(['variant-3'])
  })
})

describe('image history identity', () => {
  it('matches refreshed cards by stable server identity instead of transient UI id', () => {
    expect(sameImageHistoryRecord(
      { id: 'local-card', conversationId: 'conversation-1', messageId: 'message-1' },
      { id: 'remote-card', conversationId: 'conversation-1', messageId: 'message-1' },
    )).toBe(true)
  })

  it('reconciles a terminal remote result over a stale local failure', () => {
    const local = {
      id: 'gen-task-1',
      taskId: 'task-1',
      status: 'failed' as const,
      imageLoading: true,
      error: 'temporary status mismatch',
      prompt: 'a prompt',
    }
    const remote = {
      id: 'conversation-conv-1-message-1',
      taskId: 'task-1',
      conversationId: 'conv-1',
      messageId: 'message-1',
      status: 'completed' as const,
      imageUrl: '/api/assets/asset-1/original',
    }

    expect(sameImageHistoryRecord(local, remote)).toBe(true)
    expect(mergeImageHistoryRecords(local, remote)).toMatchObject({
      id: 'gen-task-1',
      taskId: 'task-1',
      status: 'completed',
      imageLoading: false,
      imageUrl: '/api/assets/asset-1/original',
    })
    expect(mergeImageHistoryRecords(local, remote).error).toBeUndefined()
  })

  it('keeps one completed record when a task has stale and final server messages', () => {
    const records = dedupeImageHistoryRecords([
      { id: 'failed-message', taskId: 'task-2', status: 'failed' as const, createdAt: 2, error: 'stale' },
      { id: 'completed-message', taskId: 'task-2', status: 'completed' as const, createdAt: 3, imageUrl: '/image.png' },
    ])

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ taskId: 'task-2', status: 'completed', imageUrl: '/image.png' })
  })
})
