import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { AUTH_CHANGED_EVENT, auth } from './lib/auth'
import { eventStream } from './lib/event-stream'
import { OnboardingManual, OnboardingTour } from './components/OnboardingTour'
import { navigateRoute } from './lib/navigation'
import { DesktopUpdateOverlay } from './components/DesktopUpdateOverlay'
import { ThemeTransition } from './components/ui/ThemeTransition'
import { CreativeArtworkRotator } from './components/ui/CreativeArtworkRotator'
import type { EditorMode } from './lib/editor-store'
import { loadProfileRoute, preloadPrimaryCreationRoutes, preloadProfileRoute } from './lib/route-preload'
import { BrandLoadingScreen } from './components/ui/BrandLoadingScreen'
import { startTaskEventSync } from './lib/task-event-sync'
import { isElectron } from './lib/electron'
import LegalReconsentGate from './components/LegalReconsentGate'
import { useConfirm } from './components/ui/ConfirmDialog'
import { INSUFFICIENT_CREDITS_EVENT, type InsufficientCreditsDetail } from './lib/credits'

const LoginPage = lazy(() => import('./pages/LoginPage'))
const EditorPage = lazy(() => import('./pages/EditorPage'))
const ModelsPage = lazy(() => import('./pages/ModelsPage'))
const ProfilePage = lazy(loadProfileRoute)
const RechargePage = lazy(() => import('./pages/RechargePage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const PublicGalleryPage = lazy(() => import('./pages/PublicGalleryPage'))
const ImagePromptPage = lazy(() => import('./pages/ImagePromptPage'))
const CanvasFlowPage = lazy(() => import('./pages/CanvasFlowPage'))
const DownloadPage = lazy(() => import('./pages/DownloadPage'))
const PsPluginSetupPage = lazy(() => import('./pages/PsPluginSetupPage'))
const TermsPage = lazy(() => import('./pages/TermsPage'))
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'))
const AiDisclaimerPage = lazy(() => import('./pages/AiDisclaimerPage'))
const PaymentTermsPage = lazy(() => import('./pages/PaymentTermsPage'))
const MobilePage = lazy(() => import('./pages/MobilePage'))
const PPTPresentationPage = lazy(() => import('./pages/PPTPresentationPage'))
const MobileProfileRouter = lazy(() => import('./pages/MobilePage').then(module => ({ default: module.MobileProfileRouter })))
const MobileRechargeRouter = lazy(() => import('./pages/MobilePage').then(module => ({ default: module.MobileRechargeRouter })))
const MobileDownloadRouter = lazy(() => import('./pages/MobilePage').then(module => ({ default: module.MobileDownloadRouter })))
const DesktopPetBridge = lazy(() => import('./components/DesktopPetBridge').then(module => ({ default: module.DesktopPetBridge })))

/** 视口断点：小于此宽度渲染移动端页面 */
const MOBILE_BREAKPOINT = 640
const PUBLIC_LANDING_ROUTE = '/login'

/** 根据视口宽度自动切换移动端/桌面端 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return isMobile
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionValid, setSessionValid] = useState(() => auth.isLoggedIn())

  useEffect(() => {
    let cancelled = false
    if (!auth.isLoggedIn()) {
      setSessionValid(false)
      setSessionReady(true)
      return
    }
    void auth.ensureAccessSession().then(valid => {
      if (cancelled) return
      setSessionValid(valid)
      setSessionReady(true)
    })
    return () => { cancelled = true }
  }, [])
  if (!sessionReady) return <RouteLoading />
  if (!sessionValid || !auth.isLoggedIn()) return <Navigate to="/login?auth=1" replace />
  return <>{children}</>
}

function App() {
  const isMobile = useIsMobile()
  const location = useLocation()

  useEffect(() => startTaskEventSync(), [])

  useEffect(() => {
    if (!auth.isLoggedIn()) return
    preloadProfileRoute()
    const timer = window.setTimeout(preloadPrimaryCreationRoutes, 900)
    return () => window.clearTimeout(timer)
  }, [location.pathname])

  useEffect(() => {
    const ensureSession = async (forceUserSync = false) => {
      if (!auth.isLoggedIn()) {
        eventStream.stop()
        return false
      }
      const valid = await auth.ensureValidSession(forceUserSync)
      if (!valid) {
        eventStream.stop()
        return false
      }
      if (isElectron() || document.visibilityState === 'visible') {
        eventStream.start()
      } else {
        eventStream.stop()
      }
      return true
    }

    void ensureSession()

    const authChangedHandler = () => {
      void ensureSession(true)
    }
    const focusHandler = () => {
      if (document.visibilityState === 'visible') void ensureSession(true)
    }
    const authStorageHandler = (event: StorageEvent) => {
      if (event.key && !['lg_access_token', 'lg_refresh_token', 'lg_user', 'pixelscribe-auth-session-started-at'].includes(event.key)) return
      if (auth.isLoggedIn()) {
        void ensureSession()
      } else {
        eventStream.stop()
        if (window.location.pathname !== '/login') {
          navigateRoute('/login?auth=1', { replace: true })
        }
      }
    }
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') {
        if (!isElectron()) eventStream.stop()
        return
      }
      void ensureSession()
    }
    window.addEventListener(AUTH_CHANGED_EVENT, authChangedHandler)
    window.addEventListener('storage', authStorageHandler)
    window.addEventListener('focus', focusHandler)
    document.addEventListener('visibilitychange', visibilityHandler)
    const tokenCheckInterval = setInterval(() => {
      void ensureSession()
    }, 60_000)
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, authChangedHandler)
      window.removeEventListener('storage', authStorageHandler)
      window.removeEventListener('focus', focusHandler)
      document.removeEventListener('visibilitychange', visibilityHandler)
      eventStream.stop()
      clearInterval(tokenCheckInterval)
    }
  }, [])

  return (
    <>
      {isElectron() && <Suspense fallback={null}><DesktopPetBridge /></Suspense>}
      {auth.isLoggedIn() && <CreativeArtworkRotator />}
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/" element={<Navigate to={PUBLIC_LANDING_ROUTE} replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/ai-disclaimer" element={<AiDisclaimerPage />} />
          <Route path="/payment-terms" element={<PaymentTermsPage />} />
          <Route path="/editor" element={<RequireAuth><EditorRouteSwitcher /></RequireAuth>} />
          <Route path="/text-to-image" element={<RequireAuth><EditorModeRoute mode="TEXT_TO_IMAGE" /></RequireAuth>} />
          <Route path="/image-edit" element={<RequireAuth><EditorModeRoute mode="IMAGE_EDIT" /></RequireAuth>} />
          <Route path="/ppt" element={<RequireAuth><EditorModeRoute mode="PPT_GEN" /></RequireAuth>} />
          <Route path="/scientific-figure" element={<RequireAuth><EditorModeRoute mode="SCI_FIG" /></RequireAuth>} />
          <Route path="/poster" element={<RequireAuth><EditorModeRoute mode="POSTER_GEN" /></RequireAuth>} />
          <Route path="/paper-lab" element={<RequireAuth><PaperLabRoute /></RequireAuth>} />
          <Route path="/models" element={<RequireAuth><ModelsPage /></RequireAuth>} />
          <Route path="/profile" element={<RequireAuth><ProfileRouteSwitcher /></RequireAuth>} />
          <Route path="/recharge" element={<RequireAuth><RechargeRouteSwitcher /></RequireAuth>} />
          <Route path="/orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
          <Route path="/gallery" element={<RequireAuth><PublicGalleryPage /></RequireAuth>} />
          <Route path="/image-to-prompt" element={<RequireAuth><ImagePromptPage /></RequireAuth>} />
          <Route path="/canvas-flow" element={<RequireAuth><CanvasFlowRoute /></RequireAuth>} />
          <Route path="/presentations" element={<RequireAuth><PPTPresentationPage /></RequireAuth>} />
          <Route path="/storage-cleanup" element={<Navigate to="/text-to-image" replace />} />
          <Route path="/download" element={<DownloadRouteSwitcher />} />
          <Route path="/ps-plugin-setup" element={<RequireAuth><PsPluginSetupPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to={PUBLIC_LANDING_ROUTE} replace />} />
        </Routes>
      </Suspense>
      {auth.isLoggedIn() && !isMobile && <OnboardingTour />}
      {auth.isLoggedIn() && <OnboardingManual />}
      <DesktopUpdateOverlay />
      <ThemeTransition />
      <LegalReconsentGate />
      <InsufficientCreditsDialog />
    </>
  )
}

function InsufficientCreditsDialog() {
  const { confirmDialog, confirm } = useConfirm()
  const dialogOpenRef = useRef(false)

  const handleInsufficientCredits = useCallback((event: Event) => {
    const detail = (event as CustomEvent<InsufficientCreditsDetail>).detail
    if (
      dialogOpenRef.current
      || !detail
      || !Number.isFinite(detail.cost)
      || !Number.isFinite(detail.balance)
    ) return

    dialogOpenRef.current = true
    void confirm({
      title: '积分不足',
      message: `本次创作需要 ${detail.cost} 积分，当前可用 ${detail.balance} 积分`,
      confirmText: '去充值',
      cancelText: '暂不',
    }).then(shouldRecharge => {
      if (shouldRecharge) navigateRoute('/recharge')
    }).finally(() => {
      dialogOpenRef.current = false
    })
  }, [confirm])

  useEffect(() => {
    window.addEventListener(INSUFFICIENT_CREDITS_EVENT, handleInsufficientCredits)
    return () => window.removeEventListener(INSUFFICIENT_CREDITS_EVENT, handleInsufficientCredits)
  }, [handleInsufficientCredits])

  return confirmDialog
}

function RouteLoading() {
  return <BrandLoadingScreen />
}

function EditorRouteSwitcher() {
  const isMobile = useIsMobile()
  return isMobile ? <MobilePage /> : <EditorPage />
}

function EditorModeRoute({ mode }: { mode: EditorMode }) {
  const isMobile = useIsMobile()
  const mobileModes: EditorMode[] = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'PPT_GEN', 'SCI_FIG', 'POSTER_GEN']
  if (isMobile && mobileModes.includes(mode)) return <MobilePage initialMode={mode} />
  return <EditorPage initialMode={mode} />
}

export function CanvasFlowRoute() {
  const isMobile = useIsMobile()
  return isMobile ? <Navigate to="/text-to-image" replace /> : <CanvasFlowPage />
}

function PaperLabRoute() {
  return <EditorPage initialMode="PAPER_GEN" />
}

function ProfileRouteSwitcher() {
  const isMobile = useIsMobile()
  return isMobile ? <MobileProfileRouter /> : <ProfilePage />
}

function RechargeRouteSwitcher() {
  const isMobile = useIsMobile()
  return isMobile ? <MobileRechargeRouter /> : <RechargePage />
}

function DownloadRouteSwitcher() {
  const isMobile = useIsMobile()
  return isMobile ? <MobileDownloadRouter /> : <DownloadPage />
}

export default App
