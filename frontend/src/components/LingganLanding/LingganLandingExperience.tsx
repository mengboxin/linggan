import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useInView } from 'motion/react'
import {
  ArrowRight,
  Brush,
  ExternalLink,
  GalleryHorizontalEnd,
  Grid3X3,
  Image as ImageIcon,
  Moon,
  Move,
  Play,
  Presentation,
  Sparkles,
  Sun,
  WandSparkles,
  Workflow,
} from 'lucide-react'

import { BackgroundBeamsWithCollision } from '@/components/ui/background-beams-with-collision'
import { ThreeDMarquee } from '@/components/ui/3d-marquee'
import {
  MobileNav,
  MobileNavHeader,
  MobileNavMenu,
  MobileNavToggle,
  NavBody,
  NavItems,
  Navbar,
} from '@/components/ui/resizable-navbar'
import { BrandWordmark } from '../ui/BrandWordmark'
import './linggan-landing-experience.css'

const AnimatedTestimonials = lazy(() => import('@/components/ui/animated-testimonials').then(module => ({ default: module.AnimatedTestimonials })))
const ContainerScroll = lazy(() => import('@/components/ui/container-scroll-animation').then(module => ({ default: module.ContainerScroll })))
const DraggableCardBody = lazy(() => import('@/components/ui/draggable-card').then(module => ({ default: module.DraggableCardBody })))
const DraggableCardContainer = lazy(() => import('@/components/ui/draggable-card').then(module => ({ default: module.DraggableCardContainer })))
const FloatingDock = lazy(() => import('@/components/ui/floating-dock').then(module => ({ default: module.FloatingDock })))
const TextHoverEffect = lazy(() => import('@/components/ui/text-hover-effect').then(module => ({ default: module.TextHoverEffect })))

export type LingganLandingLang = 'zh' | 'en'

export interface LingganLandingFeature {
  icon: string
  title: string
  body: string
}

interface LandingActionProps {
  lang: LingganLandingLang
  onLogin: () => void
  onRegister: () => void
}

interface LingganLandingNavProps extends Omit<LandingActionProps, 'onLogin'> {
  brand: ReactNode
  isDark: boolean
  isAuth: boolean
  isFoxApiPanel: boolean
  showLandingLinks: boolean
  languageLabel: string
  registerLabel: string
  startLabel: string
  foxApiLabel: string
  themeLabel: string
  onBrand: () => void
  onTheme: () => void
  onLanguage: () => void
  onFoxApi: () => void
  onStart: () => void
  onLandingSectionRequest?: (hash: string) => void
}

const ARTWORKS = [
  '/creative-library/high-concept-cosmic-vortex.webp',
  '/creative-library/gallery-meigen-fashion-editorial.webp',
  '/creative-library/high-concept-tiger-interceptor.webp',
  '/creative-library/gallery-fantasy-cloud-market.webp',
  '/creative-library/gallery-meigen-candy-game.webp',
  '/creative-library/gallery-cinema-harbor-key-art.webp',
  '/creative-library/gallery-eastern-still-life-plum.webp',
  '/creative-library/gallery-meigen-dragon-portrait.webp',
  '/creative-library/gallery-architecture-library-stairwell.webp',
  '/creative-library/gallery-natural-history-butterfly.webp',
  '/creative-library/gallery-poster-citrus-collage.webp',
  '/creative-library/gallery-poster-new-chinese-tea.webp',
  '/creative-library/gallery-zine-mountain-lake.webp',
  '/creative-library/high-concept-desert-rider.webp',
  '/creative-library/high-concept-orbital-forge.webp',
  '/creative-library/gallery-character-bible-cloud-lantern.webp',
  '/creative-library/gallery-cinema-harbor-shot-1.webp',
  '/creative-library/gallery-cinema-harbor-shot-2.webp',
  '/creative-library/gallery-cinema-harbor-shot-3.webp',
  '/creative-library/gallery-coastal-paper-map.webp',
  '/creative-library/gallery-meigen-tang-fantasy.webp',
  '/creative-library/meigen-latest-2038617381388583283.webp',
  '/creative-library/meigen-latest-2047174895293849972.webp',
  '/creative-library/meigen-latest-2054586679663698417.webp',
  '/creative-library/meigen-latest-2063440876823859646.webp',
  '/creative-library/meigen-latest-2042058511937679439.webp',
  '/creative-library/meigen-latest-2053687599319896509.webp',
  '/creative-library/gallery-moments-photo-diary.webp',
  '/creative-library/gallery-poster-night-run.webp',
  '/creative-library/welcome-zine-train-journey.webp',
] as const
// Flattened from 18 unique library works so Android only composites one static bitmap.
const MOBILE_HERO_ARTWORK = '/landing/linggan-mobile-hero-artwork.webp'

interface LandingArtwork {
  src: string
  zh: string
  en: string
  zhBody: string
  enBody: string
}

const GALLERY_WORKS: readonly LandingArtwork[] = [
  { src: '/creative-library/gallery-meigen-fashion-editorial.webp', zh: '时尚编辑视觉', en: 'Editorial fashion', zhBody: '黑白人物与高饱和笔触，让品牌肖像更有辨识度', enBody: 'Monochrome portraiture meets expressive brand texture.' },
  { src: '/creative-library/gallery-cinema-harbor-key-art.webp', zh: '电影主视觉', en: 'Cinematic key art', zhBody: '从光线、空间到人物位置，延展完整的电影叙事', enBody: 'Build cinematic narrative through light, space, and character.' },
  { src: '/creative-library/gallery-fantasy-cloud-market.webp', zh: '东方幻想场景', en: 'Eastern fantasy', zhBody: '用明亮材质和故事元素，把概念变成完整世界', enBody: 'Turn a concept into a world of light, material, and story.' },
  { src: '/creative-library/gallery-architecture-library-stairwell.webp', zh: '建筑空间叙事', en: 'Spatial narrative', zhBody: '保留真实空间尺度，同时建立克制的视觉情绪', enBody: 'Keep spatial scale intact while shaping a restrained mood.' },
  { src: '/creative-library/gallery-eastern-still-life-plum.webp', zh: '东方静物', en: 'Eastern still life', zhBody: '在材质、留白与色彩之间建立安静的画面秩序', enBody: 'Balance material, negative space, and a quiet color rhythm.' },
  { src: '/creative-library/gallery-meigen-dragon-portrait.webp', zh: '角色概念设计', en: 'Character concept', zhBody: '从单张肖像延展角色气质、服装与世界观', enBody: 'Extend one portrait into costume, character, and world.' },
  { src: '/creative-library/gallery-natural-history-butterfly.webp', zh: '自然观察笔记', en: 'Natural history', zhBody: '把观察、材质与信息组织成有呼吸感的视觉笔记', enBody: 'Turn observation, texture, and information into a tactile visual note.' },
  { src: '/creative-library/gallery-poster-citrus-collage.webp', zh: '纸艺产品海报', en: 'Paper-cut product', zhBody: '用纸张、物件和留白，建立有节奏的产品主视觉', enBody: 'Use paper, objects, and negative space to create a paced product visual.' },
  { src: '/creative-library/gallery-meigen-candy-game.webp', zh: '糖果游戏世界', en: 'Candy game world', zhBody: '用夸张比例、色彩和材质，快速建立可玩的世界观', enBody: 'Use scale, color, and material to establish a playful world quickly.' },
  { src: '/creative-library/gallery-poster-new-chinese-tea.webp', zh: '新中式茶饮视觉', en: 'New Chinese tea', zhBody: '让产品、留白和东方材质形成克制的品牌记忆', enBody: 'Give product, negative space, and Eastern material a restrained brand memory.' },
  { src: '/creative-library/gallery-zine-mountain-lake.webp', zh: '山湖杂志拼贴', en: 'Mountain zine', zhBody: '用照片、纸张和版式，把一段旅途变成可分享的叙事', enBody: 'Turn a journey into a sharable story through photo, paper, and layout.' },
  { src: '/creative-library/high-concept-desert-rider.webp', zh: '荒漠载具概念', en: 'Desert concept', zhBody: '用电影级光线和结构细节建立完整的概念氛围', enBody: 'Build a complete concept atmosphere with cinematic light and structure.' },
] as const

function artworkRotationRank(value: string, seed: number) {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

function rotateArtworkList<T extends { src: string }>(items: readonly T[], seed: number) {
  return [...items].sort((left, right) => (
    artworkRotationRank(left.src, seed) - artworkRotationRank(right.src, seed)
    || left.src.localeCompare(right.src)
  ))
}

function uniqueLandingArtworks(items: readonly LandingArtwork[]) {
  const sources = new Set<string>()
  const titles = new Set<string>()
  return items.filter(item => {
    const source = item.src.trim()
    const title = item.zh.trim().toLocaleLowerCase()
    if (!source || sources.has(source) || titles.has(title)) return false
    sources.add(source)
    titles.add(title)
    return true
  })
}

export function getLandingArtworkSet(rotationSeed: number) {
  const works = uniqueLandingArtworks(rotateArtworkList(GALLERY_WORKS, rotationSeed + 19))
  const heroArtworks = (() => {
    const sources = Array.from(new Set([
      ...ARTWORKS,
      ...works.map(work => work.src),
    ])).map(src => ({ src }))
     return rotateArtworkList(sources, rotationSeed + 53).slice(0, 20).map(item => item.src)
  })()

  return { heroArtworks, works }
}

function useRotatingLandingArtworks() {
  const [rotationSeed] = useState(() => Date.now())
  return useMemo(() => getLandingArtworkSet(rotationSeed), [rotationSeed])
}

function useScrollActivity() {
  const [isScrolling, setIsScrolling] = useState(false)
  const isScrollingRef = useRef(false)

  useEffect(() => {
    const root = document.documentElement
    if (window.matchMedia('(max-width: 720px), (pointer: coarse)').matches) {
      root.removeAttribute('data-linggan-scroll-active')
      return
    }
    let settleTimer: number | null = null
    const settle = () => {
      settleTimer = null
      isScrollingRef.current = false
      root.removeAttribute('data-linggan-scroll-active')
      setIsScrolling(false)
    }
    const handleScroll = () => {
      if (!isScrollingRef.current) {
        isScrollingRef.current = true
        root.setAttribute('data-linggan-scroll-active', 'true')
        setIsScrolling(true)
      }
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(settle, 120)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      root.removeAttribute('data-linggan-scroll-active')
    }
  }, [])

  return isScrolling
}

const PRODUCT_SCREENS = [
  {
    id: 'generate',
    src: '/landing/linggan-text-to-image.webp',
    icon: ImageIcon,
    zh: '图片生成',
    en: 'Generate',
    zhBody: '提示词、模型、比例和历史记录在同一画面完成',
    enBody: 'Prompts, models, ratios, and history share one focused surface.',
  },
  {
    id: 'edit',
    src: '/landing/linggan-image-edit.webp',
    icon: Brush,
    zh: '图片编辑',
    en: 'Edit',
    zhBody: '从生成结果继续修改，保留可回溯的创作分支',
    enBody: 'Continue from any result while preserving editable branches.',
  },
  {
    id: 'canvas',
    src: '/landing/linggan-canvas-dark.webp',
    icon: Workflow,
    zh: '自由画布',
    en: 'Canvas',
    zhBody: '把参考图、提示词、模型与结果组织成可复用流程',
    enBody: 'Arrange references, prompts, models, and results into reusable flows.',
  },
  {
    id: 'gallery',
    src: '/landing/linggan-gallery.webp',
    icon: Grid3X3,
    zh: '灵感广场',
    en: 'Gallery',
    zhBody: '从真实作品和配方出发，找到下一张图的方向',
    enBody: 'Start from real work and reusable recipes for your next image.',
  },
  {
    id: 'ppt',
    src: '/landing/linggan-ppt.webp',
    icon: Presentation,
    zh: 'PPT 创作',
    en: 'PPT',
    zhBody: '让视觉成果继续进入演示、导出和交付环节',
    enBody: 'Carry visual work into presentation, export, and delivery.',
  },
] as const

export function LingganLandingNav({
  lang,
  brand,
  isDark,
  isAuth,
  isFoxApiPanel,
  showLandingLinks,
  languageLabel,
  registerLabel,
  startLabel,
  foxApiLabel,
  themeLabel,
  onBrand,
  onTheme,
  onLanguage,
  onRegister,
  onFoxApi,
  onStart,
  onLandingSectionRequest,
}: LingganLandingNavProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const landingItems = showLandingLinks
    ? [
        { name: lang === 'zh' ? '作品与风格' : 'Work', link: '#gallery' },
        { name: lang === 'zh' ? '平台体验' : 'Studio', link: '#studio' },
        { name: lang === 'zh' ? '创作流程' : 'Flow', link: '#workflow' },
      ]
    : []

  const handleNavItemClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!showLandingLinks) {
      onBrand()
      return
    }

    const hash = event.currentTarget.hash
    const target = hash ? document.querySelector(hash) : null
    if (!target) {
      onLandingSectionRequest?.(hash)
      return
    }
    window.history.pushState(null, '', hash)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleTheme = () => {
    const documentWithTransition = document as Document & {
      startViewTransition?: (callback: () => void) => unknown
    }
    const compactViewport = window.matchMedia('(max-width: 720px), (pointer: coarse)').matches
    if (!compactViewport && documentWithTransition.startViewTransition) {
      documentWithTransition.startViewTransition(onTheme)
      return
    }
    onTheme()
  }

  return (
    <Navbar className={`linggan-v2-topbar ${isAuth ? 'linggan-v2-topbar--auth' : ''}`} fixed={isAuth}>
      <NavBody className="linggan-v2-topbar__shell" fixed={isAuth}>
        <button type="button" className="linggan-v2-topbar__brand" onClick={onBrand} aria-label={lang === 'zh' ? '返回灵感首页' : 'Back to Linggan'}>
          <span className="linggan-v2-topbar__brand-motion" data-login-brand>{brand}</span>
        </button>
        <NavItems items={landingItems} className="linggan-v2-topbar__nav !relative !inset-auto" onItemClick={handleNavItemClick} />
        <div className="linggan-v2-topbar__actions">
          <button type="button" className={`linggan-v2-topbar__foxapi ${isFoxApiPanel ? 'is-active' : ''}`} onClick={onFoxApi}>
            <img src="/foxapi-logo-cutout.png" alt="" />
            {foxApiLabel}
          </button>
          <button type="button" onClick={handleTheme} className="linggan-v2-icon-button linggan-v2-theme-toggle" aria-label={themeLabel} title={themeLabel}>
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button type="button" onClick={onLanguage} className="linggan-v2-language-button">{languageLabel}</button>
          <button type="button" onClick={onRegister} className="linggan-v2-topbar__register">{registerLabel}</button>
          <button type="button" onClick={onStart} className="linggan-v2-topbar__start">
            {startLabel}
            {isFoxApiPanel && <ExternalLink size={15} />}
          </button>
        </div>
      </NavBody>

      <MobileNav className="linggan-v2-mobile-nav" fixed={isAuth}>
      <MobileNavHeader className="linggan-v2-mobile-nav__header">
          <button type="button" className="linggan-v2-topbar__brand" onClick={onBrand}>{brand}</button>
          <div className="linggan-v2-mobile-nav__actions">
            <button type="button" onClick={handleTheme} className="linggan-v2-icon-button linggan-v2-theme-toggle" aria-label={themeLabel}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <MobileNavToggle isOpen={mobileOpen} onClick={() => setMobileOpen(open => !open)} />
          </div>
        </MobileNavHeader>
        <MobileNavMenu isOpen={mobileOpen} onClose={() => setMobileOpen(false)} className="linggan-v2-mobile-nav__menu">
          {landingItems.map(item => (
            <a key={item.link + item.name} href={item.link} onClick={event => {
              handleNavItemClick(event)
              setMobileOpen(false)
            }}>{item.name}</a>
          ))}
          <button type="button" onClick={() => { onFoxApi(); setMobileOpen(false) }}>{foxApiLabel}</button>
          <button type="button" onClick={() => { onLanguage(); setMobileOpen(false) }}>{languageLabel}</button>
          <button type="button" onClick={() => { onRegister(); setMobileOpen(false) }}>{registerLabel}</button>
          <button type="button" className="linggan-v2-mobile-nav__start" onClick={() => { onStart(); setMobileOpen(false) }}>{startLabel}</button>
        </MobileNavMenu>
      </MobileNav>
    </Navbar>
  )
}

export function LingganHeroCanvas({ isDark }: { isDark: boolean }) {
  const [isCompact, setIsCompact] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
  ))
  const canvasRef = useRef<HTMLDivElement>(null)
  const heroInView = useInView(canvasRef, { amount: 0.01 })
  const isScrolling = useScrollActivity()
  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)')
    const sync = () => setIsCompact(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const mobileArtwork = <img className="linggan-v2-mobile-hero-artwork" src={MOBILE_HERO_ARTWORK} alt="" aria-hidden="true" decoding="sync" loading="eager" fetchPriority="high" />

  const canvasContent = (
    <>
      <div ref={canvasRef} className="linggan-v2-hero-visibility-sentinel" aria-hidden="true" />
      <div className="linggan-v2-hero-glow linggan-v2-hero-glow--apricot" />
      <div className="linggan-v2-hero-glow linggan-v2-hero-glow--orchid" />
      {isCompact ? mobileArtwork : <ThreeDMarquee images={[...ARTWORKS]} className="linggan-v2-marquee" />}
      <div className="linggan-v2-hero-veil" />
    </>
  )

  if (isCompact) {
    return <div className={`linggan-v2-hero-canvas ${heroInView ? 'is-in-view' : 'is-out-of-view'} ${isScrolling ? 'is-scrolling' : ''} ${isDark ? 'is-dark' : ''}`}>{canvasContent}</div>
  }

  return (
    <BackgroundBeamsWithCollision
      className={`linggan-v2-hero-canvas ${heroInView ? 'is-in-view' : 'is-out-of-view'} ${isScrolling ? 'is-scrolling' : ''} ${isDark ? 'is-dark' : ''}`}
      beamClassName="linggan-v2-hero-beam"
      collisionClassName="linggan-v2-hero-collision"
    >
      {canvasContent}
    </BackgroundBeamsWithCollision>
  )
}

export function LingganHeroCopy({ lang, onLogin, onRegister }: LandingActionProps) {
  return (
    <div className="linggan-v2-hero-copy">
      <div className="linggan-v2-eyebrow" data-login-reveal>
        <Sparkles size={15} />
        {lang === 'zh' ? 'AI 图像创作平台' : 'AI IMAGE CREATION STUDIO'}
      </div>
      <h1 data-login-reveal>
        <BrandWordmark className="brand-wordmark--linggan-hero" showMark text={lang === 'zh' ? '灵感' : 'LINGGAN'} />
      </h1>
      <div className="linggan-v2-hero-statement" data-login-reveal>
        {lang === 'zh' ? '把想象，变成下一幅作品' : 'Turn an idea into your next image.'}
      </div>
      <p className="linggan-v2-hero-body" data-login-reveal>
        {lang === 'zh'
          ? '从文生图到局部编辑、自由画布与灵感广场，每一步都保留上下文，让作品自然往下走'
          : 'Generate, edit, organize, and discover visual directions without losing the context of your work.'}
      </p>
      <div className="linggan-v2-hero-actions" data-login-reveal>
        <button type="button" className="linggan-v2-button linggan-v2-button--primary" onClick={onLogin}>
          {lang === 'zh' ? '开始创作' : 'Start creating'}
          <ArrowRight size={18} />
        </button>
        <button type="button" className="linggan-v2-button linggan-v2-button--ghost" onClick={onRegister}>
          {lang === 'zh' ? '创建账号' : 'Create account'}
          <Sparkles size={17} className="linggan-v2-create-sparkle" />
        </button>
      </div>
    </div>
  )
}

function DraggableArtworkLab({ lang, works }: { lang: LingganLandingLang; works: readonly LandingArtwork[] }) {
  return (
    <section id="gallery" className="linggan-v2-section linggan-v2-gallery-section">
      <div className="linggan-v2-section-heading">
        <div>
          <span className="linggan-v2-kicker"><Move size={15} /> Drag the direction</span>
          <h2>{lang === 'zh' ? '把风格拖到手边' : 'Pull a visual direction closer.'}</h2>
        </div>
        <p>{lang === 'zh' ? '拖动卡片查看真实生成作品，每张图都可以成为下一轮创作的参考，而不是装饰占位' : 'Drag real generated work into view and use it as the direction for what comes next.'}</p>
      </div>
      <div className="linggan-v2-artwork-lab">
        <Suspense fallback={null}>
          <DraggableCardContainer className="linggan-v2-drag-deck">
            <div className="linggan-v2-drag-stamp" aria-hidden="true"><TextHoverEffect text="LINGGAN" duration={0.2} /></div>
            {works.slice(0, 6).map((work, index) => (
              <DraggableCardBody
                key={work.src}
                ariaLabel={lang === 'zh' ? `可拖拽作品：${work.zh}` : `Draggable work: ${work.en}`}
                className={`linggan-v2-drag-card linggan-v2-drag-card--${index + 1}`}
              >
                <img src={work.src} alt={lang === 'zh' ? work.zh : work.en} draggable={false} />
                <div>
                  <span>0{index + 1}</span>
                  <strong>{lang === 'zh' ? work.zh : work.en}</strong>
                </div>
              </DraggableCardBody>
            ))}
          </DraggableCardContainer>
        </Suspense>
      </div>

      <div className="linggan-v2-testimonial-showcase">
        <div className="linggan-v2-section-heading linggan-v2-section-heading--testimonial">
          <div>
            <span className="linggan-v2-kicker"><GalleryHorizontalEnd size={15} /> Visual recipes</span>
            <h2>{lang === 'zh' ? '作品背后，是可以继续使用的视觉方向' : 'Every work carries a reusable visual direction.'}</h2>
          </div>
        </div>
        <Suspense fallback={null}>
          <AnimatedTestimonials
            autoplay
            testimonials={works.slice(4, 9).map(work => ({
              src: work.src,
              name: lang === 'zh' ? work.zh : work.en,
              designation: lang === 'zh' ? '灵感作品与风格配方' : 'LINGGAN WORK / VISUAL RECIPE',
              quote: lang === 'zh' ? work.zhBody : work.enBody,
            }))}
          />
        </Suspense>
      </div>
    </section>
  )
}

function ProductScrollShowcase({ lang }: { lang: LingganLandingLang }) {
  const [activeId, setActiveId] = useState<(typeof PRODUCT_SCREENS)[number]['id']>('generate')
  const active = PRODUCT_SCREENS.find(screen => screen.id === activeId) ?? PRODUCT_SCREENS[0]
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = PRODUCT_SCREENS.findIndex(screen => screen.id === activeId)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? PRODUCT_SCREENS.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + PRODUCT_SCREENS.length) % PRODUCT_SCREENS.length
    const next = PRODUCT_SCREENS[nextIndex]
    setActiveId(next.id)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
  }

  const title = (
    <div className="linggan-v2-product-scroll__heading">
      <span className="linggan-v2-kicker"><Play size={14} /> Product experience</span>
      <h2>{lang === 'zh' ? '从画面出发，继续创作' : 'Start from an image. Keep creating.'}</h2>
      <p>{lang === 'zh' ? '生成、修改、组织与交付始终在同一条路径上' : 'Generate, refine, organize, and deliver in one connected path.'}</p>
      <div className="linggan-v2-product-tabs" role="tablist" aria-label={lang === 'zh' ? '平台能力' : 'Platform capabilities'} onKeyDown={handleTabKeyDown}>
        {PRODUCT_SCREENS.map(screen => {
          const Icon = screen.icon
          const selected = screen.id === activeId
          return (
            <button
              key={screen.id}
              id={`linggan-product-tab-${screen.id}`}
              type="button"
              role="tab"
              aria-controls={`linggan-product-panel-${screen.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(screen.id)}
            >
              <Icon size={16} />
              <span>{lang === 'zh' ? screen.zh : screen.en}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <section id="studio" className="linggan-v2-product-section">
      <Suspense fallback={null}>
        <ContainerScroll titleComponent={title}>
          <div className="linggan-v2-product-frame">
            <div className="linggan-v2-product-frame__bar">
              <span><i /><i /><i /></span>
              <strong>image.foxapi.cn / {active.id}</strong>
              <em>{lang === 'zh' ? '真实产品界面' : 'REAL PRODUCT UI'}</em>
            </div>
            <div
              id={`linggan-product-panel-${active.id}`}
              className="linggan-v2-product-frame__screen"
              role="tabpanel"
              aria-labelledby={`linggan-product-tab-${active.id}`}
            >
              <img key={active.src} src={active.src} alt={lang === 'zh' ? active.zh : active.en} decoding="async" />
            </div>
          </div>
        </ContainerScroll>
      </Suspense>
      <p className="linggan-v2-product-caption">{lang === 'zh' ? active.zhBody : active.enBody}</p>
    </section>
  )
}

function CreationFlow({ lang, features }: { lang: LingganLandingLang; features: readonly LingganLandingFeature[] }) {
  return (
    <section id="workflow" className="linggan-v2-flow-section">
      <div className="linggan-v2-section-heading">
        <div>
          <span className="linggan-v2-kicker"><Workflow size={15} /> One creative flow</span>
          <h2>{lang === 'zh' ? '复杂留在系统里，创作保持直觉' : 'Complex underneath. Intuitive in your hands.'}</h2>
        </div>
        <p>{lang === 'zh' ? '每一步都保留上下文，结果可以继续生成、修改、组合和交付' : 'Every step keeps context so results can evolve instead of restarting.'}</p>
      </div>
      <div className="linggan-v2-flow-track">
        {features.map((feature, index) => (
          <article key={feature.title}>
            <span>0{index + 1}</span>
            <i className="material-symbols-outlined" aria-hidden="true">{feature.icon}</i>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function LingganFooter({ lang }: { lang: LingganLandingLang }) {
  const groups = [
    {
      title: lang === 'zh' ? '产品' : 'Product',
      links: [
        { label: lang === 'zh' ? 'FoxAPI 算力平台' : 'FoxAPI Compute Platform', href: 'https://foxapi.cn' },
        { label: lang === 'zh' ? '灵感 - 一站式AI创作平台' : 'Linggan - All-in-one AI creative platform', href: 'https://image.foxapi.cn/' },
      ],
    },
    {
      title: lang === 'zh' ? '政策' : 'Policy',
      links: [
        { label: lang === 'zh' ? '服务条款' : 'Terms of service', href: '/terms' },
        { label: lang === 'zh' ? '隐私政策' : 'Privacy policy', href: '/privacy' },
        { label: lang === 'zh' ? 'AI 内容说明' : 'AI content notice', href: '/ai-disclaimer' },
        { label: lang === 'zh' ? '付费服务规则' : 'Payment terms', href: '/payment-terms' },
      ],
    },
    {
      title: lang === 'zh' ? '支持' : 'Support',
      links: [
        { label: lang === 'zh' ? '灵感广场' : 'Creation commons', href: '/gallery' },
        { label: lang === 'zh' ? '图片反推' : 'Prompt lens', href: '/image-to-prompt' },
        { label: lang === 'zh' ? '联系支持' : 'Contact support', href: 'mailto:3782952533@qq.com' },
      ],
    },
  ]

  return (
    <footer className="linggan-v2-footer">
      <div className="linggan-v2-footer__inner">
        <div className="linggan-v2-footer__brand">
          <div className="linggan-v2-footer__brand-line"><Sparkles size={20} /><strong>{lang === 'zh' ? '灵感' : 'Linggan'}</strong></div>
          <p>{lang === 'zh' ? '从灵感到成品，让每一步都能继续创作' : 'Move from first idea to finished work without breaking the creative thread.'}</p>
        </div>
        <div className="linggan-v2-footer__groups">
          {groups.map(group => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.links.map(link => {
                const isExternal = /^https?:\/\//.test(link.href)
                return <a key={link.href} href={link.href} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noopener noreferrer' : undefined}>{link.label}</a>
              })}
            </section>
          ))}
        </div>
      </div>
      <div className="linggan-v2-footer__meta">
        <span>© 2026 Linggan. {lang === 'zh' ? '保留所有权利' : 'All rights reserved.'}</span>
        <span><i />{lang === 'zh' ? '创作服务运行正常' : 'Creative services operational'}</span>
      </div>
    </footer>
  )
}

export function LingganHomeSections({ lang, features, onLogin, onRegister }: LandingActionProps & { features: readonly LingganLandingFeature[] }) {
  const { works } = useRotatingLandingArtworks()
  return (
    <>
      <DraggableArtworkLab lang={lang} works={works} />
      <ProductScrollShowcase lang={lang} />
      <CreationFlow lang={lang} features={features} />
      <section id="create" className="linggan-v2-final-cta">
        <div className="linggan-v2-final-cta__visual" data-no-artwork-rotation aria-hidden="true">
          <div className="linggan-v2-final-cta__wordmark">
            <Suspense fallback={null}><TextHoverEffect text="LINGGAN" duration={0.2} /></Suspense>
          </div>
          {works.slice(8, 12).map((work, index) => <img key={work.src} src={work.src} alt="" style={{ '--cta-index': index } as CSSProperties} loading="lazy" />)}
        </div>
        <div className="linggan-v2-final-cta__copy">
          <span className="linggan-v2-kicker"><WandSparkles size={15} /> Begin with an idea</span>
          <h2>{lang === 'zh' ? '下一张画面，从这里开始' : 'Your next image starts here.'}</h2>
          <p>{lang === 'zh' ? '进入灵感，把脑海中的描述变成可以继续编辑和交付的作品' : 'Turn what you imagine into work you can edit, refine, and deliver.'}</p>
          <div>
            <button type="button" className="linggan-v2-button linggan-v2-button--primary" onClick={onLogin}>{lang === 'zh' ? '进入工作台' : 'Enter workspace'}<ArrowRight size={18} /></button>
            <button type="button" className="linggan-v2-button linggan-v2-button--ghost" onClick={onRegister}>{lang === 'zh' ? '免费注册' : 'Create account'}</button>
          </div>
        </div>
      </section>
      <LingganFooter lang={lang} />
    </>
  )
}

export function LingganFloatingDock({ lang, onLogin }: Pick<LandingActionProps, 'lang' | 'onLogin'>) {
  const items = [
    { title: lang === 'zh' ? '作品与风格' : 'Work', icon: <GalleryHorizontalEnd className="h-full w-full" />, href: '#gallery' },
    { title: lang === 'zh' ? '平台体验' : 'Studio', icon: <ImageIcon className="h-full w-full" />, href: '#studio' },
    { title: lang === 'zh' ? '创作流程' : 'Flow', icon: <Workflow className="h-full w-full" />, href: '#workflow' },
    { title: lang === 'zh' ? '开始创作' : 'Create', icon: <Sparkles className="h-full w-full" />, href: '#create' },
  ]

  const handleDockClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (anchor?.getAttribute('href') === '#create') {
      event.preventDefault()
      onLogin()
    }
  }

  return (
    <div className="linggan-v2-dock" onClick={handleDockClick}>
      <Suspense fallback={null}>
        <FloatingDock items={items} desktopClassName="linggan-v2-dock__desktop" mobileClassName="linggan-v2-dock__mobile" />
      </Suspense>
      <nav className="linggan-v2-dock__mobile-row" aria-label={lang === 'zh' ? '首页快捷导航' : 'Homepage shortcuts'}>
        {items.map(item => (
          <a key={item.href} href={item.href} aria-label={item.title} title={item.title}>
            <span>{item.icon}</span>
          </a>
        ))}
      </nav>
    </div>
  )
}
