import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PosterPreview } from '../PosterPreview'
import type { PosterItem } from '../poster-types'

const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function makePosters(): PosterItem[] {
  return [
    {
      id: 'poster-1',
      poster_index: 0,
      number: '01',
      title: 'Poster 1',
      versions: [
        { id: 'p1-v1', posterIndex: 0, number: '01', renderedB64: onePixel, prompt: '', userPrompt: 'first', title: 'v1', createdAt: '2026-07-02T00:00:00Z' },
        { id: 'p1-v2', posterIndex: 0, number: '01', renderedB64: onePixel, prompt: '', userPrompt: 'second', title: 'v2', createdAt: '2026-07-02T00:01:00Z' },
      ],
      selected_version_index: 0,
    },
    {
      id: 'poster-2',
      poster_index: 1,
      number: '02',
      title: 'Poster 2',
      versions: [
        { id: 'p2-v1', posterIndex: 1, number: '02', renderedB64: onePixel, prompt: '', userPrompt: 'third', title: 'v1', createdAt: '2026-07-02T00:02:00Z' },
      ],
      selected_version_index: 0,
    },
  ]
}

describe('PosterPreview artifacts', () => {
  it('renders every generated poster version as a separate artifact and selects the clicked version', () => {
    const onSelectVersion = vi.fn()
    render(
      <PosterPreview
        phase="preview"
        progress={100}
        message=""
        posters={makePosters()}
        selectedPosterIndex={0}
        isDark={false}
        accent="#d48200"
        accentBg="rgba(212,130,0,0.08)"
        cardBorder="rgba(0,0,0,0.08)"
        textMuted="#8a8176"
        onSelectPoster={vi.fn()}
        onSelectVersion={onSelectVersion}
        onDownload={vi.fn()}
      />,
    )

    expect(screen.getAllByTestId('poster-artifact-card')).toHaveLength(3)

    fireEvent.click(screen.getAllByTestId('poster-artifact-select')[1])

    expect(onSelectVersion).toHaveBeenCalledWith(0, 1)
  })

  it('uses the optimized preview URL when an inline original is also present', () => {
    const posters = makePosters()
    posters[0].versions[0] = {
      ...posters[0].versions[0],
      previewUrl: '/api/assets/poster-asset/preview',
      renderedUrl: '/api/assets/poster-asset/original',
    }

    render(
      <PosterPreview
        phase="preview"
        progress={100}
        message=""
        posters={posters}
        selectedPosterIndex={0}
        isDark={false}
        accent="#d48200"
        accentBg="rgba(212,130,0,0.08)"
        cardBorder="rgba(0,0,0,0.08)"
        textMuted="#8a8176"
        onSelectPoster={vi.fn()}
        onSelectVersion={vi.fn()}
        onDownload={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('img', { name: 'Poster 1' })[0]).toHaveAttribute(
      'src',
      expect.stringContaining('/api/assets/poster-asset/preview'),
    )
  })

  it('offers each generated poster version to the image-edit workflow', () => {
    const onImportToWorkflow = vi.fn()
    const posters = makePosters()

    render(
      <PosterPreview
        phase="preview"
        progress={100}
        message=""
        posters={posters}
        selectedPosterIndex={0}
        isDark={false}
        accent="#d48200"
        accentBg="rgba(212,130,0,0.08)"
        cardBorder="rgba(0,0,0,0.08)"
        textMuted="#8a8176"
        onSelectPoster={vi.fn()}
        onSelectVersion={vi.fn()}
        onDownload={vi.fn()}
        onImportToWorkflow={onImportToWorkflow}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: '导入图片编辑' })[1])

    expect(onImportToWorkflow).toHaveBeenCalledWith(posters[0], posters[0].versions[1])
  })
})
