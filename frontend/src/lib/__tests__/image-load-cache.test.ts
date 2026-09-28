import { describe, expect, it } from 'vitest'
import { cacheImageLoad, getCachedImageLoad } from '../image-load-cache'

describe('image load cache identity', () => {
  it('reuses a loaded CDN asset when only its signed delivery parameters change', () => {
    const firstSignedUrl = 'https://image.example.test/cdn-assets/cache-stability/preview.webp?expires=100&signature=first'
    const refreshedSignedUrl = 'https://image.example.test/cdn-assets/cache-stability/preview.webp?signature=second&expires=200'

    cacheImageLoad(firstSignedUrl, { naturalAspect: '4 / 3' })

    expect(getCachedImageLoad(refreshedSignedUrl)).toEqual({ naturalAspect: '4 / 3' })
  })

  it('does not reuse a cache entry when a meaningful image parameter changes', () => {
    const previewUrl = 'https://image.example.test/cdn-assets/cache-variant/source.webp?width=640&expires=100&signature=first'
    const originalUrl = 'https://image.example.test/cdn-assets/cache-variant/source.webp?width=2048&expires=200&signature=second'

    cacheImageLoad(previewUrl, { naturalAspect: '1 / 1' })

    expect(getCachedImageLoad(originalUrl)).toBeUndefined()
  })
})
