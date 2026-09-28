/**
 * useReducedMotion — 监听用户系统级 reduced-motion 偏好
 *
 * 当用户在操作系统中启用"减少动画"时返回 true，
 * 此时 UI 应禁用所有 scale/opacity 过渡，直接应用样式变更。
 *
 * @see Requirements R10.6
 */

import { useState, useEffect } from 'react'

const MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * 获取当前 reduced-motion 状态（SSR 安全）
 */
function getReducedMotionPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MEDIA_QUERY).matches
}

/**
 * React hook：监听 prefers-reduced-motion 媒体查询变化
 * @returns true 表示用户偏好减少动画
 */
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getReducedMotionPreference)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(MEDIA_QUERY)

    // 初始同步（防止 SSR hydration 不一致）
    setPrefersReducedMotion(mql.matches)

    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches)
    }

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }

    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }, [])

  return prefersReducedMotion
}
