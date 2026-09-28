import { validateCanvasFlowConnection } from './canvas-flow-connections'
import {
  canvasFlowResultHasMedia,
  createCanvasFlowNode,
  type CanvasFlowEdge,
  type CanvasFlowNode,
  type CanvasFlowNodeData,
  type CanvasFlowNodeKind,
} from './canvas-flow-document'
import { layoutCanvasFlowNodes, type CanvasFlowGraph } from './canvas-flow-editing'

export const CANVAS_FLOW_DIRECTOR_MAX_SHOTS = 8
export const CANVAS_FLOW_DIRECTOR_DEFAULT_SHOTS = 6
export const CANVAS_FLOW_DIRECTOR_MAX_CHARACTERS = 4

export type CanvasFlowDirectorMode = 'shot_pipeline' | 'nine_grid'
export type CanvasFlowDirectorInputMode = 'plan' | 'inherit'
export type CanvasFlowDirectorIntent = 'plan' | 'edit' | 'rebuild'
export type CanvasFlowDirectorObjective = 'full_episode' | 'script_breakdown' | 'character_consistency' | 'shot_production'
export type CanvasFlowDirectorSourceKind = 'premise' | 'script' | 'canvas'
export type CanvasFlowDirectorRole = 'story' | 'script' | 'board' | 'style' | 'character' | 'shot' | 'review'
export type CanvasFlowDirectorGenre = 'urban' | 'apocalypse' | 'xianxia' | 'campus' | 'rule_horror' | 'office' | 'costume' | 'scifi' | 'mystery' | 'romance' | 'war' | 'custom'
export type CanvasFlowDirectorLook = 'manhua' | 'manga' | 'live_action' | 'cinematic' | 'illustration'
export type CanvasFlowDirectorStage = 'script' | 'board' | 'cast' | 'stills' | 'episode'
export type CanvasFlowDirectorStepId = 'intake' | 'script' | 'board' | 'cast' | 'shots' | 'prompts' | 'review'

export const CANVAS_FLOW_DIRECTOR_MAX_TOPIC = 8000
export const CANVAS_FLOW_DIRECTOR_TEMPLATE_CLICHES = [
  '一句闲话或一个眼神把身份差露出来',
  '当众被低估或羞辱',
  '证据翻盘',
  '日常裂口',
]

export const CANVAS_FLOW_DIRECTOR_GENRES: Array<{
  id: CanvasFlowDirectorGenre
  label: string
  hint: string
  example: string
}> = [
  { id: 'urban', label: '都市情感', hint: '当众高光必须是动作或对白，不是眼神', example: '年会上麦递到装穷 intern 手里，大屏突然打出她的旧名字' },
  { id: 'apocalypse', label: '末世觉醒', hint: '先给一个救人/能力兑现，再给暴露的代价', example: '集市里有人要踢倒摊主，他伸手去挡，手腕旧表开始倒转' },
  { id: 'xianxia', label: '仙侠玄幻', hint: '境界差落在一个看得见的法术或器物上', example: '外门弟子当众点燃嫡脉废炉，炉里飞出一枚识海钉' },
  { id: 'campus', label: '校园青春', hint: '公开课/操场，同辈对峙，高光是具体答题或比赛', example: '公开课上粉笔砸到转校生桌上，他必须站着把那道题算完' },
  { id: 'rule_horror', label: '规则怪谈', hint: '可执行禁令，违反有可见后果', example: '晚自习后禁止回头看三楼，值日生袖章发黑时不要跟他走' },
  { id: 'office', label: '职场逆袭', hint: '会议室里有一件当众放完的证据', example: '被甩锅的项目经理把录音放到董事会正中间' },
  { id: 'costume', label: '古装权谋', hint: '宴席/朝堂上一句错话或一份诏书掀桌', example: '冷宫妃子把先帝密诏拍进中秋家宴' },
  { id: 'scifi', label: '科幻未来', hint: '一条可读的系统规则，身体或工牌变化看得见', example: '快递员的工牌在安检口自己变成舰长编号' },
  { id: 'mystery', label: '悬疑推理', hint: '证物、不在场证明必须看得见', example: '停尸间抽屉里多出一枚还温热的校徽' },
  { id: 'romance', label: '甜宠日常', hint: '当众高光是具体动作，不是眼神蒙太奇', example: '她把迟到的便当拍到他竞赛桌上，全场回头' },
  { id: 'war', label: '战争历史', hint: '一条军令和一个可见代价', example: '通讯兵把已经作废的撤退令送到前线' },
  { id: 'custom', label: '自定义', hint: '按你写的题材发明一集，不套类型母题', example: '' },
]

export const CANVAS_FLOW_DIRECTOR_LOOKS: Array<{
  id: CanvasFlowDirectorLook
  label: string
  prompt: string
  quality: string
  sheetKind: string
  stillKind: string
}> = [
  {
    id: 'manhua',
    label: '国漫剧场',
    prompt: '当代国漫厚涂剧场，电影构图，皮肤有体积和血色，服装褶皱清楚，五官立体，不是日漫大眼赛璐璐，不是扁平贴纸。',
    quality: '国漫厚涂，体积感强，8K 高清，无文字，无水印。',
    sheetKind: '国漫角色设定稿',
    stillKind: '国漫宽银幕剧照',
  },
  {
    id: 'manga',
    label: '日韩漫画',
    prompt: '日韩漫画赛璐璐平涂，干净流畅线条，精致五官，类似高质量乙游动态漫，统一光源。',
    quality: '日韩漫画平涂，线条干净，8K 高清，无文字，无水印。',
    sheetKind: '日韩漫画人物设定稿',
    stillKind: '日韩漫画宽银幕剧照',
  },
  {
    id: 'live_action',
    label: '数字真人',
    prompt: '超写实数字短剧剧照，皮肤毛孔、布料质感、自然光和轻微镜头呼吸，像真人短剧，不是二次元，不是漫画线稿，不是插画描边。',
    quality: '超写实数字短剧，自然光，8K 高清，无文字，无水印。',
    sheetKind: '超写实数字演员造型照',
    stillKind: '超写实数字短剧剧照',
  },
  {
    id: 'cinematic',
    label: '电影感',
    prompt: '电影剧照，浅景深，写实光影，16:9 宽银幕，偏真人质感的数字角色，色彩有胶片层次，不是动漫滤镜。',
    quality: '电影剧照，浅景深，8K 高清，无文字，无水印。',
    sheetKind: '电影角色造型定妆照',
    stillKind: '电影宽银幕剧照',
  },
  {
    id: 'illustration',
    label: '插画剧场',
    prompt: '高质量数字插画剧场，细腻光影和材质，偏概念艺术，构图完整，不是廉价日漫滤镜，不是简笔漫画。',
    quality: '高质量数字插画，8K 高清，无文字，无水印。',
    sheetKind: '概念艺术角色设定',
    stillKind: '概念艺术宽银幕剧照',
  },
]

export const CANVAS_FLOW_DIRECTOR_STAGES: Array<{
  id: CanvasFlowDirectorStage
  label: string
  detail: string
}> = [
  { id: 'script', label: '只写剧本', detail: '先写出故事卡和这一集能演的剧本，不铺生成节点。' },
  { id: 'board', label: '只做分镜', detail: '再拆成带景别、运镜和对白的分镜表。' },
  { id: 'cast', label: '角色垫图', detail: '三视图和正面锁定，专做角色一致性。' },
  { id: 'stills', label: '分镜静帧', detail: '每镜独立静帧，可当投产垫图，不出视频。' },
  { id: 'episode', label: '一集成片', detail: '静帧后再接图生视频，按镜头出片。' },
]

export const CANVAS_FLOW_DIRECTOR_STEPS: Array<{ id: CanvasFlowDirectorStepId; label: string; detail: string }> = [
  { id: 'intake', label: '识别素材', detail: '区分灵感、完整剧本和现有制作包。' },
  { id: 'script', label: '锁定故事', detail: '整理世界规则、人物、场次、动作与对白。' },
  { id: 'board', label: '拆解分镜', detail: '为每镜确定景别、运镜、画面和对白。' },
  { id: 'cast', label: '建立角色资产', detail: '生成三视图和正面锚点，保持跨镜一致。' },
  { id: 'shots', label: '搭建生产链', detail: '连接逐镜提示词、模型和结果节点。' },
  { id: 'prompts', label: '写入生成指令', detail: '把每镜可见内容与动作写入节点。' },
  { id: 'review', label: '建立交付检查', detail: '加入故事、角色、分镜和出图复核关口。' },
]

export const CANVAS_FLOW_DIRECTOR_OBJECTIVES: Array<{
  id: CanvasFlowDirectorObjective
  label: string
  detail: string
}> = [
  { id: 'full_episode', label: '完整制作包', detail: '从故事锁定到逐镜静帧和交付检查。' },
  { id: 'script_breakdown', label: '剧本拆解', detail: '保留原文事实，整理场次并拆成可执行分镜。' },
  { id: 'character_consistency', label: '角色一致性', detail: '建立角色档案、三视图和正面锚点。' },
  { id: 'shot_production', label: '分镜生产', detail: '把分镜接成逐镜提示词、生成和结果链。' },
]

const STAGE_RANK: Record<CanvasFlowDirectorStage, number> = {
  script: 0,
  board: 1,
  cast: 2,
  stills: 3,
  episode: 4,
}

export interface CanvasFlowDirectorCharacter {
  id: string
  name: string
  identity?: string
  sheetPrompt: string
}

export interface CanvasFlowDirectorShot {
  id: string
  title: string
  hasCharacters: boolean
  characterIds: string[]
  location: string
  shotSize: string
  camera: string
  action: string
  dialogue: string
  storyboard: string
  imagePrompt: string
  motionPrompt: string
  duration: number
}

export interface CanvasFlowDirectorBible {
  logline: string
  genre: CanvasFlowDirectorGenre
  look: CanvasFlowDirectorLook
  style: string
  setting: string
  hook: string
  conflict: string
  rules: string[]
  scriptCard: string
}

export interface CanvasFlowDirectorProduction {
  sourceKind: CanvasFlowDirectorSourceKind
  deliverables: string[]
  checkpoints: string[]
}

export interface CanvasFlowDirectorPlan {
  title: string
  mode: CanvasFlowDirectorMode
  stage: CanvasFlowDirectorStage
  objective: CanvasFlowDirectorObjective
  production: CanvasFlowDirectorProduction
  bible: CanvasFlowDirectorBible
  characters: CanvasFlowDirectorCharacter[]
  shots: CanvasFlowDirectorShot[]
  motionPrompt?: string
}

export interface CanvasFlowDirectorCompileOptions {
  includeVideo?: boolean
  stage?: CanvasFlowDirectorStage
  look?: CanvasFlowDirectorLook
  modelId?: string
  modelName?: string
  videoModelId?: string
  videoModelName?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  origin?: { x: number; y: number }
  occupiedIds?: Iterable<string>
}

export interface CanvasFlowDirectorGraphInsight {
  nodeCount: number
  edgeCount: number
  notes: number
  prompts: number
  generators: number
  videos: number
  results: number
  completedResults: number
  hasScript: boolean
  hasBoard: boolean
  hasCast: boolean
  hasStills: boolean
  hasVideo: boolean
  missingCharacterAnchors: boolean
  videoWithoutStill: boolean
}

export interface CanvasFlowDirectorSuggestion {
  id: string
  title: string
  detail: string
  action: 'direct' | 'run' | 'review'
}

export interface CanvasFlowDirectorProductionProfile extends CanvasFlowDirectorProduction {
  stage: CanvasFlowDirectorStage
}

export function resolveCanvasFlowDirectorObjective(value: unknown): CanvasFlowDirectorObjective {
  const raw = cleanText(value).replace(/-/g, '_')
  return CANVAS_FLOW_DIRECTOR_OBJECTIVES.some(item => item.id === raw)
    ? raw as CanvasFlowDirectorObjective
    : 'full_episode'
}

export function resolveCanvasFlowDirectorSourceKind(value: unknown): CanvasFlowDirectorSourceKind {
  const raw = cleanText(value)
  return raw === 'script' || raw === 'canvas' ? raw : 'premise'
}

export function productionProfileForCanvasFlowDirector(
  objective: CanvasFlowDirectorObjective,
  sourceKind: CanvasFlowDirectorSourceKind,
  includeVideo: boolean,
): CanvasFlowDirectorProductionProfile {
  if (objective === 'script_breakdown') {
    return {
      sourceKind,
      stage: 'board',
      deliverables: sourceKind === 'script'
        ? ['原文事实', '场次拆解', '分镜表', '连续性检查']
        : ['故事设定', '可拍剧本', '分镜表', '连续性检查'],
      checkpoints: ['事实核对', '故事锁定', '分镜锁定'],
    }
  }
  if (objective === 'character_consistency') {
    return {
      sourceKind,
      stage: 'cast',
      deliverables: ['角色档案', '造型规则', '三视图', '正面锚点'],
      checkpoints: ['角色锁定', '造型一致性'],
    }
  }
  if (objective === 'shot_production') {
    return {
      sourceKind,
      stage: 'stills',
      deliverables: ['分镜表', '角色引用', '逐镜提示词', '逐镜静帧', '结果预览'],
      checkpoints: ['角色锁定', '分镜锁定', '出图复核'],
    }
  }
  return {
    sourceKind,
    stage: includeVideo ? 'episode' : 'stills',
    deliverables: [
      sourceKind === 'script' ? '原文事实' : '故事设定',
      '可拍剧本',
      '角色资产',
      '分镜表',
      '逐镜静帧',
      ...(includeVideo ? ['逐镜视频'] : []),
      '交付检查',
    ],
    checkpoints: ['故事锁定', '角色锁定', '分镜锁定', '出图复核', ...(includeVideo ? ['成片复核'] : [])],
  }
}

/** Give existing canvases an edit prompt grounded in their actual nodes. */
export function canvasFlowDirectorEditPlaceholder(graph: { nodes: CanvasFlowNode[] }) {
  const titles = graph.nodes
    .map(node => String(node.data.title || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const shot = titles.find(title => /(?:第\s*[一二三四五六七八1-8]\s*镜|镜头|分镜)/.test(title))
  const target = shot || titles[0]
  return target
    ? `例如：修改「${target.slice(0, 28)}」的画面、对白或提示词。`
    : '告诉我需要修改的角色、镜头、规则或连线。'
}

export type CanvasFlowDesignOp =
  | { type: 'add_node'; step: CanvasFlowDirectorStepId; node: CanvasFlowNode }
  | { type: 'add_edge'; step: CanvasFlowDirectorStepId; edge: CanvasFlowEdge }

export interface CanvasFlowDirectorCompileResult {
  ops: CanvasFlowDesignOp[]
  graph: CanvasFlowGraph
  plan: CanvasFlowDirectorPlan
}

const AGE_WORD = /男孩|女孩|少年|孩子|儿童|幼童|\bboy\b|\bgirl\b|\bchild\b|\bkid\b|\bteen\b|\byoung\b/gi
const REAL_FACE = /真实人脸|真人面部|real human face|real person/gi
const ANTISLOP = /令人叹为观止|视觉盛宴|光影交响|巧妙融合|震撼人心|breathtaking|stunning|cinematic masterpiece|a symphony of|seamlessly|flawlessly|groundbreaking/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cleanText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : fallback
}

function cleanMultiline(value: unknown, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || fallback
}

function slugId(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || fallback
}

function clampDuration(value: unknown, fallback = 5) {
  const duration = Number(value)
  if (!Number.isFinite(duration)) return fallback
  return Math.max(1, Math.min(15, Math.round(duration)))
}

function sanitizeVisualText(value: string) {
  return value
    .replace(AGE_WORD, '角色')
    .replace(REAL_FACE, '超逼真数字角色')
    .replace(ANTISLOP, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function sanitizeVisualMultiline(value: string) {
  return value
    .replace(AGE_WORD, '角色')
    .replace(REAL_FACE, '超逼真数字角色')
    .replace(ANTISLOP, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function uniqueId(seed: string, occupied: Set<string>) {
  if (!occupied.has(seed)) {
    occupied.add(seed)
    return seed
  }
  let suffix = 2
  while (occupied.has(`${seed}-${suffix}`)) suffix += 1
  const id = `${seed}-${suffix}`
  occupied.add(id)
  return id
}

function asStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(item => cleanText(item)).filter(Boolean)
}

export function resolveCanvasFlowDirectorGenre(value: unknown, _topic = ''): CanvasFlowDirectorGenre {
  const raw = cleanText(value).replace(/-/g, '_')
  if (raw && CANVAS_FLOW_DIRECTOR_GENRES.some(item => item.id === raw)) {
    return raw as CanvasFlowDirectorGenre
  }
  return 'custom'
}

export function resolveCanvasFlowDirectorLook(value: unknown): CanvasFlowDirectorLook {
  const raw = cleanText(value).replace(/-/g, '_')
  if (raw === 'liveaction') return 'live_action'
  return CANVAS_FLOW_DIRECTOR_LOOKS.some(item => item.id === raw)
    ? raw as CanvasFlowDirectorLook
    : 'manhua'
}

export function resolveCanvasFlowDirectorStage(value: unknown): CanvasFlowDirectorStage {
  const raw = cleanText(value)
  if (!raw) return 'episode'
  if (raw === 'video' || raw === 'full') return 'episode'
  if (raw === 'character' || raw === 'sheet' || raw === 'sheets') return 'cast'
  if (raw === 'still' || raw === 'frames') return 'stills'
  if (raw === 'storyboard') return 'board'
  return CANVAS_FLOW_DIRECTOR_STAGES.some(item => item.id === raw)
    ? raw as CanvasFlowDirectorStage
    : 'stills'
}

export function canvasFlowDirectorLookSpec(look: CanvasFlowDirectorLook) {
  return CANVAS_FLOW_DIRECTOR_LOOKS.find(item => item.id === look) || CANVAS_FLOW_DIRECTOR_LOOKS[0]
}

export function canvasFlowDirectorGenreSpec(genre: CanvasFlowDirectorGenre) {
  return CANVAS_FLOW_DIRECTOR_GENRES.find(item => item.id === genre) || CANVAS_FLOW_DIRECTOR_GENRES[CANVAS_FLOW_DIRECTOR_GENRES.length - 1]
}

export function canvasFlowDirectorStageIncludes(stage: CanvasFlowDirectorStage, needed: CanvasFlowDirectorStage) {
  return STAGE_RANK[stage] >= STAGE_RANK[needed]
}

function defaultStyleForLook(look: CanvasFlowDirectorLook) {
  const spec = canvasFlowDirectorLookSpec(look)
  return `${spec.prompt} ${spec.quality}`
}

function inferLookFromStyle(style: string, fallback: CanvasFlowDirectorLook = 'manhua'): CanvasFlowDirectorLook {
  const text = style.toLowerCase()
  if (/真人|写实|live.?action|photoreal|超写实|短剧剧照/.test(text)) return 'live_action'
  if (/电影|cinematic|胶片|浅景深/.test(text)) return 'cinematic'
  if (/插画|concept art|概念艺术/.test(text)) return 'illustration'
  if (/日漫|赛璐璐|乙游|anime|manga|日韩漫画/.test(text)) return 'manga'
  if (/国漫|厚涂/.test(text)) return 'manhua'
  return fallback
}

export function parseCanvasFlowDirectorPlan(value: unknown): CanvasFlowDirectorPlan | null {
  if (!isRecord(value)) return null
  if (Object.keys(value).length === 0) return null
  const mode = cleanText(value.mode) === 'nine_grid' ? 'nine_grid' : 'shot_pipeline'
  const bibleValue = isRecord(value.bible) ? value.bible : {}
  const title = cleanText(value.title, '未命名漫剧')
  const look = resolveCanvasFlowDirectorLook(
    bibleValue.look || value.look || inferLookFromStyle(cleanText(bibleValue.style)),
  )
  const genre = resolveCanvasFlowDirectorGenre(bibleValue.genre || value.genre, title)
  const stage = resolveCanvasFlowDirectorStage(value.stage)
  const objective = resolveCanvasFlowDirectorObjective(value.objective)
  const productionValue = isRecord(value.production) ? value.production : {}
  const sourceKind = resolveCanvasFlowDirectorSourceKind(
    productionValue.source_kind ?? productionValue.sourceKind ?? value.source_kind ?? value.sourceKind
      ?? (cleanText(value.input_mode ?? value.inputMode) === 'inherit' ? 'script' : 'premise'),
  )
  const defaultProduction = productionProfileForCanvasFlowDirector(objective, sourceKind, stage === 'episode')
  const deliverables = asStringList(productionValue.deliverables).slice(0, 10)
  const checkpoints = asStringList(productionValue.checkpoints).slice(0, 8)
  const bible: CanvasFlowDirectorBible = {
    logline: sanitizeVisualText(cleanText(bibleValue.logline, title)),
    genre,
    look,
    style: sanitizeVisualText(cleanText(bibleValue.style, defaultStyleForLook(look))),
    setting: sanitizeVisualText(cleanText(bibleValue.setting)),
    hook: sanitizeVisualText(cleanText(bibleValue.hook)),
    conflict: sanitizeVisualText(cleanText(bibleValue.conflict)),
    rules: asStringList(bibleValue.rules).map(item => sanitizeVisualText(item)).filter(Boolean).slice(0, 6),
    scriptCard: sanitizeVisualMultiline(cleanMultiline(bibleValue.script_card ?? bibleValue.scriptCard, cleanText(bibleValue.logline, title))),
  }
  const characters: CanvasFlowDirectorCharacter[] = []
  for (const [index, entry] of (Array.isArray(value.characters) ? value.characters : []).entries()) {
    if (!isRecord(entry) || characters.length >= CANVAS_FLOW_DIRECTOR_MAX_CHARACTERS) continue
    const name = cleanText(entry.name, `角色${index + 1}`)
    const id = slugId(cleanText(entry.id, name), `char-${index + 1}`)
    const sheetPrompt = sanitizeVisualText(cleanText(entry.sheet_prompt ?? entry.sheetPrompt, name))
    if (!sheetPrompt) continue
    const identity = sanitizeVisualText(cleanText(entry.identity))
    characters.push(identity ? { id, name, identity, sheetPrompt } : { id, name, sheetPrompt })
  }

  const shotLimit = mode === 'nine_grid' ? 9 : CANVAS_FLOW_DIRECTOR_MAX_SHOTS
  const shots = (Array.isArray(value.shots) ? value.shots : [])
    .map((entry, index) => {
      if (!isRecord(entry)) return null
      const title = cleanText(entry.title, `镜头 ${index + 1}`)
      const id = slugId(cleanText(entry.id, `shot-${index + 1}`), `shot-${index + 1}`)
      const action = sanitizeVisualText(cleanText(entry.action, cleanText(entry.storyboard, title)))
      const location = sanitizeVisualText(cleanText(entry.location))
      const shotSize = sanitizeVisualText(cleanText(entry.shot_size ?? entry.shotSize, '中景'))
      const camera = sanitizeVisualText(cleanText(entry.camera, '固定'))
      const dialogue = sanitizeVisualText(cleanText(entry.dialogue))
      const storyboard = sanitizeVisualText(cleanText(entry.storyboard, action || title))
      const imagePrompt = sanitizeVisualText(cleanText(entry.image_prompt ?? entry.imagePrompt, storyboard))
      const motionPrompt = sanitizeVisualText(cleanText(entry.motion_prompt ?? entry.motionPrompt, camera || storyboard))
      if (!storyboard && !imagePrompt && !action) return null
      const characterIds = asStringList(entry.character_ids ?? entry.characterIds)
        .map(item => slugId(item, item))
        .filter(item => characters.some(character => character.id === item))
      const hasCharacters = entry.has_characters === true || entry.hasCharacters === true || characterIds.length > 0
      return {
        id,
        title,
        hasCharacters,
        characterIds,
        location,
        shotSize,
        camera,
        action: action || storyboard || title,
        dialogue,
        storyboard: storyboard || action || title,
        imagePrompt: imagePrompt || storyboard || title,
        motionPrompt: motionPrompt || camera || storyboard || title,
        duration: clampDuration(entry.duration, mode === 'nine_grid' ? 12 : 5),
      } satisfies CanvasFlowDirectorShot
    })
    .filter((entry): entry is CanvasFlowDirectorShot => Boolean(entry))
    .slice(0, shotLimit)

  if (!bible.logline && shots.length === 0) return null
  return {
    title,
    mode,
    stage,
    objective,
    production: {
      sourceKind,
      deliverables: deliverables.length ? deliverables : defaultProduction.deliverables,
      checkpoints: checkpoints.length ? checkpoints : defaultProduction.checkpoints,
    },
    bible,
    characters,
    shots,
    motionPrompt: sanitizeVisualText(cleanText(value.motion_prompt ?? value.motionPrompt)),
  }
}

function excerptTopic(topic: string, limit = 80) {
  const text = cleanText(topic, '未命名短剧')
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text
}

type FallbackEpisode = {
  title: string
  logline: string
  setting: string
  hook: string
  conflict: string
  rules: string[]
  scriptCard: string
  characters: CanvasFlowDirectorCharacter[]
  shots: Array<Omit<CanvasFlowDirectorShot, 'id' | 'hasCharacters' | 'characterIds'> & { characterKeys: string[] }>
}

function detectFallbackKind(topic: string, genre: CanvasFlowDirectorGenre) {
  if (/规则怪谈|校园怪谈|校规|禁止回头|值日生/.test(topic) || genre === 'rule_horror') return 'campus_rule'
  if (/末世|废墟|觉醒|丧尸|求生/.test(topic) || genre === 'apocalypse') return 'apocalypse'
  if (/董事会|录音|职场|项目经理/.test(topic) || genre === 'office') return 'office'
  if (/仙侠|宗门|灵根|修仙|炼器/.test(topic) || genre === 'xianxia') return 'xianxia'
  if (/古装|冷宫|密诏|朝堂|后宅/.test(topic) || genre === 'costume') return 'costume'
  if (/科幻|舰长|工牌|格式化|安检/.test(topic) || genre === 'scifi') return 'scifi'
  if (/年会|装穷|前未婚夫|当众翻盘|都市/.test(topic) || genre === 'urban') return 'urban'
  if (/公开课|转校生|操场|年级第一/.test(topic) || genre === 'campus') return 'campus'
  if (/停尸|校徽|推理|证物/.test(topic) || genre === 'mystery') return 'generic'
  if (/便当|甜宠|竞赛桌/.test(topic) || genre === 'romance') return 'generic'
  if (/撤退令|通讯兵|前线/.test(topic) || genre === 'war') return 'generic'
  return 'generic'
}

export function inferCanvasFlowDirectorSourceKind(topic: string, attachmentCount = 0): CanvasFlowDirectorSourceKind {
  const text = cleanMultiline(topic)
  if (attachmentCount > 0) return 'script'
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const screenplaySignals = [
    /(?:^|\n)\s*场\s*\d+/,
    /(?:^|\n)\s*(?:镜头|分镜)\s*\d+/,
    /(?:^|\n)[^\n：:]{1,12}[：:]\s*[「“\"]?[^\n]+/,
    /(?:日|夜)\s+(?:内|外)(?:\s|$)/,
    /(?:动作|对白|旁白|画外音)[：:]/,
  ].filter(pattern => pattern.test(text)).length
  if (screenplaySignals >= 1 && lines.length >= 2) return 'script'
  if (text.length >= 220 && lines.length >= 3) return 'script'
  return 'premise'
}

export function sourceLooksLikeScript(topic: string, attachmentCount = 0) {
  return inferCanvasFlowDirectorSourceKind(topic, attachmentCount) === 'script'
}

export function instructionLooksLikeRebuild(instruction: string) {
  return /全部重来|重新规划|整集重写|换个故事|按这份剧本重铺|推倒重来|重铺|换成.{0,20}(故事|董事会|题材|剧本)/.test(cleanText(instruction))
}

export function routeCanvasFlowDirectorIntent(input: {
  hasCanvas: boolean
  topic: string
  attachmentCount?: number
}): CanvasFlowDirectorIntent {
  if (!input.hasCanvas) return 'plan'
  if (instructionLooksLikeRebuild(input.topic)) return 'rebuild'
  return 'edit'
}

function fallbackEpisodeFor(topic: string, genre: CanvasFlowDirectorGenre): FallbackEpisode {
  const kind = detectFallbackKind(topic, genre)
  if (kind === 'campus_rule') {
    return {
      title: '夜自习守则 · 第一集',
      logline: '转校生林晚第一天夜自习，发现校规第三条会当场改写走廊。',
      setting: '旧教学楼三层，夜自习后的日光灯走廊和阶梯教室。',
      hook: '走廊尽头的灯一盏盏灭到她脚边，墙上校规自己多出一行红字。',
      conflict: '她回头看了一眼三楼，违反了「晚自习后禁止回头看三楼」。',
      rules: [
        '晚自习结束后必须在两分钟内离开教学楼。',
        '走廊只许往前走，禁止回头看三楼。',
        '如果有人在身后叫你的学号，不要答应。',
        '值日生袖章是红的才是人；袖章发黑时跟着他走的人会从名单上消失。',
      ],
      scriptCard: [
        '场1 日 外 校门：林晚第一次走进旧教学楼，广播重复「请遵守夜自习守则」。',
        '林晚：「这学校连校规都印红字？」',
        '场2 夜 内 三楼走廊：她看见告示「禁止回头看三楼」，身后有人喊「林晚」。',
        '值日生：「第三条规定过了。你回头了。」',
        '场3 夜 内 教室后门：灯一盏盏灭到她脚边，墙上多出新校规：回头的人留下值日。',
        '钩子：名单最后一行出现她的学号，还没写名字。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '林晚', identity: '刚转入的高中生', sheetPrompt: '十七八岁观感的转校生，黑色齐肩直发，深灰校服外套，白衬衫，深蓝领带，帆布鞋，神情克制，肩上斜挎旧书包。' },
        { id: 'monitor', name: '值日生', identity: '执行校规的人', sheetPrompt: '同龄值日生，寸头，校服扣到最上一颗，左臂红袖章，手持铁皮点名册，表情没有温度。' },
      ],
      shots: [
        { title: '校门广播', location: '旧教学楼门口', shotSize: '全景', camera: '缓推', action: '林晚停在校门，广播重复夜自习守则。', dialogue: '广播：请遵守夜自习守则。', storyboard: '日，校门外。林晚抬头看旧教学楼，广播正在念校规。', imagePrompt: '阴天旧教学楼门口，林晚背着书包停在铁门前，喇叭挂在门柱上。', motionPrompt: '从校门外缓推进到林晚停下的脚步。', duration: 5, characterKeys: ['hero'] },
        { title: '校规告示', location: '三楼走廊', shotSize: '特写接中景', camera: '切', action: '她看见墙上红字：晚自习后禁止回头看三楼。', dialogue: '林晚：禁止回头？', storyboard: '夜，走廊。先特写告示红字，再切到林晚侧脸。', imagePrompt: '日光灯走廊，墙上海报特写红字校规，林晚侧脸停住。', motionPrompt: '告示特写硬切到林晚侧脸。', duration: 4, characterKeys: ['hero'] },
        { title: '身后喊名', location: '三楼走廊', shotSize: '过肩', camera: '固定后微推', action: '身后有人喊她的学号，她的肩膀动了一下，还是没有回头。', dialogue: '值日生：林晚。', storyboard: '夜，走廊。镜头停在她后背，声音从画面外传来。', imagePrompt: '林晚背对镜头站在走廊中央，身后灯更暗，点名册的影子投在地上。', motionPrompt: '固定看她后背，轻微前推。', duration: 5, characterKeys: ['hero', 'monitor'] },
        { title: '回头的代价', location: '三楼走廊转角', shotSize: '中景', camera: '硬切', action: '她还是回头了。值日生站在灯下，袖章正在变黑。', dialogue: '值日生：第三条规定过了。你回头了。', storyboard: '她回头，值日生挡住去路，袖章从红转黑。', imagePrompt: '走廊转角中景，林晚回头，值日生挡住过道，红袖章正在发黑。', motionPrompt: '正反打，距离越来越近。', duration: 5, characterKeys: ['hero', 'monitor'] },
        { title: '灯灭到脚边', location: '阶梯教室后门', shotSize: '全景转特写', camera: '跟拍再切特写', action: '灯一盏盏灭到她脚边，墙上多出新校规。', dialogue: '新校规：回头的人留下值日。', storyboard: '她退进教室后门，灯灭到脚边，红字自己长出来。', imagePrompt: '空教室后门，灯一盏盏灭，墙上海报多出一行新红字。', motionPrompt: '跟她后退，再切到新校规特写。', duration: 6, characterKeys: ['hero'] },
        { title: '名单钩子', location: '教室讲台', shotSize: '特写', camera: '缓推', action: '点名册最后一行出现她的学号，名字栏还是空的。', dialogue: '', storyboard: '铁皮点名册特写，最后一行只有学号。', imagePrompt: '讲台上打开的铁皮点名册，最后一行红笔学号，名字栏空白。', motionPrompt: '缓推进到学号那一行停住。', duration: 4, characterKeys: [] },
      ],
    }
  }
  if (kind === 'office') {
    const name = /沈渡/.test(topic) ? '沈渡' : '主角'
    return {
      title: `${name}的录音 · 第一集`,
      logline: `${name}把录音放进董事会，甩锅的人第一次当众说不出话。`,
      setting: '白天，高层玻璃会议室。',
      hook: '录音刚响第一句，对面的手就按住了话筒。',
      conflict: '项目被栽赃，唯一证据是一段被删过的录音。',
      rules: ['证据必须当众放完，中途停掉就作废。'],
      scriptCard: [
        `场1 日 内 会议室门外：${name}整理衣领，手机里是那段录音。`,
        `${name}：「这次不解释。只放证据。」`,
        '场2 日 内 董事会：录音放到栽赃原话，对面伸手去抢手机。',
        '钩子：录音还没放完，门又被推开。',
      ].join('\n'),
      characters: [
        { id: 'hero', name, identity: '被甩锅的项目负责人', sheetPrompt: '成年职场人，深色西装，白衬衫，没有领带，黑眼圈，手里捏着旧手机。' },
        { id: 'boss', name: '对面', identity: '甩锅的上级', sheetPrompt: '中年管理者，浅灰西装，袖扣发亮，笑容先于眼睛到达。' },
      ],
      shots: [
        { title: '门外整理', location: '会议室门外', shotSize: '中景', camera: '缓推', action: `${name}停在门外，拇指按在播放键上。`, dialogue: `${name}：这次不解释。只放证据。`, storyboard: '日，门外。她/他深呼吸，推门。', imagePrompt: '玻璃门外中景，职场人按住手机，会议室灯光从门缝漏出。', motionPrompt: '缓推进到按播放键的手指。', duration: 4, characterKeys: ['hero'] },
        { title: '录音第一句', location: '董事会长桌', shotSize: '近景', camera: '固定', action: '手机立在桌上，录音响起栽赃原话。', dialogue: '录音：这锅必须让项目组背。', storyboard: '日，长桌。全场听第一句。', imagePrompt: '长桌近景，旧手机立着，对面的手停在半空。', motionPrompt: '固定听完第一句。', duration: 5, characterKeys: ['hero', 'boss'] },
        { title: '抢手机', location: '董事会长桌', shotSize: '中景', camera: '硬切', action: '对面伸手去抢，被按住手腕。', dialogue: '对面：先停一下。', storyboard: '抢手机失败，录音还在放。', imagePrompt: '两只手在桌面上僵持，手机还在震动。', motionPrompt: '硬切到僵持的手。', duration: 4, characterKeys: ['hero', 'boss'] },
        { title: '门又开了', location: '会议室门口', shotSize: '全景', camera: '缓拉', action: '录音没放完，门再次被推开。', dialogue: '', storyboard: '全场回头，门口站着新的人影。', imagePrompt: '玻璃会议室全景，门开着，逆光人影，桌上手机还亮着。', motionPrompt: '缓拉到门口停住。', duration: 5, characterKeys: ['hero'] },
        { title: '证据还在响', location: '董事会长桌', shotSize: '特写', camera: '缓推', action: '手机屏幕还在跳动波形，没人敢伸第二只手。', dialogue: '', storyboard: '特写还在响的手机，全场手都停着。', imagePrompt: '旧手机屏幕波形特写，一圈停在半空的手。', motionPrompt: '缓推进波形。', duration: 4, characterKeys: [] },
        { title: '门外的人', location: '会议室门口', shotSize: '过肩', camera: '固定', action: '门口的人影没有进来，只把文件夹换到另一只手。', dialogue: '', storyboard: '钩子：真正要听这段录音的人还站在门外。', imagePrompt: '逆光门口，人影抱着文件夹，会议室里所有人都看着门。', motionPrompt: '固定停在门口。', duration: 4, characterKeys: ['hero'] },
      ],
    }
  }
  if (kind === 'apocalypse') {
    return {
      title: '废墟招人 · 第一集',
      logline: '陆明在集市挡住一脚，第一次当众把系统能力用出来。',
      setting: '末日后的城市废墟和地下集市。',
      hook: '他挡住那一脚时，手腕上的旧表针突然倒转。',
      conflict: '救人会暴露能力，暴露就会被招进不该进的队伍。',
      rules: ['白天不在高处停留。', '集市里动手，会被「招人的人」盯上。'],
      scriptCard: [
        '场1 日 外 废墟：陆明穿过倒塌高楼，旧表一直停着。',
        '场2 日 内 地下集市：有人踢向宁曦，他伸手去挡。',
        '陆明：「别碰她。」',
        '钩子：表针倒转的同时，远处有人开始记他的脸。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '陆明', identity: '在废墟里活下来的人', sheetPrompt: '成年男性，黑色微长碎发，深棕风衣，脏靴，左手旧表，神情压着怒。' },
        { id: 'heroine', name: '宁曦', identity: '被集市欺压的人', sheetPrompt: '成年女性，黑色长发披肩，旧绿外套，手腕有擦伤，表情先怕后盯人。' },
      ],
      shots: [
        { title: '废墟远景', location: '倒塌街区', shotSize: '远景', camera: '缓推', action: '陆明独自走过黑烟和高楼残骸。', dialogue: '', storyboard: '日，废墟。一个人很小。', imagePrompt: '倒塌高楼与黑烟，一个穿风衣的人走在尘土路上。', motionPrompt: '高处缓推进入废墟。', duration: 5, characterKeys: ['hero'] },
        { title: '集市拦人', location: '地下集市角落', shotSize: '中景', camera: '硬切', action: '有人踢向宁曦，陆明伸臂挡住。', dialogue: '陆明：别碰她。', storyboard: '日，集市。拦截动作清楚。', imagePrompt: '狭窄集市中景，陆明挡住踢出的腿，宁曦摔倒在地摊边。', motionPrompt: '硬切到拦截瞬间。', duration: 5, characterKeys: ['hero', 'heroine'] },
        { title: '表针倒转', location: '陆明手腕', shotSize: '特写', camera: '缓推', action: '旧表针突然倒转一格。', dialogue: '', storyboard: '表针特写，集市嘈杂被压低。', imagePrompt: '脏旧手表特写，指针反向跳动，背景虚化的集市灯。', motionPrompt: '缓推进指针。', duration: 4, characterKeys: ['hero'] },
        { title: '有人在看', location: '集市出口', shotSize: '过肩', camera: '固定', action: '远处有人合上本子，记下他的脸。', dialogue: '', storyboard: '招人的人站在出口看他。', imagePrompt: '集市出口逆光，一个拿本子的人合上封面，陆明还跪在地上。', motionPrompt: '固定停在合本子的动作。', duration: 5, characterKeys: ['hero'] },
        { title: '表还在转', location: '陆明手腕', shotSize: '近景', camera: '切', action: '宁曦抓住他的手腕，表针又倒了一格。', dialogue: '宁曦：你的表在倒着走。', storyboard: '近景，两只手和倒转的表。', imagePrompt: '宁曦抓住陆明手腕，旧表指针反向跳，两人低头看。', motionPrompt: '切到两只手和表。', duration: 4, characterKeys: ['hero', 'heroine'] },
        { title: '被跟上', location: '集市外坡道', shotSize: '全景', camera: '缓拉', action: '他们离开集市，合本子的人跟在同一个出口。', dialogue: '', storyboard: '救人结束，跟踪开始。', imagePrompt: '废墟坡道全景，两个人往前走，出口处那人合上本子跟上。', motionPrompt: '缓拉出坡道。', duration: 5, characterKeys: ['hero', 'heroine'] },
      ],
    }
  }
  if (kind === 'campus') {
    return {
      title: '公开课第一题 · 第一集',
      logline: '转校生林晚被粉笔砸中桌子，必须站着把那道题算完。',
      setting: '白天，阶梯教室公开课。',
      hook: '粉笔砸在她摊开的本子上，全班转头。',
      conflict: '她不认识这所学校的题型，但坐下就算弃权。',
      rules: [
        '粉笔砸中谁的桌子，谁必须站着答完。',
        '公开课中途坐下，记一次弃权。',
        '年级第一有一次当场纠错的权利。',
      ],
      scriptCard: [
        '场1 日 内 阶梯教室：粉笔砸在林晚本子上，粉屑迸开。',
        '老师：「转校生，站着把这道题算完。」',
        '场2 日 内 黑板前：她写到第三步，年级第一周衡举手。',
        '周衡：「她用的不是我们的公式。」',
        '林晚：「那你上来写。」',
        '钩子：老师把她的名字写进下一次竞赛名单，没有问过她。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '林晚', identity: '刚转入的学生', sheetPrompt: '黑色齐肩直发，深灰校服，白衬衫，深蓝领带，神情克制，手指有粉笔灰。' },
        { id: 'rival', name: '周衡', identity: '年级第一', sheetPrompt: '短发整齐，校服熨平，袖口翻起一截，下巴微抬，手里转着自动笔。' },
      ],
      shots: [
        { title: '粉笔砸桌', location: '阶梯教室后排', shotSize: '特写接中景', camera: '硬切', action: '粉笔砸在摊开的本子上，粉屑迸到林晚手上。', dialogue: '老师：转校生，站着把这道题算完。', storyboard: '先特写粉笔砸本，再切全班回头。', imagePrompt: '课桌特写，粉笔砸进本子，粉屑飞起，林晚的手停住。', motionPrompt: '硬切到全班转头。', duration: 4, characterKeys: ['hero'] },
        { title: '她站起来', location: '阶梯教室过道', shotSize: '全景', camera: '缓推', action: '林晚抱着本子走上过道，周衡转笔看着她。', dialogue: '', storyboard: '日，教室。她从后排走到黑板。', imagePrompt: '阶梯教室全景，一个女生走上过道，前排男生转着笔看她。', motionPrompt: '从后排缓推跟上她。', duration: 5, characterKeys: ['hero', 'rival'] },
        { title: '板书第三步', location: '黑板前', shotSize: '中景', camera: '固定', action: '她在黑板上写到第三步，公式和墙上例题不一样。', dialogue: '周衡：她用的不是我们的公式。', storyboard: '板书清楚，周衡举手。', imagePrompt: '黑板中景，林晚写到一半，周衡举手，老师侧身。', motionPrompt: '固定看板书和举手。', duration: 5, characterKeys: ['hero', 'rival'] },
        { title: '把笔递回去', location: '黑板前', shotSize: '近景', camera: '正反打', action: '林晚把粉笔转过去，对着周衡。', dialogue: '林晚：那你上来写。', storyboard: '近景对峙，粉笔停在两人中间。', imagePrompt: '近景，粉笔横在两人之间，林晚看着周衡。', motionPrompt: '正反打。', duration: 4, characterKeys: ['hero', 'rival'] },
        { title: '她写完', location: '黑板', shotSize: '特写', camera: '缓推', action: '最后一行数字落下，教室里有人把笔放下。', dialogue: '', storyboard: '板书收尾，不是口号，是算完。', imagePrompt: '黑板特写，最后一行数字，粉笔停住。', motionPrompt: '缓推进最后一行。', duration: 4, characterKeys: ['hero'] },
        { title: '竞赛名单', location: '讲台', shotSize: '特写', camera: '缓推', action: '老师把她的名字写进竞赛名单，没有问她。', dialogue: '', storyboard: '钩子：她赢了这一题，被写进下一场。', imagePrompt: '讲台名单特写，新写上林晚两个字，墨水还没干。', motionPrompt: '缓推进名字。', duration: 4, characterKeys: [] },
      ],
    }
  }
  if (kind === 'urban') {
    return {
      title: '年会旧名字 · 第一集',
      logline: '装穷 intern 苏晚在年会上接过话筒，大屏打出她已经改掉的旧名字。',
      setting: '晚上，酒店宴会厅年会。',
      hook: '麦递到她手里的同一秒，大屏翻到旧名字。',
      conflict: '她必须当着前未婚夫把这段主持完，中途放下麦就等于认。',
      rules: [
        '年会大屏名单一旦打出，现场不能撤回。',
        '话筒递到谁手里，谁必须把这段说完。',
        '中途把麦放下，就算默认大屏上的身份。',
      ],
      scriptCard: [
        '场1 夜 内 宴会厅侧门：苏晚整理工牌，不想走主入口。',
        '场2 夜 内 主桌前：主持把麦递过来，大屏翻页。',
        '苏晚：「今晚只报业绩。名字以后再改。」',
        '前未婚夫：「先停一下。」',
        '钩子：大屏下一页是一份没签完的合同，甲方栏是她的旧名字。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '苏晚', identity: '装穷 intern', sheetPrompt: '黑色长直发，合身黑西装，工牌别得偏低，耳钉很小，神情压着。' },
        { id: 'ex', name: '前未婚夫', identity: '台上的嘉宾', sheetPrompt: '深色礼服，袖扣发亮，笑容先到，手指总想去按遥控。' },
      ],
      shots: [
        { title: '侧门进场', location: '宴会厅侧门', shotSize: '中景', camera: '缓推', action: '苏晚从侧门进来，把工牌翻到背面。', dialogue: '', storyboard: '夜，侧门。她不想被第一眼认出来。', imagePrompt: '酒店侧门中景，黑西装女生把工牌翻过去，宴会灯光从门缝漏出。', motionPrompt: '缓推进侧门。', duration: 4, characterKeys: ['hero'] },
        { title: '麦递过来', location: '主桌前', shotSize: '中景', camera: '跟拍', action: '主持把麦塞进她手里，全场灯光打到她脸上。', dialogue: '', storyboard: '她还没准备好，麦已经在手里。', imagePrompt: '宴会厅中景，话筒递到苏晚手里，追光打在她脸上。', motionPrompt: '跟麦递出的手。', duration: 4, characterKeys: ['hero'] },
        { title: '旧名字上屏', location: '宴会厅大屏', shotSize: '特写接全景', camera: '切', action: '大屏翻出旧名字，全场有人开始交头接耳。', dialogue: '苏晚：今晚只报业绩。名字以后再改。', storyboard: '先看大屏，再看她接麦。', imagePrompt: '大屏特写旧名字，再切苏晚举着话筒。', motionPrompt: '大屏切到她。', duration: 5, characterKeys: ['hero'] },
        { title: '他要停掉', location: '主桌', shotSize: '近景', camera: '硬切', action: '前未婚夫伸手去按遥控，被她用麦挡住。', dialogue: '前未婚夫：先停一下。', storyboard: '抢遥控失败，大屏还亮着。', imagePrompt: '近景，一只手去按遥控，话筒横过来挡住。', motionPrompt: '硬切到两只手。', duration: 4, characterKeys: ['hero', 'ex'] },
        { title: '她把这段说完', location: '主桌前', shotSize: '中景', camera: '缓推', action: '她没有放下麦，把业绩数字报完。', dialogue: '', storyboard: '高光是报完，不是骂回去。', imagePrompt: '中景，苏晚举麦报数字，前未婚夫的手停在半空。', motionPrompt: '缓推到她的脸。', duration: 5, characterKeys: ['hero', 'ex'] },
        { title: '下一页合同', location: '大屏', shotSize: '特写', camera: '缓推', action: '大屏自动翻到下一页，甲方栏还是那个旧名字。', dialogue: '', storyboard: '钩子：名字战没完，合同还在后面。', imagePrompt: '大屏合同特写，甲方栏旧名字，红章位置空着。', motionPrompt: '缓推进甲方栏。', duration: 4, characterKeys: [] },
      ],
    }
  }
  if (kind === 'xianxia') {
    return {
      title: '废炉认主 · 第一集',
      logline: '外门弟子陈岁当众点燃嫡脉废炉，炉里飞出一枚认主的识海钉。',
      setting: '白日，外门演武场和废炉台。',
      hook: '别人都在等炉炸，炉火却顺着她的袖口往回走。',
      conflict: '废炉一旦点燃就不能灭，飞出来的东西会认第一个碰它的人。',
      rules: [
        '废炉当众点燃后不可用水浇灭。',
        '炉里飞出的器物认第一个碰到它的人。',
        '外门弟子碰嫡脉炉火，要当场报出身。',
      ],
      scriptCard: [
        '场1 日 外 演武场：陈岁被点名去点那座半年没亮的废炉。',
        '嫡女：「废灵根也敢碰嫡脉的炉。」',
        '场2 日 外 废炉台：她伸手进去，炉火顺着袖口回来。',
        '陈岁：「它认的不是灵根。」',
        '钩子：识海钉钉进她眉心，楼上宗主的茶盏裂了。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '陈岁', identity: '外门弟子', sheetPrompt: '束起的黑发，洗旧的灰外门袍，袖口有烧痕，手腕一圈麻绳，神情很稳。' },
        { id: 'heir', name: '嫡女', identity: '嫡脉候选人', sheetPrompt: '金纹白袍，发冠整齐，指上玉扳指，笑意不达眼底。' },
      ],
      shots: [
        { title: '点名点炉', location: '外门演武场', shotSize: '全景', camera: '缓推', action: '执事点到陈岁，让她去点那座废炉。', dialogue: '执事：外门，陈岁。去点炉。', storyboard: '日，演武场。她从队列最后走出来。', imagePrompt: '演武场全景，灰袍弟子从队列末尾走出，远处一座冷炉。', motionPrompt: '缓推进入队列。', duration: 5, characterKeys: ['hero'] },
        { title: '嫡女拦话', location: '废炉台下', shotSize: '中景', camera: '正反打', action: '嫡女挡住台阶，用扇骨点她的袖口。', dialogue: '嫡女：废灵根也敢碰嫡脉的炉。', storyboard: '中景对峙，扇骨点在烧痕上。', imagePrompt: '台阶中景，白袍嫡女用扇骨点灰袍袖口的烧痕。', motionPrompt: '正反打。', duration: 4, characterKeys: ['hero', 'heir'] },
        { title: '伸手点火', location: '废炉台', shotSize: '近景', camera: '缓推', action: '陈岁把手伸进炉口，炉灰先塌再亮。', dialogue: '', storyboard: '手进炉口，火不是炸，是回来。', imagePrompt: '近景，一只手伸进冷炉，炉心重新亮起。', motionPrompt: '缓推进炉口。', duration: 5, characterKeys: ['hero'] },
        { title: '炉火回袖', location: '废炉台', shotSize: '中景', camera: '跟拍', action: '炉火顺着袖口往回走，没有烧穿衣服。', dialogue: '陈岁：它认的不是灵根。', storyboard: '火沿袖口走，嫡女的扇子停住。', imagePrompt: '中景，火光沿灰袍袖口回流，嫡女后退半步。', motionPrompt: '跟火走袖口。', duration: 5, characterKeys: ['hero', 'heir'] },
        { title: '识海钉飞出', location: '炉心', shotSize: '特写', camera: '硬切', action: '一枚细钉从炉心飞出，钉进她眉心。', dialogue: '', storyboard: '器物认主，可见、可拍。', imagePrompt: '特写，细长识海钉飞向眉心，炉火在后面。', motionPrompt: '硬切钉飞出。', duration: 4, characterKeys: ['hero'] },
        { title: '楼上茶盏', location: '演武场高台', shotSize: '特写接全景', camera: '切', action: '高台上茶盏裂开，有人把茶倒掉。', dialogue: '', storyboard: '钩子：真正管这件事的人在楼上。', imagePrompt: '茶盏裂纹特写，再切高台轮廓。', motionPrompt: '茶盏切到高台。', duration: 4, characterKeys: [] },
      ],
    }
  }
  if (kind === 'costume') {
    return {
      title: '家宴密诏 · 第一集',
      logline: '冷宫妃子沈昭把先帝密诏拍进中秋家宴，第一个该跪下的人没有跪。',
      setting: '夜，王府中秋家宴正殿。',
      hook: '酒过三巡，她把一卷没拆封的诏书拍在主桌。',
      conflict: '密诏当众展开才作数，家主想先抢走再灭口。',
      rules: [
        '密诏必须当众展开才算数。',
        '宴席上谁先跪下，谁就认这卷诏。',
        '没展开之前，任何人夺诏都不算谋逆。',
      ],
      scriptCard: [
        '场1 夜 内 侧殿：沈昭把密诏从袖里移到托盘下。',
        '场2 夜 内 正殿：她把诏书拍在家主酒杯旁。',
        '沈昭：「先帝的字，今晚当众念。」',
        '家主：「先收起来。」',
        '钩子：殿外甲士的脚步停住了，还没有进来。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '沈昭', identity: '被打入冷宫的妃', sheetPrompt: '素色褙子，头发挽得很低，颈间旧玉，手腕有冷宫的冻痕，神情很静。' },
        { id: 'lord', name: '家主', identity: '今晚的东道', sheetPrompt: '暗红吉服，扳指很厚，笑着劝酒，眼睛先看诏再看人。' },
      ],
      shots: [
        { title: '侧殿藏诏', location: '王府侧殿', shotSize: '近景', camera: '缓推', action: '沈昭把密诏从袖里抽出来，压进托盘底下。', dialogue: '', storyboard: '夜，侧殿。动作清楚：诏还不能被看见。', imagePrompt: '烛光近景，素衣女子把一卷封泥诏书压进托盘下。', motionPrompt: '缓推进袖口。', duration: 4, characterKeys: ['hero'] },
        { title: '拍诏上桌', location: '正殿主桌', shotSize: '中景', camera: '硬切', action: '她把诏书拍在家主酒杯旁边，酒面晃了一下。', dialogue: '沈昭：先帝的字，今晚当众念。', storyboard: '诏书落地比骂人更清楚。', imagePrompt: '中秋宴中景，一卷诏书拍在酒杯旁，全桌筷子停住。', motionPrompt: '硬切到主桌。', duration: 5, characterKeys: ['hero', 'lord'] },
        { title: '夺诏', location: '正殿主桌', shotSize: '近景', camera: '切', action: '家主伸手去夺，沈昭按住封泥。', dialogue: '家主：先收起来。', storyboard: '没展开之前，夺诏还不算谋逆。', imagePrompt: '近景，两只手按在同一卷封泥上。', motionPrompt: '切到僵持的手。', duration: 4, characterKeys: ['hero', 'lord'] },
        { title: '展开第一行', location: '正殿主桌', shotSize: '特写', camera: '缓推', action: '她撕开封泥，展开第一行，有人已经跪下去。', dialogue: '', storyboard: '当众展开，规则生效。', imagePrompt: '诏书特写第一行墨字，前景有人跪倒的袖口。', motionPrompt: '缓推进第一行。', duration: 5, characterKeys: ['hero'] },
        { title: '家主没跪', location: '正殿主位', shotSize: '中景', camera: '固定', action: '半场跪下，家主还坐着，酒杯没有放下。', dialogue: '', storyboard: '谁先跪谁认，他不跪。', imagePrompt: '中景，一半人跪着，主位上的人仍坐着举杯。', motionPrompt: '固定看主位。', duration: 5, characterKeys: ['lord'] },
        { title: '殿外甲士', location: '正殿门外', shotSize: '全景', camera: '缓拉', action: '殿外甲士的脚步停住，刀还没有出鞘。', dialogue: '', storyboard: '钩子：里面的诏和外面的兵，还没碰上。', imagePrompt: '夜，殿门外甲士停步，门缝漏出宴席烛光。', motionPrompt: '缓拉到门外。', duration: 4, characterKeys: [] },
      ],
    }
  }
  if (kind === 'scifi') {
    return {
      title: '工牌过闸 · 第一集',
      logline: '快递员江辞过安检口时，工牌自己变成舰长编号。',
      setting: '白天，轨道站安检口和分拣通道。',
      hook: '闸机绿灯还没亮，工牌上的名字先换了。',
      conflict: '系统规则是：工牌过闸只显示一次真实编制，改过就不能改第二次。',
      rules: [
        '工牌过安检口会显示真实编制。',
        '同一枚工牌只能被系统改写一次。',
        '安检员按住你的牌，你必须当场对视镜头核验。',
      ],
      scriptCard: [
        '场1 日 内 安检队列：江辞把一箱货放上传送带，工牌还是快递员。',
        '场2 日 内 闸机：绿灯未亮，编号先变成舰长。',
        '安检员：「看着镜头。不要眨眼。」',
        '江辞：「这牌是公司发的。」',
        '钩子：他摔掉的工牌自己从地上爬回他胸口。',
      ].join('\n'),
      characters: [
        { id: 'hero', name: '江辞', identity: '记忆被格式化的快递员', sheetPrompt: '短发，深灰连帽工装，胸口工牌，护目镜推到额上，小臂有接口疤。' },
        { id: 'guard', name: '安检员', identity: '闸机核验员', sheetPrompt: '黑色站务制服，耳麦，手套，眼神先看牌再看人。' },
      ],
      shots: [
        { title: '排队过闸', location: '轨道站安检队列', shotSize: '全景', camera: '缓推', action: '江辞把货箱放上传送带，工牌还印着快递员。', dialogue: '', storyboard: '日，车站。先看起来只是送货。', imagePrompt: '未来车站安检队列全景，灰工装快递员把货箱放上传送带。', motionPrompt: '缓推进队列。', duration: 5, characterKeys: ['hero'] },
        { title: '工牌改号', location: '闸机读卡区', shotSize: '特写', camera: '缓推', action: '工牌上的字自己刷新成舰长编号。', dialogue: '', storyboard: '规则兑现：过闸显示真实编制。', imagePrompt: '工牌特写，字从快递员刷成舰长编号，闸机灯还是红的。', motionPrompt: '缓推进编号。', duration: 4, characterKeys: ['hero'] },
        { title: '按住核验', location: '闸机前', shotSize: '近景', camera: '硬切', action: '安检员按住他的牌，把镜头转过来。', dialogue: '安检员：看着镜头。不要眨眼。', storyboard: '近景对峙，牌被按住。', imagePrompt: '近景，戴手套的手按住工牌，镜头红灯对着江辞的眼睛。', motionPrompt: '硬切到眼睛和镜头。', duration: 5, characterKeys: ['hero', 'guard'] },
        { title: '他不认', location: '闸机前', shotSize: '中景', camera: '正反打', action: '江辞去摘工牌，安检员没有松手。', dialogue: '江辞：这牌是公司发的。', storyboard: '他想否认，牌已经改过一次。', imagePrompt: '中景，两人抢同一枚工牌，身后闸机仍是红灯。', motionPrompt: '正反打。', duration: 4, characterKeys: ['hero', 'guard'] },
        { title: '摔牌', location: '闸机地面', shotSize: '特写', camera: '切', action: '工牌摔在地上，编号还亮着。', dialogue: '', storyboard: '他以为摔掉就能不当舰长。', imagePrompt: '地面特写，发光工牌正面朝上，舰长编号还在跳。', motionPrompt: '切到地上的牌。', duration: 4, characterKeys: [] },
        { title: '牌自己回来', location: '分拣通道口', shotSize: '中景', camera: '缓拉', action: '工牌从地上滑回他胸口，吸回原位。', dialogue: '', storyboard: '钩子：系统不让他改第二次。', imagePrompt: '通道中景，工牌贴着地面滑回他胸口，安检员停在闸机后。', motionPrompt: '缓拉看牌飞回。', duration: 5, characterKeys: ['hero'] },
      ],
    }
  }
  const name = extractFallbackName(topic)
  return {
    title: `${excerptTopic(topic, 12)} · 第一集`,
    logline: `${name}必须在一个看得见的规则里做第一次选择，代价当场出现。`,
    setting: '这一集只发生在两三个能反复拍的室内外空间。',
    hook: '开场先给一个不该出现的物件或一声不该响起的叫名。',
    conflict: `${name}如果照做，会立刻留下把柄；如果不做，对面会当众逼他。`,
    rules: [
      '同一集只推进一个冲突。',
      '关键证据或禁令必须当众兑现，不能只在心里完成。',
      '谁先开口承认，谁先付出代价。',
    ],
    scriptCard: [
      `场1：${name}走进这个空间，环境先看起来正常。`,
      `${name}：「按你们的规矩走。」`,
      '场2：异常出现，必须是看得见的动作或物件。',
      '对面：「你已经看见了。」',
      `场3：${name}做一个会立刻有后果的选择。`,
      '钩子：人走了，新的痕迹留在原地。',
    ].join('\n'),
    characters: [
      { id: 'hero', name, identity: '推动这一集的人', sheetPrompt: '成年角色，服装服务这个题材，五官清楚，有一件能反复入画的标志物。' },
      { id: 'other', name: '对面', identity: '把规则按到他头上的人', sheetPrompt: '成年角色，和主角形成服装反差，手里拿着执行规则的物件。' },
    ],
    shots: [
      { title: '入场', location: '主场景入口', shotSize: '全景', camera: '缓推', action: `${name}走进这个空间，先把标志物放在手里。`, dialogue: '', storyboard: '建立镜头，人物入画。', imagePrompt: '入口全景，人物半侧面走进画面，手里有一件标志物。', motionPrompt: '缓推进入空间。', duration: 5, characterKeys: ['hero'] },
      { title: '规矩上桌', location: '主场景内部', shotSize: '中景', camera: '切', action: '对面把一条写着禁令的纸或牌放上桌。', dialogue: `${name}：按你们的规矩走。`, storyboard: '规则必须看得见。', imagePrompt: '中景，桌上多出一张禁令或证件，两人隔桌。', motionPrompt: '切到桌上的禁令。', duration: 4, characterKeys: ['hero', 'other'] },
      { title: '异常', location: '主场景内部', shotSize: '特写接中景', camera: '切', action: '一个不该亮的灯或不该响的声音出现。', dialogue: '对面：你已经看见了。', storyboard: '先看异常，再看人物停住。', imagePrompt: '异常物件特写，再接到人物停住的脸。', motionPrompt: '特写切中景。', duration: 4, characterKeys: ['hero', 'other'] },
      { title: '选择', location: '对峙位置', shotSize: '中景', camera: '正反打', action: `${name}伸手去碰那个物件，对面按住他的腕。`, dialogue: `${name}：那就按这个来。`, storyboard: '动作清楚，因果关系看得见。', imagePrompt: '中景对峙，两只手抢同一件道具。', motionPrompt: '正反打后拉开。', duration: 5, characterKeys: ['hero', 'other'] },
      { title: '代价', location: '对峙位置', shotSize: '近景', camera: '缓推', action: '物件留下痕迹，名单、印记或裂纹出现。', dialogue: '', storyboard: '违反或遵守都要有可见后果。', imagePrompt: '近景，道具上出现新的字迹或裂纹。', motionPrompt: '缓推进痕迹。', duration: 4, characterKeys: ['hero'] },
      { title: '余波', location: '离开后的空镜', shotSize: '全景', camera: '缓拉', action: '人走了，那件道具还留在原地。', dialogue: '', storyboard: '空镜收住钩子。', imagePrompt: '空场景里那件道具还亮着或还开着。', motionPrompt: '缓拉离开。', duration: 4, characterKeys: [] },
    ],
  }
}

function extractFallbackName(topic: string) {
  const blocked = /规划|校园|漫剧|短剧|分镜|剧本|帮我|一个|规则|怪谈|题材|第一集|公开课|转校生|董事会|录音|末世|废墟/
  const tokens = topic.match(/[\u4e00-\u9fff]{2,3}/g) || []
  const name = tokens.find(token => !blocked.test(token) && !/的|了|在|是|和|与/.test(token))
  return name || '主角'
}

export function fallbackCanvasFlowDirectorPlan(
  topic: string,
  options: {
    mode?: CanvasFlowDirectorMode
    shotCount?: number
    genre?: CanvasFlowDirectorGenre
    look?: CanvasFlowDirectorLook
    stage?: CanvasFlowDirectorStage
    objective?: CanvasFlowDirectorObjective
    sourceKind?: CanvasFlowDirectorSourceKind
    includeVideo?: boolean
  } = {},
): CanvasFlowDirectorPlan {
  const mode = options.mode === 'nine_grid' ? 'nine_grid' : 'shot_pipeline'
  const source = cleanText(topic, '未命名短剧')
  const title = source.slice(0, 24)
  const genre = resolveCanvasFlowDirectorGenre(options.genre, title)
  const look = resolveCanvasFlowDirectorLook(options.look)
  const stage = resolveCanvasFlowDirectorStage(options.stage)
  const objective = resolveCanvasFlowDirectorObjective(options.objective)
  const sourceKind = resolveCanvasFlowDirectorSourceKind(options.sourceKind)
  const production = productionProfileForCanvasFlowDirector(
    objective,
    sourceKind,
    Boolean(options.includeVideo && stage === 'episode'),
  )
  const lookSpec = canvasFlowDirectorLookSpec(look)
  const shotCount = Math.max(1, Math.min(
    mode === 'nine_grid' ? 9 : CANVAS_FLOW_DIRECTOR_MAX_SHOTS,
    options.shotCount || (mode === 'nine_grid' ? 9 : CANVAS_FLOW_DIRECTOR_DEFAULT_SHOTS),
  ))
  const episode = fallbackEpisodeFor(source, genre)
  const characters = episode.characters
  const shots = episode.shots.slice(0, shotCount).map((shot, index) => {
    const characterIds = shot.characterKeys.filter(id => characters.some(character => character.id === id))
    return {
      id: `shot-${index + 1}`,
      title: shot.title,
      hasCharacters: characterIds.length > 0,
      characterIds,
      location: shot.location,
      shotSize: shot.shotSize,
      camera: shot.camera,
      action: shot.action,
      dialogue: shot.dialogue,
      storyboard: shot.storyboard,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      duration: mode === 'nine_grid' ? 12 : shot.duration,
    } satisfies CanvasFlowDirectorShot
  })
  return {
    title: episode.title || `${title} · 第一集`,
    mode,
    stage,
    objective,
    production,
    bible: {
      logline: episode.logline,
      genre,
      look,
      style: defaultStyleForLook(look),
      setting: episode.setting,
      hook: episode.hook,
      conflict: episode.conflict,
      rules: episode.rules,
      scriptCard: episode.scriptCard,
    },
    characters,
    shots,
    motionPrompt: mode === 'nine_grid'
      ? `Style & Mood: ${lookSpec.label}，高对比光影。\nDynamic Description: 按分镜顺序演出场景里的动作，硬切衔接。不要拍摄漫画书。\nStatic Description: 角色服装发型与静帧首帧一致。`
      : '',
  }
}

function stylePrompt(plan: CanvasFlowDirectorPlan) {
  const look = canvasFlowDirectorLookSpec(plan.bible.look)
  return sanitizeVisualText(`全片统一画风：${plan.bible.style} ${look.quality} 不要混用其他画风。`)
}

function characterSheetPrompt(plan: CanvasFlowDirectorPlan, character: CanvasFlowDirectorCharacter, variant: 'turnaround' | 'front' = 'turnaround') {
  const look = canvasFlowDirectorLookSpec(plan.bible.look)
  if (variant === 'front') {
    return sanitizeVisualText(
      `${look.sheetKind}正面锁定：${character.name}，纯色干净背景，胸像到腰，直视镜头。${character.sheetPrompt}。这张图用于后续所有镜头的脸、发型、五官和服装锚定。`,
    )
  }
  return sanitizeVisualText(
    `${look.sheetKind}，${character.name}三视图：正面、侧面、背面横向并排展示，纯色干净背景。${character.sheetPrompt}。三个视图保持发型、五官、身材、服装严格一致，仅角度不同。`,
  )
}

function shotImagePrompt(plan: CanvasFlowDirectorPlan, shot: CanvasFlowDirectorShot, characters: CanvasFlowDirectorCharacter[]) {
  const look = canvasFlowDirectorLookSpec(plan.bible.look)
  const names = characters.map(character => character.name).join('、')
  const reference = shot.hasCharacters && names
    ? `${names}严格遵循参考图人物的脸、发型、五官、身材和服装，不要换脸。`
    : '无人物正脸特写。'
  const place = shot.location ? `地点：${shot.location}。` : ''
  const size = shot.shotSize ? `景别：${shot.shotSize}。` : ''
  return sanitizeVisualText(
    `${look.stillKind}。单镜头剧场画面，禁止漫画页、九宫格、分镜稿。${place}${size}${shot.imagePrompt} ${shot.action} ${reference}`,
  )
}

function shotMotionPrompt(shot: CanvasFlowDirectorShot) {
  const camera = shot.camera || '中景固定'
  return sanitizeVisualText(
    `${camera}。${shot.motionPrompt} ${shot.action} 描写场景里正在发生的动作和运镜，不要拍摄漫画书、分镜页或九宫格本身。`,
  )
}

function nineGridPrompt(plan: CanvasFlowDirectorPlan) {
  const panels = Array.from({ length: 9 }, (_, index) => {
    const shot = plan.shots[index] || plan.shots[plan.shots.length - 1]
    const beat = shot?.storyboard || plan.bible.logline
    return `Panel ${index + 1}: ${beat}`
  }).join('\n')
  const look = canvasFlowDirectorLookSpec(plan.bible.look)
  return sanitizeVisualText(
    `A 3x3 storyboard page with 9 panels depicting ${plan.bible.logline}. Read order: left-to-right, top-to-bottom. Bold black panel borders with thin white gutters. Consistent character appearance across all panels.\n${panels}\nStyle: ${look.label} storyboard, ${plan.bible.style}. Digital characters, no real human face, no text, no watermark.`,
  )
}

function nineGridMotionPrompt(plan: CanvasFlowDirectorPlan) {
  return sanitizeVisualText(
    plan.motionPrompt
    || `Style & Mood: ${plan.bible.style}\nDynamic Description: 按分镜表顺序演出场景里的动作，硬切衔接。画面是连续剧场，不是漫画页、九宫格或分镜稿。\nStatic Description: 角色服装发型与静帧首帧一致。`,
  )
}

function firstShotStillPrompt(plan: CanvasFlowDirectorPlan) {
  const shot = plan.shots[0]
  const characters = plan.characters.filter(character => shot?.characterIds.includes(character.id))
  if (shot) return shotImagePrompt(plan, shot, characters)
  const look = canvasFlowDirectorLookSpec(plan.bible.look)
  return sanitizeVisualText(`${look.stillKind}宽银幕首帧。${plan.bible.logline} ${plan.bible.style} ${look.quality}`)
}

function storyCardText(plan: CanvasFlowDirectorPlan) {
  const rules = plan.bible.rules.length
    ? plan.bible.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
    : '这一集先把地点和冲突拍清楚。'
  const cast = plan.characters.map(character => (
    `${character.name}${character.identity ? `：${character.identity}` : ''}`
  )).join('\n')
  return [
    `一句话：${plan.bible.logline}`,
    plan.bible.setting ? `地点：${plan.bible.setting}` : '',
    plan.bible.hook ? `开场钩子：${plan.bible.hook}` : '',
    plan.bible.conflict ? `这一集冲突：${plan.bible.conflict}` : '',
    `这一集规则：\n${rules}`,
    cast ? `人物：\n${cast}` : '',
  ].filter(Boolean).join('\n\n')
}

function storyboardTable(plan: CanvasFlowDirectorPlan) {
  return plan.shots.map((shot, index) => {
    const names = plan.characters
      .filter(character => shot.characterIds.includes(character.id))
      .map(character => character.name)
      .join('、')
    return [
      `${index + 1}. ${shot.title} · ${shot.duration}s`,
      shot.location ? `地点：${shot.location}` : '',
      `景别：${shot.shotSize || '中景'}　运镜：${shot.camera || '固定'}`,
      `画面：${shot.action || shot.storyboard}`,
      names ? `人物：${names}` : '人物：无',
      shot.dialogue ? `对白：${shot.dialogue}` : '对白：无',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

function makeEdge(source: string, target: string): CanvasFlowEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'default',
  }
}

function nodeAt(
  kind: CanvasFlowNodeKind,
  id: string,
  position: { x: number; y: number },
  data: Partial<CanvasFlowNodeData>,
): CanvasFlowNode {
  return createCanvasFlowNode(kind, position, data, id)
}

export function compileCanvasFlowDirectorPlan(
  input: CanvasFlowDirectorPlan,
  options: CanvasFlowDirectorCompileOptions = {},
): CanvasFlowDirectorCompileResult {
  const requestedLook = options.look ? resolveCanvasFlowDirectorLook(options.look) : undefined
  const requestedStage = options.stage ? resolveCanvasFlowDirectorStage(options.stage) : undefined
  const parsed = parseCanvasFlowDirectorPlan(input)
  const plan = parsed
    ? {
      ...parsed,
      stage: requestedStage || parsed.stage || 'episode',
      bible: {
        ...parsed.bible,
        look: requestedLook || parsed.bible.look,
        style: requestedLook ? defaultStyleForLook(requestedLook) : parsed.bible.style,
      },
    }
    : fallbackCanvasFlowDirectorPlan(input.title || '未命名短剧', {
      mode: input.mode,
      look: requestedLook,
      stage: requestedStage || 'episode',
    })
  const stage = requestedStage || plan.stage || 'episode'
  const includeBoard = canvasFlowDirectorStageIncludes(stage, 'board')
  const includeCast = canvasFlowDirectorStageIncludes(stage, 'cast')
  const includeStills = canvasFlowDirectorStageIncludes(stage, 'stills')
  const includeVideo = options.includeVideo !== false && stage === 'episode'
  const origin = options.origin || { x: 48, y: 48 }
  const occupied = new Set(options.occupiedIds || [])
  const idFor = (seed: string) => uniqueId(`drama-${seed}`, occupied)
  const modelId = String(options.modelId || '')
  const modelName = String(options.modelName || modelId)
  const videoModelId = String(options.videoModelId || '')
  const videoModelName = String(options.videoModelName || videoModelId)
  const aspectRatio = String(options.aspectRatio || (plan.mode === 'nine_grid' ? '1:1' : '16:9'))
  const resolution = String(options.resolution || '1k')
  const quality = String(options.quality || 'auto')

  const nodes: CanvasFlowNode[] = []
  const edges: CanvasFlowEdge[] = []
  const ops: CanvasFlowDesignOp[] = []

  const pushNode = (step: CanvasFlowDirectorStepId, node: CanvasFlowNode) => {
    nodes.push(node)
    ops.push({ type: 'add_node', step, node })
  }
  const pushEdge = (step: CanvasFlowDirectorStepId, edge: CanvasFlowEdge) => {
    const validation = validateCanvasFlowConnection({ nodes, edges }, edge)
    if (!validation.valid) return
    edges.push(edge)
    ops.push({ type: 'add_edge', step, edge })
  }

  const topicId = idFor('topic')
  const scriptId = idFor('script')
  const boardId = idFor('board')
  const styleId = idFor('style')

  pushNode('intake', nodeAt('note', topicId, origin, {
    title: '故事卡',
    text: storyCardText(plan),
    directorRole: 'story',
  }))
  pushNode('script', nodeAt('note', scriptId, { x: origin.x + 360, y: origin.y }, {
    title: '这一集剧本',
    text: plan.bible.scriptCard,
    directorRole: 'script',
  }))
  pushEdge('script', makeEdge(topicId, scriptId))
  if (includeBoard) {
    pushNode('board', nodeAt('note', boardId, { x: origin.x + 720, y: origin.y }, {
      title: '分镜表',
      text: storyboardTable(plan) || plan.bible.logline,
      directorRole: 'board',
    }))
    pushEdge('board', makeEdge(scriptId, boardId))
  }
  if (includeBoard && plan.production.checkpoints.length > 0) {
    const reviewId = idFor('review')
    pushNode('review', nodeAt('note', reviewId, { x: origin.x + 1080, y: origin.y }, {
      title: '制作检查',
      text: [
        `交付物：${plan.production.deliverables.join(' · ')}`,
        `检查关口：${plan.production.checkpoints.join(' · ')}`,
      ].join('\n'),
      directorRole: 'review',
    }))
    pushEdge('review', makeEdge(boardId, reviewId))
  }
  if (includeCast || includeStills) {
    pushNode('prompts', nodeAt('prompt', styleId, { x: origin.x, y: origin.y + 240 }, {
      title: '全片画风',
      prompt: stylePrompt(plan),
      directorRole: 'style',
    }))
    pushEdge('prompts', makeEdge(scriptId, styleId))
  }

  const characterResultIds = new Map<string, string>()
  if (plan.mode === 'shot_pipeline') {
    if (includeCast) {
      plan.characters.forEach((character, index) => {
        const turnPromptId = idFor(`char-${character.id}-turn-prompt`)
        const turnGenId = idFor(`char-${character.id}-turn-gen`)
        const turnResultId = idFor(`char-${character.id}-turn-result`)
        const frontPromptId = idFor(`char-${character.id}-front-prompt`)
        const frontGenId = idFor(`char-${character.id}-front-gen`)
        const frontResultId = idFor(`char-${character.id}-front-result`)
        const y = origin.y + 240 + index * 520
        pushNode('cast', nodeAt('prompt', turnPromptId, { x: origin.x + 360, y }, {
          title: `${character.name} · 三视图`,
          prompt: characterSheetPrompt(plan, character, 'turnaround'),
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(styleId, turnPromptId))
        pushNode('cast', nodeAt('generator', turnGenId, { x: origin.x + 720, y }, {
          title: `${character.name} · 三视图生成`,
          prompt: characterSheetPrompt(plan, character, 'turnaround'),
          directorRole: 'character',
          directorRef: character.id,
          modelId,
          modelName,
          aspectRatio: '16:9',
          resolution,
          quality,
        }))
        pushEdge('cast', makeEdge(turnPromptId, turnGenId))
        pushNode('cast', nodeAt('result', turnResultId, { x: origin.x + 1080, y }, {
          title: `${character.name} · 三视图锚点`,
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(turnGenId, turnResultId))
        pushNode('cast', nodeAt('prompt', frontPromptId, { x: origin.x + 360, y: y + 240 }, {
          title: `${character.name} · 正面锁定`,
          prompt: characterSheetPrompt(plan, character, 'front'),
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(styleId, frontPromptId))
        pushNode('cast', nodeAt('generator', frontGenId, { x: origin.x + 720, y: y + 240 }, {
          title: `${character.name} · 正面生成`,
          prompt: characterSheetPrompt(plan, character, 'front'),
          directorRole: 'character',
          directorRef: character.id,
          modelId,
          modelName,
          aspectRatio: '3:4',
          resolution,
          quality,
        }))
        pushEdge('cast', makeEdge(frontPromptId, frontGenId))
        pushEdge('cast', makeEdge(turnResultId, frontGenId))
        pushNode('cast', nodeAt('result', frontResultId, { x: origin.x + 1080, y: y + 240 }, {
          title: `${character.name} · 正面锚点`,
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(frontGenId, frontResultId))
        characterResultIds.set(character.id, frontResultId)
      })
    }

    if (includeStills) {
      plan.shots.forEach((shot, index) => {
        const y = origin.y + 240 + Math.max(includeCast ? plan.characters.length : 0, 1) * (includeCast ? 520 : 280) + index * 320
        const promptId = idFor(`${shot.id}-prompt`)
        const generatorId = idFor(`${shot.id}-gen`)
        const resultId = idFor(`${shot.id}-still`)
        const motionId = idFor(`${shot.id}-motion`)
        const videoId = idFor(`${shot.id}-video`)
        const videoResultId = idFor(`${shot.id}-clip`)
        const referenced = plan.characters.filter(character => shot.characterIds.includes(character.id))
        pushNode('shots', nodeAt('prompt', promptId, { x: origin.x + 1440, y }, {
          title: shot.title,
          prompt: shotImagePrompt(plan, shot, referenced),
          directorRole: 'shot',
          directorRef: shot.id,
        }))
        pushEdge('shots', makeEdge(boardId, promptId))
        pushNode('shots', nodeAt('generator', generatorId, { x: origin.x + 1800, y }, {
          title: `${shot.title} · 静帧`,
          prompt: shotImagePrompt(plan, shot, referenced),
          directorRole: 'shot',
          directorRef: shot.id,
          modelId,
          modelName,
          aspectRatio: plan.mode === 'nine_grid' ? aspectRatio : '16:9',
          resolution,
          quality,
        }))
        pushEdge('shots', makeEdge(promptId, generatorId))
        if (shot.hasCharacters) {
          referenced.forEach(character => {
            const source = characterResultIds.get(character.id)
            if (source) pushEdge('shots', makeEdge(source, generatorId))
          })
        }
        pushNode('shots', nodeAt('result', resultId, { x: origin.x + 2160, y }, {
          title: `${shot.title} · 静帧结果`,
          directorRole: 'shot',
          directorRef: shot.id,
        }))
        pushEdge('shots', makeEdge(generatorId, resultId))
        if (includeVideo) {
          pushNode('prompts', nodeAt('prompt', motionId, { x: origin.x + 1440, y: y + 150 }, {
            title: `${shot.title} · 运镜`,
            prompt: shotMotionPrompt(shot),
            directorRole: 'shot',
            directorRef: shot.id,
          }))
          pushEdge('prompts', makeEdge(promptId, motionId))
          pushNode('shots', nodeAt('video-generator', videoId, { x: origin.x + 2520, y }, {
            title: `${shot.title} · 视频`,
            prompt: shotMotionPrompt(shot),
            directorRole: 'shot',
            directorRef: shot.id,
            modelId: videoModelId,
            modelName: videoModelName,
            aspectRatio: '16:9',
            resolution: '720p',
            duration: shot.duration,
          }))
          pushEdge('shots', makeEdge(resultId, videoId))
          pushEdge('shots', makeEdge(motionId, videoId))
          pushNode('shots', nodeAt('result', videoResultId, { x: origin.x + 2880, y }, {
            title: `${shot.title} · 视频结果`,
            directorRole: 'shot',
            directorRef: shot.id,
          }))
          pushEdge('shots', makeEdge(videoId, videoResultId))
        }
      })
    }
  } else {
    if (includeCast) {
      plan.characters.forEach((character, index) => {
        const turnPromptId = idFor(`char-${character.id}-turn-prompt`)
        const turnGenId = idFor(`char-${character.id}-turn-gen`)
        const turnResultId = idFor(`char-${character.id}-turn-result`)
        const frontPromptId = idFor(`char-${character.id}-front-prompt`)
        const frontGenId = idFor(`char-${character.id}-front-gen`)
        const frontResultId = idFor(`char-${character.id}-front-result`)
        const y = origin.y + 240 + index * 520
        pushNode('cast', nodeAt('prompt', turnPromptId, { x: origin.x + 360, y }, {
          title: `${character.name} · 三视图`,
          prompt: characterSheetPrompt(plan, character, 'turnaround'),
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(styleId, turnPromptId))
        pushNode('cast', nodeAt('generator', turnGenId, { x: origin.x + 720, y }, {
          title: `${character.name} · 三视图生成`,
          prompt: characterSheetPrompt(plan, character, 'turnaround'),
          directorRole: 'character',
          directorRef: character.id,
          modelId,
          modelName,
          aspectRatio: '16:9',
          resolution,
          quality,
        }))
        pushEdge('cast', makeEdge(turnPromptId, turnGenId))
        pushNode('cast', nodeAt('result', turnResultId, { x: origin.x + 1080, y }, {
          title: `${character.name} · 三视图锚点`,
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(turnGenId, turnResultId))
        pushNode('cast', nodeAt('prompt', frontPromptId, { x: origin.x + 360, y: y + 240 }, {
          title: `${character.name} · 正面锁定`,
          prompt: characterSheetPrompt(plan, character, 'front'),
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(styleId, frontPromptId))
        pushNode('cast', nodeAt('generator', frontGenId, { x: origin.x + 720, y: y + 240 }, {
          title: `${character.name} · 正面生成`,
          prompt: characterSheetPrompt(plan, character, 'front'),
          directorRole: 'character',
          directorRef: character.id,
          modelId,
          modelName,
          aspectRatio: '3:4',
          resolution,
          quality,
        }))
        pushEdge('cast', makeEdge(frontPromptId, frontGenId))
        pushEdge('cast', makeEdge(turnResultId, frontGenId))
        pushNode('cast', nodeAt('result', frontResultId, { x: origin.x + 1080, y: y + 240 }, {
          title: `${character.name} · 正面锚点`,
          directorRole: 'character',
          directorRef: character.id,
        }))
        pushEdge('cast', makeEdge(frontGenId, frontResultId))
        characterResultIds.set(character.id, frontResultId)
      })
    }
    if (includeStills) {
    const gridPromptId = idFor('grid-prompt')
    const gridGenId = idFor('grid-gen')
    const gridResultId = idFor('grid-result')
    const stillPromptId = idFor('still-prompt')
    const stillGenId = idFor('still-gen')
    const stillResultId = idFor('still-result')
    const motionId = idFor('grid-motion')
    const videoId = idFor('grid-video')
    const videoResultId = idFor('grid-clip')
    pushNode('shots', nodeAt('prompt', gridPromptId, { x: origin.x + 360, y: origin.y + 240 }, {
      title: '九宫格分镜',
      prompt: nineGridPrompt(plan),
    }))
    pushEdge('shots', makeEdge(boardId, gridPromptId))
    pushEdge('shots', makeEdge(styleId, gridPromptId))
    pushNode('shots', nodeAt('generator', gridGenId, { x: origin.x + 720, y: origin.y + 240 }, {
      title: '九宫格生成',
      prompt: nineGridPrompt(plan),
      modelId,
      modelName,
      aspectRatio: '1:1',
      resolution,
      quality,
    }))
    pushEdge('shots', makeEdge(gridPromptId, gridGenId))
    pushNode('shots', nodeAt('result', gridResultId, { x: origin.x + 1080, y: origin.y + 240 }, {
      title: '九宫格结果',
    }))
    pushEdge('shots', makeEdge(gridGenId, gridResultId))
    pushNode('shots', nodeAt('prompt', stillPromptId, { x: origin.x + 360, y: origin.y + 520 }, {
      title: '首帧静帧',
      prompt: firstShotStillPrompt(plan),
    }))
    pushEdge('shots', makeEdge(boardId, stillPromptId))
    pushEdge('shots', makeEdge(styleId, stillPromptId))
    pushNode('shots', nodeAt('generator', stillGenId, { x: origin.x + 720, y: origin.y + 520 }, {
      title: '首帧生成',
      prompt: firstShotStillPrompt(plan),
      modelId,
      modelName,
      aspectRatio: '16:9',
      resolution,
      quality,
    }))
    pushEdge('shots', makeEdge(stillPromptId, stillGenId))
    characterResultIds.forEach(source => pushEdge('shots', makeEdge(source, stillGenId)))
    pushNode('shots', nodeAt('result', stillResultId, { x: origin.x + 1080, y: origin.y + 520 }, {
      title: '首帧结果',
    }))
    pushEdge('shots', makeEdge(stillGenId, stillResultId))
    if (includeVideo) {
      pushNode('prompts', nodeAt('prompt', motionId, { x: origin.x + 720, y: origin.y + 800 }, {
        title: '漫剧运镜',
        prompt: nineGridMotionPrompt(plan),
      }))
      pushEdge('prompts', makeEdge(stillPromptId, motionId))
      pushNode('shots', nodeAt('video-generator', videoId, { x: origin.x + 1440, y: origin.y + 520 }, {
        title: '15 秒漫剧',
        prompt: nineGridMotionPrompt(plan),
        modelId: videoModelId,
        modelName: videoModelName,
        aspectRatio: '16:9',
        resolution: '720p',
        duration: Math.max(10, plan.shots[0]?.duration || 12),
      }))
      pushEdge('shots', makeEdge(stillResultId, videoId))
      pushEdge('shots', makeEdge(motionId, videoId))
      pushNode('shots', nodeAt('result', videoResultId, { x: origin.x + 1800, y: origin.y + 520 }, {
        title: '漫剧视频',
      }))
      pushEdge('shots', makeEdge(videoId, videoResultId))
    }
    }
  }

  const laidOut = layoutCanvasFlowNodes({ nodes, edges }, { horizontalGap: 132, verticalGap: 56 })
  const positioned = new Map(laidOut.map(node => [node.id, node.position]))
  const graph: CanvasFlowGraph = {
    nodes: nodes.map(node => ({ ...node, position: positioned.get(node.id) || node.position })),
    edges,
  }
  return {
    plan,
    graph,
    ops: ops.map(op => (
      op.type === 'add_node'
        ? { ...op, node: { ...op.node, position: positioned.get(op.node.id) || op.node.position } }
        : op
    )),
  }
}

export interface CanvasFlowDirectorGraphIndexItem {
  id: string
  title: string
  kind: string
  role?: CanvasFlowDirectorRole
  ref?: string
}

export function inferCanvasFlowDirectorRole(node: CanvasFlowNode): CanvasFlowDirectorRole | undefined {
  if (node.data.directorRole) return node.data.directorRole
  const title = String(node.data.title || '')
  if (title === '故事卡' || title === '题材卡') return 'story'
  if (title === '这一集剧本' || title === '剧本一卡') return 'script'
  if (title === '分镜表') return 'board'
  if (title === '全片画风') return 'style'
  if (/三视图|正面锁定|正面锚点/.test(title)) return 'character'
  if (/静帧|运镜|视频/.test(title) || node.data.kind === 'generator' || node.data.kind === 'video-generator') return 'shot'
  return undefined
}

export function canvasFlowDirectorGraphIndex(nodes: CanvasFlowNode[]): CanvasFlowDirectorGraphIndexItem[] {
  return nodes.map(node => ({
    id: node.id,
    title: String(node.data.title || ''),
    kind: String(node.data.kind || ''),
    role: inferCanvasFlowDirectorRole(node),
    ref: node.data.directorRef || '',
  }))
}

export function recoverCanvasFlowDirectorPlan(graph: { nodes: CanvasFlowNode[] }, fallback?: CanvasFlowDirectorPlan | null): CanvasFlowDirectorPlan | null {
  if (fallback) return fallback
  const story = graph.nodes.find(node => inferCanvasFlowDirectorRole(node) === 'story')
  const script = graph.nodes.find(node => inferCanvasFlowDirectorRole(node) === 'script')
  if (!story && !script) {
    const readableText = (node: CanvasFlowNode) => cleanText(
      node.data.text || node.data.prompt || node.data.title,
    )
    const seed = graph.nodes.find(node => readableText(node))
    if (!seed) return null

    const seenShotRefs = new Set<string>()
    const shotNodes = graph.nodes.filter(node => {
      const role = inferCanvasFlowDirectorRole(node)
      if (role === 'shot') return true
      return node.data.kind === 'prompt' || node.data.kind === 'generator' || node.data.kind === 'video-generator'
    }).filter(node => {
      const key = cleanText(node.data.directorRef) || node.id
      if (seenShotRefs.has(key)) return false
      seenShotRefs.add(key)
      return true
    }).slice(0, CANVAS_FLOW_DIRECTOR_MAX_SHOTS)
    const sourceShots = shotNodes.length ? shotNodes : [seed]
    const hasVideo = graph.nodes.some(node => node.data.kind === 'video-generator')
    const hasStills = graph.nodes.some(node => node.data.kind === 'generator' || node.data.kind === 'result')
    const hasCast = graph.nodes.some(node => inferCanvasFlowDirectorRole(node) === 'character')
    const stage: CanvasFlowDirectorStage = hasVideo ? 'episode' : hasStills ? 'stills' : hasCast ? 'cast' : 'script'
    const profile = productionProfileForCanvasFlowDirector('shot_production', 'canvas', false)
    const title = cleanText(seed.data.title, '现有画布制作包')
    return parseCanvasFlowDirectorPlan({
      title,
      mode: 'shot_pipeline',
      stage,
      objective: 'shot_production',
      production: {
        source_kind: 'canvas',
        deliverables: profile.deliverables,
        checkpoints: profile.checkpoints,
      },
      bible: {
        logline: readableText(seed) || title,
        script_card: graph.nodes
          .filter(node => node.data.kind === 'note')
          .map(node => readableText(node))
          .filter(Boolean)
          .join('\n\n'),
      },
      characters: graph.nodes
        .filter(node => inferCanvasFlowDirectorRole(node) === 'character')
        .map((node, index) => ({
          id: cleanText(node.data.directorRef, `character-${index + 1}`),
          name: cleanText(node.data.title, `角色 ${index + 1}`),
          sheet_prompt: readableText(node),
        })),
      shots: sourceShots.map((node, index) => {
        const content = readableText(node)
        return {
          id: cleanText(node.data.directorRef) || cleanText(node.id) || `shot-${index + 1}`,
          title: cleanText(node.data.title, `镜头 ${index + 1}`),
          has_characters: false,
          character_ids: [],
          action: content,
          storyboard: content,
          image_prompt: cleanText(node.data.prompt, content),
          motion_prompt: node.data.kind === 'video-generator' ? cleanText(node.data.prompt, '固定镜头') : '固定镜头',
          duration: Number(node.data.duration || 5),
        }
      }),
    })
  }
  return parseCanvasFlowDirectorPlan({
    title: cleanText(story?.data.text, '未命名漫剧').split('\n')[0] || '未命名漫剧',
    mode: 'shot_pipeline',
    bible: {
      logline: cleanText(story?.data.text, '未命名漫剧').split('\n')[0],
      script_card: script?.data.text || '',
    },
    characters: [],
    shots: [],
  })
}

function clonePlan(plan: CanvasFlowDirectorPlan): CanvasFlowDirectorPlan {
  return {
    ...plan,
    bible: { ...plan.bible, rules: [...plan.bible.rules] },
    characters: plan.characters.map(item => ({ ...item })),
    shots: plan.shots.map(item => ({ ...item, characterIds: [...item.characterIds] })),
  }
}

type DirectorShotPatch = Partial<CanvasFlowDirectorShot> & {
  id?: string
  shot_size?: string
  image_prompt?: string
  motion_prompt?: string
  title?: string
}

export interface CanvasFlowDirectorPlanPatch {
  summary?: string
  bible?: Partial<CanvasFlowDirectorBible> & { script_card?: string; rules?: string[] }
  characters?: Array<Partial<CanvasFlowDirectorCharacter> & { id?: string; sheet_prompt?: string }>
  shots?: DirectorShotPatch[]
  add_shots?: DirectorShotPatch[]
  remove_shot_ids?: string[]
}

const SHOT_INDEX_WORDS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8,
}

export function keywordCanvasFlowDirectorPatch(instruction: string, base?: CanvasFlowDirectorPlan | null): CanvasFlowDirectorPlanPatch {
  const text = cleanText(instruction)
  const patch: CanvasFlowDirectorPlanPatch = { summary: '关键词最小修改' }
  const shotToken = text.match(/第\s*([一二三四五六七八]|[1-8])\s*镜/)?.[1]
  const shotIndex = shotToken ? (SHOT_INDEX_WORDS[shotToken] || Number(shotToken)) : 0
  const dialogue = text.match(/(?:对白|台词)\s*(?:改成|换成)\s*[「""']?(.+?)[」""']?$/)?.[1]
  if (shotIndex && dialogue !== undefined) {
    const nextDialogue = sanitizeVisualText(dialogue)
    const current = base?.shots[shotIndex - 1]
    const shotPatch: CanvasFlowDirectorPlanPatch['shots'] = [{
      id: current?.id || `shot-${shotIndex}`,
      dialogue: nextDialogue,
    }]
    if (current?.storyboard) shotPatch[0].storyboard = `${current.storyboard.replace(/对白[:：].*$/, '').trim()} 对白：${nextDialogue}`
    if (current?.imagePrompt) shotPatch[0].imagePrompt = `${current.imagePrompt.replace(/对白[:：].*$/, '').trim()} 对白：${nextDialogue}`
    patch.shots = shotPatch
    if (current?.dialogue && base?.bible.scriptCard.includes(current.dialogue)) {
      patch.bible = { script_card: base.bible.scriptCard.split(current.dialogue).join(nextDialogue) }
    }
  }
  const rule = text.match(/(?:加一条|加上一条|新增一条|加上|加一条)?(?:校规|规则)[:：]\s*(.+)$/)?.[1]
  if (rule) {
    const nextRules = [...(base?.bible.rules || []), sanitizeVisualText(rule)].filter(Boolean).slice(0, 6)
    patch.bible = { ...(patch.bible || {}), rules: nextRules }
  }
  return patch
}

export function applyCanvasFlowDirectorPlanPatch(base: CanvasFlowDirectorPlan, patch: CanvasFlowDirectorPlanPatch): CanvasFlowDirectorPlan {
  const next = clonePlan(base)
  if (patch.bible) {
    const bible = patch.bible
    if (bible.logline) next.bible.logline = sanitizeVisualText(bible.logline)
    if (bible.setting) next.bible.setting = sanitizeVisualText(bible.setting)
    if (bible.hook) next.bible.hook = sanitizeVisualText(bible.hook)
    if (bible.conflict) next.bible.conflict = sanitizeVisualText(bible.conflict)
    if (bible.style) next.bible.style = sanitizeVisualText(bible.style)
    if (Array.isArray(bible.rules) && bible.rules.length) {
      next.bible.rules = bible.rules.map(item => sanitizeVisualText(item)).filter(Boolean).slice(0, 6)
    }
    const script = bible.script_card || bible.scriptCard
    if (script) next.bible.scriptCard = sanitizeVisualMultiline(script)
  }
  for (const entry of patch.characters || []) {
    const id = cleanText(entry.id)
    const target = next.characters.find(item => item.id === id || item.name === cleanText(entry.name))
    if (!target) continue
    if (entry.name) target.name = sanitizeVisualText(entry.name)
    if (entry.identity) target.identity = sanitizeVisualText(entry.identity)
    const sheet = entry.sheetPrompt || entry.sheet_prompt
    if (sheet) target.sheetPrompt = sanitizeVisualText(sheet)
  }
  const remove = new Set((patch.remove_shot_ids || []).map(item => cleanText(item)).filter(Boolean))
  if (remove.size) next.shots = next.shots.filter(shot => !remove.has(shot.id))
  for (const entry of patch.shots || []) {
    const id = cleanText(entry.id)
    const indexHint = id.match(/shot-(\d+)/)?.[1]
    const target = next.shots.find(item => item.id === id || item.title === cleanText(entry.title))
      || (indexHint ? next.shots[Number(indexHint) - 1] : undefined)
    if (!target) continue
    if (entry.title) target.title = sanitizeVisualText(entry.title)
    if (entry.location) target.location = sanitizeVisualText(entry.location)
    if (entry.shotSize || entry.shot_size) target.shotSize = sanitizeVisualText(entry.shotSize || entry.shot_size || target.shotSize)
    if (entry.camera) target.camera = sanitizeVisualText(entry.camera)
    if (entry.action) target.action = sanitizeVisualText(entry.action)
    if (entry.dialogue !== undefined) target.dialogue = sanitizeVisualText(entry.dialogue)
    if (entry.storyboard) target.storyboard = sanitizeVisualText(entry.storyboard)
    if (entry.imagePrompt || entry.image_prompt) target.imagePrompt = sanitizeVisualText(entry.imagePrompt || entry.image_prompt || '')
    if (entry.motionPrompt || entry.motion_prompt) target.motionPrompt = sanitizeVisualText(entry.motionPrompt || entry.motion_prompt || '')
    if (!target.storyboard && target.action) target.storyboard = target.action
    if (!target.imagePrompt && target.action) target.imagePrompt = target.action
  }
  for (const entry of patch.add_shots || []) {
    if (next.shots.length >= CANVAS_FLOW_DIRECTOR_MAX_SHOTS) break
    const title = sanitizeVisualText(cleanText(entry.title, `镜头 ${next.shots.length + 1}`))
    const action = sanitizeVisualText(cleanText(entry.action || entry.storyboard, title))
    next.shots.push({
      id: `shot-${next.shots.length + 1}`,
      title,
      hasCharacters: false,
      characterIds: [],
      location: sanitizeVisualText(cleanText(entry.location)),
      shotSize: sanitizeVisualText(cleanText(entry.shotSize || entry.shot_size, '中景')),
      camera: sanitizeVisualText(cleanText(entry.camera, '固定')),
      action,
      dialogue: sanitizeVisualText(cleanText(entry.dialogue)),
      storyboard: action,
      imagePrompt: sanitizeVisualText(cleanText(entry.imagePrompt || entry.image_prompt, action)),
      motionPrompt: sanitizeVisualText(cleanText(entry.motionPrompt || entry.motion_prompt, entry.camera || '固定')),
      duration: clampDuration(entry.duration, 5),
    })
  }
  return next
}

function nodeMatchesRole(node: CanvasFlowNode, role: CanvasFlowDirectorRole, ref = '') {
  const inferred = inferCanvasFlowDirectorRole(node)
  if (inferred !== role) return false
  if (!ref) return true
  return node.data.directorRef === ref || String(node.data.title || '').includes(ref)
}

function markStaleIfPromptChanged(node: CanvasFlowNode, nextPrompt: string): CanvasFlowNode {
  const previous = String(node.data.prompt || '')
  if (previous === nextPrompt) return node
  return {
    ...node,
    data: {
      ...node.data,
      prompt: nextPrompt,
      stale: node.data.kind === 'result' || canvasFlowResultHasMedia(node.data) ? true : node.data.stale,
      updatedAt: Date.now(),
    },
  }
}

function directorShotForNode(plan: CanvasFlowDirectorPlan, node: CanvasFlowNode) {
  const ref = cleanText(node.data.directorRef)
  if (ref) {
    const referenced = plan.shots.find(shot => shot.id === ref)
    if (referenced) return referenced
  }
  const nodeRef = slugId(cleanText(node.id), '')
  if (nodeRef) {
    const originalNodeShot = plan.shots.find(shot => shot.id === nodeRef)
    if (originalNodeShot) return originalNodeShot
  }
  const prompt = cleanText(node.data.prompt || node.data.text)
  if (prompt) {
    const contentMatch = plan.shots.find(shot => (
      prompt === shot.imagePrompt
      || prompt === shot.motionPrompt
      || prompt === shot.action
      || prompt === shot.storyboard
    ))
    if (contentMatch) return contentMatch
  }
  const title = cleanText(node.data.title)
  return title ? plan.shots.find(shot => shot.title === title || title.includes(shot.title)) : undefined
}

function matchingDirectorShot(
  target: CanvasFlowDirectorPlan,
  shot: CanvasFlowDirectorShot,
  source: CanvasFlowDirectorPlan,
) {
  const idMatch = target.shots.find(item => item.id === shot.id)
  if (idMatch) return idMatch
  if (source.shots.filter(item => item.title === shot.title).length !== 1) return undefined
  const titleMatches = target.shots.filter(item => item.title === shot.title)
  return titleMatches.length === 1 ? titleMatches[0] : undefined
}

export function applyDirectorPlanToExistingGraph(
  graph: CanvasFlowGraph,
  previous: CanvasFlowDirectorPlan,
  next: CanvasFlowDirectorPlan,
  options: CanvasFlowDirectorCompileOptions = {},
): { graph: CanvasFlowGraph; changedNodeIds: string[] } {
  const compiled = compileCanvasFlowDirectorPlan(next, {
    ...options,
    includeVideo: options.includeVideo,
    occupiedIds: graph.nodes.map(node => node.id),
  })
  const changed = new Set<string>()
  const nodes = graph.nodes.map(node => {
    const role = inferCanvasFlowDirectorRole(node)
    if (role === 'story') {
      const text = storyCardText(next)
      if (node.data.text === text) return node
      changed.add(node.id)
      return { ...node, data: { ...node.data, text, updatedAt: Date.now() } }
    }
    if (role === 'script') {
      if (node.data.text === next.bible.scriptCard) return node
      changed.add(node.id)
      return { ...node, data: { ...node.data, text: next.bible.scriptCard, updatedAt: Date.now() } }
    }
    if (role === 'board') {
      const text = storyboardTable(next) || next.bible.logline
      if (node.data.text === text) return node
      changed.add(node.id)
      return { ...node, data: { ...node.data, text, updatedAt: Date.now() } }
    }
    if (role === 'style') {
      const prompt = stylePrompt(next)
      if (node.data.prompt === prompt) return node
      changed.add(node.id)
      return markStaleIfPromptChanged(node, prompt)
    }
    if (role === 'character') {
      const character = next.characters.find(item => nodeMatchesRole(node, 'character', item.id) || String(node.data.title || '').includes(item.name))
      if (!character) return node
      const variant = /正面/.test(String(node.data.title || '')) ? 'front' : 'turnaround'
      const prompt = characterSheetPrompt(next, character, variant)
      if (node.data.kind === 'prompt' || node.data.kind === 'generator') {
        if (node.data.prompt === prompt) return node
        changed.add(node.id)
        return markStaleIfPromptChanged(node, prompt)
      }
      if (node.data.kind === 'result' && previous.characters.find(item => item.id === character.id)?.sheetPrompt !== character.sheetPrompt) {
        changed.add(node.id)
        return { ...node, data: { ...node.data, stale: true, updatedAt: Date.now() } }
      }
    }
    const canCarryShot = role === 'shot' || (
      !role && ['prompt', 'generator', 'video-generator', 'result'].includes(node.data.kind)
    )
    if (canCarryShot) {
      const previousShot = directorShotForNode(previous, node)
      const shot = previousShot
        ? matchingDirectorShot(next, previousShot, previous)
        : directorShotForNode(next, node)
      if (!shot) return node
      const referenced = next.characters.filter(character => shot.characterIds.includes(character.id))
      const prompt = /运镜|视频/.test(String(node.data.title || '')) || node.data.kind === 'video-generator'
        ? shotMotionPrompt(shot)
        : shotImagePrompt(next, shot, referenced)
      if (node.data.kind === 'prompt' || node.data.kind === 'generator' || node.data.kind === 'video-generator') {
        if (node.data.prompt === prompt) return node
        changed.add(node.id)
        return markStaleIfPromptChanged(node, prompt)
      }
      if (node.data.kind === 'result') {
        const old = previousShot || previous.shots.find(item => item.id === shot.id)
        if (old && old.imagePrompt === shot.imagePrompt && old.action === shot.action && old.dialogue === shot.dialogue) return node
        changed.add(node.id)
        return { ...node, data: { ...node.data, stale: true, updatedAt: Date.now() } }
      }
    }
    return node
  })

  const removedShotIds = previous.shots
    .filter(shot => !matchingDirectorShot(next, shot, previous))
    .map(shot => shot.id)
  const keptNodes = removedShotIds.length
    ? nodes.filter(node => {
        const shot = directorShotForNode(previous, node)
        return !shot || !removedShotIds.includes(shot.id)
      })
    : nodes
  const keptIds = new Set(keptNodes.map(node => node.id))
  const edges = graph.edges.filter(edge => keptIds.has(edge.source) && keptIds.has(edge.target))

  const extraOps: CanvasFlowDesignOp[] = []
  const compiledNodeIds = new Map<string, string>()
  const claimedExistingIds = new Set<string>()
  const addedNodeIds = new Set<string>()
  compiled.ops.forEach(op => {
    if (op.type !== 'add_node') return
    const role = inferCanvasFlowDirectorRole(op.node)
    const title = String(op.node.data.title || '')
    const ref = String(op.node.data.directorRef || '')
    const referencedShot = role === 'shot' && ref ? next.shots.find(shot => shot.id === ref) : undefined
    const existing = keptNodes.find(node => {
      if (claimedExistingIds.has(node.id) || node.data.kind !== op.node.data.kind) return false
      if (role === 'shot' && ref && (node.id === ref || slugId(cleanText(node.id), '') === ref)) return true
      const nodeTitle = String(node.data.title || '')
      const nodeRole = inferCanvasFlowDirectorRole(node)
      if (role && nodeRole === role && ref && node.data.directorRef === ref) return true
      if (title && nodeTitle === title) return true
      return role === 'shot' && referencedShot
        ? nodeRole !== 'character' && nodeTitle.includes(referencedShot.title)
        : false
    })
    if (existing) {
      compiledNodeIds.set(op.node.id, existing.id)
      claimedExistingIds.add(existing.id)
      return
    }
    if (role !== 'shot' && role !== 'character') return
    extraOps.push(op)
    compiledNodeIds.set(op.node.id, op.node.id)
    addedNodeIds.add(op.node.id)
  })
  compiled.ops.forEach(op => {
    if (op.type !== 'add_edge') return
    const source = compiledNodeIds.get(op.edge.source)
    const target = compiledNodeIds.get(op.edge.target)
    if (!source || !target || (!addedNodeIds.has(source) && !addedNodeIds.has(target))) return
    extraOps.push({
      ...op,
      edge: {
        ...op.edge,
        id: `edge-${source}-${target}`,
        source,
        target,
      },
    })
  })
  const applied = extraOps.length ? applyCanvasFlowDesignOps({ nodes: keptNodes, edges }, extraOps) : { nodes: keptNodes, edges }
  extraOps.forEach(op => {
    if (op.type === 'add_node') changed.add(op.node.id)
  })
  return { graph: applied, changedNodeIds: [...changed] }
}

export function canvasFlowNodeSize(node: CanvasFlowNode) {
  return {
    width: Number(node.style?.width || node.width || 280),
    height: Number(node.style?.height || node.height || 190),
  }
}

export function canvasFlowNodeCenter(node: CanvasFlowNode) {
  const { width, height } = canvasFlowNodeSize(node)
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
  }
}

export function canvasFlowNodePort(node: CanvasFlowNode, side: 'input' | 'output') {
  const { width, height } = canvasFlowNodeSize(node)
  return {
    x: node.position.x + (side === 'input' ? 0 : width),
    y: node.position.y + height / 2,
  }
}

export function canvasFlowDesignOpDuration(op: CanvasFlowDesignOp, reducedMotion = false) {
  if (reducedMotion) return 0
  return op.type === 'add_node' ? 320 : 520
}

export function applyCanvasFlowDesignOps(
  graph: CanvasFlowGraph,
  ops: CanvasFlowDesignOp[],
  untilIndex = ops.length,
): CanvasFlowGraph {
  let nodes = [...graph.nodes]
  let edges = [...graph.edges]
  ops.slice(0, Math.max(0, untilIndex)).forEach(op => {
    if (op.type === 'add_node' && !nodes.some(node => node.id === op.node.id)) {
      nodes = [...nodes, op.node]
    }
    if (op.type === 'add_edge' && !edges.some(edge => edge.id === op.edge.id)) {
      const validation = validateCanvasFlowConnection({ nodes, edges }, op.edge)
      if (validation.valid) edges = [...edges, op.edge]
    }
  })
  return { nodes, edges }
}

function nodeTitle(node: CanvasFlowNode) {
  return String(node.data.title || '')
}

export function inspectCanvasFlowDirectorGraph(graph: { nodes: CanvasFlowNode[]; edges: CanvasFlowEdge[] }): CanvasFlowDirectorGraphInsight {
  const nodes = graph.nodes
  const edges = graph.edges
  const notes = nodes.filter(node => node.data.kind === 'note')
  const prompts = nodes.filter(node => node.data.kind === 'prompt')
  const generators = nodes.filter(node => node.data.kind === 'generator')
  const videos = nodes.filter(node => node.data.kind === 'video-generator')
  const results = nodes.filter(node => node.data.kind === 'result')
  const completedResults = results.filter(node => node.data.status === 'completed' && !node.data.stale)
  const hasScript = notes.some(node => /剧本|故事卡/.test(nodeTitle(node)))
  const hasBoard = notes.some(node => /分镜/.test(nodeTitle(node)))
  const hasCast = results.some(node => /锚点|三视图|正面锁定/.test(nodeTitle(node)))
    || prompts.some(node => /三视图|正面锁定/.test(nodeTitle(node)))
  const hasStills = generators.some(node => /静帧|首帧/.test(nodeTitle(node)))
  const videoWithoutStill = videos.some(video => {
    const incoming = edges.filter(edge => edge.target === video.id).map(edge => nodes.find(node => node.id === edge.source))
    return !incoming.some(node => node && (node.data.kind === 'result' || /静帧|首帧/.test(nodeTitle(node))))
  })
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    notes: notes.length,
    prompts: prompts.length,
    generators: generators.length,
    videos: videos.length,
    results: results.length,
    completedResults: completedResults.length,
    hasScript,
    hasBoard,
    hasCast,
    hasStills,
    hasVideo: videos.length > 0,
    missingCharacterAnchors: hasStills && !hasCast,
    videoWithoutStill,
  }
}

export function suggestCanvasFlowDirectorNext(
  graph: { nodes: CanvasFlowNode[]; edges: CanvasFlowEdge[] },
  options: { grokEnabled?: boolean } = {},
): CanvasFlowDirectorSuggestion[] {
  const insight = inspectCanvasFlowDirectorGraph(graph)
  const suggestions: CanvasFlowDirectorSuggestion[] = []
  if (insight.nodeCount === 0) {
    suggestions.push({
      id: 'start-script',
      title: '下一步：先写这一集',
      detail: '空画布先把地点、规则、人物和开场钩子写清楚。',
      action: 'direct',
    })
    return suggestions
  }
  if (!insight.hasScript) {
    suggestions.push({
      id: 'add-script',
      title: '下一步：补这一集剧本',
      detail: '画布还没有能演的场次和对白，先写剧本再拆镜。',
      action: 'direct',
    })
  } else if (insight.hasScript && !insight.hasBoard) {
    suggestions.push({
      id: 'add-board',
      title: '下一步：拆分镜表',
      detail: '剧本已经在了，按阅读顺序排出 4–8 个可拍摄瞬间。',
      action: 'direct',
    })
  } else if (insight.missingCharacterAnchors || (insight.hasBoard && !insight.hasCast)) {
    suggestions.push({
      id: insight.missingCharacterAnchors ? 'cast-before-stills' : 'lock-cast',
      title: insight.missingCharacterAnchors ? '下一步：静帧前补角色锚点' : '下一步：锁角色三视图',
      detail: '先出三视图和正面锁定，再画镜头，后面才不会换脸。',
      action: 'direct',
    })
  } else if (insight.hasCast && !insight.hasStills) {
    suggestions.push({
      id: 'make-stills',
      title: '下一步：按分镜出静帧',
      detail: '角色已经锁定，铺每镜独立宽银幕静帧当投产垫图。',
      action: 'direct',
    })
  } else if (insight.generators > 0 && insight.completedResults === 0) {
    suggestions.push({
      id: 'run-workflow',
      title: '下一步：先跑角色垫图',
      detail: `画布上有 ${insight.generators} 个生成节点。先跑角色，再跑镜头静帧。`,
      action: 'run',
    })
  } else if (insight.hasStills && !insight.hasVideo && options.grokEnabled !== false) {
    suggestions.push({
      id: 'make-episode',
      title: '下一步：静帧转成片',
      detail: '每镜用自己的静帧做图生视频，不要拿九宫格当第一帧。',
      action: 'direct',
    })
  } else if (insight.videoWithoutStill) {
    suggestions.push({
      id: 'fix-video-first-frame',
      title: '先检查：视频首帧接错了',
      detail: '有视频节点没有吃独立静帧，容易把漫画页当成第一帧。',
      action: 'review',
    })
  }
  if (suggestions.length === 0) {
    suggestions.push({
      id: 'review-prompts',
      title: '下一步：检查提示词',
      detail: '结构已经齐了。打开角色和静帧提示词，确认没有换故事。',
      action: 'review',
    })
  }
  return suggestions.slice(0, 1)
}

export function directorThinkingLines(input: {
  topic: string
  objective?: CanvasFlowDirectorObjective
  sourceKind?: CanvasFlowDirectorSourceKind
  genre: CanvasFlowDirectorGenre
  look: CanvasFlowDirectorLook
  stage: CanvasFlowDirectorStage
  shotCount: number
  includeVideo: boolean
  insight?: CanvasFlowDirectorGraphInsight
}) {
  const genre = canvasFlowDirectorGenreSpec(input.genre)
  const look = canvasFlowDirectorLookSpec(input.look)
  const stage = CANVAS_FLOW_DIRECTOR_STAGES.find(item => item.id === input.stage)
  const objective = CANVAS_FLOW_DIRECTOR_OBJECTIVES.find(item => item.id === input.objective)
  const sourceKind = input.sourceKind || inferCanvasFlowDirectorSourceKind(input.topic)
  const lines = [
    sourceKind === 'canvas'
      ? '已读取现有制作包，先锁定用户点名的修改范围。'
      : sourceKind === 'script'
        ? '已识别为剧本输入，先核对人物、场次和关键事件，再拆生产任务。'
        : '已识别为灵感输入，先补齐本集冲突、人物、场次和开场钩子。',
    `本次目标是「${objective?.label || '完整制作包'}」，交付物与检查关口会写进画布。`,
    `类型参考「${genre.label}」，视觉锁定为「${look.label}」。`,
    `生产链铺到「${stage?.label || '分镜静帧'}」。`,
  ]
  if (input.insight?.nodeCount) {
    lines.push(`当前画布 ${input.insight.nodeCount} 个节点：剧本${input.insight.hasScript ? '已有' : '还没有'}，角色垫图${input.insight.hasCast ? '已有' : '还没有'}，静帧${input.insight.hasStills ? '已有' : '还没有'}。`)
  }
  if (input.stage === 'cast') lines.push('角色会出三视图和正面锁定两张垫图，后面镜头都吃同一张脸。')
  if (input.stage === 'stills' || input.stage === 'episode') {
    lines.push(`镜头轨按 ${input.shotCount} 镜拆，每镜独立宽银幕静帧，不拿九宫格当视频首帧。`)
  }
  if (input.stage === 'episode' && input.includeVideo) lines.push('视频只接该镜静帧结果，运镜写场景动作，不扫漫画页。')
  return lines
}
