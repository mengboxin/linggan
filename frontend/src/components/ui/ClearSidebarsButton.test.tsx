import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClearSidebarsButton } from './ClearSidebarsButton'

describe('ClearSidebarsButton', () => {
  it('uses the neutral glass treatment in the light theme', () => {
    render(
      <ClearSidebarsButton
        isDark={false}
        accent="#fca311"
        accentBg="rgba(252,163,17,0.14)"
        restoreMode={false}
        onClick={vi.fn()}
      />,
    )

    const button = screen.getByRole('button')
    expect(button).toHaveClass('clear-sidebars-button__action')
    expect(button.style.background).toBe('')
  })

  it('uses the same neutral glass treatment in the dark theme', () => {
    render(
      <ClearSidebarsButton
        isDark
        accent="#d4d4d8"
        accentBg="rgba(212,212,216,0.12)"
        restoreMode={false}
        onClick={vi.fn()}
      />,
    )

    const button = screen.getByRole('button')
    expect(button).toHaveClass('clear-sidebars-button__action')
    expect(button.style.background).toBe('')
  })
})
