import { useEffect, useRef, useState } from 'react'

export function useEstimatedProgress(
  actualProgress: number | null | undefined,
  active: boolean,
  options: {
    cap?: number
    durationMs?: number
    tickMs?: number
    minProgress?: number
    resetKey?: string | number | null
  } = {},
) {
  const cap = options.cap ?? 88
  const durationMs = options.durationMs ?? 180_000
  const tickMs = options.tickMs ?? 900
  const minProgress = options.minProgress ?? 0
  const resetKey = options.resetKey ?? null
  const hasActualProgress = typeof actualProgress === 'number' && Number.isFinite(actualProgress)
  const normalizedActualProgress = hasActualProgress
    ? Math.max(0, Math.min(100, actualProgress))
    : undefined
  const baseRef = useRef({ at: Date.now(), progress: minProgress })
  const resetKeyRef = useRef(resetKey)
  const activeRef = useRef(active)
  const [displayProgress, setDisplayProgress] = useState(() => normalizedActualProgress ?? minProgress)

  useEffect(() => {
    let resetProgress: number | undefined
    const activeStarted = !activeRef.current && active
    if (resetKeyRef.current !== resetKey || activeStarted) {
      const next = normalizedActualProgress ?? minProgress
      resetProgress = next
      resetKeyRef.current = resetKey
      baseRef.current = { at: Date.now(), progress: next }
      setDisplayProgress(next)
    }
    activeRef.current = active

    if (!active || hasActualProgress) {
      const next = normalizedActualProgress ?? minProgress
      baseRef.current = { at: Date.now(), progress: next }
      setDisplayProgress(next)
      return
    }

    setDisplayProgress(current => resetProgress ?? current)

    const timer = window.setInterval(() => {
      const base = baseRef.current
      const elapsed = Date.now() - base.at
      const eased = 1 - Math.exp(-elapsed / Math.max(1, durationMs / 3))
      const synthetic = base.progress + (cap - base.progress) * eased
      setDisplayProgress(current => Math.max(current, Math.min(cap, synthetic)))
    }, tickMs)

    return () => window.clearInterval(timer)
  }, [active, cap, durationMs, hasActualProgress, minProgress, normalizedActualProgress, resetKey, tickMs])

  return Math.round(Math.max(0, Math.min(100, displayProgress)))
}
