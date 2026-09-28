import { describe, expect, it } from 'vitest'
import { getLandingArtworkSet } from '../LingganLandingExperience'

describe('landing artwork sources', () => {
  it('uses only bundled creative-library artwork and Chinese display copy', () => {
    const { heroArtworks, works } = getLandingArtworkSet(20260821)

    expect(heroArtworks.length).toBeGreaterThan(0)
    expect(heroArtworks.every(src => src.startsWith('/creative-library/'))).toBe(true)
    expect(works.length).toBeGreaterThan(0)
    expect(works.every(work => work.src.startsWith('/creative-library/') && /[\u4e00-\u9fff]/.test(work.zh))).toBe(true)
  })
})
