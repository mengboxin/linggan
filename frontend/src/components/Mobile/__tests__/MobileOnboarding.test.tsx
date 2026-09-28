import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MobileOnboarding, { MOBILE_ONBOARDING_STEPS, getMobileOnboardingTooltipStyle } from '../MobileOnboarding'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('mobile onboarding tooltip placement', () => {
  it('keeps a bottom-positioned card inside a short viewport', () => {
    const style = getMobileOnboardingTooltipStyle({
      position: 'bottom',
      rect: { top: 560, bottom: 620 },
      viewportHeight: 700,
      cardHeight: 360,
      margin: 16,
      bottomInset: 24,
    })

    expect(style.top).toBe(316)
    expect(style.maxHeight).toBe('360px')
  })

  it('keeps a top-positioned card visible when the target is below the viewport', () => {
    const style = getMobileOnboardingTooltipStyle({
      position: 'top',
      rect: { top: 920, bottom: 980 },
      viewportHeight: 760,
      cardHeight: 360,
      margin: 16,
      bottomInset: 24,
    })

    expect(style.top).toBe(376)
    expect(style.maxHeight).toBe('360px')
  })

  it('waits for navigation to finish before scrolling to the target', async () => {
    vi.useFakeTimers()
    const target = document.createElement('div')
    target.id = 'mobile-mode-switcher'
    target.getBoundingClientRect = () => ({
      x: 20,
      y: 80,
      top: 80,
      right: 340,
      bottom: 128,
      left: 20,
      width: 320,
      height: 48,
      toJSON: () => ({}),
    }) as DOMRect
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    document.body.appendChild(target)

    let finishNavigation: (() => void) | undefined
    const onNavigate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        finishNavigation = resolve
      }))
    render(<MobileOnboarding open onClose={vi.fn()} onNavigate={onNavigate} />)

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(50)
    })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()

    await act(async () => {
      finishNavigation?.()
      await Promise.resolve()
      vi.advanceTimersByTime(400)
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('keeps the basic tour limited to targets available before generation', () => {
    const targets = MOBILE_ONBOARDING_STEPS.map(step => step.targetId)

    expect(targets).not.toContain('mobile-scifig-result-preview')
    expect(targets).not.toContain('mobile-scifig-refine-panel')
    expect(targets).not.toContain('mobile-poster-version-grid')
    expect(targets).not.toContain('mobile-poster-refine-panel')
    expect(targets).not.toContain('mobile-poster-download-actions')
  })

  it('provides an explicit close button when a target cannot be located', () => {
    const onClose = vi.fn()
    render(<MobileOnboarding open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭导览' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('explains complete parameter groups and links to the full manual', () => {
    render(<MobileOnboarding open onClose={vi.fn()} />)

    expect(screen.getByRole('list', { name: '本步骤涵盖内容' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完整手册' })).toBeInTheDocument()
    expect(MOBILE_ONBOARDING_STEPS.some(step => step.items?.includes('比例、清晰度与渲染质量'))).toBe(true)
    expect(MOBILE_ONBOARDING_STEPS.some(step => step.items?.includes('SVG / image2 模式'))).toBe(true)
  })
})
