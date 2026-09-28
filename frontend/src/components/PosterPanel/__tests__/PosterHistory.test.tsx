import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PosterHistory } from '../PosterHistory'
import type { PosterHistoryItem } from '../poster-types'
import { auth } from '../../../lib/auth'

const baseProps = {
  activeId: null,
  deleteConfirmId: null,
  isDark: false,
  accent: '#d48200',
  accentBg: 'rgba(212,130,0,0.08)',
  cardBorder: 'rgba(0,0,0,0.08)',
  textMuted: '#8a8176',
  onNew: vi.fn(),
  onOpen: vi.fn(),
  onDelete: vi.fn(),
}

describe('PosterHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('lg_access_token', 'poster-token')
    localStorage.setItem('pixelscribe-auth-session-started-at', String(Date.now()))
    vi.spyOn(auth, 'refreshImageAccessToken').mockResolvedValue(false)
  })

  afterEach(() => vi.restoreAllMocks())

  it('loads protected thumbnails through the authenticated asset URL', () => {
    const item: PosterHistoryItem = {
      id: 'poster-1',
      title: '测试海报',
      timestamp: Date.now(),
      status: 'done',
      thumbnailUrl: '/api/assets/poster-asset/thumb',
    }

    render(<PosterHistory {...baseProps} history={[item]} />)

    expect(screen.getByRole('img', { name: '测试海报缩略图' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/assets/poster-asset/thumb?token=poster-token'),
    )
  })

  it('falls back to the preview asset when the thumbnail request fails', async () => {
    const item: PosterHistoryItem = {
      id: 'poster-with-fallback',
      title: 'Poster with fallback',
      timestamp: Date.now(),
      status: 'done',
      thumbnailUrl: '/api/assets/poster-asset/thumb',
      previewUrl: '/api/assets/poster-asset/preview',
    }

    render(<PosterHistory {...baseProps} history={[item]} />)

    fireEvent.error(screen.getByRole('img'))

    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('/api/assets/poster-asset/preview?token=poster-token'),
      )
    })
  })

  it('stops the thumbnail loading state and tries the preview after a timeout', async () => {
    vi.useFakeTimers()
    try {
      const item: PosterHistoryItem = {
        id: 'poster-with-pending-thumb',
        title: 'Poster with pending thumbnail',
        timestamp: Date.now(),
        status: 'done',
        thumbnailUrl: '/api/assets/poster-asset/thumb',
        previewUrl: '/api/assets/poster-asset/preview',
      }

      render(<PosterHistory {...baseProps} history={[item]} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('/api/assets/poster-asset/preview?token=poster-token'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show a completion badge for saved records', () => {
    const unseen = {
      id: 'poster-unseen',
      title: '未查看海报',
      timestamp: Date.now(),
      status: 'done',
      seen: false,
    } as PosterHistoryItem
    const seen = {
      id: 'poster-seen',
      title: '已查看海报',
      timestamp: Date.now(),
      status: 'done',
      seen: true,
    } as PosterHistoryItem

    const { rerender } = render(<PosterHistory {...baseProps} history={[unseen]} />)
    expect(screen.queryByText('完成')).not.toBeInTheDocument()

    rerender(<PosterHistory {...baseProps} history={[seen]} />)
    expect(screen.queryByText('完成')).not.toBeInTheDocument()
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
  })
})
