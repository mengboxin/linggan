import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@gsap/react', () => ({
  useGSAP: vi.fn(),
}))

vi.mock('gsap', () => ({
  gsap: {
    registerPlugin: vi.fn(),
  },
}))

vi.mock('../../../lib/theme', () => ({
  useThemeStore: () => ({ theme: 'light' }),
}))

import { BrandLoadingScreen } from '../BrandLoadingScreen'

describe('BrandLoadingScreen', () => {
  it('uses the current brand mark instead of the legacy PNG logo', () => {
    const { container } = render(<BrandLoadingScreen />)

    expect(screen.getByRole('status', { name: '正在加载灵感' })).toBeVisible()
    expect(container.querySelector('.app-route-loader__logo')).toHaveAttribute('src', '/linggan-mark.svg?v=20260811-centered')
    expect(screen.getByRole('img', { name: '灵感' })).toHaveClass('brand-wordmark--hero')
    expect(container.querySelector('.brand-wordmark__text')).toHaveTextContent('灵感')
    expect(container.innerHTML).not.toContain('linggan-wordmark.svg')
    expect(container.innerHTML).not.toContain('/logo.png')
  })
})
