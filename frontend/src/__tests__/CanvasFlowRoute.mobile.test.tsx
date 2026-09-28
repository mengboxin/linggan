import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasFlowRoute } from '../App'

const originalInnerWidth = window.innerWidth

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  vi.unstubAllGlobals()
})

describe('CanvasFlowRoute on mobile', () => {
  it('redirects narrow viewports to the mobile creation page', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))

    render(
      <MemoryRouter initialEntries={['/canvas-flow']}>
        <Routes>
          <Route path="/canvas-flow" element={<CanvasFlowRoute />} />
          <Route path="/text-to-image" element={<div data-testid="mobile-editor">Mobile editor</div>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('mobile-editor')).toBeInTheDocument()
  })
})
