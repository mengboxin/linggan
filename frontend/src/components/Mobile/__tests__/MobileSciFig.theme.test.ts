import { describe, expect, it } from 'vitest'
import { mobileSciFigPrimaryActionStyle } from '../MobileSciFig'

describe('MobileSciFig primary action theme', () => {
  it('keeps labels legible when a selected action uses the primary fill', () => {
    const style = mobileSciFigPrimaryActionStyle()

    expect(style.background).toBe('var(--app-primary)')
    expect(style.color).toBe('var(--app-on-primary)')
  })
})
