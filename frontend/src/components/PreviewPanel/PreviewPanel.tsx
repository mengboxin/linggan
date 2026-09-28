/**
 * PreviewPanel
 * Single-image preview for text-to-image mode.
 */
import React, { useEffect, useState } from 'react'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import type { GenCard } from '../GenerativeCanvas/GenerativeCanvas'
import { ImageGenerationFrame } from '../ui/ImageGenerationFrame'
import { ImageLightbox } from '../ui/ImageLightbox'
import { downloadImageSource, imageSrc } from '../../lib/image-url'
import { StudioAtmosphere } from '../ui/StudioAtmosphere'
import './PreviewPanel.css'

interface PreviewPanelProps {
  card: GenCard | null
  onZoom: (card: GenCard) => void
  onDownload: (card: GenCard) => void
  onEdit: (card: GenCard) => void
  onUseInspiration?: (prompt: string) => void
}

const PROMPT_MAX_LEN = 80

interface EmptyPreviewInspiration {
  title: string
  subtitle: string
  image: string
  prompt: string
  rotate: string
  aspect: 'poster' | 'landscape' | 'square'
  className: string
}

const EMPTY_PREVIEW_INSPIRATIONS: readonly EmptyPreviewInspiration[] = [
  {
    title: '山湖露营拼贴',
    subtitle: '手撕纸艺 · 风景',
    image: '/creative-library/welcome-zine-mountain-lake.webp',
    prompt: '竖版旅行杂志拼贴：清晨高原湖畔的帐篷和背包客作为真实摄影锚点，保留远山、湖面与帐篷关系；另一侧扩展为米白纸面上的抽象岩层和云雾插画，照片和插画之间有清晰手撕纸纤维边缘，一抹钴蓝从湖岸线延续到纸面。画面不生成文字、商标或水印。',
    rotate: '-7deg',
    aspect: 'poster',
    className: 'left-[7%] top-[17%] w-[27%] sm:w-[25%]',
  },
  {
    title: '雨港书摊',
    subtitle: '人物 · 夜航札记',
    image: '/creative-library/welcome-zine-rainy-harbor.webp',
    prompt: '竖版手撕杂志拼贴：雨后傍晚的海港小镇，一位穿姜黄雨衣的女性站在临海旧书摊旁；保留书摊、港湾与远处屋顶的真实摄影关系，再用象牙白手撕纸、靛蓝海浪剪纸、低饱和珊瑚票根碎片和铅笔路线勾线向外延展。独立杂志质感，克制、安静，不生成文字、商标、水印或电影滤镜。',
    rotate: '4deg',
    aspect: 'poster',
    className: 'left-[35%] top-[4%] z-10 w-[34%] sm:w-[31%]',
  },
  {
    title: '雪线列车',
    subtitle: '人物 · 高原旅程',
    image: '/creative-library/welcome-zine-train-journey.webp',
    prompt: '竖版手撕杂志拼贴：高原列车上，一位穿铁锈红毛衣的年轻男性望向窗外雪峰与湖泊；保留车厢、人物、湖面与山峰的真实场景，再用浅天蓝纸面、铅笔山脊线稿、苔绿邮票形状和少量手撕边缘组织版面。安静的独立旅行杂志质感，无文字、商标、水印、UI 或过度 HDR。',
    rotate: '-3deg',
    aspect: 'poster',
    className: 'right-[7%] top-[21%] w-[25%] sm:w-[23%]',
  },
  {
    title: '云朵集市奇遇',
    subtitle: '原创角色 · 轻幻想',
    image: '/creative-library/welcome-fantasy-cloud-market.webp',
    prompt: '方形原创轻幻想插画：傍晚的云朵集市漂浮在巨大蘑菇屋和暖色星球之间，一只戴红围巾的圆润小怪物骑纸飞机运送发光果实。主角动作清楚、远景简化、近景层次丰富，深青蓝天空配橙红灯光和柔粉云朵，预留干净呼吸空间，不生成文字、商标或水印。',
    rotate: '-11deg',
    aspect: 'square',
    className: 'left-[23%] top-[2%] w-[17%] sm:w-[15%]',
  },
  {
    title: '神经云海漩涡',
    subtitle: '高概念 · 宇宙奇观',
    image: '/creative-library/high-concept-cosmic-vortex.webp',
    prompt: '电影级宽幅宇宙景观：广阔行星表面覆盖厚重起伏的灰色神经纹理云层，中央形成巨大的旋转大气漩涡，核心散发炽热橙光；左上方悬浮一颗质感强烈的巨型行星，一道锐利蓝绿色脉冲星光束划破深空。低饱和钢蓝与炭黑配色，仅保留一处橙色暖光，硬朗高反差光影，超写实纹理和史诗尺度，无文字、商标或水印。',
    rotate: '7deg',
    aspect: 'landscape',
    className: 'right-[8%] bottom-[17%] w-[25%] sm:w-[22%]',
  },
  {
    title: '荒漠机械骑手',
    subtitle: '高概念 · 电影角色',
    image: '/creative-library/high-concept-desert-rider.webp',
    prompt: '全身电影剧照：一名低重心荒漠工业骑手穿着被沙尘磨损的破旧工装，骑乘钢制关节腿与赭黄色装甲构成的生物机械侦察单位。头顶强烈硬光形成锐利阴影，抛光外骨骼与哑光旧布产生材质对比；使用 ARRI Alexa、50mm 变形镜头、柯达 Vision3 500T 胶片颗粒和暖琥珀调色，避免霓虹、卡通、光滑塑料、过饱和色彩、文字和水印。',
    rotate: '8deg',
    aspect: 'poster',
    className: 'left-[15%] bottom-[15%] w-[16%] sm:w-[14%]',
  },
]

export function PreviewPanel({ card, onZoom, onDownload, onEdit, onUseInspiration }: PreviewPanelProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const [hovered, setHovered] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'failed'>('idle')
  const [fullscreen, setFullscreen] = useState(false)
  const isDark = theme === 'dark'

  useEffect(() => {
    setPromptExpanded(false)
    setDownloadState('idle')
  }, [card?.id])

  const originalImage = card?.localImageUrl || card?.imageUrl || card?.imageBase64 || ''
  const previewImage = card?.previewUrl || card?.thumbnailUrl || card?.thumbnailBase64 || ''
  const previewSrc = imageSrc(previewImage || originalImage)
  const originalSrc = imageSrc(originalImage)

  if (!card) {
    return (
      <div className="relative isolate flex flex-1 items-center justify-center overflow-hidden bg-[var(--app-canvas)] px-4 py-6" data-no-artwork-rotation>
        <StudioAtmosphere variant="workspace" />
        <div className="text-to-image-inspiration-stage relative z-10 flex w-full max-w-[880px] -translate-y-2 flex-col items-center">
          <div className="relative z-20 mb-4 w-[min(92%,390px)] border border-[var(--app-border)] bg-[var(--app-glass)] px-4 py-3 text-center text-[var(--app-text)] shadow-[var(--app-shadow)] backdrop-blur" style={{ borderRadius: 12 }}>
            <span className="block text-[7px] font-black tracking-[0.22em] text-[var(--app-primary)] opacity-80">VISUAL PROMPT STUDIO</span>
            <div className="mt-1 flex items-baseline justify-center gap-1.5 font-serif text-[17px] font-bold leading-none">
              <span>{lang === 'zh' ? '创作，从' : 'Create from'}</span>
              <em className="text-[var(--app-primary)]">{lang === 'zh' ? '这里开始' : 'here'}</em>
            </div>
            <p className="mt-1 text-[10px] leading-5 text-[var(--app-muted)]">
              {lang === 'zh' ? '选择挂画会把结构写入右侧提示词，也可以直接描述你的想法。' : 'Pick a hanging card to fill the prompt, or start with your own idea.'}
            </p>
          </div>
          <div className="relative z-10 mt-1 h-[min(58vw,460px)] min-h-[330px] w-full">
            {EMPTY_PREVIEW_INSPIRATIONS.map(item => (
              <button
                key={item.title}
                type="button"
                onClick={() => onUseInspiration?.(item.prompt)}
                className={`group absolute overflow-hidden border-[5px] border-white/85 bg-white text-left shadow-[0_18px_35px_rgba(27,20,12,0.25)] transition duration-300 hover:z-20 hover:-translate-y-2 hover:scale-[1.035] ${item.className}`}
                style={{ rotate: item.rotate, borderRadius: 8 }}
                aria-label={lang === 'zh' ? `使用${item.title}灵感` : `Use ${item.title}`}
                title={lang === 'zh' ? `使用${item.title}灵感` : `Use ${item.title}`}
              >
                <div className={`${item.aspect === 'landscape' ? 'aspect-[16/10]' : item.aspect === 'square' ? 'aspect-square' : 'aspect-[3/4]'} overflow-hidden bg-zinc-100`}>
                  <img src={item.image} alt={item.title} className="h-full w-full object-cover transition duration-500 group-hover:scale-110" />
                </div>
                <div className="px-2 py-2">
                  <div className="truncate text-[10px] font-black text-zinc-800">{item.title}</div>
                  <div className="mt-0.5 truncate text-[8px] font-bold text-zinc-500">{item.subtitle}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Keep the workbench on one display source. Promoting the original after the
  // preview paints causes a visible second flash, while zoom/download already
  // use originalImage below.
  const src = previewSrc || originalSrc
  const stableAssetBase = card.assetId ? `/api/assets/${encodeURIComponent(card.assetId)}` : ''
  const fallbackSrc = imageSrc(
    card.previewFallbackUrl
      || card.thumbnailFallbackUrl
      || card.imageFallbackUrl
      || (stableAssetBase ? `${stableAssetBase}/${previewImage ? 'preview' : 'original'}` : ''),
  )
  const loadingFullImage = Boolean(
    card.status !== 'failed'
      && (card.imageLoading || (!card.localImageUrl && !card.imageUrl && !card.previewUrl && !card.imageBase64 && card.hasImage)),
  )
  const generatingImage = Boolean(
    card.taskId
      && card.imageLoading
      && !card.hasImage
      && !originalSrc
      && !previewSrc
      && card.status !== 'completed'
      && card.status !== 'failed',
  )
  const canUseFullImage = Boolean(originalSrc || previewSrc)

  const promptText = card.prompt
  const isTruncated = promptText.length > PROMPT_MAX_LEN
  const displayPrompt = isTruncated && !promptExpanded
    ? `${promptText.slice(0, PROMPT_MAX_LEN)}...`
    : promptText

  const handleDownload = () => {
    const downloadSource = originalImage || previewImage
    if (!canUseFullImage || !downloadSource || downloadState === 'downloading') return
    const ts = card.createdAt || Date.now()
    setDownloadState('downloading')
    onDownload(card)
    void downloadImageSource(downloadSource, `gen_${ts}.png`)
      .then(() => setDownloadState('idle'))
      .catch(() => {
        setDownloadState('failed')
        window.setTimeout(() => setDownloadState('idle'), 2600)
      })
  }

  const handleZoom = () => {
    if (!canUseFullImage) return
    setFullscreen(true)
    onZoom(card)
  }

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(card.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  const actions = [
    {
      icon: 'zoom_in',
      label: lang === 'zh' ? '放大查看' : 'Preview',
      onClick: handleZoom,
      disabled: !canUseFullImage,
    },
    {
      icon: 'download',
      label: downloadState === 'downloading'
        ? (lang === 'zh' ? '正在下载' : 'Downloading')
        : downloadState === 'failed'
          ? (lang === 'zh' ? '下载失败，请重试' : 'Download failed, retry')
          : (lang === 'zh' ? '下载原图' : 'Download original'),
      onClick: handleDownload,
      disabled: !canUseFullImage || downloadState === 'downloading',
    },
    {
      icon: 'brush',
      label: lang === 'zh' ? '编辑' : 'Edit',
      onClick: () => onEdit(card),
      highlight: true,
    },
  ]

  const promptCardStyle = {
    background: isDark ? 'rgba(24,24,27,0.88)' : 'rgba(255,255,255,0.92)',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
    boxShadow: isDark ? '0 10px 24px rgba(0,0,0,0.28)' : '0 10px 24px rgba(15,23,42,0.06)',
  }

  return (
    <>
      <div
        className="text-to-image-history-preview flex flex-1 flex-col items-center justify-center gap-4 p-4 min-h-0"
        data-testid="text-to-image-history-preview"
        style={{ backgroundColor: isDark ? '#151518' : '#f3ede3' }}
      >
        <div
          className="flex items-center justify-center"
          style={{ width: 'min(92%, 860px)', maxHeight: 'calc(100% - 128px)' }}
        >
          <div
            className="relative inline-flex max-h-full max-w-full cursor-pointer overflow-hidden rounded-xl"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={canUseFullImage ? handleZoom : undefined}
            title={lang === 'zh' ? '点击放大查看' : 'Click to preview'}
          >
            <ImageGenerationFrame
              key={card.id}
              src={src}
              fallbackSrc={fallbackSrc}
              alt={card.prompt}
              busy={loadingFullImage}
              error={card.status === 'failed' ? card.error : undefined}
              label={generatingImage
                ? (lang === 'zh' ? '正在生成图片...' : 'Generating image...')
                : (lang === 'zh' ? '正在加载图片...' : 'Loading image...')}
              hint={generatingImage ? (lang === 'zh' ? '构图 · 渲染 · 保存' : 'Composing · Rendering · Saving') : undefined}
              aspectRatio="auto"
              isDark={isDark}
              accent="var(--app-primary)"
              fit="contain"
              className="max-h-[min(66vh,720px)] w-[min(72vw,640px)] rounded-xl border-zinc-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.6)]"
              style={{
                '--image-frame-max-width': 'min(72vw, 640px)',
                '--image-frame-max-height': 'min(66vh, 720px)',
              } as React.CSSProperties}
            />

            <div
              className="preview-panel__image-scrim absolute inset-0 flex items-center justify-center transition-opacity duration-200"
              onFocusCapture={() => setHovered(true)}
              onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false)
              }}
              style={{
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
              }}
            >
              {!loadingFullImage && (
                <div
                  className="preview-panel__action-dock"
                  role="toolbar"
                  aria-label={lang === 'zh' ? '图片预览操作' : 'Image preview actions'}
                  onClick={event => event.stopPropagation()}
                >
                  {actions.map(action => (
                    <button
                      key={action.icon}
                      type="button"
                      disabled={action.disabled}
                      onClick={event => {
                        event.stopPropagation()
                        if (action.disabled) return
                        action.onClick()
                      }}
                      title={action.label}
                      aria-label={action.label}
                      className="preview-panel__action"
                      data-highlight={action.highlight ? 'true' : undefined}
                    >
                      <span
                        className="preview-panel__action-icon material-symbols-outlined"
                        aria-hidden="true"
                        style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
                      >
                        {action.icon}
                      </span>
                      <span className="preview-panel__action-label">{action.label}</span>
                    </button>
                  ))}
                  <span className="preview-panel__action-dock-shine" aria-hidden="true" />
                </div>
              )}
            </div>
          </div>
        </div>

        <div data-testid="prompt-card" className="w-full max-w-[min(92%,860px)] rounded-xl px-4 py-3" style={promptCardStyle}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div
              className="inline-flex items-center gap-1.5 font-['Space_Grotesk'] text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: isDark ? '#a1a1aa' : '#7a7067' }}
            >
              <span className="material-symbols-outlined text-[14px]">chat</span>
              <span>{lang === 'zh' ? '本次提示词' : 'Prompt'}</span>
            </div>
            <button
              onClick={handleCopyPrompt}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-['Space_Grotesk'] text-[10px] uppercase tracking-wider transition-colors"
              style={{
                background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)',
                border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
                color: isDark ? '#d4d4d8' : '#475569',
              }}
              title={lang === 'zh' ? '复制提示词' : 'Copy prompt'}
            >
              <span className="material-symbols-outlined text-[13px]">{copied ? 'check' : 'content_copy'}</span>
              {copied ? (lang === 'zh' ? '已复制' : 'Copied') : (lang === 'zh' ? '复制' : 'Copy')}
            </button>
          </div>

          <div
            data-testid="prompt-scroll"
            className={promptExpanded ? 'max-h-[180px] overflow-y-auto pr-1' : ''}
          >
            <p
              data-testid="prompt-text"
              className="font-['Space_Grotesk'] text-[12px] leading-relaxed text-left"
              style={{ color: isDark ? '#f4f4f5' : '#1f2937' }}
            >
              {displayPrompt}
            </p>
          </div>

          {isTruncated && (
            <button
              data-testid="expand-btn"
              onClick={() => setPromptExpanded(value => !value)}
              className="mt-2 font-['Space_Grotesk'] text-[10px] uppercase tracking-wider transition-colors"
              style={{ color: `var(--app-accent, ${isDark ? '#d4d4d8' : '#c87900'})` }}
            >
              {promptExpanded
                ? (lang === 'zh' ? '收起' : 'Collapse')
                : (lang === 'zh' ? '展开全部' : 'Expand')}
            </button>
          )}
        </div>
      </div>

      {fullscreen && (
        <ImageLightbox
          src={originalSrc || src}
          alt={card.prompt}
          caption={lang === 'zh' ? '文生图预览' : 'Text-to-image preview'}
          meta={card.prompt}
          onClose={() => setFullscreen(false)}
          onDownload={handleDownload}
        />
      )}
    </>
  )
}

export function generateDownloadFilename(card: Pick<GenCard, 'createdAt'>): string {
  return `gen_${card.createdAt}.png`
}
