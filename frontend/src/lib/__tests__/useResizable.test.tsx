import { act, renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { useResizable } from '../useResizable'

function pointerDown(button: number, clientX: number, pointerId = 7) {
  const target = document.createElement('div')
  Object.assign(target, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  })

  return {
    button,
    buttons: button === 2 ? 2 : 1,
    clientX,
    pointerId,
    pointerType: 'mouse',
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLDivElement>
}

function dispatchPointer(type: string, clientX: number, buttons: number, pointerId = 7) {
  const event = new MouseEvent(type, { clientX, buttons, bubbles: true })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  window.dispatchEvent(event)
}

describe('useResizable pointer lifecycle', () => {
  it('ignores a right click instead of latching onto subsequent mouse movement', () => {
    const { result } = renderHook(() => useResizable({ initial: 300, min: 180, max: 500, side: 'left' }))

    act(() => result.current.onPointerDown(pointerDown(2, 300)))
    act(() => dispatchPointer('pointermove', 360, 2))

    expect(result.current.width).toBe(300)
  })

  it('resizes only while the left pointer button remains held', () => {
    const { result } = renderHook(() => useResizable({ initial: 300, min: 180, max: 500, side: 'left' }))

    act(() => result.current.onPointerDown(pointerDown(0, 300)))
    act(() => dispatchPointer('pointermove', 360, 1))
    expect(result.current.width).toBe(360)

    act(() => dispatchPointer('pointerup', 360, 0))
    act(() => dispatchPointer('pointermove', 420, 0))
    expect(result.current.width).toBe(360)
  })
})
