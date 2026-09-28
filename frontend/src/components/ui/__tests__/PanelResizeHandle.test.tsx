import { render, screen } from '@testing-library/react'

import { PanelResizeHandle } from '../PanelResizeHandle'

describe('PanelResizeHandle positioning', () => {
  it('keeps viewport-edge handles fixed instead of letting the default relative class win', () => {
    const { container } = render(
      <PanelResizeHandle
        isDark={false}
        title="调整右侧栏宽度"
        className="fixed z-[80] pointer-events-auto"
        style={{ right: 320, width: 28 }}
      />,
    )

    expect(screen.getByRole('separator', { name: /调整右侧栏宽度/ })).toHaveStyle({
      position: 'fixed',
      right: '320px',
      width: '28px',
    })
    expect(container.querySelector('[data-resize-grip="true"]')).toHaveStyle({
      width: '8px',
      height: '80px',
    })
  })
})
