import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MobileModeContentTransition from '../MobileModeContentTransition'

describe('MobileModeContentTransition', () => {
  it('shows the separate switch step while keeping mode state mounted', () => {
    render(
      <MobileModeContentTransition mode="TEXT_TO_IMAGE" switchingTo="SCI_FIG">
        <div data-testid="mode-content">content</div>
      </MobileModeContentTransition>,
    )
    const container = screen.getByTestId('mobile-mode-content-transition')
    const switchStep = screen.getByTestId('mobile-mode-switch-step')
    const content = screen.getByTestId('mobile-mode-content')

    expect(container.dataset.mode).toBe('TEXT_TO_IMAGE')
    expect(container.dataset.switching).toBe('true')
    expect(container.style.minHeight).toBe('calc(100dvh - 168px)')
    expect(switchStep.style.display).toBe('block')
    expect(switchStep.style.minHeight).toBe('calc(100dvh - 168px)')
    expect(switchStep.textContent).toContain('正在切换到')
    expect(content.style.display).toBe('none')
    expect(screen.getByTestId('mode-content')).toBeInTheDocument()
  })

  it('mounts committed mode content when no switch step is active', () => {
    render(
      <MobileModeContentTransition mode="SCI_FIG">
        <div data-testid="mode-content">content</div>
      </MobileModeContentTransition>,
    )
    const container = screen.getByTestId('mobile-mode-content-transition')
    const switchStep = screen.getByTestId('mobile-mode-switch-step')
    const content = screen.getByTestId('mobile-mode-content')

    expect(container.dataset.mode).toBe('SCI_FIG')
    expect(container.dataset.switching).toBe('false')
    expect(switchStep.style.display).toBe('none')
    expect(content.style.display).toBe('block')
    expect(screen.getByTestId('mode-content')).toBeInTheDocument()
  })
})
