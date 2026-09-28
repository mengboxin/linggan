import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEstimatedProgress } from '../useEstimatedProgress'

describe('useEstimatedProgress', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a numeric server progress value stable', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useEstimatedProgress(24, true, {
      cap: 92,
      durationMs: 150_000,
      tickMs: 900,
      resetKey: 'job-1',
    }))

    act(() => {
      vi.advanceTimersByTime(120_000)
    })

    expect(result.current).toBe(24)
  })

  it('estimates progress only when the server has no numeric value', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useEstimatedProgress(undefined, true, {
      minProgress: 3,
      cap: 92,
      durationMs: 150_000,
      tickMs: 900,
      resetKey: 'job-2',
    }))

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(result.current).toBeGreaterThan(3)
    expect(result.current).toBeLessThanOrEqual(92)
  })
})
