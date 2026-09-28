import { useCallback, useEffect, useRef, useState } from 'react'
import { imageSourceIdentity, imageSrc, isProtectedAssetImage, refreshProtectedAssetImage } from './image-url'

export function useAssetImageRetrySource(value?: string | null, fallbackValue?: string | null) {
  const incomingBaseSrc = imageSrc(value)
  const incomingFallbackSrc = imageSrc(fallbackValue)
  const incomingIdentity = imageSourceIdentity(incomingBaseSrc)
  const incomingFallbackIdentity = imageSourceIdentity(incomingFallbackSrc)
  const incomingSourceKey = `${incomingIdentity}\n${incomingFallbackIdentity}`
  const [baseSrc, setBaseSrc] = useState(incomingBaseSrc || incomingFallbackSrc)
  const baseSourceKeyRef = useRef(incomingSourceKey)
  const [retrySrc, setRetrySrc] = useState('')
  const refreshAttemptedRef = useRef(false)
  const retryAttemptRef = useRef(0)
  const activeSrc = retrySrc || baseSrc

  useEffect(() => {
    if (incomingSourceKey === baseSourceKeyRef.current) return
    baseSourceKeyRef.current = incomingSourceKey
    setBaseSrc(incomingBaseSrc || incomingFallbackSrc)
    setRetrySrc('')
    refreshAttemptedRef.current = false
    retryAttemptRef.current = 0
  }, [incomingBaseSrc, incomingFallbackSrc, incomingSourceKey])

  const retryWithFreshToken = useCallback(async () => {
    if (!activeSrc) return false
    if (incomingFallbackSrc && imageSourceIdentity(activeSrc) !== incomingFallbackIdentity) {
      setBaseSrc(incomingFallbackSrc)
      setRetrySrc('')
      refreshAttemptedRef.current = false
      retryAttemptRef.current = 0
      return true
    }
    if (refreshAttemptedRef.current || !isProtectedAssetImage(activeSrc)) return false
    refreshAttemptedRef.current = true
    retryAttemptRef.current += 1
    const refreshed = await refreshProtectedAssetImage(activeSrc, retryAttemptRef.current)
    if (!refreshed || refreshed === activeSrc) return false
    setRetrySrc(refreshed)
    return true
  }, [activeSrc, incomingFallbackIdentity, incomingFallbackSrc])

  return { src: activeSrc, retryWithFreshToken }
}
