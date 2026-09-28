import { describe, expect, it } from 'vitest'
import { publicAssetBaseUrl, publicAssetUrl } from '../public-assets'

describe('public asset URLs', () => {
  it('uses the configured object-storage base without an API redirect', () => {
    const base = 'https://assets.example.com/static/'

    expect(publicAssetBaseUrl(base)).toBe('https://assets.example.com/static')
    expect(publicAssetUrl('/pets/bubu.webp', base)).toBe('https://assets.example.com/static/pets/bubu.webp')
  })

  it('keeps the API redirect as a compatibility fallback', () => {
    expect(publicAssetUrl('pets/bubu.webp', '')).toBe('/api/system/public-assets/pets/bubu.webp')
  })
})
