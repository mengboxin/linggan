import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { Pin, PinOff } from 'lucide-react'
import { useI18nStore } from '../../lib/i18n'
import { TOPBAR_COLLAPSED_EVENT, useTopbarPreferenceStore } from '../../lib/topbar-preference'
import { useTourStore } from '../OnboardingTour'
import './floating-topbar.css'

const DESKTOP_HOVER_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 641px)'
const HIDE_DELAY_MS = 280

type FloatingTopBarContextValue = {
  floatingEnabled: boolean
  pinned: boolean
  setPinned: (pinned: boolean) => void
}

type TopbarLayoutStyle = CSSProperties & {
  '--app-topbar-height': string
  '--floating-topbar-height': string
}

const FloatingTopBarContext = createContext<FloatingTopBarContextValue | null>(null)

function useDesktopHoverCapability() {
  const read = () => {
    if (typeof window === 'undefined') return false
    if (typeof window.matchMedia !== 'function') return window.innerWidth >= 641
    return window.matchMedia(DESKTOP_HOVER_QUERY).matches
  }
  const [enabled, setEnabled] = useState(read)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DESKTOP_HOVER_QUERY)
    const update = () => setEnabled(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return enabled
}

export type FloatingTopBarProps = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  children: ReactNode
  height?: number
  forceVisible?: boolean
}

export function FloatingTopBar({
  children,
  className = '',
  height = 48,
  forceVisible = false,
  style,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
  ...props
}: FloatingTopBarProps) {
  const pinned = useTopbarPreferenceStore(state => state.pinned)
  const setPinned = useTopbarPreferenceStore(state => state.setPinned)
  const syncFromStorage = useTopbarPreferenceStore(state => state.syncFromStorage)
  const tourActive = useTourStore(state => state.isActive)
  const floatingEnabled = useDesktopHoverCapability()
  const [transientVisible, setTransientVisible] = useState(false)
  const [keyboardFocusWithin, setKeyboardFocusWithin] = useState(false)
  const pointerSourcesRef = useRef({ revealZone: false, topbar: false })
  const keyboardFocusWithinRef = useRef(false)
  const keyboardModeRef = useRef(false)
  const hideTimerRef = useRef<number | null>(null)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }, [])

  const scheduleHide = useCallback(() => {
    clearHideTimer()
    if (!floatingEnabled || pinned || forceVisible || tourActive) return
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      const pointerInside = pointerSourcesRef.current.revealZone || pointerSourcesRef.current.topbar
      if (!pointerInside && !keyboardFocusWithinRef.current) {
        setTransientVisible(false)
        window.dispatchEvent(new Event(TOPBAR_COLLAPSED_EVENT))
      }
    }, HIDE_DELAY_MS)
  }, [clearHideTimer, floatingEnabled, forceVisible, pinned, tourActive])

  useEffect(() => {
    const markKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Tab') keyboardModeRef.current = true
    }
    const markPointer = () => { keyboardModeRef.current = false }
    const syncPreference = (event: StorageEvent) => {
      if (event.key === null || event.key === 'linggan.topbar-pinned.v1') syncFromStorage()
    }
    window.addEventListener('keydown', markKeyboard, true)
    window.addEventListener('pointerdown', markPointer, true)
    window.addEventListener('storage', syncPreference)
    return () => {
      window.removeEventListener('keydown', markKeyboard, true)
      window.removeEventListener('pointerdown', markPointer, true)
      window.removeEventListener('storage', syncPreference)
    }
  }, [syncFromStorage])

  useEffect(() => clearHideTimer, [clearHideTimer])

  useEffect(() => {
    if (!floatingEnabled || pinned || forceVisible || tourActive) {
      clearHideTimer()
      setTransientVisible(false)
      keyboardFocusWithinRef.current = false
      setKeyboardFocusWithin(false)
    }
  }, [clearHideTimer, floatingEnabled, forceVisible, pinned, tourActive])

  const visible = !floatingEnabled || pinned || forceVisible || tourActive || transientVisible || keyboardFocusWithin
  const contextValue = useMemo(() => ({ floatingEnabled, pinned, setPinned }), [floatingEnabled, pinned, setPinned])
  const componentStyle = {
    ...style,
    '--app-topbar-height': `${height}px`,
    '--floating-topbar-height': `${height}px`,
  } as TopbarLayoutStyle

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    pointerSourcesRef.current.topbar = true
    pointerSourcesRef.current.revealZone = false
    pointerSourcesRef.current.revealZone = false
    clearHideTimer()
    setTransientVisible(true)
    onPointerEnter?.(event)
  }

  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    pointerSourcesRef.current.topbar = false
    scheduleHide()
    onPointerLeave?.(event)
  }

  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    if (keyboardModeRef.current) {
      clearHideTimer()
      keyboardFocusWithinRef.current = true
      setKeyboardFocusWithin(true)
      setTransientVisible(true)
    }
    onFocusCapture?.(event)
  }

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget as Node | null
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      keyboardFocusWithinRef.current = false
      setKeyboardFocusWithin(false)
      if (!pointerSourcesRef.current.revealZone && !pointerSourcesRef.current.topbar) scheduleHide()
    }
    onBlurCapture?.(event)
  }

  return (
    <FloatingTopBarContext.Provider value={contextValue}>
      {!pinned && floatingEnabled && (
        <div
          className="floating-topbar-reveal-zone"
          data-testid="topbar-reveal-zone"
          aria-hidden="true"
          onPointerEnter={() => {
            pointerSourcesRef.current.revealZone = true
            clearHideTimer()
            setTransientVisible(true)
          }}
          onPointerLeave={() => {
            pointerSourcesRef.current.revealZone = false
            scheduleHide()
          }}
        >
          <span />
        </div>
      )}
      <header
        {...props}
        className={`floating-topbar ${className}`.trim()}
        style={componentStyle}
        data-testid="floating-topbar"
        data-floating-enabled={floatingEnabled ? 'true' : 'false'}
        data-pinned={pinned ? 'true' : 'false'}
        data-visible={visible ? 'true' : 'false'}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
      >
        {children}
      </header>
    </FloatingTopBarContext.Provider>
  )
}

type TopBarPinButtonProps = {
  className?: string
  pinnedLabel?: string
  floatingLabel?: string
}

export function TopBarPinButton({ className = '', pinnedLabel, floatingLabel }: TopBarPinButtonProps) {
  const context = useContext(FloatingTopBarContext)
  const fallbackPinned = useTopbarPreferenceStore(state => state.pinned)
  const fallbackSetPinned = useTopbarPreferenceStore(state => state.setPinned)
  const { lang } = useI18nStore()
  const pinned = context?.pinned ?? fallbackPinned
  const setPinned = context?.setPinned ?? fallbackSetPinned
  const floatingEnabled = context?.floatingEnabled ?? true
  const label = pinned
    ? (pinnedLabel || (lang === 'zh' ? '取消固定顶栏' : 'Use floating top bar'))
    : (floatingLabel || (lang === 'zh' ? '固定顶栏' : 'Pin top bar'))

  if (!floatingEnabled) return null

  return (
    <button
      type="button"
      className={`topbar-pin-button ${className}`.trim()}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={event => {
        const topbar = event.currentTarget.closest<HTMLElement>('[data-testid="floating-topbar"]')
        setPinned(!pinned)
        if (pinned) {
          event.currentTarget.blur()
          window.requestAnimationFrame(() => {
            if (topbar?.matches(':hover')) return
            window.dispatchEvent(new Event(TOPBAR_COLLAPSED_EVENT))
          })
        }
      }}
    >
      {pinned ? <Pin size={16} aria-hidden="true" /> : <PinOff size={16} aria-hidden="true" />}
    </button>
  )
}
