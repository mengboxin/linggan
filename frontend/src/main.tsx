import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { CloseDialog } from './components/ui/CloseDialog'
import { TaskCompleteToast } from './components/ui/TaskCompleteToast'
import { recoverStaleBrowserShell } from './lib/browser-cache-recovery'
import { usesHashRouting } from './lib/navigation'

const AppRouter = usesHashRouting() ? HashRouter : BrowserRouter
const ICON_FONT_FAMILY = 'Material Symbols Outlined'
const ICON_FONT_SPEC = `24px "${ICON_FONT_FAMILY}"`
const ICON_FONT_SAMPLES = [
  'download',
  'image',
  'brush',
  'layers',
  'auto_awesome',
  'progress_activity',
  'workspace_premium',
]
const rootElement = document.documentElement
const PRODUCT_TITLE = '灵感 - 从灵感到画面'
const BRAND_MARK_SRC = '/linggan-mark.svg?v=20260811-centered'

rootElement.classList.add('icons-loading')
document.title = PRODUCT_TITLE

function waitForDocumentComplete() {
  if (document.readyState === 'complete') return Promise.resolve()
  return new Promise<void>(resolve => {
    const done = () => {
      window.removeEventListener('load', done)
      resolve()
    }
    window.addEventListener('load', done, { once: true })
  })
}

function waitForAnimationFrames(count = 2) {
  return new Promise<void>(resolve => {
    const tick = (remaining: number) => {
      if (remaining <= 0) resolve()
      else requestAnimationFrame(() => tick(remaining - 1))
    }
    tick(count)
  })
}

function waitForImage(src: string) {
  return new Promise<void>(resolve => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = src
  })
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function markIconFontReady() {
  rootElement.classList.remove('icons-loading')
  rootElement.classList.add('icons-ready')
}

function isIconFontVisuallyReady() {
  const sample = 'download'
  const iconProbe = document.createElement('span')
  const fallbackProbe = document.createElement('span')
  const baseStyle = [
    'position:absolute',
    'left:-9999px',
    'top:-9999px',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:nowrap',
    'font-size:48px',
    'line-height:1',
    'letter-spacing:normal',
  ].join(';')

  iconProbe.textContent = sample
  iconProbe.setAttribute(
    'style',
    `${baseStyle};font-family:"${ICON_FONT_FAMILY}";font-feature-settings:"liga";-webkit-font-feature-settings:"liga";`,
  )
  fallbackProbe.textContent = sample
  fallbackProbe.setAttribute('style', `${baseStyle};font-family:Arial,sans-serif;font-feature-settings:normal;`)

  document.body.append(iconProbe, fallbackProbe)
  const iconWidth = iconProbe.getBoundingClientRect().width
  const fallbackWidth = fallbackProbe.getBoundingClientRect().width
  iconProbe.remove()
  fallbackProbe.remove()

  return iconWidth > 0 && fallbackWidth > 0 && iconWidth < fallbackWidth * 0.45
}

async function tryLoadIconFontOnce() {
  const fonts = document.fonts
  if (fonts) {
    await Promise.all(ICON_FONT_SAMPLES.map(sample => fonts.load(ICON_FONT_SPEC, sample)))
    if (!ICON_FONT_SAMPLES.every(sample => fonts.check(ICON_FONT_SPEC, sample))) {
      return false
    }
  } else {
    await waitForDocumentComplete()
  }

  await waitForAnimationFrames()
  return isIconFontVisuallyReady()
}

async function waitForIconFont(timeoutMs: number) {
  const deadline = performance.now() + timeoutMs

  do {
    const attemptTimeout = Math.max(120, Math.min(1000, deadline - performance.now()))
    const ready = await Promise.race([
      tryLoadIconFontOnce().catch(() => false),
      delay(attemptTimeout).then(() => false),
    ])

    if (ready) {
      markIconFontReady()
      return true
    }
    await delay(120)
  } while (performance.now() < deadline)

  return false
}

let iconRetryTimer: number | undefined
function retryIconFontInBackground() {
  if (iconRetryTimer || rootElement.classList.contains('icons-ready')) return

  const retry = async () => {
    iconRetryTimer = undefined
    if (rootElement.classList.contains('icons-ready')) return
    const ready = await waitForIconFont(1500)
    if (!ready) {
      iconRetryTimer = window.setTimeout(retry, 1000)
    }
  }

  iconRetryTimer = window.setTimeout(retry, 1000)
}

async function waitForBootAssets() {
  const fonts = document.fonts
  const iconFontReady = waitForIconFont(7600).then(ready => {
    if (!ready) retryIconFontInBackground()
    return ready
  })

  if (!fonts) {
    await Promise.allSettled([waitForDocumentComplete(), iconFontReady])
    await waitForAnimationFrames()
    return
  }

  const textSamples = ['灵感', '从灵感到画面', '工作区']

  await Promise.allSettled([
    ...textSamples.map(sample => fonts.load('14px "Microsoft YaHei"', sample)),
    waitForImage(BRAND_MARK_SRC),
    waitForDocumentComplete(),
    iconFontReady,
  ])

  await waitForAnimationFrames()
}

function AppBootGate() {
  useEffect(() => {
    let cancelled = false
    const revealIcons = window.setTimeout(() => {
      if (!cancelled) markIconFontReady()
    }, 1800)
    waitForBootAssets()
      .then(() => {
        if (!cancelled) markIconFontReady()
      })
      .catch(() => {
        if (!cancelled) retryIconFontInBackground()
      })

    return () => {
      cancelled = true
      window.clearTimeout(revealIcons)
    }
  }, [])

  return (
    <>
      <App />
      <CloseDialog />
      <TaskCompleteToast />
    </>
  )
}

const reloadScheduled = await recoverStaleBrowserShell()

if (!reloadScheduled) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppBootGate />
      </AppRouter>
    </StrictMode>,
  )
}
