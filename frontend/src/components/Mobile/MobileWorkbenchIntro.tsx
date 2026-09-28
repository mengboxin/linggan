type MobileWorkbenchKind = 'ppt' | 'poster' | 'science' | 'image' | 'retouch'

const WORKBENCH_CONTENT: Record<MobileWorkbenchKind, {
  eyebrow: string
  title: string
  description: string
  icon: string
  primaryImage: string
  secondaryImage: string
}> = {
  ppt: {
    eyebrow: '可编辑演示',
    title: '从结构到成片的演示设计',
    description: '内容、版式与视觉素材会在同一条链路中完成。',
    icon: 'slideshow',
    primaryImage: '/showcase-ppt-hero-preview.webp',
    secondaryImage: '/showcase-ppt-architecture-preview.webp',
  },
  poster: {
    eyebrow: '视觉海报',
    title: '让画面先说出主题',
    description: '从创意、排版到质感，先确定一条视觉方向。',
    icon: 'auto_awesome',
    primaryImage: '/creative-library/gallery-poster-citrus-collage.webp',
    secondaryImage: '/creative-library/gallery-poster-swiss-grid.webp',
  },
  science: {
    eyebrow: '科研图表',
    title: '把研究关系变成清楚的图',
    description: '描述机制、数据或结构，生成可继续编辑的图表。',
    icon: 'science',
    primaryImage: '/creative-library/gallery-science-photonic-sensor.webp',
    secondaryImage: '/creative-library/gallery-science-organ-chip.webp',
  },
  image: {
    eyebrow: '自由图像创作',
    title: '从一句灵感，展开一张完整画面',
    description: '提示词、参考图、灵感配方和输出规格，都在同一张创作台里完成。',
    icon: 'auto_awesome',
    primaryImage: '/creative-library/welcome-zine-train-journey.webp',
    secondaryImage: '/creative-library/welcome-zine-mountain-lake.webp',
  },
  retouch: {
    eyebrow: '单图精修',
    title: '圈出想改的地方，再让画面继续生长',
    description: '导入图片或历史作品，标注区域后用 image2 完成局部改造。',
    icon: 'brush',
    primaryImage: '/creative-library/gallery-moments-photo-diary.webp',
    secondaryImage: '/creative-library/gallery-poster-citrus-collage.webp',
  },
}

interface MobileWorkbenchIntroProps {
  kind: MobileWorkbenchKind
}

/** A compact visual anchor for the three mobile creation workbenches. */
export function MobileWorkbenchIntro({ kind }: MobileWorkbenchIntroProps) {
  const content = WORKBENCH_CONTENT[kind]
  const artworkPool = kind === 'science' ? 'scientific' : kind === 'poster' ? 'poster' : 'all'

  return (
    <section className={`mobile-workbench-intro mobile-workbench-intro--${kind}`} aria-label={content.title}>
      <div className="mobile-workbench-intro__copy">
        <span className="mobile-workbench-intro__eyebrow">
          <span className="material-symbols-outlined" aria-hidden="true">{content.icon}</span>
          {content.eyebrow}
        </span>
        <h2>{content.title}</h2>
        <p>{content.description}</p>
      </div>
      <div className="mobile-workbench-intro__art" aria-hidden="true">
        <span className="mobile-workbench-intro__frame mobile-workbench-intro__frame--back">
          <img
            src={content.secondaryImage}
            alt=""
            loading="lazy"
            decoding="async"
            data-creative-artwork
            data-artwork-pool={artworkPool}
          />
        </span>
        <span className="mobile-workbench-intro__frame mobile-workbench-intro__frame--front">
          <img
            src={content.primaryImage}
            alt=""
            loading="lazy"
            decoding="async"
            data-creative-artwork
            data-artwork-pool={artworkPool}
          />
        </span>
      </div>
    </section>
  )
}
