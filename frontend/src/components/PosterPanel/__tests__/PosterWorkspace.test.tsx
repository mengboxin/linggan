import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PosterWorkspace } from '../PosterWorkspace'

describe('PosterWorkspace version thumbnails', () => {
  it('uses the dedicated compact loader while a version thumbnail is loading', () => {
    render(
      <PosterWorkspace
        phase="preview"
        posters={[{
          id: 'poster-1',
          poster_index: 0,
          number: '01',
          title: '海报 1',
          versions: [{
            id: 'poster-1-v1',
            posterIndex: 0,
            number: '01',
            title: 'v1',
            renderedB64: '',
            thumbnailUrl: '/api/assets/poster-1-v1/thumbnail',
            renderedUrl: '/api/assets/poster-1-v1/original',
            prompt: '',
            createdAt: '2026-08-24T00:00:00Z',
          }],
          selected_version_index: 0,
        }]}
        selectedPosterIndex={0}
        progress={100}
        message=""
        isDark={false}
        accent="#171717"
        accentBg="rgba(17,17,17,0.08)"
        cardBorder="rgba(17,17,17,0.1)"
        textMuted="#686868"
        onSelectPoster={vi.fn()}
        onSelectVersion={vi.fn()}
        onDownload={vi.fn()}
        onRefine={vi.fn()}
      />,
    )

    const versionThumbnail = screen.getByTitle('版本 1')
    const status = within(versionThumbnail).getByTestId('image-generation-status')
    expect(status).toHaveAttribute('data-status-variant', 'thumbnail')
    expect(status).toHaveAttribute('aria-label', '正在加载缩略图')
  })
})
