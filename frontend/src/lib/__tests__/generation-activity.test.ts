import { describe, expect, it } from 'vitest'
import { mergeGenerationActivities } from '../generation-activity'
import type { RegisteredTask } from '../task-registry'

const task = (patch: Partial<RegisteredTask> = {}): RegisteredTask => ({
  id: 'poster-job-1',
  taskType: 'poster_generation',
  status: 'running',
  title: 'Poster task',
  progress: 24,
  jobId: 'poster-job-1',
  conversationId: 'poster-conv-1',
  startedAt: 100,
  updatedAt: 200,
  ...patch,
})

describe('mergeGenerationActivities', () => {
  it('merges a running task and its history record into one activity', () => {
    const activities = mergeGenerationActivities([
      {
        id: 'poster-conv-1',
        type: 'poster',
        title: 'Poster history',
        job_id: 'poster-job-1',
        conversation_id: 'poster-conv-1',
        status: 'preview',
        updated_at: '2026-07-01T10:00:00.000Z',
      },
    ], [task()])

    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      id: 'job:poster-job-1',
      kind: 'poster',
      status: 'running',
      progress: 24,
      jobId: 'poster-job-1',
      conversationId: 'poster-conv-1',
    })
  })

  it('keeps concurrent jobs of the same kind as separate activities', () => {
    const activities = mergeGenerationActivities([], [
      task(),
      task({ id: 'poster-job-2', jobId: 'poster-job-2', conversationId: 'poster-conv-2', updatedAt: 300 }),
    ])

    expect(activities.map(item => item.id)).toEqual([
      'job:poster-job-2',
      'job:poster-job-1',
    ])
  })

  it('does not let an unresolved mobile submit replace its completed server job by conversation id', () => {
    const completedAt = Date.parse('2026-08-06T09:57:42.000Z')
    const activities = mergeGenerationActivities([
      {
        id: 'image-server-job',
        type: 'image',
        title: '3D character',
        job_id: 'server-job-1',
        conversation_id: 'image-conversation-1',
        status: 'completed',
        updated_at: '2026-08-06T09:57:42.000Z',
      },
    ], [
      task({
        id: 'image-mobile-123',
        taskType: 'image_generation',
        status: 'waiting',
        progress: 8,
        jobId: 'image-mobile-123',
        conversationId: 'image-conversation-1',
        startedAt: completedAt - 240_000,
        updatedAt: completedAt - 1_000,
      }),
    ])

    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      id: 'job:server-job-1',
      status: 'success',
      jobId: 'server-job-1',
    })
  })

  it('keeps a dismissed task and its matching history row hidden', () => {
    const activities = mergeGenerationActivities([
      {
        id: 'poster-conv-1',
        type: 'poster',
        title: 'Poster history',
        job_id: 'poster-job-1',
        conversation_id: 'poster-conv-1',
      },
      {
        id: 'poster-conv-1-second-job',
        type: 'poster',
        title: 'Another poster history',
        job_id: 'poster-job-2',
        conversation_id: 'poster-conv-1',
      },
    ], [task({ dismissed: true })])

    expect(activities.map(activity => activity.jobId)).toEqual(['poster-job-2'])
  })

  it('does not surface an expired terminal local task over refreshed history', () => {
    const activities = mergeGenerationActivities([
      {
        id: 'image-blue-glass',
        type: 'image',
        title: '蓝色透亮',
        job_id: 'image-blue-glass',
        created_at: '2026-08-18T18:53:00.000Z',
      },
    ], [task({
      id: 'ppt-stale-task',
      taskType: 'ppt_generation',
      status: 'failed',
      title: '旧的卡死任务',
      updatedAt: 1,
    })], { terminalTaskRetentionMs: 60_000 })

    expect(activities.map(activity => activity.title)).toEqual(['蓝色透亮'])
  })
})
