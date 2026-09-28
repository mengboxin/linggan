import '@testing-library/jest-dom'

class IntersectionObserverStub implements IntersectionObserver {
  private readonly callback: IntersectionObserverCallback
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  disconnect() {}

  observe(target: Element) {
    const targetRect = target.getBoundingClientRect()
    this.callback([{
      boundingClientRect: targetRect,
      intersectionRatio: 1,
      intersectionRect: targetRect,
      isIntersecting: true,
      rootBounds: null,
      target,
      time: performance.now(),
    }], this)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  unobserve() {}
}

globalThis.IntersectionObserver = IntersectionObserverStub
