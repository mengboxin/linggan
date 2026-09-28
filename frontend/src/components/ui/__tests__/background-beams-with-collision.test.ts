import { describe, expect, it } from 'vitest'

import { getCollisionPoint } from '../background-beams-with-collision'

function elementWithRect(rect: Partial<DOMRect>, width: number, height: number) {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    offsetWidth: { value: width },
    offsetHeight: { value: height },
  })
  element.getBoundingClientRect = () => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  })
  return element
}

describe('getCollisionPoint', () => {
  it('uses each beam rendered position instead of its untransformed offset', () => {
    const parent = elementWithRect({ left: 100, top: 200, width: 500, height: 300 }, 1000, 600)
    const beam = elementWithRect({ left: 300, width: 4 }, 4, 14)
    const floor = elementWithRect({ top: 480 }, 1000, 1)

    expect(getCollisionPoint(parent, beam, floor)).toEqual({ x: 404, y: 560 })
  })
})
