import { useEffect, useRef, useState } from 'react'
import type { EditorMode } from '../../lib/editor-store'
import { auth } from '../../lib/auth'
import { useThemeStore } from '../../lib/theme'
import { useTourStore } from '../OnboardingTour'
import type { GuideChapterId } from '../OnboardingTour/guide-catalog'

interface MobileOnboardingProps {
  open: boolean
  onClose: () => void
  onNavigate?: (target: { bottomTab?: 'generate' | 'pet' | 'recharge' | 'profile'; mode?: EditorMode }) => void | Promise<void>
}

type TourStepPosition = 'top' | 'bottom' | 'center'

interface TooltipPlacementRect { top: number; bottom: number }

interface TooltipPlacementInput {
  position: TourStepPosition
  rect?: TooltipPlacementRect | null
  viewportHeight?: number
  cardHeight?: number
  margin?: number
  bottomInset?: number
}

const TOUR_CARD_MAX_HEIGHT = 340
const TOUR_CARD_MARGIN = 16
const TOUR_CARD_BOTTOM_INSET = 24
const TARGET_RETRY_MS = 80
const TARGET_RETRY_LIMIT = 20
const SCROLL_SETTLE_MS = 300

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function getMobileOnboardingTooltipStyle({
  position,
  rect,
  viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720,
  cardHeight = TOUR_CARD_MAX_HEIGHT,
  margin = TOUR_CARD_MARGIN,
  bottomInset = TOUR_CARD_BOTTOM_INSET,
}: TooltipPlacementInput): React.CSSProperties {
  const availableHeight = Math.max(180, viewportHeight - margin - bottomInset)
  const safeCardHeight = Math.min(cardHeight, availableHeight)
  const maxTop = Math.max(margin, viewportHeight - bottomInset - safeCardHeight)
  const centeredTop = margin + Math.max(0, availableHeight - safeCardHeight) / 2
  const top = !rect || position === 'center'
    ? centeredTop
    : position === 'bottom'
      ? rect.bottom + 16
      : rect.top - safeCardHeight - 16

  return {
    top: clamp(top, margin, maxTop),
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: `${safeCardHeight}px`,
  }
}

export const MOBILE_ONBOARDING_STEPS: Array<{
  targetId: string | null
  fallbackTargetId?: string
  title: string
  desc: string
  position: TourStepPosition
  bottomTab?: 'generate' | 'pet' | 'recharge' | 'profile'
  mode?: EditorMode
  chapterId?: GuideChapterId
  chapter?: string
  items?: string[]
}> = [
  {
    targetId: null,
    title: '从灵感到成品',
    desc: 'Linggan 已升级为完整的移动创作工作台。接下来快速认识不同创作方式、灵感配方、历史任务和算力管理。',
    position: 'center',
    bottomTab: 'generate',
    mode: 'TEXT_TO_IMAGE',
    chapterId: 'overview',
    chapter: '平台总览',
    items: ['顶部选择创作模块', '历史记录恢复任务', '参数区配置模型与输出', '结果区预览、下载与继续编辑'],
  },
  {
    targetId: 'mobile-mode-switcher',
    title: '选择创作方式',
    desc: '在这里切换文生图、单图精修、科研绘图、海报和 PPT。每种方式都有独立的任务、预览和提交状态。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'TEXT_TO_IMAGE',
    chapterId: 'overview',
    chapter: '平台总览',
    items: ['文生图：从文字和参考图生成', '单图精修：定位修改与本地编辑', '海报 / PPT / 科研：专用参数工作台'],
  },
  {
    targetId: 'mobile-prompt-input',
    fallbackTargetId: 'mobile-mode-text-to-image',
    title: '文生图工作台',
    desc: '输入画面意图，补充参考图、尺寸和模型。选择灵感配方时，会同时带入一套风格、构图和画面约束；提交后在对应任务里等待结果。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'TEXT_TO_IMAGE',
    chapterId: 'text-to-image',
    chapter: '文生图',
    items: ['提示词：主体、场景、构图与限制', '参考图：角色、产品、姿势或配色', '灵感配方：整套风格与约束一次复用'],
  },
  {
    targetId: 'mobile-prompt-input',
    fallbackTargetId: 'mobile-mode-text-to-image',
    title: '模型与输出参数',
    desc: '提交前逐项确认生成方式与成本。快速模式直接执行，深度模式会先整理需求；导览只讲解，不会替你提交任务。',
    position: 'top',
    bottomTab: 'generate',
    mode: 'TEXT_TO_IMAGE',
    chapterId: 'text-to-image',
    chapter: '文生图',
    items: ['快速 / 深度模式', '文本规划模型与生图模型', '比例、清晰度与渲染质量', '预估费用与生成按钮'],
  },
  {
    targetId: 'mobile-retouch-workbench',
    title: '单图精修',
    desc: '导入图片或从历史记录选图，圈选需要调整的区域后再提交。每次精修与其结果绑定，切换对话不会覆盖正在进行的任务。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'IMAGE_EDIT',
    chapterId: 'image-retouch',
    chapter: '单图精修',
    items: ['导入图片或打开历史', '点选、涂抹、框选定位', '裁剪、调节、文字、水印与马赛克', '统一撤销 / 重做、保存与原图下载'],
  },
  {
    targetId: 'mobile-scifig-form',
    fallbackTargetId: 'mobile-mode-sci-fig',
    title: '科研绘图',
    desc: '描述机制、结构、数据关系或论文图目标；上传论文、表格或参考图后，系统会把内容约束带入图表规划。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'SCI_FIG',
    chapterId: 'scientific-figure',
    chapter: '科研生图',
    items: ['研究目标、机制与数据关系', '论文图类型和期刊视觉方向', '历史、版本与结果继续修改'],
  },
  {
    targetId: 'mobile-scifig-mode-panel',
    fallbackTargetId: 'mobile-scifig-form',
    title: '科研输出路线',
    desc: 'SVG 适合可编辑结构图和机制图；image2 适合高完成度科研视觉。先选路线，再配置输出。',
    position: 'top',
    bottomTab: 'generate',
    mode: 'SCI_FIG',
    chapterId: 'scientific-figure',
    chapter: '科研生图',
    items: ['SVG / image2 模式', '分类、风格与输出格式', '清晰度、质量与模型成本', '论文、表格、截图和附件解析'],
  },
  {
    targetId: 'mobile-poster-form',
    fallbackTargetId: 'mobile-mode-poster-gen',
    title: '海报设计',
    desc: '填写主题、卖点和受众，再用参考图决定版式密度与视觉方向。多张生成会作为同一任务中的系列方案管理。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'POSTER_GEN',
    chapterId: 'poster',
    chapter: '海报设计',
    items: ['主题、卖点、受众和文案', '预设方向与灵感配方', '单张或系列海报任务'],
  },
  {
    targetId: 'mobile-poster-size-panel',
    fallbackTargetId: 'mobile-poster-form',
    title: '海报版式与输出',
    desc: '画幅决定信息排布边界，数量决定系列方案规模；参考图负责约束版式密度和视觉语言。',
    position: 'top',
    bottomTab: 'generate',
    mode: 'POSTER_GEN',
    chapterId: 'poster',
    chapter: '海报设计',
    items: ['数量与画幅', '清晰度和渲染质量', '文本模型与生图模型', '附件、参考图与生成'],
  },
  {
    targetId: 'mobile-ppt-form',
    fallbackTargetId: 'mobile-mode-ppt-gen',
    title: '可编辑 PPT',
    desc: '先给出主题和素材，生成可编辑大纲与页面。成品可继续预览、调整或导出，而不是只能得到一张静态图片。',
    position: 'bottom',
    bottomTab: 'generate',
    mode: 'PPT_GEN',
    chapterId: 'ppt-generation',
    chapter: 'PPT 生成',
    items: ['模板、主题和受众', '页数与总风格', '大纲规划和逐页生成', '页面编辑、排序与导出版本'],
  },
  {
    targetId: 'mobile-ppt-topic',
    fallbackTargetId: 'mobile-ppt-form',
    title: 'PPT 内容与素材',
    desc: '总主题控制整套演示，单页提示控制局部内容；附件会参与结构、事实和版式理解。',
    position: 'top',
    bottomTab: 'generate',
    mode: 'PPT_GEN',
    chapterId: 'ppt-generation',
    chapter: 'PPT 生成',
    items: ['主题、风格和页数', '总提示词与单页提示词', '参考图、PPT、Word、PDF 附件', '预览质量、生成路线和模型费用'],
  },
  {
    targetId: 'mobile-nav-gallery',
    fallbackTargetId: 'mobile-bottom-nav',
    title: '灵感广场与灵感配方',
    desc: '在广场浏览不同类型的作品，点赞或收藏后可快速回看。生成同款会进入对应模块；反推图片还可以保存为自己的灵感配方。',
    position: 'top',
    chapterId: 'gallery',
    chapter: '灵感广场',
    items: ['作品：按图片类型浏览', '灵感配方：一整套固定创作规则', '点赞与收藏', '生成同款会自动打开正确模块'],
  },
  {
    targetId: 'mobile-credits-btn',
    title: '算力与个人中心',
    desc: '从这里查看积分余额，或在 FoxAPI密钥模式下确认算力状态。底部“我的”可以管理安全设置、账户信息和完整使用记录。',
    position: 'bottom',
    bottomTab: 'profile',
    chapterId: 'compute',
    chapter: '账户与算力',
    items: ['平台积分 / FoxAPI密钥', '连接状态和可用模型', '积分、订单和使用记录', '账户、安全、主题与下载'],
  },
]

export default function MobileOnboarding({ open, onClose, onNavigate }: MobileOnboardingProps) {
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [step, setStep] = useState(0)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [aligning, setAligning] = useState(false)
  const [viewportHeight, setViewportHeight] = useState(() => window.visualViewport?.height || window.innerHeight)
  const onNavigateRef = useRef(onNavigate)
  const baseCurrent = MOBILE_ONBOARDING_STEPS[step]
  const isExternalComputeUser = auth.isExternalComputeUser()
  const current = isExternalComputeUser && baseCurrent.targetId === 'mobile-credits-btn'
    ? { ...baseCurrent, title: 'FoxAPI 算力', desc: '当前账号使用 FoxAPI密钥。这里可以确认连接状态、可用模型和调用方式，创作请求不会扣除平台积分。' }
    : baseCurrent
  const isLast = step === MOBILE_ONBOARDING_STEPS.length - 1

  useEffect(() => { onNavigateRef.current = onNavigate }, [onNavigate])
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => setViewportHeight(viewport?.height || window.innerHeight)
    update()
    window.addEventListener('resize', update)
    viewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
    }
  }, [])
  useEffect(() => {
    if (!open) {
      setStep(0)
      setTargetRect(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timers = new Set<number>()
    const delay = (milliseconds: number) => new Promise<void>(resolve => {
      const timer = window.setTimeout(() => { timers.delete(timer); resolve() }, milliseconds)
      timers.add(timer)
    })

    const alignTarget = async () => {
      setAligning(true)
      setTargetRect(null)
      await Promise.resolve(onNavigateRef.current?.({ bottomTab: current.bottomTab, mode: current.mode }))
      if (cancelled || !current.targetId) {
        if (!cancelled) setAligning(false)
        return
      }

      for (let attempt = 0; attempt <= TARGET_RETRY_LIMIT; attempt += 1) {
        const target = document.getElementById(current.targetId)
          || (current.fallbackTargetId ? document.getElementById(current.fallbackTargetId) : null)
        if (target) {
          const rect = target.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
            setTargetRect(rect)
            await delay(SCROLL_SETTLE_MS)
            if (!cancelled) setTargetRect(target.getBoundingClientRect())
            break
          }
        }
        await delay(TARGET_RETRY_MS)
        if (cancelled) return
      }
      if (!cancelled) setAligning(false)
    }

    void alignTarget()
    return () => {
      cancelled = true
      timers.forEach(timer => window.clearTimeout(timer))
    }
  }, [current.bottomTab, current.fallbackTargetId, current.mode, current.targetId, open, step])

  useEffect(() => {
    const targetId = current.targetId
    if (!open || !targetId) return
    const refreshTargetRect = () => {
      const target = document.getElementById(targetId)
        || (current.fallbackTargetId ? document.getElementById(current.fallbackTargetId) : null)
      if (!target) return
      const rect = target.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setTargetRect(rect)
    }
    const target = document.getElementById(targetId)
      || (current.fallbackTargetId ? document.getElementById(current.fallbackTargetId) : null)
    const observer = typeof ResizeObserver !== 'undefined' && target ? new ResizeObserver(refreshTargetRect) : null
    observer?.observe(target!)
    window.addEventListener('resize', refreshTargetRect)
    document.addEventListener('scroll', refreshTargetRect, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', refreshTargetRect)
      document.removeEventListener('scroll', refreshTargetRect, true)
    }
  }, [current.fallbackTargetId, current.targetId, open])

  if (!open) return null

  const accent = `var(--app-accent, ${isDark ? '#e4e4e7' : '#d9822b'})`
  const onAccent = `var(--app-on-accent, ${isDark ? '#18181b' : '#fff'})`
  const cardBackground = `var(--app-glass, ${isDark ? 'rgba(20,20,23,0.96)' : 'rgba(255,252,246,0.96)'})`
  const cardBorder = `var(--app-border, ${isDark ? 'rgba(255,255,255,0.13)' : 'rgba(153,112,68,0.22)'})`
  const panelSoft = `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.56)'})`
  const text = `var(--app-text, ${isDark ? '#f4f4f5' : '#2f2923'})`
  const muted = `var(--app-muted, ${isDark ? '#a1a1aa' : '#75695d'})`
  const tooltipStyle = getMobileOnboardingTooltipStyle({ position: current.position, rect: targetRect, viewportHeight, cardHeight: 430 })
  const progress = ((step + 1) / MOBILE_ONBOARDING_STEPS.length) * 100

  return (
    <div className="fixed inset-0 z-[500]" data-aligning={aligning ? 'true' : 'false'} role="dialog" aria-modal="true" aria-label="新手导览">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onClose} />
      {targetRect && (
        <div
          className="pointer-events-none fixed z-[501]"
          style={{
            top: targetRect.top - 7,
            left: targetRect.left - 7,
            width: targetRect.width + 14,
            height: targetRect.height + 14,
            border: `1.5px solid ${accent}`,
            borderRadius: 12,
            boxShadow: `0 0 0 9999px rgba(0,0,0,0.3), 0 0 0 5px color-mix(in srgb, ${accent} 14%, transparent), 0 0 24px color-mix(in srgb, ${accent} 34%, transparent)`,
            transition: 'all 260ms cubic-bezier(.2,.8,.2,1)',
          }}
        />
      )}
      <section
        key={step}
          className="mobile-onboarding-card absolute z-[502] flex w-[336px] max-w-[calc(100vw-24px)] flex-col overflow-hidden"
        style={{
          ...tooltipStyle,
          background: cardBackground,
          border: `1px solid ${cardBorder}`,
          borderRadius: 16,
          boxShadow: isDark ? '0 26px 60px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.06)' : '0 26px 60px rgba(75,55,30,.25), inset 0 1px 0 rgba(255,255,255,.82)',
          backdropFilter: 'blur(22px) saturate(1.1)',
        }}
      >
        <button type="button" onClick={onClose} className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full" style={{ color: muted }} aria-label="关闭导览">
          <span className="material-symbols-outlined text-[17px]">close</span>
        </button>
        <div className="relative shrink-0 px-4 pb-2 pt-4 pr-12">
          <div className="mb-2 flex items-center justify-between text-[10px] font-black" style={{ color: accent }}>
            <span>{current.chapter || '新手导览'}</span><span>{step + 1} / {MOBILE_ONBOARDING_STEPS.length}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${cardBorder} 72%, transparent)` }}>
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${progress}%`, background: accent }} />
          </div>
        </div>
        <div className="relative min-h-0 overflow-y-auto px-4 pb-3 pt-2">
          <h3 className="text-[17px] font-black" style={{ color: text }}>{current.title}</h3>
          <p className="mt-2 whitespace-pre-line text-[12px] leading-6" style={{ color: muted }}>{current.desc}</p>
          {current.items && current.items.length > 0 && (
            <ul className="mt-3 grid gap-1.5" aria-label="本步骤涵盖内容">
              {current.items.map(item => (
                <li key={item} className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-4" style={{ borderColor: cardBorder, background: panelSoft, color: text }}>
                  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="relative flex shrink-0 flex-wrap gap-2 px-4 pb-4 pt-1">
          <button type="button" onClick={() => { onClose(); useTourStore.getState().openManual(current.chapterId || 'overview') }} className="min-h-11 rounded-xl border px-3 text-[11px] font-bold" style={{ borderColor: cardBorder, color: muted }}>完整手册</button>
          {step > 0 && <button type="button" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={aligning} className="flex-1 rounded-xl border py-2.5 text-[11px] font-bold disabled:opacity-50" style={{ borderColor: cardBorder, color: muted }}>上一步</button>}
          <button type="button" disabled={aligning} onClick={() => isLast ? onClose() : setStep(value => Math.min(MOBILE_ONBOARDING_STEPS.length - 1, value + 1))} className="min-h-11 flex-1 rounded-xl py-2.5 text-[11px] font-black shadow-sm disabled:opacity-50" style={{ background: accent, color: onAccent, boxShadow: `0 8px 18px color-mix(in srgb, ${accent} 19%, transparent)` }}>
            {isLast ? '开始创作' : aligning ? '定位中...' : '下一步'}
          </button>
        </div>
      </section>
      <style>{`
        @keyframes mobileOnboardingCardIn { from { opacity: 0; transform: translateX(-50%) translateY(10px) scale(.98); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
        .mobile-onboarding-card { animation: mobileOnboardingCardIn 220ms cubic-bezier(.2,.8,.2,1) both; transition: top 220ms ease, opacity 160ms ease; }
        @media (prefers-reduced-motion: reduce) { .mobile-onboarding-card { animation: none; transition: none; } }
      `}</style>
    </div>
  )
}
