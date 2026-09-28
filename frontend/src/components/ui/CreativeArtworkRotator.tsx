import { useEffect } from 'react'

const ROTATION_INTERVAL_MS = 18_000
const MAX_SWAPS_PER_TICK = 8
const TARGET_SELECTOR = 'img[data-creative-artwork], img[alt=""][src*="/creative-library/"]'

type ArtworkPool = Record<string, string[]>

function searchableArtworkText(item: { title?: string; prompt?: string; tags?: readonly string[] }) {
  return [item.title, item.prompt, ...(item.tags || [])].filter(Boolean).join(' ').toLowerCase()
}

function buildArtworkPools(items: Array<{ image: string; title?: string; prompt?: string; tags?: readonly string[] }>): ArtworkPool {
  const all = Array.from(new Set(items.map(item => item.image).filter(Boolean)))
  const matching = (pattern: RegExp) => Array.from(new Set(
    items.filter(item => pattern.test(searchableArtworkText(item))).map(item => item.image).filter(Boolean),
  ))
  const science = matching(/\b(science|scientific|biology|biolog|medical|medicine|molecule|molecular|cellular|cell\s|anatom|laboratory|research|diagram|infographic|technical|engineering)\b/)
  const poster = matching(/\b(poster|editorial|graphic design|typography|branding|brand identity|campaign|cover art|fashion|magazine|advertising)\b/)

  return {
    all,
    scientific: science.length >= 8 ? science : all,
    poster: poster.length >= 8 ? poster : all,
  }
}

function randomIndex(length: number) {
  return Math.floor(Math.random() * length)
}

function nextArtworkSource(sources: string[], currentSource: string, recentSources: Set<string>) {
  const eligible = sources.filter(source => source !== currentSource && !recentSources.has(source))
  const candidates = eligible.length ? eligible : sources.filter(source => source !== currentSource)
  return candidates.length ? candidates[randomIndex(candidates.length)] : ''
}

/** Rotates only public showcase artwork; user content and generated results are excluded. */
export function CreativeArtworkRotator() {
  useEffect(() => {
    let cancelled = false
    let pools: ArtworkPool = { all: [] }
    let isLoadingPool = false
    let scanTimer: number | undefined
    const recentSources = new Set<string>()

    const swapImage = (image: HTMLImageElement) => {
      if (!document.contains(image) || image.dataset.creativeArtworkLoading === 'true') return
      const currentSource = image.currentSrc || image.src
      const pool = pools[image.dataset.artworkPool || 'all'] || pools.all
      const nextSource = nextArtworkSource(pool, currentSource, recentSources)
      if (!nextSource) return

      image.dataset.creativeArtworkLoading = 'true'
      const preload = new Image()
      preload.decoding = 'async'
      preload.onload = () => {
        if (cancelled || !document.contains(image)) return
        const originalOpacity = image.style.opacity
        const originalTransition = image.style.transition
        image.style.transition = originalTransition
          ? `${originalTransition}, opacity 260ms ease`
          : 'opacity 260ms ease'
        image.style.opacity = '0'
        window.setTimeout(() => {
          if (cancelled || !document.contains(image)) return
          image.src = nextSource
          image.dataset.creativeArtworkSource = nextSource
          recentSources.add(nextSource)
          if (recentSources.size > 64) recentSources.delete(recentSources.values().next().value || '')
          image.style.opacity = originalOpacity
          window.setTimeout(() => {
            if (!document.contains(image)) return
            image.style.transition = originalTransition
            delete image.dataset.creativeArtworkLoading
          }, 280)
        }, 130)
      }
      preload.onerror = () => { delete image.dataset.creativeArtworkLoading }
      preload.src = nextSource
    }

    const targets = () => Array.from(document.querySelectorAll<HTMLImageElement>(TARGET_SELECTOR))
        .filter(image => !image.closest('[data-no-artwork-rotation]'))

    const loadPool = () => {
      if (isLoadingPool || pools.all.length || !targets().length) return
      isLoadingPool = true
      void import('../../lib/public-gallery-presets').then(({ PUBLIC_GALLERY_PRESETS }) => {
        if (cancelled) return
        pools = buildArtworkPools(PUBLIC_GALLERY_PRESETS)
        rotate()
      }).catch(() => {
        isLoadingPool = false
      })
    }

    const rotate = () => {
      if (document.visibilityState !== 'visible') return
      const artworkTargets = targets()
      if (!artworkTargets.length) return
      if (!pools.all.length) {
        loadPool()
        return
      }
      for (const image of artworkTargets) image.dataset.creativeArtwork = 'true'
      const shuffled = [...artworkTargets].sort(() => Math.random() - 0.5)
      shuffled.slice(0, Math.min(MAX_SWAPS_PER_TICK, shuffled.length)).forEach(swapImage)
    }

    const scheduleScan = () => {
      if (scanTimer) return
      scanTimer = window.setTimeout(() => {
        scanTimer = undefined
        rotate()
      }, 240)
    }

    const observer = new MutationObserver(scheduleScan)
    observer.observe(document.body, { childList: true, subtree: true })
    const interval = window.setInterval(rotate, ROTATION_INTERVAL_MS)
    rotate()

    return () => {
      cancelled = true
      observer.disconnect()
      window.clearInterval(interval)
      if (scanTimer) window.clearTimeout(scanTimer)
    }
  }, [])

  return null
}
