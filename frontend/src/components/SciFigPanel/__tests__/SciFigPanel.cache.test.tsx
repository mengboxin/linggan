import { describe, expect, it } from 'vitest'

import { cacheableSciFigHistoryItem } from '../SciFigPanel'

describe('SciFigPanel history cache', () => {
  it('replaces expiring cached delivery URLs with stable asset routes', () => {
    const cached = cacheableSciFigHistoryItem({
      id: 'sci-1',
      description: '科研图',
      category: 'data_chart',
      style: 'minimal',
      outputFormat: 'png',
      timestamp: Date.now(),
      assetId: 'sci-asset',
      imageUrl: 'https://delivery.example.test/sci.png?signature=stale',
      previewUrl: 'https://delivery.example.test/sci-preview.png?signature=stale',
      thumbnailUrl: 'https://delivery.example.test/sci-thumb.png?signature=stale',
    })

    expect(cached.imageUrl).toBe('/api/assets/sci-asset/original')
    expect(cached.previewUrl).toBe('/api/assets/sci-asset/preview')
    expect(cached.thumbnailUrl).toBe('/api/assets/sci-asset/thumb')
    expect(JSON.stringify(cached)).not.toContain('signature=stale')
  })
})
