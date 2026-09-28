import { describe, expect, it } from 'vitest'
import { posterComposerIsEditable } from '../PosterChat'

describe('poster composer availability', () => {
  it('allows a new prompt after a poster task fails', () => {
    expect(posterComposerIsEditable('failed')).toBe(true)
  })

  it('keeps the composer locked while work is active', () => {
    expect(posterComposerIsEditable('generating')).toBe(false)
    expect(posterComposerIsEditable('refining')).toBe(false)
  })
})
