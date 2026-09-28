import { describe, expect, it } from 'vitest'
import { applyPosterLiveStatus } from '../PosterPanel'
import type { PosterHistoryItem } from '../poster-types'

describe('poster history state', () => {
  it('keeps an opened historical record in its original time group', () => {
    const timestamp = Date.now() - 45 * 24 * 60 * 60 * 1000
    const history: PosterHistoryItem[] = [{
      id: 'poster-from-last-month',
      title: '上月海报',
      timestamp,
      status: 'done',
      jobId: 'poster-job-1',
    }]

    const next = applyPosterLiveStatus(history, {
      conversationId: 'poster-from-last-month',
      jobId: 'poster-job-1',
      status: 'done',
      progress: 100,
    })

    expect(next[0].timestamp).toBe(timestamp)
    expect(next[0].status).toBe('done')
  })
})
