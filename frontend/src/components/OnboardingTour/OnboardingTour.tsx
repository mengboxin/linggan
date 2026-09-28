import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useEditorStore } from '../../lib/editor-store'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import * as guideCatalogModule from './guide-catalog'
import * as tourStepsModule from './tour-steps'
import { useTourStore } from './tour-store'
import './onboarding-tour.css'

type Language = 'zh' | 'en'
type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center'
type LocalizedText = string | { zh?: string; en?: string }

interface TourParameterItem {
  id?: string
  title?: LocalizedText
  label?: LocalizedText
  name?: LocalizedText
  description?: LocalizedText
  detail?: LocalizedText
  value?: LocalizedText
}

interface CompatibleTourStep {
  id: string
  targetSelector?: string | null
  fallbackSelector?: string
  placement?: Placement
  title?: LocalizedText
  description?: LocalizedText
  tip?: LocalizedText
  chapter?: LocalizedText
  chapterTitle?: LocalizedText
  objective?: LocalizedText
  parameterId?: string
  parameterItems?: readonly (TourParameterItem | LocalizedText)[]
  requiredMode?: Parameters<ReturnType<typeof useEditorStore.getState>['setMode']>[0]
  ensurePanels?: readonly ('left' | 'right')[]
  navigateTo?: string
  allowMissingTarget?: boolean
  optional?: boolean
}

interface CompatibleGuideParameter {
  id: string
  title: LocalizedText
  description: LocalizedText
}

interface CompatibleGuideChapter {
  id: string
  title: LocalizedText
  outcome?: LocalizedText
  parameters?: readonly CompatibleGuideParameter[]
}

interface CompatibleTourStore {
  isActive: boolean
  currentStepIndex: number
  activeChapterId?: string
  nextStep: () => void
  prevStep: () => void
  skipTour: () => void
  openManual?: (chapterId?: string) => void
}

interface TooltipPosition {
  top: number
  left: number
  placement: Placement
}

const SPOTLIGHT_PADDING = 9
const TOOLTIP_GAP = 18
const VIEWPORT_MARGIN = 18
const TARGET_RETRY_DELAYS = [80, 180, 360, 700, 1200, 2000]

const FALLBACK_CHAPTER_TITLES: Record<string, { zh: string; en: string }> = {
  overview: { zh: '平台总览', en: 'Platform overview' },
  compute: { zh: '算力与模型', en: 'Compute and models' },
  'text-to-image': { zh: '文生图', en: 'Text to Image' },
  'image-edit-workflow': { zh: '图片编辑工作流', en: 'Image-edit workflow' },
  'image-retouch': { zh: '单图精修', en: 'Image retouch' },
  'prompt-lens': { zh: '灵感反推', en: 'Prompt Lens' },
  poster: { zh: '海报设计', en: 'Poster design' },
  'scientific-figure': { zh: '科研生图', en: 'Scientific figures' },
  'ppt-generation': { zh: 'PPT 生成', en: 'PPT generation' },
  'ppt-presentation': { zh: '演示与播放', en: 'Presentation' },
  'canvas-flow': { zh: '自由画布', en: 'Canvas flow' },
  gallery: { zh: '灵感广场', en: 'Creation gallery' },
  'inspiration-recipes': { zh: '灵感配方', en: 'Inspiration recipes' },
  workspace: { zh: '灵感中心', en: 'Inspiration Hub' },
  account: { zh: '个人中心', en: 'Account' },
  download: { zh: '桌面端与下载', en: 'Desktop and downloads' },
}

function localize(value: LocalizedText | null | undefined, lang: Language): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  return (lang === 'zh' ? value.zh || value.en : value.en || value.zh) || ''
}

function isElementVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = element.getBoundingClientRect()
  return rect.width >= 2 && rect.height >= 2
}

function queryVisibleElement(selector?: string | null): HTMLElement | null {
  if (!selector) return null
  try {
    const candidates = document.querySelectorAll<HTMLElement>(selector)
    return Array.from(candidates).find(isElementVisible) ?? null
  } catch {
    return null
  }
}

function hasMeaningfullyChanged(previous: DOMRect | null, next: DOMRect): boolean {
  if (!previous) return true
  return Math.abs(previous.top - next.top) > 0.5
    || Math.abs(previous.left - next.left) > 0.5
    || Math.abs(previous.width - next.width) > 0.5
    || Math.abs(previous.height - next.height) > 0.5
}

function viewportBounds() {
  const viewport = window.visualViewport
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

function getTooltipPosition(
  target: DOMRect | null,
  requestedPlacement: Placement,
  tooltipWidth: number,
  tooltipHeight: number,
): TooltipPosition {
  const viewport = viewportBounds()
  const minLeft = viewport.left + VIEWPORT_MARGIN
  const minTop = viewport.top + VIEWPORT_MARGIN
  const maxLeft = viewport.left + viewport.width - tooltipWidth - VIEWPORT_MARGIN
  const maxTop = viewport.top + viewport.height - tooltipHeight - VIEWPORT_MARGIN

  if (!target || requestedPlacement === 'center') {
    return {
      top: Math.max(minTop, minTop + (Math.max(0, viewport.height - tooltipHeight - VIEWPORT_MARGIN * 2) / 2)),
      left: Math.max(minLeft, minLeft + (Math.max(0, viewport.width - tooltipWidth - VIEWPORT_MARGIN * 2) / 2)),
      placement: 'center',
    }
  }

  const spaces: Record<Exclude<Placement, 'center'>, number> = {
    top: target.top - viewport.top,
    bottom: viewport.top + viewport.height - target.bottom,
    left: target.left - viewport.left,
    right: viewport.left + viewport.width - target.right,
  }
  const opposite: Record<Exclude<Placement, 'center'>, Exclude<Placement, 'center'>> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  }
  const preferred = requestedPlacement
  const requiredSpace = (preferred === 'top' || preferred === 'bottom' ? tooltipHeight : tooltipWidth) + TOOLTIP_GAP + VIEWPORT_MARGIN
  const placement = spaces[preferred] >= requiredSpace
    ? preferred
    : spaces[opposite[preferred]] > spaces[preferred]
      ? opposite[preferred]
      : preferred

  let top = target.top + (target.height - tooltipHeight) / 2
  let left = target.left + (target.width - tooltipWidth) / 2
  if (placement === 'top') top = target.top - tooltipHeight - TOOLTIP_GAP
  if (placement === 'bottom') top = target.bottom + TOOLTIP_GAP
  if (placement === 'left') left = target.left - tooltipWidth - TOOLTIP_GAP
  if (placement === 'right') left = target.right + TOOLTIP_GAP

  return {
    top: Math.min(Math.max(minTop, top), Math.max(minTop, maxTop)),
    left: Math.min(Math.max(minLeft, left), Math.max(minLeft, maxLeft)),
    placement,
  }
}

function normalizeParameterItem(item: TourParameterItem | LocalizedText, lang: Language, index: number) {
  if (typeof item === 'string' || ('zh' in item || 'en' in item)) {
    return { id: `parameter-${index}`, title: localize(item as LocalizedText, lang), description: '' }
  }
  const parameter = item as TourParameterItem
  const title = localize(parameter.title ?? parameter.label ?? parameter.name, lang)
  const description = localize(parameter.description ?? parameter.detail ?? parameter.value, lang)
  return { id: parameter.id ?? `parameter-${index}`, title, description }
}

export default function OnboardingTour() {
  const tourStore = useTourStore() as CompatibleTourStore
  const {
    isActive,
    currentStepIndex,
    nextStep,
    prevStep,
    skipTour,
    openManual,
  } = tourStore
  const activeChapterId = tourStore.activeChapterId || 'overview'
  const { theme } = useThemeStore()
  const { lang: appLanguage } = useI18nStore()
  const lang: Language = appLanguage === 'zh' ? 'zh' : 'en'
  const { setMode } = useEditorStore()
  const location = useLocation()
  const navigate = useNavigate()

  const chapters = ((guideCatalogModule as unknown as { GUIDE_CHAPTERS?: readonly CompatibleGuideChapter[] }).GUIDE_CHAPTERS ?? [])
  const chapter = chapters.find(item => item.id === activeChapterId)
  const getChapterSteps = (tourStepsModule as unknown as {
    getTourStepsForChapter?: (chapterId: string) => readonly CompatibleTourStep[]
  }).getTourStepsForChapter
  const legacySteps = ((tourStepsModule as unknown as { TOUR_STEPS?: readonly CompatibleTourStep[] }).TOUR_STEPS ?? [])
  const steps = useMemo(() => {
    if (!getChapterSteps) return legacySteps
    try {
      return getChapterSteps(activeChapterId) || legacySteps
    } catch {
      return legacySteps
    }
  }, [activeChapterId, getChapterSteps, legacySteps])
  const step = steps[Math.min(Math.max(0, currentStepIndex), Math.max(0, steps.length - 1))]

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null)
  const [targetStatus, setTargetStatus] = useState<'ready' | 'locating' | 'found' | 'missing'>('ready')
  const [tooltipSize, setTooltipSize] = useState({ width: 420, height: 420 })
  const [entered, setEntered] = useState(false)
  const tooltipRef = useRef<HTMLElement>(null)
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const transferringFocusToManualRef = useRef(false)
  const hasScrolledRef = useRef(false)
  const scheduledFrameRef = useRef<number | null>(null)

  const updateTargetRect = useCallback((element: HTMLElement) => {
    const nextRect = element.getBoundingClientRect()
    setTargetRect(previous => hasMeaningfullyChanged(previous, nextRect) ? nextRect : previous)
  }, [])

  const expandRequiredPanels = useCallback(() => {
    step?.ensurePanels?.forEach(panel => {
      window.dispatchEvent(new CustomEvent('tour-expand-panel', { detail: { panel } }))
    })
  }, [step?.ensurePanels])

  const locateTarget = useCallback((markMissing = false, scrollToTarget = false) => {
    if (!step?.targetSelector) {
      setTargetElement(null)
      setTargetRect(null)
      setTargetStatus('ready')
      return true
    }

    const element = queryVisibleElement(step.targetSelector)
      ?? queryVisibleElement(step.fallbackSelector)
    if (!element) {
      setTargetElement(null)
      setTargetRect(null)
      setTargetStatus(previous => (
        markMissing ? 'missing' : previous === 'missing' ? previous : 'locating'
      ))
      return false
    }

    setTargetElement(element)
    setTargetStatus('found')
    updateTargetRect(element)

    if (scrollToTarget && !hasScrolledRef.current) {
      hasScrolledRef.current = true
      const rect = element.getBoundingClientRect()
      const viewport = viewportBounds()
      const outsideComfortableViewport = rect.top < viewport.top + 72
        || rect.bottom > viewport.top + viewport.height - 72
        || rect.left < viewport.left + 32
        || rect.right > viewport.left + viewport.width - 32
      if (outsideComfortableViewport) {
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
        element.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: reduceMotion ? 'auto' : 'smooth',
        })
      }
    }
    return true
  }, [step?.fallbackSelector, step?.targetSelector, updateTargetRect])

  useEffect(() => {
    if (!isActive || !step) return
    hasScrolledRef.current = false
    setTargetElement(null)
    setTargetRect(null)
    setTargetStatus(step.targetSelector ? 'locating' : 'ready')
    setEntered(false)

    if (step.navigateTo && location.pathname !== step.navigateTo) {
      navigate(step.navigateTo)
    }
    if (step.requiredMode) setMode(step.requiredMode)

    expandRequiredPanels()
    const panelTimer = window.setTimeout(expandRequiredPanels, 180)
    const entranceTimer = window.setTimeout(() => setEntered(true), 70)
    return () => {
      window.clearTimeout(panelTimer)
      window.clearTimeout(entranceTimer)
    }
  }, [currentStepIndex, expandRequiredPanels, isActive, location.pathname, navigate, setMode, step])

  useEffect(() => {
    if (!isActive || !step) return
    if (!step.targetSelector) {
      locateTarget()
      return
    }

    const timers = TARGET_RETRY_DELAYS.map((delay, index) => window.setTimeout(() => {
      expandRequiredPanels()
      locateTarget(index === TARGET_RETRY_DELAYS.length - 1, true)
    }, delay))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [currentStepIndex, expandRequiredPanels, isActive, locateTarget, location.pathname, step])

  useEffect(() => {
    if (!isActive || !step) return

    const scheduleMeasurement = () => {
      if (scheduledFrameRef.current !== null) return
      scheduledFrameRef.current = window.requestAnimationFrame(() => {
        scheduledFrameRef.current = null
        if (targetElement && isElementVisible(targetElement)) {
          updateTargetRect(targetElement)
        } else if (step.targetSelector) {
          locateTarget(false, false)
        }
      })
    }

    window.addEventListener('resize', scheduleMeasurement)
    document.addEventListener('scroll', scheduleMeasurement, true)
    window.visualViewport?.addEventListener('resize', scheduleMeasurement)
    window.visualViewport?.addEventListener('scroll', scheduleMeasurement)

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleMeasurement)
    if (targetElement) resizeObserver?.observe(targetElement)

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleMeasurement)
    mutationObserver?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-expanded'],
    })

    return () => {
      window.removeEventListener('resize', scheduleMeasurement)
      document.removeEventListener('scroll', scheduleMeasurement, true)
      window.visualViewport?.removeEventListener('resize', scheduleMeasurement)
      window.visualViewport?.removeEventListener('scroll', scheduleMeasurement)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      if (scheduledFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledFrameRef.current)
        scheduledFrameRef.current = null
      }
    }
  }, [isActive, locateTarget, step, targetElement, updateTargetRect])

  useEffect(() => {
    const tooltip = tooltipRef.current
    if (!isActive || !tooltip) return
    const measure = () => {
      const rect = tooltip.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setTooltipSize(previous => (
          Math.abs(previous.width - rect.width) > 0.5 || Math.abs(previous.height - rect.height) > 0.5
            ? { width: rect.width, height: rect.height }
            : previous
        ))
      }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(tooltip)
    return () => observer?.disconnect()
  }, [currentStepIndex, isActive, targetStatus])

  useEffect(() => {
    if (!isActive) return
    transferringFocusToManualRef.current = false
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const previousFocus = previousFocusRef.current
      if (!transferringFocusToManualRef.current && previousFocus?.isConnected) {
        window.setTimeout(() => previousFocus.focus(), 0)
      }
      previousFocusRef.current = null
    }
  }, [isActive])

  useEffect(() => {
    if (!isActive) return
    const timer = window.setTimeout(() => primaryButtonRef.current?.focus(), 180)
    return () => window.clearTimeout(timer)
  }, [currentStepIndex, isActive, targetStatus])

  useEffect(() => {
    if (!isActive) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const interactiveTarget = event.target instanceof HTMLButtonElement
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement

      if (event.key === 'Escape') {
        event.preventDefault()
        skipTour()
        return
      }
      if (!interactiveTarget && (event.key === 'ArrowRight' || event.key === 'Enter')) {
        event.preventDefault()
        if (targetStatus !== 'missing') nextStep()
        return
      }
      if (!interactiveTarget && event.key === 'ArrowLeft') {
        event.preventDefault()
        prevStep()
        return
      }
      if (event.key !== 'Tab' || !tooltipRef.current) return

      const focusable = Array.from(tooltipRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, nextStep, prevStep, skipTour, targetStatus])

  if (!isActive || !step || steps.length === 0) return null

  const isLast = currentStepIndex >= steps.length - 1
  const showSpotlight = targetStatus === 'found' && !!targetRect
  const tooltipPosition = getTooltipPosition(
    showSpotlight ? targetRect : null,
    step.placement ?? 'center',
    tooltipSize.width,
    tooltipSize.height,
  )
  const progress = Math.min(100, ((currentStepIndex + 1) / steps.length) * 100)
  const chapterTitle = localize(chapter?.title ?? step.chapterTitle ?? step.chapter, lang)
    || localize(FALLBACK_CHAPTER_TITLES[activeChapterId], lang)
    || (lang === 'zh' ? '平台导览' : 'Product guide')
  const stepTitle = localize(step.title, lang) || (lang === 'zh' ? '功能说明' : 'Feature guide')
  const stepDescription = localize(step.description ?? step.objective, lang)
  const tip = localize(step.tip, lang)
  const chapterParameter = step.parameterId
    ? chapter?.parameters?.find(parameter => parameter.id === step.parameterId)
    : undefined
  const parameterItems = [
    ...(chapterParameter ? [{
      id: chapterParameter.id,
      title: localize(chapterParameter.title, lang),
      description: localize(chapterParameter.description, lang),
    }] : []),
    ...((step.parameterItems ?? []).map((item, index) => normalizeParameterItem(item, lang, index))),
  ].filter((item, index, list) => item.title && list.findIndex(candidate => candidate.id === item.id) === index)
  const targetMissing = targetStatus === 'missing'
  const targetOptional = step.optional || step.allowMissingTarget
  const tooltipStyle = {
    top: tooltipPosition.top,
    left: tooltipPosition.left,
  } as CSSProperties

  const handleOpenManual = () => {
    transferringFocusToManualRef.current = true
    if (openManual) {
      openManual(activeChapterId)
      return
    }
    window.dispatchEvent(new CustomEvent('open-onboarding-manual', { detail: { chapterId: activeChapterId } }))
    skipTour()
  }

  return (
    <div
      className="product-tour"
      data-theme={theme === 'dark' ? 'dark' : 'light'}
      data-entered={entered ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-tour-title"
      aria-describedby="product-tour-description"
    >
      {!showSpotlight && <div className="product-tour__veil" aria-hidden="true" />}

      {showSpotlight && targetRect && (
        <div
          className="product-tour__spotlight"
          aria-hidden="true"
          style={{
            top: targetRect.top - SPOTLIGHT_PADDING,
            left: targetRect.left - SPOTLIGHT_PADDING,
            width: targetRect.width + SPOTLIGHT_PADDING * 2,
            height: targetRect.height + SPOTLIGHT_PADDING * 2,
          }}
        />
      )}

      <section
        ref={tooltipRef}
        className="product-tour__card"
        data-placement={tooltipPosition.placement}
        style={tooltipStyle}
      >
        <header className="product-tour__header">
          <div className="product-tour__chapter-mark" aria-hidden="true">
            <span className="material-symbols-outlined">route</span>
          </div>
          <div className="product-tour__heading-copy">
            <div className="product-tour__eyebrow">
              <span>{lang === 'zh' ? '交互导览' : 'Guided tour'}</span>
              <span aria-hidden="true">/</span>
              <span>{chapterTitle}</span>
            </div>
            <h2 id="product-tour-title">{stepTitle}</h2>
          </div>
          <button
            type="button"
            className="product-tour__icon-button"
            onClick={skipTour}
            aria-label={lang === 'zh' ? '关闭新手导览' : 'Close guided tour'}
            title={lang === 'zh' ? '关闭导览 (Esc)' : 'Close tour (Esc)'}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="product-tour__progress-heading">
          <span>{lang === 'zh' ? '本章进度' : 'Chapter progress'}</span>
          <strong>{currentStepIndex + 1} / {steps.length}</strong>
        </div>
        <div
          className="product-tour__progress"
          role="progressbar"
          aria-label={lang === 'zh' ? `${chapterTitle}导览进度` : `${chapterTitle} tour progress`}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={currentStepIndex + 1}
          aria-valuetext={`${Math.round(progress)}%`}
        >
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="product-tour__content">
          <section className="product-tour__objective" aria-labelledby="product-tour-objective-heading">
            <div className="product-tour__section-label" id="product-tour-objective-heading">
              <span className="material-symbols-outlined" aria-hidden="true">target</span>
              {lang === 'zh' ? '本步目标' : 'Objective'}
            </div>
            <p id="product-tour-description">{stepDescription}</p>
          </section>

          {parameterItems.length > 0 && (
            <section className="product-tour__parameters" aria-labelledby="product-tour-parameters-heading">
              <div className="product-tour__section-label" id="product-tour-parameters-heading">
                <span className="material-symbols-outlined" aria-hidden="true">tune</span>
                {lang === 'zh' ? '当前参数组' : 'Parameter group'}
              </div>
              <div className="product-tour__parameter-list">
                {parameterItems.map((parameter, index) => (
                  <article className="product-tour__parameter" key={`${parameter.id}-${index}`}>
                    <span className="product-tour__parameter-index">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <h3>{parameter.title}</h3>
                      {parameter.description && <p>{parameter.description}</p>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {tip && (
            <aside className="product-tour__tip">
              <span className="material-symbols-outlined" aria-hidden="true">lightbulb</span>
              <p>{tip}</p>
            </aside>
          )}

          {targetStatus === 'locating' && step.targetSelector && (
            <div className="product-tour__target-state" role="status" aria-live="polite">
              <span className="product-tour__spinner" aria-hidden="true" />
              <div>
                <strong>{lang === 'zh' ? '正在定位当前功能' : 'Locating this control'}</strong>
                <p>{lang === 'zh' ? '正在等待页面和参数面板完成加载。' : 'Waiting for the page and parameter panel to finish loading.'}</p>
              </div>
            </div>
          )}

          {targetMissing && (
            <div className="product-tour__target-state product-tour__target-state--missing" role="status" aria-live="assertive">
              <span className="material-symbols-outlined" aria-hidden="true">location_off</span>
              <div>
                <strong>{lang === 'zh' ? '当前控件暂未显示' : 'This control is not visible yet'}</strong>
                <p>
                  {targetOptional
                    ? (lang === 'zh' ? '该功能需要先有任务或产物。可先跳过，完整说明已保留在手册中。' : 'This control needs an existing task or artifact. Skip it for now; the full explanation remains in the manual.')
                    : (lang === 'zh' ? '可能是页面仍在加载，或相关面板尚未展开。请重试定位。' : 'The page may still be loading or its panel may be collapsed. Try locating it again.')}
                </p>
                <div className="product-tour__target-actions">
                  <button type="button" onClick={() => locateTarget(true, true)}>
                    <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
                    {lang === 'zh' ? '重试定位' : 'Retry'}
                  </button>
                  <button type="button" onClick={nextStep}>
                    {lang === 'zh' ? '跳过此项' : 'Skip this item'}
                    <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="product-tour__footer">
          <button type="button" className="product-tour__manual-button" onClick={handleOpenManual}>
            <span className="material-symbols-outlined" aria-hidden="true">menu_book</span>
            {lang === 'zh' ? '打开完整手册' : 'Open full manual'}
          </button>
          <div className="product-tour__navigation">
            {currentStepIndex > 0 && (
              <button type="button" className="product-tour__back-button" onClick={prevStep}>
                <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
                {lang === 'zh' ? '上一步' : 'Back'}
              </button>
            )}
            <button
              ref={primaryButtonRef}
              type="button"
              className="product-tour__next-button"
              onClick={nextStep}
              disabled={targetMissing}
            >
              {isLast
                ? (lang === 'zh' ? '完成本章' : 'Finish chapter')
                : (lang === 'zh' ? '下一步' : 'Next')}
              <span className="material-symbols-outlined" aria-hidden="true">
                {isLast ? 'check' : 'arrow_forward'}
              </span>
            </button>
          </div>
        </footer>

        <p className="product-tour__keyboard-hint" aria-hidden="true">
          <span>← / →</span> {lang === 'zh' ? '切换步骤' : 'navigate'}
          <span>Esc</span> {lang === 'zh' ? '关闭' : 'close'}
        </p>
      </section>
    </div>
  )
}
