import { describe, expect, it } from 'vitest'
import { PUBLIC_GALLERY_PRESETS, type PublicGalleryPreset } from '../../lib/public-gallery-presets'
import { mergeGalleryReactionStates } from '../PublicGalleryPage'

describe('public gallery reaction hydration', () => {
  it('hydrates curated static items without dropping their gallery metadata', () => {
    const curated = PUBLIC_GALLERY_PRESETS[0]
    const [hydrated] = mergeGalleryReactionStates([curated], [{
      id: curated.id,
      likes: 3,
      favorites: 2,
      liked: true,
      favorited: true,
    }])

    expect(hydrated).toMatchObject({
      id: curated.id,
      title: curated.title,
      image: curated.image,
      likes: curated.likes + 3,
      favorites: (curated.favorites || 0) + 2,
      liked: true,
      favorited: true,
    })
  })

  it('uses server aggregate counts directly for public UUID items', () => {
    const remote: PublicGalleryPreset = {
      ...PUBLIC_GALLERY_PRESETS[0],
      id: '71dc77db-7400-4655-8b17-a254897fec66',
      likes: 99,
      favorites: 88,
    }
    const [hydrated] = mergeGalleryReactionStates([remote], [{
      id: remote.id,
      likes: 5,
      favorites: 4,
      liked: false,
      favorited: true,
    }])

    expect(hydrated.likes).toBe(5)
    expect(hydrated.favorites).toBe(4)
    expect(hydrated.liked).toBe(false)
    expect(hydrated.favorited).toBe(true)
  })
})
