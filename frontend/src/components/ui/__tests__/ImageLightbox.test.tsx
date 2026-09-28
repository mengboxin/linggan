import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ImageLightbox, previewLightboxMeta } from '../ImageLightbox'

describe('ImageLightbox', () => {
  it('truncates prompt metadata and hides it when the user zooms with the wheel', () => {
    const prompt = 'Detailed prompt '.repeat(20)
    render(
      <ImageLightbox
        src="https://example.test/image.png"
        caption="文生图预览"
        meta={prompt}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('image-lightbox-meta')).toHaveTextContent(previewLightboxMeta(prompt))
    expect(screen.getByTestId('image-lightbox-meta')).not.toHaveTextContent(prompt)

    fireEvent.wheel(screen.getByTestId('image-lightbox-stage'), { deltaY: -120 })

    expect(screen.queryByTestId('image-lightbox-details')).not.toBeInTheDocument()
  })
})
