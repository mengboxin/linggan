import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { EditorMode } from '../lib/editor-store'
import { auth, apiUrl } from '../lib/auth'
import { useAuthUser } from '../lib/use-auth-user'
import { fetchBalance, formatCredits } from '../lib/credits'
import { useThemeStore } from '../lib/theme'
import { useI18nStore } from '../lib/i18n'
import { normalizeCreativeStylePreset, type CreativeStylePreset } from '../lib/creative-style-presets'
import {
  DEFAULT_PAYMENT_SETTINGS,
  cancelPayment,
  createPayment,
  fetchPackages,
  fetchPaymentOrders,
  openPaymentWindow,
  queryPaymentStatus,
  resumePayment,
  type CreatePaymentResult,
  type PaymentChannelStatus,
  type PaymentOrder,
  type PaymentSettings,
  type RechargePackage,
  type SubscriptionPlan,
} from '../lib/payment'
import {
  fetchLegalDocument,
  legalAcceptanceClaim,
  type LegalDocumentSnapshot,
} from '../lib/legal'
import { AlipayIcon } from '../components/ui/PaymentIcons'
import MobileAppBar from '../components/Mobile/MobileAppBar'
import MobileModeSwitcher from '../components/Mobile/MobileModeSwitcher'
import MobileModeContentTransition, { MOBILE_MODE_SWITCH_COMMIT_MS } from '../components/Mobile/MobileModeContentTransition'
import MobileBottomNav from '../components/Mobile/MobileBottomNav'
import MobileDrawer from '../components/Mobile/MobileDrawer'
import MobileOnboarding from '../components/Mobile/MobileOnboarding'
import MobileConversationView from '../components/Mobile/MobileConversationView'
import { ComputeSourceDialog } from '../components/ui/ComputeSourceDialog'
import { ExternalComputeStatus } from '../components/ui/ExternalComputeStatus'
import StorageCleanupPage from './StorageCleanupPage'
import { BrandLoadingScreen } from '../components/ui/BrandLoadingScreen'
import { SubscriptionMembershipPanel } from '../features/billing'
import '../components/Mobile/mobile-surface.css'

const MobileTextToImage = lazy(() => import('../components/Mobile/MobileTextToImage'))
const MobileImageRetouch = lazy(() => import('../components/Mobile/MobileImageRetouch'))
const MobileSciFig = lazy(() => import('../components/Mobile/MobileSciFig'))
const MobilePPTGen = lazy(() => import('../components/Mobile/MobilePPTGen'))
const MobilePoster = lazy(() => import('../components/Mobile/MobilePoster'))

const MOBILE_MODE_PATHS: Partial<Record<EditorMode, string>> = {
  TEXT_TO_IMAGE: '/text-to-image',
  IMAGE_EDIT: '/image-edit',
  PPT_GEN: '/ppt',
  SCI_FIG: '/scientific-figure',
  POSTER_GEN: '/poster',
}
const MobileProfile = lazy(() => import('../components/Mobile/MobileProfile'))
const MobilePet = lazy(() => import('../components/Mobile/MobilePet'))
const MOBILE_CREATION_MODES: EditorMode[] = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'PPT_GEN', 'SCI_FIG']
const MOBILE_BOTTOM_TABS = new Set(['generate', 'pet', 'recharge', 'profile'])
type MobileDraftPayload = {
  prompt: string
  draftKey: string
  styleHint?: string
  templateId?: string
  skillId?: string
  skillPreset?: CreativeStylePreset | null
} | null
const MOBILE_ROUTE_MODES = new Set<EditorMode>(MOBILE_CREATION_MODES)

function getRequestedMobileMode(state: unknown): EditorMode | null {
  const value = (state as { mode?: unknown } | null)?.mode
  return typeof value === 'string' && MOBILE_ROUTE_MODES.has(value as EditorMode)
    ? value as EditorMode
    : null
}

function getRequestedRouteText(state: unknown, key: string): string {
  const value = (state as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

function getInitialMobileBottomTab() {
  const stored = localStorage.getItem('mobile-bottom-tab') || 'generate'
  if (stored === 'guide') return 'profile'
  if (stored === 'overview' || stored === 'storage') return 'profile'
  return MOBILE_BOTTOM_TABS.has(stored) ? stored : 'generate'
}

function dedupePackages(packages: RechargePackage[]) {
  const bestByAmount = new Map<number, RechargePackage>()
  for (const pkg of packages) {
    const prev = bestByAmount.get(pkg.amount_yuan)
    if (!prev || pkg.sort_order < prev.sort_order || (pkg.sort_order === prev.sort_order && pkg.bonus_credits > prev.bonus_credits)) {
      bestByAmount.set(pkg.amount_yuan, pkg)
    }
  }
  return Array.from(bestByAmount.values()).sort((a, b) => a.sort_order - b.sort_order || a.amount_yuan - b.amount_yuan)
}

const PAYMENT_SUCCESS_STATUSES = new Set(['paid', 'completed'])
const PAYMENT_TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'expired', 'refunded'])

function formatMobileDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function shortMobileOrderNo(orderNo: string) {
  return orderNo.length > 12 ? `${orderNo.slice(0, 6)}...${orderNo.slice(-4)}` : orderNo
}

function renderMobileCreationMode(
  mode: EditorMode,
  initialConversations: {
    image: { id: string; jobId?: string } | null
    sciFig: { id: string; jobId?: string } | null
    poster: { id: string; jobId?: string } | null
    ppt: { id: string; jobId?: string } | null
  },
  initialDrafts: Partial<Record<EditorMode, MobileDraftPayload>>,
) {
  if (mode === 'TEXT_TO_IMAGE') {
    return <MobileTextToImage initialConversation={initialConversations.image} initialDraft={initialDrafts.TEXT_TO_IMAGE || null} />
  }
  if (mode === 'IMAGE_EDIT') {
    return <MobileImageRetouch />
  }
  if (mode === 'SCI_FIG') {
    return <MobileSciFig initialConversation={initialConversations.sciFig} initialDraft={initialDrafts.SCI_FIG || null} />
  }
  if (mode === 'POSTER_GEN') {
    return <MobilePoster initialConversation={initialConversations.poster} initialDraft={initialDrafts.POSTER_GEN || null} />
  }
  if (mode === 'PPT_GEN') {
    return <MobilePPTGen initialConversation={initialConversations.ppt} initialDraft={initialDrafts.PPT_GEN || null} />
  }
  return null
}

function MobileModuleLoading() {
  return <BrandLoadingScreen inline label="正在准备创作工作台" />
}

function MobileSurfaceBackdrop({ isDark }: { isDark: boolean }) {
  return (
    <div className={`mobile-surface-backdrop ${isDark ? 'mobile-surface-backdrop--dark' : ''}`} aria-hidden="true">
      <img
        src={isDark ? '/creative-library/high-concept-cosmic-vortex.webp' : '/creative-library/gallery-zine-rainy-harbor.webp'}
        alt=""
        loading="lazy"
        decoding="async"
        className="mobile-surface-backdrop__art mobile-surface-backdrop__art--primary"
      />
      <img
        src={isDark ? '/creative-library/high-concept-orbital-forge.webp' : '/creative-library/gallery-poster-citrus-collage.webp'}
        alt=""
        loading="lazy"
        decoding="async"
        className="mobile-surface-backdrop__art mobile-surface-backdrop__art--secondary"
      />
      <span className="mobile-surface-backdrop__ribbon mobile-surface-backdrop__ribbon--one" />
      <span className="mobile-surface-backdrop__ribbon mobile-surface-backdrop__ribbon--two" />
      <div className="mobile-surface-backdrop__wash" />
    </div>
  )
}

export function getMobileTaskInitialConversation(task: {
  conversation_id?: string
  message_id?: string
  job_id?: string
  jobId?: string
}) {
  const conversationId = task.conversation_id?.trim()
  const jobId = task.job_id || task.jobId || task.message_id
  if (!conversationId && !jobId) return null
  return {
    // PPT workspaces can be restored directly by job id. Preserve that path
    // for a just-submitted mobile task before its conversation row arrives.
    id: conversationId || '',
    jobId,
  }
}

export default function MobilePage({ initialMode }: { initialMode?: EditorMode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const authUser = useAuthUser()
  const requestedRouteMode = useMemo(() => initialMode || getRequestedMobileMode(location.state), [initialMode, location.state])
  const requestedDraftPrompt = useMemo(() => getRequestedRouteText(location.state, 'draftPrompt'), [location.state])
  const requestedDraftKey = useMemo(() => getRequestedRouteText(location.state, 'draftKey'), [location.state])
  const requestedPosterStyleHint = useMemo(() => getRequestedRouteText(location.state, 'posterStyleHint'), [location.state])
  const requestedPptTemplateId = useMemo(() => getRequestedRouteText(location.state, 'pptTemplateId'), [location.state])
  const requestedPptStyleHint = useMemo(() => getRequestedRouteText(location.state, 'pptStyleHint'), [location.state])
  const requestedCreativeSkillId = useMemo(() => getRequestedRouteText(location.state, 'creativeSkillId'), [location.state])
  const requestedCreativeSkillPreset = useMemo(
    () => normalizeCreativeStylePreset((location.state as Record<string, unknown> | null)?.creativeSkillPreset),
    [location.state],
  )
  const externalCompute = auth.isExternalComputeUser(authUser)
  const [mode, setMode] = useState<EditorMode>(() => initialMode || (localStorage.getItem('mobile-mode') as EditorMode) || 'TEXT_TO_IMAGE')
  const [bottomTab, setBottomTab] = useState(getInitialMobileBottomTab)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [showComputeSourceDialog, setShowComputeSourceDialog] = useState(false)
  const [viewingConversationId, setViewingConversationId] = useState<string | null>(null)
  const [activeHistoryRecordId, setActiveHistoryRecordId] = useState<string | null>(null)
  const [imageInitialConversation, setImageInitialConversation] = useState<{ id: string; jobId?: string } | null>(null)
  const [posterInitialConversation, setPosterInitialConversation] = useState<{ id: string; jobId?: string } | null>(null)
  const [sciFigInitialConversation, setSciFigInitialConversation] = useState<{ id: string; jobId?: string } | null>(null)
  const [pptInitialConversation, setPptInitialConversation] = useState<{ id: string; jobId?: string } | null>(null)
  const [initialDrafts, setInitialDrafts] = useState<Partial<Record<EditorMode, MobileDraftPayload>>>({})
  const [visibleMode, setVisibleMode] = useState<EditorMode>(() => mode)
  const [switchingMode, setSwitchingMode] = useState<EditorMode | null>(null)
  const [mountedModes, setMountedModes] = useState<Set<EditorMode>>(() => new Set([mode]))
  const [modeSessionKeys, setModeSessionKeys] = useState<Record<string, number>>({})
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const modeScrollInitializedRef = useRef(false)
  const visibleModeRef = useRef<EditorMode>(mode)
  const switchingModeRef = useRef<EditorMode | null>(null)
  const modeSwitchTimerRef = useRef<number | null>(null)
  const navigationStateRef = useRef({
    drawerOpen: false,
    onboardingOpen: false,
    viewingConversationId: null as string | null,
    bottomTab: 'generate',
    mode: 'TEXT_TO_IMAGE' as EditorMode,
  })

  const requestModeChange = useCallback((nextMode: EditorMode, options: { immediate?: boolean } = {}) => {
    setMountedModes(previous => {
      if (previous.has(nextMode)) return previous
      const next = new Set(previous)
      next.add(nextMode)
      return next
    })
    if (modeSwitchTimerRef.current) {
      window.clearTimeout(modeSwitchTimerRef.current)
      modeSwitchTimerRef.current = null
    }
    if (options.immediate || visibleModeRef.current === nextMode) {
      switchingModeRef.current = null
      visibleModeRef.current = nextMode
      setMode(nextMode)
      setVisibleMode(nextMode)
      setSwitchingMode(null)
      return
    }
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    switchingModeRef.current = nextMode
    setSwitchingMode(nextMode)
    modeSwitchTimerRef.current = window.setTimeout(() => {
      if (switchingModeRef.current !== nextMode) {
        modeSwitchTimerRef.current = null
        return
      }
      switchingModeRef.current = null
      visibleModeRef.current = nextMode
      setMode(nextMode)
      setVisibleMode(nextMode)
      setSwitchingMode(null)
      modeSwitchTimerRef.current = null
    }, MOBILE_MODE_SWITCH_COMMIT_MS)
  }, [])

  const startModeSession = useCallback((targetMode: EditorMode) => {
    setModeSessionKeys(previous => ({
      ...previous,
      [targetMode]: (previous[targetMode] || 0) + 1,
    }))
  }, [])

  const handleModeNavigate = useCallback((targetMode: EditorMode) => {
    const path = MOBILE_MODE_PATHS[targetMode]
    if (path && location.pathname !== path) {
      navigate(path)
      return
    }
    requestModeChange(targetMode)
  }, [location.pathname, navigate, requestModeChange])

  useEffect(() => {
    if (!initialMode || visibleModeRef.current === initialMode) return
    requestModeChange(initialMode, { immediate: true })
    setBottomTab('generate')
    localStorage.setItem('mobile-mode', initialMode)
  }, [initialMode, requestModeChange])

  useEffect(() => {
    if (!requestedRouteMode || (!requestedDraftPrompt.trim() && !requestedPptTemplateId.trim() && !requestedCreativeSkillId.trim())) return
    const draftKey = requestedDraftKey || `mobile-gallery:${requestedRouteMode}:${Date.now()}`
    setInitialDrafts(previous => ({
      ...previous,
      [requestedRouteMode]: {
        prompt: requestedDraftPrompt,
        draftKey,
        styleHint: requestedRouteMode === 'PPT_GEN' ? requestedPptStyleHint : requestedPosterStyleHint,
        templateId: requestedRouteMode === 'PPT_GEN' ? requestedPptTemplateId : '',
        skillId: requestedCreativeSkillId,
        skillPreset: requestedCreativeSkillPreset,
      },
    }))
    setViewingConversationId(null)
    setDrawerOpen(false)
    setBottomTab('generate')
    requestModeChange(requestedRouteMode, { immediate: true })
    localStorage.setItem('mobile-bottom-tab', 'generate')
    localStorage.setItem('mobile-mode', requestedRouteMode)
    window.setTimeout(() => mainScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }), 0)
  }, [requestModeChange, requestedCreativeSkillId, requestedCreativeSkillPreset, requestedDraftKey, requestedDraftPrompt, requestedPosterStyleHint, requestedPptStyleHint, requestedPptTemplateId, requestedRouteMode])

  const handleOnboardingNavigate = useCallback(async (target: {
    bottomTab?: 'generate' | 'pet' | 'recharge' | 'profile'
    mode?: EditorMode
  }) => {
    setViewingConversationId(null)
    setDrawerOpen(false)
    if (target.bottomTab) setBottomTab(target.bottomTab)
    if (target.mode) {
      const requiresTransition = visibleModeRef.current !== target.mode
      requestModeChange(target.mode)
      if (requiresTransition) {
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, MOBILE_MODE_SWITCH_COMMIT_MS + 40)
        })
      }
    }
  }, [requestModeChange])

  useEffect(() => () => {
    if (modeSwitchTimerRef.current) window.clearTimeout(modeSwitchTimerRef.current)
    switchingModeRef.current = null
  }, [])

  useEffect(() => {
    localStorage.setItem('mobile-mode', mode)
  }, [mode])

  useEffect(() => {
    if (!modeScrollInitializedRef.current) {
      modeScrollInitializedRef.current = true
      return
    }
    if (bottomTab !== 'generate' || viewingConversationId) return
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [bottomTab, viewingConversationId, visibleMode])

  useEffect(() => {
    localStorage.setItem('mobile-bottom-tab', bottomTab)
  }, [bottomTab])

  useEffect(() => {
    navigationStateRef.current = {
      drawerOpen,
      onboardingOpen,
      viewingConversationId,
      bottomTab,
      mode,
    }
  }, [bottomTab, drawerOpen, mode, onboardingOpen, viewingConversationId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const pushMobileGuard = () => {
      try {
        window.history.pushState({ ...(window.history.state || {}), pixelScribeMobileGuard: true }, '', window.location.href)
      } catch {
        // Browser history is best-effort; the app still works without the guard.
      }
    }

    try {
      window.history.replaceState({ ...(window.history.state || {}), pixelScribeMobileRoot: true }, '', window.location.href)
      pushMobileGuard()
    } catch {
      // Ignore unsupported history state environments.
    }

    const handlePopState = () => {
      if (document.querySelector('[data-image-lightbox="true"]')) return
      const current = navigationStateRef.current
      let handled = false

      if (current.onboardingOpen) {
        setOnboardingOpen(false)
        handled = true
      } else if (current.drawerOpen) {
        setDrawerOpen(false)
        handled = true
      } else if (current.viewingConversationId) {
        setViewingConversationId(null)
        handled = true
      } else if (current.bottomTab !== 'generate') {
        setBottomTab('generate')
        handled = true
      } else if (current.mode !== 'TEXT_TO_IMAGE') {
        requestModeChange('TEXT_TO_IMAGE')
        setImageInitialConversation(null)
        setPosterInitialConversation(null)
        setSciFigInitialConversation(null)
        setPptInitialConversation(null)
        handled = true
      }

      if (handled) window.setTimeout(pushMobileGuard, 0)
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [requestModeChange])

  const handleTabChange = (tab: string) => {
    if (tab === 'gallery') {
      navigate('/gallery')
      return
    }
    setBottomTab(MOBILE_BOTTOM_TABS.has(tab) ? tab : 'generate')
    setViewingConversationId(null)
  }

  const handleTaskSelect = (task: { id: string; type: string; conversation_id?: string; message_id?: string; job_id?: string; jobId?: string }) => {
    const conversationId = task.conversation_id || ''
    const initialConversation = getMobileTaskInitialConversation(task)
    setActiveHistoryRecordId(task.job_id || task.jobId || task.message_id || conversationId || task.id)
    if (task.type === 'image' || task.type === 'image_generation') {
      startModeSession('TEXT_TO_IMAGE')
      setBottomTab('generate')
      requestModeChange('TEXT_TO_IMAGE')
      setViewingConversationId(null)
      setImageInitialConversation(initialConversation)
      setPosterInitialConversation(null)
      setSciFigInitialConversation(null)
      setPptInitialConversation(null)
      localStorage.setItem('mobile-bottom-tab', 'generate')
      localStorage.setItem('mobile-mode', 'TEXT_TO_IMAGE')
      setDrawerOpen(false)
      return
    }
    if (task.type === 'poster' || task.type === 'poster_generation') {
      startModeSession('POSTER_GEN')
      setBottomTab('generate')
      requestModeChange('POSTER_GEN')
      setViewingConversationId(null)
      setImageInitialConversation(null)
      setPosterInitialConversation(initialConversation)
      setSciFigInitialConversation(null)
      setPptInitialConversation(null)
      localStorage.setItem('mobile-bottom-tab', 'generate')
      localStorage.setItem('mobile-mode', 'POSTER_GEN')
      setDrawerOpen(false)
      return
    }
    if (task.type === 'sci-fig' || task.type === 'sci_fig_generation') {
      startModeSession('SCI_FIG')
      setBottomTab('generate')
      requestModeChange('SCI_FIG')
      setViewingConversationId(null)
      setImageInitialConversation(null)
      setPosterInitialConversation(null)
      setSciFigInitialConversation(initialConversation)
      setPptInitialConversation(null)
      localStorage.setItem('mobile-bottom-tab', 'generate')
      localStorage.setItem('mobile-mode', 'SCI_FIG')
      setDrawerOpen(false)
      return
    }
    if (task.type === 'ppt' || task.type === 'ppt_generation') {
      startModeSession('PPT_GEN')
      setBottomTab('generate')
      requestModeChange('PPT_GEN')
      setViewingConversationId(null)
      setImageInitialConversation(null)
      setPosterInitialConversation(null)
      setSciFigInitialConversation(null)
      setPptInitialConversation(initialConversation)
      localStorage.setItem('mobile-bottom-tab', 'generate')
      localStorage.setItem('mobile-mode', 'PPT_GEN')
      setDrawerOpen(false)
      return
    }
    setImageInitialConversation(null)
    setPosterInitialConversation(null)
    setSciFigInitialConversation(null)
    setPptInitialConversation(null)
    setViewingConversationId(conversationId || task.id)
    setDrawerOpen(false)
  }

  return (
    <div
      className={`mobile-product-shell ${isDark ? 'mobile-product-shell--dark' : 'mobile-product-shell--light'}`}
      style={{
        height: '100dvh',
        background: 'var(--bg-color, #0f1415)',
        color: 'var(--text-color, #dee3e4)',
      }}
    >
      <MobileSurfaceBackdrop isDark={isDark} />
      <MobileAppBar
        onMenuOpen={() => setDrawerOpen(true)}
        onHelpOpen={() => setOnboardingOpen(true)}
        onComputeSourceOpen={() => setShowComputeSourceDialog(true)}
      />

      <main ref={mainScrollRef} className="mobile-product-main" style={{ paddingBottom: viewingConversationId ? 0 : 64 }}>
        <div style={{ display: viewingConversationId ? 'none' : 'block' }} aria-hidden={viewingConversationId ? true : undefined}>
          <div style={{ display: bottomTab === 'generate' ? 'block' : 'none' }} aria-hidden={bottomTab === 'generate' ? undefined : true}>
            <div id="mobile-mode-switcher" className="mobile-product-mode-rail">
              <MobileModeSwitcher mode={mode} pendingMode={switchingMode} onChange={handleModeNavigate} />
            </div>
            <MobileModeContentTransition mode={visibleMode} switchingTo={switchingMode}>
              <Suspense fallback={<MobileModuleLoading />}>
                {MOBILE_CREATION_MODES.filter(item => mountedModes.has(item)).map(item => (
                  <div
                    key={`${item}:${modeSessionKeys[item] || 0}`}
                    id={`mobile-mode-${item.toLowerCase().replaceAll('_', '-')}`}
                    data-mobile-mode={item}
                    style={{ display: visibleMode === item ? 'block' : 'none' }}
                    aria-hidden={visibleMode === item ? undefined : true}
                  >
                    {renderMobileCreationMode(item, {
                      image: imageInitialConversation,
                      sciFig: sciFigInitialConversation,
                      poster: posterInitialConversation,
                      ppt: pptInitialConversation,
                    }, initialDrafts)}
                  </div>
                ))}
              </Suspense>
            </MobileModeContentTransition>
          </div>
          {bottomTab === 'recharge' && (
            externalCompute
              ? <MobileExternalComputeMembership />
              : <MobileRechargeInline />
          )}
          {bottomTab === 'pet' && (
            <Suspense fallback={<MobileModuleLoading />}>
              <MobilePet />
            </Suspense>
          )}
          {bottomTab === 'profile' && (
            <Suspense fallback={<MobileModuleLoading />}>
              <MobileProfile onGuideOpen={() => setOnboardingOpen(true)} />
            </Suspense>
          )}
        </div>
        {viewingConversationId && (
          <MobileConversationView conversationId={viewingConversationId} onBack={() => setViewingConversationId(null)} />
        )}
      </main>

      <div id="mobile-bottom-nav">
        <MobileBottomNav activeTab={bottomTab} onChange={handleTabChange} />
      </div>

      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onTaskSelect={handleTaskSelect}
        activeRecordId={activeHistoryRecordId}
      />
      <MobileOnboarding
        open={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        onNavigate={handleOnboardingNavigate}
      />
      <ComputeSourceDialog
        open={showComputeSourceDialog}
        onClose={() => setShowComputeSourceDialog(false)}
      />
    </div>
  )
}

function MobileExternalComputeMembership() {
  return (
    <div className="mobile-compute-workbench mobile-recharge-workbench space-y-4 p-4">
      <ExternalComputeStatus showPlatformWallet />
      <div className="mobile-recharge-membership">
        <SubscriptionMembershipPanel
          variant="mobile"
          statusOnly
          paymentAvailable={false}
        />
      </div>
    </div>
  )
}

function MobileRechargeInline() {
  const navigate = useNavigate()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const { lang } = useI18nStore()
  const [balance, setBalance] = useState<number | null>(null)
  const [packages, setPackages] = useState<RechargePackage[]>([])
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([])
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings>(DEFAULT_PAYMENT_SETTINGS)
  const [channels, setChannels] = useState<Record<string, PaymentChannelStatus>>({})
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [selectedPkg, setSelectedPkg] = useState<RechargePackage | null>(null)
  const [activePayment, setActivePayment] = useState<CreatePaymentResult | null>(null)
  const [pollingOrder, setPollingOrder] = useState<string | null>(null)
  const [resumingOrder, setResumingOrder] = useState<string | null>(null)
  const [cancellingOrder, setCancellingOrder] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [paymentLegalDocument, setPaymentLegalDocument] = useState<LegalDocumentSnapshot | null>(null)
  const [paymentLegalAccepted, setPaymentLegalAccepted] = useState(false)
  const [paymentLegalError, setPaymentLegalError] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [packagesLoadFailed, setPackagesLoadFailed] = useState(false)

  const accent = `var(--app-accent, ${isDark ? '#d4d4d8' : '#FFB74D'})`
  const accentSoft = `var(--app-accent-soft, ${isDark ? 'rgba(212, 212, 216,0.12)' : 'rgba(255,183,77,0.12)'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#2d2a26'})`
  const panelBg = `var(--app-panel, ${isDark ? '#18181b' : '#ede7d9'})`
  const panelSoft = `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.04)' : '#fff8ef'})`
  const textColor = `var(--app-text, ${isDark ? '#f4f4f5' : '#2d2a26'})`
  const mutedColor = `var(--app-muted, ${isDark ? '#a1a1aa' : '#8d8377'})`
  const borderColor = `var(--app-border, ${isDark ? '#3f3f46' : '#d1c7b8'})`
  const dangerColor = isDark ? '#ffb4ab' : '#BA1A1A'
  const successColor = '#4CAF50'

  const refreshOrders = async () => {
    const data = await fetchPaymentOrders(20)
    setOrders(data.orders || [])
    return data.orders || []
  }

  const refreshRechargeData = async (showPackageLoading = false) => {
    fetchBalance().then(setBalance).catch(() => {})
    if (showPackageLoading) setPackagesLoading(true)
    try {
      const data = await fetchPackages()
      setPackages(data.packages || [])
      setSubscriptionPlans(data.subscription_plans || [])
      setChannels(data.channels || {})
      setPaymentSettings({ ...DEFAULT_PAYMENT_SETTINGS, ...(data.settings || {}) })
      setPackagesLoadFailed(false)
    } catch {
      setPackagesLoadFailed(true)
    } finally {
      if (showPackageLoading) setPackagesLoading(false)
    }
    refreshOrders().catch(() => {})
  }

  useEffect(() => {
    void refreshRechargeData(true)
    const refreshFromReturn = () => void refreshRechargeData(false)
    const handleVisibility = () => {
      if (!document.hidden) void refreshRechargeData(false)
    }
    window.addEventListener('focus', refreshFromReturn)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', refreshFromReturn)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchLegalDocument('payment', controller.signal)
      .then(setPaymentLegalDocument)
      .catch(error => {
        if (controller.signal.aborted) return
        setPaymentLegalError(error instanceof Error ? error.message : '付费规则暂时无法加载')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!pollingOrder) return
    const timer = setInterval(async () => {
      try {
        const st = await queryPaymentStatus(pollingOrder)
        if (PAYMENT_SUCCESS_STATUSES.has(st.status)) {
          clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          setMsg({
            type: 'ok',
            text: st.product_kind === 'subscription'
              ? (lang === 'zh'
                  ? `${st.product_name || '会员'}已开通，${st.credits + st.bonus_credits} 积分已到账`
                  : 'Membership activated and credits added')
              : (lang === 'zh' ? `充值成功，已到账 ${st.credits + st.bonus_credits} 积分` : 'Payment successful!'),
          })
          fetchBalance().then(setBalance).catch(() => {})
          refreshOrders().catch(() => {})
        } else if (PAYMENT_TERMINAL_STATUSES.has(st.status)) {
          clearInterval(timer)
          setPollingOrder(null)
          setActivePayment(null)
          setMsg({ type: 'err', text: lang === 'zh' ? '订单未完成或已取消' : 'Order was not completed' })
          refreshOrders().catch(() => {})
        }
      } catch {
        // keep polling
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [lang, pollingOrder])

  const dedupedPackages = useMemo(() => dedupePackages(packages), [packages])
  const zpayAvailable = !!channels.zpay?.available
  const pendingOrders = useMemo(() => orders.filter(order => order.status === 'pending'), [orders])
  const pendingSubscriptionOrder = useMemo(
    () => pendingOrders.find(order => order.product_kind === 'subscription') || null,
    [pendingOrders],
  )
  const activeOrder = useMemo(
    () =>
      (activePayment ? pendingOrders.find(order => order.order_no === activePayment.order_no) : null) ||
      pendingOrders[0] ||
      null,
    [activePayment, pendingOrders],
  )
  const pendingLimitReached = pendingOrders.length >= paymentSettings.max_pending_orders
  const payDisabled = creating || packagesLoading || packagesLoadFailed || !zpayAvailable || pendingLimitReached

  useEffect(() => {
    if (!dedupedPackages.length) {
      setSelectedPkg(null)
      return
    }
    setSelectedPkg(current => (
      (current ? dedupedPackages.find(pkg => pkg.id === current.id) : null) || dedupedPackages[0]
    ))
  }, [dedupedPackages])

  const handlePay = async () => {
    if (!selectedPkg || creating) return
    if (!zpayAvailable) {
      setMsg({ type: 'err', text: lang === 'zh' ? '当前支付方式暂未开放，请稍后再试' : 'This payment method is not available right now' })
      return
    }
    if (pendingLimitReached) {
      setMsg({ type: 'err', text: lang === 'zh' ? '请先处理待支付订单，再创建新订单' : 'Please handle pending orders before creating a new one' })
      return
    }
    setPaymentLegalAccepted(false)
    setConfirmOpen(true)
  }

  const handleConfirmPay = async () => {
    if (!selectedPkg || creating || !paymentLegalDocument || !paymentLegalAccepted) return
    setCreating(true)
    setMsg(null)
    try {
      const order = await createPayment(
        selectedPkg.amount_yuan,
        legalAcceptanceClaim(paymentLegalDocument),
        'zpay',
      )
      setActivePayment(order)
      setPollingOrder(order.order_no)
      setConfirmOpen(false)
      openPaymentWindow(order)
      await refreshOrders()
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || (lang === 'zh' ? '创建订单失败，请稍后重试' : 'Failed to create order') })
    } finally {
      setCreating(false)
    }
  }

  const handleResume = async (orderNo: string) => {
    setResumingOrder(orderNo)
    setMsg(null)
    try {
      const payment = await resumePayment(orderNo)
      setActivePayment(payment)
      setPollingOrder(orderNo)
      openPaymentWindow(payment)
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || (lang === 'zh' ? '继续支付失败' : 'Failed to resume payment') })
      refreshOrders().catch(() => {})
    } finally {
      setResumingOrder(null)
    }
  }

  const handleCancel = async (orderNo: string) => {
    setCancellingOrder(orderNo)
    setMsg(null)
    try {
      await cancelPayment(orderNo)
      if (pollingOrder === orderNo) setPollingOrder(null)
      if (activePayment?.order_no === orderNo) setActivePayment(null)
      setOrders(prev => prev.map(order => (
        order.order_no === orderNo
          ? { ...order, status: 'cancelled', cancelled_at: new Date().toISOString() }
          : order
      )))
      setMsg({ type: 'ok', text: lang === 'zh' ? '订单已取消' : 'Order cancelled' })
      await refreshOrders()
    } catch (err: any) {
      setMsg({ type: 'err', text: err?.message || (lang === 'zh' ? '取消订单失败' : 'Failed to cancel order') })
    } finally {
      setCancellingOrder(null)
    }
  }

  return (
    <div className="mobile-compute-workbench mobile-recharge-workbench min-w-0 overflow-x-hidden p-4 space-y-4">
      <ExternalComputeStatus showPlatformWallet />
      <div className="mobile-recharge-membership">
        <SubscriptionMembershipPanel
          variant="mobile"
          subscriptionPlans={subscriptionPlans}
          creditsRatio={paymentSettings.credits_ratio}
          plansLoading={packagesLoading}
          paymentAvailable={zpayAvailable}
          onPaymentCreated={() => { void refreshOrders() }}
          pendingSubscriptionOrder={pendingSubscriptionOrder}
          onPendingOrderChanged={() => refreshOrders()}
          onPaymentComplete={() => void refreshRechargeData(false)}
        />
        <button type="button" onClick={() => navigate('/orders')} className="mt-3 inline-flex w-full items-center justify-center rounded-xl border px-4 py-2.5 text-xs font-bold" style={{ color: accent, borderColor, background: panelBg }}>
          {lang === 'zh' ? '进入订单中心' : 'Open order center'}
        </button>
      </div>

      <div className="mobile-recharge-workbench__section-heading">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: accent }}>
          {lang === 'zh' ? '按量积分' : 'Pay-as-you-go credits'}
        </p>
        <h2 className="mt-1 text-xl font-bold" style={{ color: textColor }}>
          {lang === 'zh' ? '按使用量购买积分' : 'Buy credits as needed'}
        </h2>
        <p className="mt-1 text-xs" style={{ color: mutedColor }}>
          {lang === 'zh'
            ? '不需要会员也可单独补充，已购积分长期有效。'
            : 'Top up without a membership. Purchased credits do not expire.'}
        </p>
      </div>

      <div className="rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs" style={{ color: mutedColor }}>{lang === 'zh' ? '按量积分余额' : 'Pay-as-you-go balance'}</p>
            <p className="mt-1 text-3xl font-bold" style={{ color: accent }}>{balance !== null ? formatCredits(balance) : '--'}</p>
          </div>
          <div className="text-right text-[11px]" style={{ color: mutedColor }}>
            {lang === 'zh' ? `1 元 = ${paymentSettings.credits_ratio} 积分` : `¥1 = ${paymentSettings.credits_ratio} credits`}
          </div>
        </div>
      </div>

      {activeOrder && (
        <div className="mobile-recharge-order min-w-0 overflow-hidden rounded-xl p-4" style={{ background: accentSoft, border: `1px solid ${accent}` }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold" style={{ color: accent }}>
                {activeOrder.product_kind === 'subscription'
                  ? (activeOrder.product_name || (lang === 'zh' ? '待支付会员订单' : 'Pending membership'))
                  : (lang === 'zh' ? '待支付订单' : 'Pending order')}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-lg px-2 py-2" style={{ background: panelSoft }}>
                  <p className="text-[10px]" style={{ color: mutedColor }}>{lang === 'zh' ? '支付金额' : 'Amount'}</p>
                  <p className="mt-0.5 text-sm font-bold" style={{ color: textColor }}>¥{activeOrder.amount_yuan}</p>
                </div>
                <div className="rounded-lg px-2 py-2" style={{ background: panelSoft }}>
                  <p className="text-[10px]" style={{ color: mutedColor }}>{lang === 'zh' ? '到账积分' : 'Credits'}</p>
                  <p className="mt-0.5 text-sm font-bold" style={{ color: accent }}>{activeOrder.credits + activeOrder.bonus_credits}</p>
                </div>
              </div>
              <p className="mt-2 text-[10px] font-mono" style={{ color: mutedColor }} title={activeOrder.order_no}>
                {lang === 'zh' ? '订单 ' : 'Order '}{shortMobileOrderNo(activeOrder.order_no)}
              </p>
              {activeOrder.expires_at && (
                <p className="mt-1 text-[10px]" style={{ color: mutedColor }}>
                  {lang === 'zh' ? '过期时间：' : 'Expires: '}{formatMobileDate(activeOrder.expires_at)}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => handleResume(activeOrder.order_no)}
              disabled={resumingOrder === activeOrder.order_no}
              className="rounded-xl py-2 text-xs font-bold"
              style={{ background: accent, color: onAccent, opacity: resumingOrder === activeOrder.order_no ? 0.65 : 1 }}
            >
              {resumingOrder === activeOrder.order_no ? (lang === 'zh' ? '打开中...' : 'Opening...') : (lang === 'zh' ? '继续支付' : 'Continue')}
            </button>
            <button
              onClick={() => handleCancel(activeOrder.order_no)}
              disabled={cancellingOrder === activeOrder.order_no}
              className="rounded-xl py-2 text-xs font-bold"
              style={{ background: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(186,26,26,0.08)', color: dangerColor, border: `1px solid ${dangerColor}`, opacity: cancellingOrder === activeOrder.order_no ? 0.65 : 1 }}
            >
              {cancellingOrder === activeOrder.order_no ? (lang === 'zh' ? '取消中...' : 'Cancelling...') : (lang === 'zh' ? '取消订单' : 'Cancel')}
            </button>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider" style={{ color: accent }}>
          {lang === 'zh' ? '选择套餐' : 'Select Package'}
        </h3>
        {packagesLoading ? (
          <div className="rounded-xl p-4 text-center text-xs" style={{ background: panelBg, border: `1px solid ${borderColor}`, color: mutedColor }}>
            {lang === 'zh' ? '正在加载套餐与支付通道...' : 'Loading packages and payment channel...'}
          </div>
        ) : packagesLoadFailed ? (
          <div className="rounded-xl p-4 text-center" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <p className="text-xs" style={{ color: mutedColor }}>
              {lang === 'zh' ? '充值配置加载失败，请稍后重试' : 'Failed to load recharge configuration'}
            </p>
            <button
              type="button"
              onClick={() => void refreshRechargeData(true)}
              className="mt-3 rounded-xl px-4 py-2 text-xs font-bold"
              style={{ background: accent, color: onAccent }}
            >
              {lang === 'zh' ? '重新加载' : 'Retry'}
            </button>
          </div>
        ) : dedupedPackages.length === 0 ? (
          <div className="rounded-xl p-4 text-center text-xs" style={{ background: panelBg, border: `1px solid ${borderColor}`, color: mutedColor }}>
            {lang === 'zh' ? '暂无可用充值套餐' : 'No recharge packages available'}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {dedupedPackages.map(pkg => {
              const active = selectedPkg?.id === pkg.id
              return (
                <button
                  key={pkg.id}
                  onClick={() => setSelectedPkg(pkg)}
                  className="min-w-0 overflow-hidden rounded-xl p-3 text-center transition-all"
                  style={{
                    border: `2px solid ${active ? accent : borderColor}`,
                    background: active ? accentSoft : panelBg,
                  }}
                >
                  <p className="text-lg font-bold" style={{ color: textColor }}>{pkg.base_credits + pkg.bonus_credits}</p>
                  <p className="text-[10px]" style={{ color: mutedColor }}>{lang === 'zh' ? '积分' : 'credits'}</p>
                  <p className="mt-1 text-xs font-semibold" style={{ color: accent }}>¥{pkg.amount_yuan}</p>
                  {pkg.bonus_credits > 0 && (
                    <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[9px]" style={{ background: '#4CAF50', color: '#fff' }}>
                      +{pkg.bonus_credits}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {selectedPkg && (
        <button
          onClick={handlePay}
          disabled={payDisabled}
          className="w-full rounded-xl py-3 text-sm font-bold"
          style={{
            background: payDisabled ? borderColor : accent,
            color: payDisabled ? mutedColor : onAccent,
            opacity: payDisabled ? 0.6 : 1,
          }}
        >
          {creating
            ? (lang === 'zh' ? '处理中...' : 'Processing...')
            : packagesLoading
              ? (lang === 'zh' ? '正在确认支付通道...' : 'Checking payment channel...')
            : packagesLoadFailed
              ? (lang === 'zh' ? '配置加载失败' : 'Configuration failed')
            : !zpayAvailable
              ? (lang === 'zh' ? '支付暂不可用' : 'Payment unavailable')
              : pendingLimitReached
                ? (lang === 'zh' ? '请先处理待支付订单' : 'Handle pending order first')
              : `${lang === 'zh' ? '支付宝支付' : 'Pay with Alipay'} ¥${selectedPkg.amount_yuan}`}
        </button>
      )}

      <div className="rounded-xl p-4" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
        <p className="mb-2 text-xs font-bold" style={{ color: mutedColor }}>{lang === 'zh' ? '支付方式' : 'Payment method'}</p>
        <div className="flex items-center gap-3 rounded-xl px-3 py-3" style={{ background: isDark ? 'rgba(212, 212, 216,0.08)' : '#eef6ff', border: '1px solid #1677ff33' }}>
          <AlipayIcon className="h-7 w-7" />
          <div>
            <p className="text-sm font-bold" style={{ color: textColor }}>{lang === 'zh' ? '支付宝支付' : 'Alipay'}</p>
            <p className="text-[10px]" style={{ color: mutedColor }}>
              {packagesLoading
                ? (lang === 'zh' ? '正在确认支付通道...' : 'Checking payment channel...')
                : zpayAvailable
                  ? (lang === 'zh' ? '确认订单后跳转支付宝付款' : 'Opens Alipay after confirmation')
                  : (lang === 'zh' ? '支付通道暂不可用' : 'Payment channel is unavailable')}
            </p>
          </div>
        </div>
      </div>

      {pollingOrder && (
        <div className="rounded-lg p-3 text-center text-xs" style={{ background: accentSoft, color: accent }}>
          {lang === 'zh' ? '等待支付确认，请在新窗口完成付款。' : 'Waiting for payment confirmation.'}
        </div>
      )}

      {!packagesLoading && !packagesLoadFailed && !zpayAvailable && (
        <div
          className="rounded-lg p-3 text-center text-xs"
          style={{
            background: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(186,26,26,0.08)',
            color: isDark ? '#fca5a5' : '#BA1A1A',
          }}
        >
          {lang === 'zh' ? '支付方式暂未开通，充值入口会在可用后自动恢复' : 'Recharge will be available once payment methods are enabled'}
        </div>
      )}

      {msg && (
        <div
          className="rounded-lg p-3 text-center text-xs"
          style={{
            background: msg.type === 'ok' ? 'rgba(76,175,80,0.15)' : '#93000a',
            color: msg.type === 'ok' ? '#4CAF50' : '#ffb4ab',
          }}
        >
          {msg.text}
        </div>
      )}

      {confirmOpen && selectedPkg && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.52)' }}>
          <div className="w-full max-w-sm overflow-hidden rounded-2xl" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
            <div className="flex items-center justify-between border-b p-4" style={{ borderColor }}>
              <div className="flex items-center gap-3">
                <AlipayIcon className="h-8 w-8" />
                <div>
                  <h3 className="text-base font-bold" style={{ color: textColor }}>{lang === 'zh' ? '确认充值订单' : 'Confirm recharge'}</h3>
                  <p className="text-[10px]" style={{ color: mutedColor }}>{lang === 'zh' ? '支付宝支付，成功后自动到账' : 'Alipay, credits arrive automatically'}</p>
                </div>
              </div>
              <button onClick={() => setConfirmOpen(false)} className="rounded-full px-2 py-1 text-xs" style={{ color: mutedColor }}>
                {lang === 'zh' ? '关闭' : 'Close'}
              </button>
            </div>
            <div className="space-y-4 p-4">
              <div className="rounded-xl p-3 text-sm" style={{ background: panelSoft, border: `1px solid ${borderColor}`, color: textColor }}>
                <div className="flex justify-between">
                  <span style={{ color: mutedColor }}>{lang === 'zh' ? '充值金额' : 'Amount'}</span>
                  <strong>¥{selectedPkg.amount_yuan}</strong>
                </div>
                <div className="mt-2 flex justify-between">
                  <span style={{ color: mutedColor }}>{lang === 'zh' ? '到账积分' : 'Credits'}</span>
                  <strong style={{ color: accent }}>{selectedPkg.base_credits + selectedPkg.bonus_credits}</strong>
                </div>
                <div className="mt-2 flex justify-between">
                  <span style={{ color: mutedColor }}>{lang === 'zh' ? '支付方式' : 'Payment'}</span>
                  <span className="inline-flex items-center gap-1 font-bold"><AlipayIcon className="h-4 w-4" />{lang === 'zh' ? '支付宝' : 'Alipay'}</span>
                </div>
              </div>
              <p className="text-[11px] leading-5" style={{ color: mutedColor }}>
                {lang === 'zh'
                  ? '确认后会创建待支付订单并打开支付宝收银台。请不要重复支付同一订单。'
                  : 'After confirmation, an order will be created and Alipay will open. Do not pay the same order twice.'}
              </p>
              <label className="flex items-start gap-2 rounded-xl p-3 text-[11px] leading-5" style={{ background: panelSoft, border: `1px solid ${borderColor}`, color: mutedColor }}>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[var(--app-primary)]"
                  checked={paymentLegalAccepted}
                  disabled={!paymentLegalDocument}
                  onChange={event => setPaymentLegalAccepted(event.target.checked)}
                />
                <span>
                  {lang === 'zh' ? '我已阅读并同意' : 'I have read and agree to the'}{' '}
                  <a href="/payment-terms?from=/recharge" target="_blank" rel="noreferrer" className="font-bold text-[var(--app-primary)]">
                    {lang === 'zh' ? '《付费服务与退款规则》' : 'Paid Services and Refund Rules'}
                  </a>
                  {paymentLegalDocument ? `（${paymentLegalDocument.version}）` : ''}
                </span>
              </label>
              {paymentLegalError && <p className="text-[11px] font-semibold" style={{ color: dangerColor }}>{paymentLegalError}</p>}
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setConfirmOpen(false)} className="rounded-xl py-2 text-xs font-bold" style={{ background: 'transparent', border: `1px solid ${borderColor}`, color: textColor }}>
                  {lang === 'zh' ? '再看看' : 'Back'}
                </button>
                <button onClick={handleConfirmPay} disabled={creating || !paymentLegalDocument || !paymentLegalAccepted} className="rounded-xl py-2 text-xs font-bold disabled:cursor-not-allowed" style={{ background: '#1677ff', color: '#fff', opacity: creating || !paymentLegalAccepted ? 0.65 : 1 }}>
                  {creating ? (lang === 'zh' ? '创建中...' : 'Creating...') : (lang === 'zh' ? '确认支付' : 'Pay')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function MobileProfileRouter() {
  return (
    <MobileShell>
      <MobileProfile />
    </MobileShell>
  )
}

export function MobileRechargeRouter() {
  const user = useAuthUser()
  return (
    <MobileShell>
      {auth.isExternalComputeUser(user)
        ? <MobileExternalComputeMembership />
        : <MobileRechargeInline />}
    </MobileShell>
  )
}

export function MobileDownloadRouter() {
  return (
    <MobileShell>
      <div className="p-4 space-y-4">
        <div className="rounded-xl p-6 text-center" style={{ background: 'var(--panel-color, #1b2122)', border: '1px solid var(--border-color, #3d494b)' }}>
          <span className="material-symbols-outlined mx-auto mb-3 block" style={{ fontSize: 48, color: 'var(--accent-color, #d4d4d8)' }}>download</span>
          <h2 className="mb-2 text-lg font-bold" style={{ color: 'var(--text-color, #dee3e4)' }}>下载桌面客户端</h2>
          <p className="mb-4 text-xs" style={{ color: 'var(--text-color, #dee3e4)', opacity: 0.6 }}>
            桌面端支持桌宠、本地保存、PS 插件等完整能力。
          </p>
          <div className="space-y-2">
            <a href={`${apiUrl('/api/downloads/windows')}`} className="block w-full rounded-xl py-3 text-sm font-bold" style={{ background: 'var(--app-accent, #d4d4d8)', color: 'var(--app-on-accent, #18181b)' }}>
              下载 Windows 版
            </a>
            <a href={`${apiUrl('/api/downloads/macos')}`} className="block w-full rounded-xl py-3 text-sm font-bold" style={{ background: 'transparent', border: '1px solid var(--border-color, #3d494b)', color: 'var(--text-color, #dee3e4)' }}>
              下载 macOS 版
            </a>
          </div>
        </div>
      </div>
    </MobileShell>
  )
}

export function MobileStorageRouter() {
  return <StorageCleanupPage />
}

function MobileShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'
  const { lang, toggle: toggleLang } = useI18nStore()
  const [credits, setCredits] = useState<number | null>(null)
  const accent = 'var(--app-primary)'
  const accentSoft = 'var(--app-primary-soft)'
  const mutedColor = 'var(--app-muted)'

  useEffect(() => {
    fetchBalance().then(setCredits).catch(() => {})
  }, [])

  return (
    <div className={`mobile-product-shell ${isDark ? 'mobile-product-shell--dark' : 'mobile-product-shell--light'}`} style={{ height: '100dvh', background: 'var(--app-bg, #09090b)', color: 'var(--app-text, #f4f4f5)' }}>
      <MobileSurfaceBackdrop isDark={isDark} />
      <header
        className="mobile-product-appbar relative z-50 flex h-12 flex-shrink-0 items-center justify-between border-b px-3 backdrop-blur-xl"
        style={{
          background: 'var(--app-glass, rgba(24,24,27,0.92))',
          borderColor: 'var(--app-border, rgba(255,255,255,0.1))',
        }}
      >
        <button onClick={() => navigate(-1)} className="mobile-product-appbar__icon-button flex h-8 w-8 items-center justify-center" style={{ color: accent }} aria-label="返回">
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>arrow_back</span>
        </button>
        <div className="flex items-center gap-2">
          {credits !== null && (
            <div className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: accentSoft, color: accent }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>monetization_on</span>
              {formatCredits(credits)}
            </div>
          )}
          <button onClick={toggleLang} className="mobile-product-appbar__credits rounded px-2 py-0.5 text-[11px] font-bold" style={{ border: '1px solid var(--border-color, #3d494b)', color: mutedColor }}>
            {lang.toUpperCase()}
          </button>
          <button onClick={toggleTheme} className="mobile-product-appbar__icon-button flex h-8 w-8 items-center justify-center" style={{ color: accent }} aria-label="切换主题">
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{isDark ? 'light_mode' : 'dark_mode'}</span>
          </button>
        </div>
      </header>
      <main className="mobile-product-main">{children}</main>
    </div>
  )
}
