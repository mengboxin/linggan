import type { Lang } from './i18n'
import type { PublicGalleryPreset } from './public-gallery-presets'

export interface LocalizedPublicGalleryCopy {
  title: string
  subtitle: string
  prompt: string
  tags: string[]
  author: string
  moduleLabel: string
  styleHint: string
}

const ENGLISH_TITLES: Record<string, string> = {
  'poster-george-bass-guide': 'Coastal Hiking Day Trip',
  'poster-george-bass-route': 'Coastal Route Guide',
  'poster-patisserie-steps': 'Patisserie Brand Story',
  'poster-cake-product': 'Cake Product Campaign',
  'poster-airclean-architecture': 'Clean-Air Architecture',
  'poster-smartclean-robot': 'Smart Cleaning Robot',
  'poster-atelier-men': 'Atelier Menswear',
  'poster-atelier-women': 'Atelier Womenswear',
  'poster-night-run': 'Night Run',
  'poster-citrus-paper-collage': 'Citrus Paper Collage',
  'poster-swiss-exhibition': 'Swiss Exhibition Poster',
  'poster-new-chinese-tea': 'Modern Chinese Tea',
  'science-nanocarrier-delivery': 'Nanocarrier Delivery',
  'science-flexible-battery': 'Flexible Battery',
  'science-watershed-ecosystem': 'Watershed Ecosystem',
  'science-hydrogel-repair-concept': 'Hydrogel Repair Concept',
  'image-zine-mountain-lake': 'Mountain Lake Zine',
  'image-zine-rainy-harbor': 'Rainy Harbor Bookstall',
  'image-zine-train-journey': 'Snowline Train Journey',
  'image-moments-solar-term': 'Early Autumn Soda',
  'image-moments-photo-diary': 'Weekend Flower Market Diary',
  'image-fantasy-cloud-market': 'Cloud Market Adventure',
  'image-comic-ip-harbor': 'Harbor Letter Office',
  'image-character-bible-cloud-lantern': 'Cloud Lantern Character Sheet',
  'image-library-stairwell-documentary': 'Library Stairwell',
  'image-eastern-still-life-plum': 'Plum Shadow Still Life',
  'image-coastal-paper-map': 'Coastal Paper Map',
  'image-natural-history-butterfly': 'Blue Butterfly Natural History',
  'science-polymer-cycle': 'Polymer Circular Pathway',
  'science-soil-carbon-cycle': 'Soil Carbon Cycle',
  'science-organ-chip': 'Organ-on-a-Chip Channels',
  'science-cool-roofs': 'Cool Roof Mechanism',
  'science-photonic-sensor': 'Photonic Sensor Pathway',
  'meigen-tang-fantasy-space': 'Tang Fantasy Megastructure',
  'meigen-chili-topdown': 'Chili Sauce Top View',
  'meigen-dragon-material': 'Metallic Glaze Creature',
  'meigen-candy-game-world': 'Candy Block Game World',
  'meigen-brush-portrait': 'Ink Brush Fashion Portrait',
  'high-concept-cosmic-vortex': 'Neural Cloud and Stellar Vortex',
  'high-concept-orbital-forge': 'Orbital Forge in a Storm',
  'high-concept-desert-rider': 'Desert Biomechanical Rider',
  'high-concept-tiger-interceptor': 'Tiger Interceptor Bike',
}

const TERM_EN: Record<string, string> = {
  '图片生成': 'image generation', '文生图': 'text to image', '图片编辑': 'image editing',
  '海报': 'poster', '科研': 'scientific figure', 'PPT': 'presentation',
  '高概念': 'high concept', '宇宙': 'cosmic', '电影感': 'cinematic', '角色设计': 'character design',
  '人物': 'portrait', '人物时尚': 'fashion portrait', '生活方式': 'lifestyle', '旅行': 'travel',
  '风景': 'landscape', '建筑': 'architecture', '品牌': 'branding', '产品': 'product',
  '包装': 'packaging', '编辑式排版': 'editorial layout', '编辑视觉': 'editorial visual',
  '科幻': 'science fiction', '工业科幻': 'industrial science fiction', '概念设计': 'concept design',
  '视觉灵感': 'visual inspiration', '科研图形摘要': 'scientific visual abstract',
  '机制图': 'mechanism diagram', '环境科学': 'environmental science', '生物工程': 'bioengineering',
  '原创角色': 'original character', '自然光': 'natural light', '静物': 'still life',
  '东方幻想': 'eastern fantasy', '公开作品': 'public work', '可参考提示词': 'reference prompt',
}

const TERM_ZH: Record<string, string> = {
  'image generation': '图片生成', 'text to image': '文生图', 'image editing': '图片编辑',
  'poster': '海报', 'scientific figure': '科研图', 'presentation': '演示文稿',
  'high concept': '高概念', 'cosmic': '宇宙', 'cinematic': '电影感', 'character design': '角色设计',
  'portrait': '人物肖像', 'fashion': '时尚', 'lifestyle': '生活方式', 'travel': '旅行',
  'landscape': '风景', 'architecture': '建筑', 'branding': '品牌', 'product': '产品',
  'packaging': '包装', 'concept': '概念设计', 'science fiction': '科幻',
}

const CURATED_TITLE_THEMES: Array<{ match: RegExp; zh: string; en: string }> = [
  { match: /(?:astronaut|space suit|moon(?:light| surface)?|lunar|cosmo|galaxy|nebula|planet)/i, zh: '星际远行者', en: 'Interstellar Wayfarer' },
  { match: /(?:football|soccer|bayern|real madrid|stadium|match score)/i, zh: '绿茵赛事视觉', en: 'Matchday Visual' },
  { match: /(?:handbag|purse|tote bag|leather bag|fashion bag)/i, zh: '流光手袋', en: 'Liquid Light Handbag' },
  { match: /(?:cat|kitten|feline)/i, zh: '猫咪疗愈时刻', en: 'Feline Reset' },
  { match: /(?:dog|puppy|canine)/i, zh: '犬系日常', en: 'Canine Daylight' },
  { match: /(?:wolf|tiger|lion|bear|fox|elephant|bird|butterfly|animal|wildlife)/i, zh: '野境肖像', en: 'Wild Portrait' },
  { match: /(?:food|cake|dessert|coffee|tea|drink|fruit|tomato|chili|ketchup|restaurant)/i, zh: '风味叙事', en: 'Flavor Story' },
  { match: /(?:poster|typography|editorial|campaign|branding|logo|magazine)/i, zh: '编辑视觉海报', en: 'Editorial Poster' },
  { match: /(?:fashion|model|dress|couture|outfit|clothing|menswear|womenswear)/i, zh: '时装编辑瞬间', en: 'Fashion Editorial' },
  { match: /(?:portrait|face|woman|man|girl|boy|character|figure|person)/i, zh: '人物光影研究', en: 'Portrait in Light' },
  { match: /(?:city|street|architecture|building|interior|room|library|house|hotel)/i, zh: '城市空间漫游', en: 'Urban Space Walk' },
  { match: /(?:mountain|forest|lake|ocean|sea|river|waterfall|desert|landscape|nature)/i, zh: '山野远景', en: 'Open Landscape' },
  { match: /(?:car|motorcycle|bike|train|aircraft|airplane|ship|vehicle)/i, zh: '行进中的风景', en: 'Moving Horizon' },
  { match: /(?:robot|cyber|futur|technology|machine|circuit|digital|ai)/i, zh: '未来感构想', en: 'Future Construct' },
  { match: /(?:flower|plant|garden|botanical|tree|leaf|moss)/i, zh: '植物感知', en: 'Botanical Study' },
  { match: /(?:paper|craft|clay|miniature|diorama|handmade)/i, zh: '手作微观世界', en: 'Handmade Miniature World' },
  { match: /(?:abstract|surreal|dream|fantasy|myth|magic|ethereal)/i, zh: '超现实片段', en: 'Surreal Fragment' },
  { match: /(?:product|package|bottle|chair|lamp|furniture|watch|phone)/i, zh: '产品静物构图', en: 'Product Still Life' },
]

const CURATED_TITLE_FALLBACKS = [
  { zh: '光影构图练习', en: 'Light and Composition' },
  { zh: '质感视觉实验', en: 'Material Study' },
  { zh: '情绪画面采样', en: 'Moodboard Moment' },
  { zh: '留白中的故事', en: 'Story in Negative Space' },
  { zh: '色彩叙事练习', en: 'Color Narrative' },
]

const CURATED_TITLE_MOMENTS = [
  { zh: '晨光', en: 'Morning Light' },
  { zh: '晴昼', en: 'Clear Day' },
  { zh: '午后', en: 'Afternoon' },
  { zh: '薄暮', en: 'Blue Hour' },
  { zh: '夜色', en: 'Nightfall' },
  { zh: '微雨', en: 'Soft Rain' },
  { zh: '雾起', en: 'Rising Mist' },
  { zh: '微风', en: 'Light Breeze' },
  { zh: '暖阳', en: 'Warm Sun' },
  { zh: '清影', en: 'Quiet Shadow' },
  { zh: '流光', en: 'Moving Light' },
  { zh: '远望', en: 'Distant View' },
  { zh: '近景', en: 'Close Study' },
  { zh: '漫游', en: 'Wander' },
  { zh: '停驻', en: 'Stillness' },
  { zh: '初遇', en: 'First Encounter' },
  { zh: '余韵', en: 'Afterglow' },
  { zh: '碎片', en: 'Fragment' },
  { zh: '留白', en: 'Negative Space' },
  { zh: '回声', en: 'Echo' },
]

const CURATED_TITLE_DETAILS = [
  { zh: '片段', en: 'Fragment' },
  { zh: '构图', en: 'Composition' },
  { zh: '瞬间', en: 'Moment' },
  { zh: '视角', en: 'Viewpoint' },
  { zh: '光影', en: 'Light Study' },
  { zh: '质感', en: 'Material Study' },
  { zh: '叙事', en: 'Narrative' },
  { zh: '小景', en: 'Scene' },
  { zh: '画面', en: 'Frame' },
  { zh: '观察', en: 'Observation' },
  { zh: '练习', en: 'Study' },
  { zh: '剪影', en: 'Silhouette' },
  { zh: '节奏', en: 'Rhythm' },
  { zh: '想象', en: 'Imagination' },
  { zh: '漫记', en: 'Notebook' },
]

function hasCjk(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

function isGenericCuratedTitle(value: string) {
  return /^(?:(?:creative|visual)\s+(?:reference|study)|创作参考|视觉参考)\s*(?:[·#-]?\s*\d+)?$/i.test(value.trim())
}

function stableTitleIndex(value: string, length: number) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  }
  return (hash >>> 0) % length
}

function curatedTitleVariant(item: PublicGalleryPreset, lang: Lang) {
  const trailingNumber = Number(item.id.match(/(\d+)(?!.*\d)/)?.[1])
  const index = Number.isFinite(trailingNumber) && trailingNumber > 0
    ? trailingNumber - 1
    : stableTitleIndex(item.id, CURATED_TITLE_MOMENTS.length * CURATED_TITLE_DETAILS.length)
  const moment = CURATED_TITLE_MOMENTS[index % CURATED_TITLE_MOMENTS.length]
  const detail = CURATED_TITLE_DETAILS[Math.floor(index / CURATED_TITLE_MOMENTS.length) % CURATED_TITLE_DETAILS.length]
  return lang === 'zh' ? `${moment.zh}${detail.zh}` : `${moment.en} ${detail.en}`
}

function curatedThemeTitle(item: PublicGalleryPreset, lang: Lang) {
  const source = `${item.title} ${item.subtitle} ${item.tags.join(' ')} ${item.prompt}`
  const theme = CURATED_TITLE_THEMES.find(candidate => candidate.match.test(source))
    || CURATED_TITLE_FALLBACKS[stableTitleIndex(item.id, CURATED_TITLE_FALLBACKS.length)]
  const title = lang === 'zh' ? theme.zh : theme.en
  return `${title} · ${curatedTitleVariant(item, lang)}`
}

function translateTag(value: string, lang: Lang) {
  const dictionary = lang === 'en' ? TERM_EN : TERM_ZH
  const normalized = value.trim()
  if (!normalized) return ''
  if (dictionary[normalized]) return dictionary[normalized]
  if (lang === 'en' && hasCjk(normalized)) return 'visual study'
  if (lang === 'zh' && !hasCjk(normalized)) return '视觉参考'
  return normalized
}

function englishTitle(item: PublicGalleryPreset) {
  // Imported artwork has an image, title, and prompt from one reviewed source
  // record. Never infer a new title from prompt keywords: incidental words
  // (for example "cat") made unrelated works appear under the wrong theme.
  if (item.id.startsWith('meigen-hosted-')) return item.title
  if (ENGLISH_TITLES[item.id]) return ENGLISH_TITLES[item.id]
  if (isGenericCuratedTitle(item.title)) return curatedThemeTitle(item, 'en')
  if (!hasCjk(item.title)) return item.title
  return curatedThemeTitle(item, 'en')
}

function chineseTitle(item: PublicGalleryPreset) {
  if (item.id.startsWith('meigen-hosted-')) return item.title
  if (isGenericCuratedTitle(item.title)) return curatedThemeTitle(item, 'zh')
  if (hasCjk(item.title)) return item.title
  return curatedThemeTitle(item, 'zh')
}

function moduleLabel(module: PublicGalleryPreset['module'], lang: Lang) {
  if (lang === 'zh') {
    if (module === 'POSTER_GEN') return '海报'
    if (module === 'SCI_FIG') return '科研图'
    if (module === 'PPT_GEN') return 'PPT'
    if (module === 'IMAGE_EDIT') return '图片编辑'
    return '文生图'
  }
  if (module === 'POSTER_GEN') return 'Poster'
  if (module === 'SCI_FIG') return 'Scientific figure'
  if (module === 'PPT_GEN') return 'Presentation'
  if (module === 'IMAGE_EDIT') return 'Image edit'
  return 'Text to image'
}

function englishPrompt(item: PublicGalleryPreset) {
  return item.prompt
}

function chinesePrompt(item: PublicGalleryPreset) {
  return item.prompt
}

/**
 * Every gallery surface uses the selected display language. Imported works
 * keep their source prompt only in the local catalog; the public UI receives
 * a matching production-ready prompt in the active language.
 */
export function localizePublicGalleryPreset(item: PublicGalleryPreset, lang: Lang): LocalizedPublicGalleryCopy {
  const title = lang === 'zh' ? chineseTitle(item) : englishTitle(item)
  const tags = Array.from(new Set(item.tags.map(tag => translateTag(tag, lang)).filter(Boolean))).slice(0, 5)
  const sourceSubtitle = item.subtitle.trim()
  const subtitle = lang === 'zh'
    ? (hasCjk(sourceSubtitle) ? sourceSubtitle : `${moduleLabel(item.module, lang)} / 公开创作参考`)
    : (!hasCjk(sourceSubtitle) ? sourceSubtitle : `${moduleLabel(item.module, lang)} / ${tags.slice(0, 2).join(' · ') || 'Visual reference'}`)
  const author = lang === 'en' && /^(Linggan|灵感)/i.test(item.author) ? 'Linggan Curated' : item.author
  const styleHint = item.styleHint
    ? (lang === 'zh'
      ? (hasCjk(item.styleHint) ? item.styleHint : '以清晰主体、克制配色、真实光线和可触摸材质完成画面叙事。')
      : (!hasCjk(item.styleHint) ? item.styleHint : 'Prioritize a clear subject, restrained color, intentional lighting, and tactile material detail.'))
    : ''

  return {
    title,
    subtitle,
    // A gallery prompt is generation data, not UI copy. Never paraphrase it
    // during localization: copy and "generate same" must reproduce its source.
    prompt: lang === 'zh' ? chinesePrompt(item) : englishPrompt(item),
    tags,
    author,
    moduleLabel: moduleLabel(item.module, lang),
    styleHint,
  }
}
