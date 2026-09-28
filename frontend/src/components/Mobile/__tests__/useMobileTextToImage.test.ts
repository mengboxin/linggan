import { describe, expect, it } from 'vitest'
import { extractMobileImageSources } from '../useMobileTextToImage'

describe('mobile image result sources', () => {
  it('uses the lightweight preview for display while preserving original and API fallback sources', () => {
    const sources = extractMobileImageSources({
      imageUrl: 'https://image.example.test/cdn-assets/original.png?signature=original',
      previewUrl: 'https://image.example.test/cdn-assets/preview.webp?signature=preview',
      previewFallbackUrl: '/api/assets/mobile-result/preview',
    })

    expect(sources).toEqual({
      displayImage: 'https://image.example.test/cdn-assets/preview.webp?signature=preview',
      originalImage: 'https://image.example.test/cdn-assets/original.png?signature=original',
      fallbackImage: '/api/assets/mobile-result/preview',
    })
  })
})
