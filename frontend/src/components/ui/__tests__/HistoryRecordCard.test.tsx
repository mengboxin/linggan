import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HistoryRecordCard, historyStatusMeta } from '../HistoryRecordCard'

vi.mock('../../../lib/auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    getAccessToken: () => '',
    refreshImageAccessToken: vi.fn(),
  },
}))

describe('HistoryRecordCard thumbnail delivery', () => {
  it('does not show settled status labels in history', () => {
    expect(historyStatusMeta('done')).toBeNull()
    expect(historyStatusMeta('failed')).toBeNull()
  })

  it('loads history thumbnails lazily at low priority', () => {
    render(
      <HistoryRecordCard
        title="Poster"
        thumbnailUrl="https://assets.example.com/thumb.webp"
        thumbnailAlt="Poster thumbnail"
        fallbackIcon="image"
        meta={<span>now</span>}
        active={false}
        loading={false}
        deleteConfirm={false}
        isDark={false}
        accent="#f59e0b"
        accentBg="#fff7ed"
        cardBorder="#e5e7eb"
        textMuted="#6b7280"
        onOpen={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const image = screen.getByRole('img', { name: 'Poster thumbnail' })
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(image).toHaveAttribute('fetchpriority', 'low')
    expect(image).toHaveAttribute('width', '48')
    expect(image).toHaveAttribute('height', '48')
  })

  it('keeps a loaded thumbnail out of its loading state when the history card remounts', () => {
    const props = {
      title: 'Poster',
      thumbnailUrl: 'https://assets.example.com/thumb.webp',
      thumbnailAlt: 'Poster thumbnail',
      fallbackIcon: 'image',
      meta: <span>now</span>,
      active: false,
      loading: false,
      deleteConfirm: false,
      isDark: false,
      accent: '#f59e0b',
      accentBg: '#fff7ed',
      cardBorder: '#e5e7eb',
      textMuted: '#6b7280',
      onOpen: vi.fn(),
      onDelete: vi.fn(),
    }
    const first = render(<HistoryRecordCard {...props} />)
    const firstImage = screen.getByRole('img', { name: 'Poster thumbnail' })
    fireEvent.load(firstImage)
    expect(firstImage).toHaveStyle({ opacity: '1' })

    first.unmount()
    render(<HistoryRecordCard {...props} />)

    expect(screen.getByRole('img', { name: 'Poster thumbnail' })).toHaveStyle({ opacity: '1' })
  })
})
