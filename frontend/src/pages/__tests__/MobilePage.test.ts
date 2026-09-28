import { describe, expect, it } from 'vitest'
import { getMobileTaskInitialConversation } from '../MobilePage'

describe('getMobileTaskInitialConversation', () => {
  it('keeps a job-only PPT task restorable before its conversation row arrives', () => {
    expect(getMobileTaskInitialConversation({ job_id: 'job-only' })).toEqual({
      id: '',
      jobId: 'job-only',
    })
  })

  it('keeps the job id when a real conversation can be restored', () => {
    expect(getMobileTaskInitialConversation({
      conversation_id: 'conversation-1',
      job_id: 'job-1',
    })).toEqual({
      id: 'conversation-1',
      jobId: 'job-1',
    })
  })
})
