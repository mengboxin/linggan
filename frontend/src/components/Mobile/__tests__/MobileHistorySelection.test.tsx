import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auth } from '../../../lib/auth'
import MobileDrawer from '../MobileDrawer'
import MobileHistory from '../MobileHistory'
import { saveMobileHistoryCache, type MobileHistoryRecord } from '../mobile-history'

const currentRecord: MobileHistoryRecord = {
  id: 'image-job-current',
  conversation_id: 'conversation-current',
  message_id: 'message-current',
  job_id: 'job-current',
  type: 'image',
  title: '测试作品',
  created_at: '2026-07-18T02:00:00.000Z',
  updated_at: '2026-07-18T02:00:00.000Z',
}

describe('mobile history selected state', () => {
  beforeEach(() => {
    auth.clear()
    window.localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    saveMobileHistoryCache([currentRecord])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('marks the active record in the mobile drawer', async () => {
    render(
      <MobileDrawer
        open
        onClose={vi.fn()}
        onTaskSelect={vi.fn()}
        activeRecordId="job-current"
      />,
    )

    const title = await screen.findByText('测试作品')
    const row = title.closest('[role="button"]')

    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('当前')).toBeInTheDocument()
  })

  it('marks the active record in the standalone history list', async () => {
    render(<MobileHistory activeRecordId="job-current" />)

    const title = await screen.findByText('测试作品')
    const row = title.closest('[role="button"]')

    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('当前')).toBeInTheDocument()
  })
})
