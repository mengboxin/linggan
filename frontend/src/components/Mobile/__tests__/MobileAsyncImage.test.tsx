import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MobileAsyncImage } from '../MobileLoadingPrimitives'

describe('MobileAsyncImage cache', () => {
  it('keeps an already loaded image visible when the same source is remounted', () => {
    const src = '/api/assets/mobile-sci-asset/preview?token=test-token'
    const first = render(<MobileAsyncImage src={src} alt="Mobile science preview" />)

    const firstImage = screen.getByRole('img', { name: 'Mobile science preview' })
    expect(firstImage).toHaveStyle({ opacity: '0' })
    fireEvent.load(firstImage)
    expect(firstImage).toHaveStyle({ opacity: '1' })

    first.unmount()
    render(<MobileAsyncImage src={src} alt="Mobile science preview" />)

    expect(screen.getByRole('img', { name: 'Mobile science preview' })).toHaveStyle({ opacity: '1' })
  })

  it('uses the authenticated asset fallback when a signed CDN preview fails', async () => {
    render(
      <MobileAsyncImage
        src="https://image.example.test/cdn-assets/user-1/preview.webp?expires=1"
        fallbackSrc="/api/assets/mobile-image/preview"
        alt="Generated mobile image"
      />,
    )

    fireEvent.error(screen.getByRole('img', { name: 'Generated mobile image' }))

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Generated mobile image' }))
        .toHaveAttribute('src', expect.stringContaining('/api/assets/mobile-image/preview'))
    })
  })
})
