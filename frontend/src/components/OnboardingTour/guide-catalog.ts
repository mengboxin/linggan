import type { EditorMode } from '../../lib/editor-store'

export interface LocalizedGuideText {
  zh: string
  en: string
}

export type GuidePlacement = 'top' | 'bottom' | 'left' | 'right' | 'center'
export type GuidePetAnimation = 'idle' | 'waving' | 'jumping' | 'running' | 'running-right' | 'review'
export type GuideChapterGroup = 'getting-started' | 'image' | 'presentation' | 'discovery' | 'system'

export const GUIDE_CHAPTER_IDS = [
  'overview',
  'compute',
  'text-to-image',
  'image-edit-workflow',
  'image-retouch',
  'prompt-lens',
  'poster',
  'scientific-figure',
  'ppt-generation',
  'ppt-presentation',
  'canvas-flow',
  'gallery',
  'inspiration-recipes',
  'workspace',
  'account',
  'download',
] as const

export type GuideChapterId = typeof GUIDE_CHAPTER_IDS[number]

export interface GuideParameterGroup {
  id: string
  title: LocalizedGuideText
  description: LocalizedGuideText
  targetSelector?: string
  mobileTargetId?: string
}

export interface GuideWorkflowStep {
  id: string
  title: LocalizedGuideText
  description: LocalizedGuideText
}

export interface GuideCommonIssue {
  id: string
  question: LocalizedGuideText
  answer: LocalizedGuideText
}

export interface GuideTourStep {
  id: string
  targetSelector: string | null
  fallbackSelector?: string
  mobileTargetId?: string
  placement: GuidePlacement
  title: LocalizedGuideText
  description: LocalizedGuideText
  petMessage: string
  petState: GuidePetAnimation
  tip?: LocalizedGuideText
  parameterId?: string
  requiredMode?: EditorMode
  ensurePanels?: ('left' | 'right')[]
  navigateTo?: string
  allowMissingTarget?: boolean
}

export interface GuideChapter {
  id: GuideChapterId
  group: GuideChapterGroup
  icon: string
  route: string
  editorMode?: EditorMode
  mobileAvailable: boolean
  title: LocalizedGuideText
  summary: LocalizedGuideText
  outcome: LocalizedGuideText
  parameters: readonly GuideParameterGroup[]
  workflow: readonly GuideWorkflowStep[]
  tips: readonly LocalizedGuideText[]
  commonIssues: readonly GuideCommonIssue[]
  tourSteps: readonly GuideTourStep[]
}

export const OVERVIEW_CHAPTER_ID: GuideChapterId = 'overview'

const t = (zh: string, en: string): LocalizedGuideText => ({ zh, en })

export const GUIDE_CHAPTERS: readonly GuideChapter[] = [
  {
    id: 'overview',
    group: 'getting-started',
    icon: 'explore',
    route: '/text-to-image',
    editorMode: 'TEXT_TO_IMAGE',
    mobileAvailable: true,
    title: t('平台总览', 'Platform overview'),
    summary: t('从创作入口到生成、编辑、复用与交付，先建立完整的平台地图。', 'Build a complete map from creation entry to generation, editing, reuse, and delivery.'),
    outcome: t('看完后，你能判断每类任务应该从哪个模块开始，并知道历史、算力、灵感配方和交付产物分别在哪里。', 'After this chapter, you can choose the right module for any task and locate history, compute, inspiration recipes, and deliverables.'),
    parameters: [
      { id: 'creation-modes', title: t('创作模式', 'Creation modes'), description: t('图片生成、图片编辑、PPT、演示、自由画布、灵感广场和灵感反推各自保留独立任务。', 'Image generation, image edit, PPT, presentations, canvas flow, gallery, and Prompt Lens keep independent tasks.'), targetSelector: '[data-tour-id="mode-switcher"]', mobileTargetId: 'mobile-mode-switcher' },
      { id: 'history', title: t('历史与产物', 'History and artifacts'), description: t('左侧历史用于恢复任务，右侧产物用于查看、下载和继续编辑。', 'History restores tasks; artifact panels hold previews, downloads, and continuation actions.'), targetSelector: '[data-tour-id="left-panel"]' },
      { id: 'compute', title: t('算力与模型', 'Compute and models'), description: t('平台积分或 FoxAPI密钥决定调用来源，模型选择器会展示可用能力。', 'Platform credits or a connected FoxAPI key determine compute, while selectors expose available models.'), targetSelector: '[data-tour-id="compute-source-shortcut"]', mobileTargetId: 'mobile-credits-btn' },
      { id: 'account', title: t('账户与交付', 'Account and delivery'), description: t('个人中心管理账户、安全和使用记录；下载页提供桌面端与专业协作能力。', 'Profile manages account, security, and usage; Downloads provides desktop and professional handoff tools.'), targetSelector: '[data-tour-id="account-button"]' },
    ],
    workflow: [
      { id: 'choose', title: t('选择入口', 'Choose an entry'), description: t('先判断任务属于生成、编辑、演示、灵感分析还是可复用工作流。', 'First classify the task as generation, editing, presentation, inspiration analysis, or a reusable workflow.') },
      { id: 'configure', title: t('配置并提交', 'Configure and submit'), description: t('输入需求，补充参考素材，再设置模型、尺寸、质量和模块专属参数。', 'Describe the need, add references, then configure model, size, quality, and module-specific controls.') },
      { id: 'track', title: t('跟踪任务', 'Track the task'), description: t('从历史和进度卡查看排队、生成、失败与完成状态。', 'Use history and progress cards to follow queued, running, failed, and completed states.') },
      { id: 'continue', title: t('继续创作与交付', 'Continue and deliver'), description: t('打开结果进行放大、下载、精修、生成同款或导入下一条工作流。', 'Open results to inspect, download, retouch, generate similar work, or continue in another workflow.') },
    ],
    tips: [
      t('第一次使用先完成总览，再从手册进入具体模块的深度导览。', 'Complete the overview first, then launch a focused module tour from the manual.'),
      t('导览不会自动提交收费任务；结果态功能会在有真实产物时高亮，否则由手册示意。', 'The guide never submits billable jobs; result-only controls are highlighted when real artifacts exist and otherwise explained in the manual.'),
    ],
    commonIssues: [
      { id: 'wrong-entry', question: t('不知道应该进入哪个模块？', 'Not sure which module to use?'), answer: t('从任务产物倒推：生成新图用文生图，修改现有图用图片编辑，需要可复用链路用自由画布，需要拆解参考图用灵感反推。', 'Work backward from the deliverable: use Text to Image for new images, Image Edit for existing images, Canvas Flow for reusable chains, and Prompt Lens to study a reference.') },
    ],
    tourSteps: [
      {
        id: 'welcome', targetSelector: null, placement: 'center',
        title: t('欢迎来到 Linggan', 'Welcome to Linggan'),
        description: t('这里是从灵感到交付的 AI 创作工作台。接下来快速认识创作入口、任务历史、灵感配方、自由画布和账户管理。', 'This is an AI creation workspace from inspiration to delivery. Let us tour creation modes, history, recipes, canvas flow, and account controls.'),
        petMessage: '先认识整个平台，再进入你最常用的创作模块。', petState: 'waving',
      },
      {
        id: 'creation-switcher', targetSelector: '[data-tour-id="mode-switcher"]', placement: 'bottom', navigateTo: '/editor', requiredMode: 'IMAGE_EDIT', parameterId: 'creation-modes',
        title: t('选择创作方式', 'Choose a creation mode'),
        description: t('从这里进入图片生成、图片编辑、科研绘图、海报、PPT、演示、灵感广场、灵感反推和自由画布。', 'Open Image Generation, Image Edit, Research, Poster, PPT, Presentations, Gallery, Prompt Lens, or Canvas Flow.'),
        petMessage: '先选对工作台，每个模块都会保留自己的任务和历史。', petState: 'jumping',
      },
      {
        id: 'image-workbench', targetSelector: '[data-tour-id="bottom-input"]', placement: 'top', navigateTo: '/editor', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['right'],
        title: t('文生图工作台', 'Text-to-Image workspace'),
        description: t('描述画面，加入参考图或灵感配方，再选择模型、比例、清晰度和质量。', 'Describe the image, add references or a recipe, then choose model, ratio, resolution, and quality.'),
        petMessage: '提示词、参考图、灵感配方和生成参数会在同一个任务里保存。', petState: 'idle',
      },
      {
        id: 'image-edit-workflow', targetSelector: '[data-tour-id="center-canvas"]', placement: 'top', navigateTo: '/editor', requiredMode: 'IMAGE_EDIT', ensurePanels: ['left', 'right'],
        title: t('图片编辑工作流', 'Image-edit workflow'),
        description: t('导入图片后，每次编辑会成为可回溯节点；可以从任意节点继续分支、精修或导出。', 'After import, every edit becomes a traceable node that can branch, continue into retouching, or export.'),
        petMessage: '每次修改都留在自己的分支里，打开旧工作流不会复制新记录。', petState: 'review',
      },
      {
        id: 'prompt-lens', targetSelector: '#prompt-lens-title', placement: 'bottom', navigateTo: '/image-to-prompt',
        title: t('灵感反推与图片复现', 'Prompt Lens and reproduction'),
        description: t('上传图片后反推画面、构图和风格，可保存为个人灵感配方，也能在当前页面直接复现。', 'Upload an image to reverse-engineer visual language and style, save a personal recipe, or reproduce it inline.'),
        petMessage: '喜欢的画面可以变成自己的配方，也可以直接在这里复现。', petState: 'review',
      },
      {
        id: 'gallery', targetSelector: null, placement: 'center', navigateTo: '/gallery', allowMissingTarget: true,
        title: t('灵感广场与灵感配方', 'Gallery and inspiration recipes'),
        description: t('按图片类型浏览作品和配方，点赞、收藏或生成同款；每个技能会带入完整的风格约束。', 'Browse works and recipes by visual type, like, save, or generate similar results with complete style constraints.'),
        petMessage: '没有灵感时，先从作品和配方中选一个方向。', petState: 'running',
      },
      {
        id: 'canvas-flow', targetSelector: '[data-tour-id="canvas-tool-rail"]', placement: 'left', navigateTo: '/canvas-flow',
        title: t('自由画布', 'Canvas flow'),
        description: t('用提示词、图片、生成器和预览节点搭建可复用链路，连线决定数据如何流动。', 'Build reusable chains from prompt, image, generator, and preview nodes; edges define data flow.'),
        petMessage: '复杂、重复的创作过程适合沉淀成画布流。', petState: 'running-right',
      },
      {
        id: 'account', targetSelector: '[data-tour-id="account-button"]', placement: 'bottom', navigateTo: '/editor', requiredMode: 'IMAGE_EDIT', parameterId: 'account',
        title: t('账户、算力与下载', 'Account, compute, and downloads'),
        description: t('从个人中心管理积分或 FoxAPI Key、安全设置和记录；下载桌面端可使用本地资产、桌宠和 PS 协作。', 'Manage credits or a FoxAPI key, security, and records in Profile; the desktop app adds local assets, pets, and Photoshop handoff.'),
        petMessage: '最后记得检查算力来源、账户安全和交付方式。', petState: 'idle',
      },
    ],
  },
  {
    id: 'compute',
    group: 'system',
    icon: 'bolt',
    route: '/profile',
    mobileAvailable: true,
    title: t('算力与模型', 'Compute and models'),
    summary: t('理解平台积分、FoxAPI密钥、模型能力与任务费用。', 'Understand platform credits, connected FoxAPI keys, model capabilities, and job costs.'),
    outcome: t('看完后，你能选择合适的算力来源，读懂模型价格与任务扣费，并在连接异常时找到处理入口。', 'After this chapter, you can choose a compute source, understand model pricing and charges, and recover from connection issues.'),
    parameters: [
      { id: 'source', title: t('算力来源', 'Compute source'), description: t('平台积分由 Linggan 统一结算；FoxAPI密钥模式通过已绑定的 FoxAPI 账户调用。', 'Platform mode uses Linggan credits; FoxAPI Key mode calls through the connected FoxAPI account.'), targetSelector: '[data-tour-id="compute-source-shortcut"]', mobileTargetId: 'mobile-credits-btn' },
      { id: 'connection', title: t('连接状态', 'Connection status'), description: t('查看 Key 是否已配置、连通状态、指纹和可用模型数量。', 'Check whether a key is configured, its connection state, fingerprint, and available model count.'), targetSelector: '[data-tour-id="compute-source-dialog"]' },
      { id: 'model', title: t('模型能力', 'Model capabilities'), description: t('不同模块只展示兼容模型；免费、会员和按次模型会显示各自标签。', 'Each module lists compatible models with free, subscription, or per-use labels.'), targetSelector: '[data-tour-id="model-selector"]' },
      { id: 'cost', title: t('费用与记录', 'Cost and records'), description: t('提交前查看预估费用，完成后在积分记录或 FoxAPI 使用记录中核对。', 'Review estimates before submission and verify completed usage in credit or FoxAPI records.'), targetSelector: '[data-tour-id="model-cost"]' },
    ],
    workflow: [
      { id: 'open', title: t('打开算力设置', 'Open compute settings'), description: t('点击顶栏算力入口，确认当前使用平台积分还是 FoxAPI密钥。', 'Use the header shortcut to confirm platform-credit or FoxAPI Key mode.') },
      { id: 'verify', title: t('检查连接与模型', 'Verify connection and models'), description: t('FoxAPI密钥用户先确认连接正常和模型列表已同步。', 'FoxAPI Key users should verify the connection and synchronized model list.') },
      { id: 'estimate', title: t('查看费用后提交', 'Review cost and submit'), description: t('在模块的模型选择器中确认费用与输出规格，再提交任务。', 'Confirm model cost and output settings in the module before submitting.') },
      { id: 'audit', title: t('核对使用记录', 'Audit usage'), description: t('任务结束后从个人中心查看余额、扣费说明和关联任务。', 'After completion, inspect balance, charge description, and related task in Profile.') },
    ],
    tips: [
      t('连接状态异常时先重新打开算力设置，不要连续重复提交任务。', 'If connection status is unhealthy, reopen compute settings before retrying jobs.'),
      t('最终费用以成功的实际模型调用为准，失败前未发生的调用不会预扣。', 'Final cost follows successful model calls; calls that never occurred are not pre-charged.'),
    ],
    commonIssues: [
      { id: 'compute-unavailable', question: t('模型列表为空或提示算力不可用？', 'Models are missing or compute is unavailable?'), answer: t('打开算力设置检查当前来源；FoxAPI密钥模式确认连接与模型同步，平台积分模式确认余额和账户状态。', 'Open compute settings and verify the source; in FoxAPI Key mode check the connection and model sync, or in credit mode check balance and account state.') },
    ],
    tourSteps: [
      { id: 'compute-entry', targetSelector: '[data-tour-id="compute-source-shortcut"]', fallbackSelector: '[data-tour-id="account-button"]', placement: 'bottom', navigateTo: '/editor', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'source', title: t('确认算力来源', 'Confirm compute source'), description: t('顶栏会显示平台积分或 FoxAPI 连接状态，点击可进入完整设置。', 'The header shows platform credits or FoxAPI status; open it for full settings.'), petMessage: '先确认算力来源，再选择模型。', petState: 'idle' },
      { id: 'compute-models', targetSelector: '[data-tour-id="model-selector"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['right'], parameterId: 'model', title: t('选择兼容模型', 'Choose a compatible model'), description: t('模型选择器会根据模块与算力来源展示可用模型、能力和费用。', 'The selector filters available models, capabilities, and costs by module and compute source.'), petMessage: '不同任务适合的模型不一样，先看能力和费用标签。', petState: 'review' },
      { id: 'compute-records', targetSelector: '[data-tour-id="profile-compute-section"]', placement: 'right', navigateTo: '/profile', parameterId: 'cost', allowMissingTarget: true, title: t('查看余额与记录', 'Review balance and records'), description: t('个人中心汇总算力连接、积分余额、消费记录和关联任务。', 'Profile combines compute connection, balance, usage records, and related jobs.'), petMessage: '任务完成后可以在这里核对每一笔使用记录。', petState: 'idle' },
    ],
  },
  {
    id: 'text-to-image',
    group: 'image',
    icon: 'auto_awesome',
    route: '/text-to-image',
    editorMode: 'TEXT_TO_IMAGE',
    mobileAvailable: true,
    title: t('文生图', 'Text to Image'),
    summary: t('用提示词、参考图与灵感配方生成图片，并在历史中持续迭代。', 'Generate images with prompts, references, and recipes, then iterate from history.'),
    outcome: t('看完后，你能完整配置提示词、参考图、灵感配方、模型、画幅、清晰度和质量，并正确处理生成状态与结果。', 'After this chapter, you can configure prompt, references, recipes, model, ratio, resolution, and quality, then handle task states and results.'),
    parameters: [
      { id: 'prompt', title: t('提示词', 'Prompt'), description: t('描述主体、环境、构图、光线、材质和禁止项；清晰表达优先级。', 'Describe subject, setting, composition, lighting, materials, and exclusions with clear priorities.'), targetSelector: '[data-tour-id="text-to-image-prompt"]', mobileTargetId: 'mobile-prompt-input' },
      { id: 'references', title: t('参考图', 'References'), description: t('上传角色、构图、配色或产品参考图，并说明希望继承的部分。', 'Upload identity, composition, palette, or product references and state what should carry over.'), targetSelector: '[data-tour-id="text-to-image-references"]' },
      { id: 'recipe', title: t('灵感配方', 'Inspiration recipe'), description: t('配方会同时应用风格、构图、限制和负面约束，不只是追加一段提示词。', 'A recipe applies style, composition, constraints, and negative rules rather than appending one prompt.'), targetSelector: '[data-tour-id="text-to-image-recipe"]' },
      { id: 'model', title: t('模型', 'Model'), description: t('根据写实、文字渲染、参考图一致性和速度选择兼容模型。', 'Choose a compatible model for realism, typography, reference fidelity, or speed.'), targetSelector: '[data-tour-id="text-to-image-model"]' },
      { id: 'output', title: t('比例与输出', 'Ratio and output'), description: t('比例控制构图边界，清晰度控制像素规模，质量控制生成投入。', 'Ratio defines composition bounds, resolution defines pixel scale, and quality controls generation effort.'), targetSelector: '[data-tour-id="text-to-image-output"]' },
      { id: 'history', title: t('历史与结果', 'History and results'), description: t('任务提交后立即进入历史；完成后可放大、下载原图或导入图片编辑。', 'Submitted jobs enter history immediately; completed results can be viewed, downloaded, or imported into image edit.'), targetSelector: '[data-tour-id="left-panel"]' },
    ],
    workflow: [
      { id: 'describe', title: t('描述画面', 'Describe the image'), description: t('先写清主体和目的，再补充场景、镜头、材质与限制。', 'Start with subject and purpose, then add setting, camera, material, and constraints.') },
      { id: 'reference', title: t('加入参考与配方', 'Add references and a recipe'), description: t('需要一致性时加入参考图；需要稳定风格时选择灵感配方。', 'Use references for fidelity and a recipe for repeatable style.') },
      { id: 'configure', title: t('选择生成规格', 'Choose generation settings'), description: t('确认模型、比例、清晰度、质量和预估费用。', 'Confirm model, ratio, resolution, quality, and estimated cost.') },
      { id: 'submit', title: t('提交并跟踪', 'Submit and track'), description: t('提交后可继续创建其他任务，历史卡会持续更新当前状态。', 'Continue creating while the history card updates the task state.') },
      { id: 'reuse', title: t('查看、精修或复用', 'Inspect, retouch, or reuse'), description: t('打开原图下载，导入图片编辑，或把提示词与配方用于新任务。', 'Download the original, import it into Image Edit, or reuse its prompt and recipe.') },
    ],
    tips: [
      t('参考图越多不一定越好；每张图应承担明确的身份、构图或风格职责。', 'More references are not always better; give each image a clear identity, composition, or style role.'),
      t('生成中刷新页面不会丢失服务端任务，重新打开历史即可继续查看。', 'Refreshing during generation does not lose the server job; reopen it from history to continue tracking.'),
    ],
    commonIssues: [
      { id: 'blurry-download', question: t('预览清楚但下载后图片模糊？', 'The preview looks sharp but the download is blurry?'), answer: t('使用结果详情中的“下载原图”，不要保存缩略图；同时检查生成时选择的清晰度和画幅。', 'Use Download Original from result details instead of saving a thumbnail, and verify the selected resolution and ratio.') },
    ],
    tourSteps: [
      { id: 't2i-history', targetSelector: '[data-tour-id="left-panel"]', placement: 'right', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['left'], parameterId: 'history', title: t('历史与任务状态', 'History and task status'), description: t('左栏保存生成中、已完成和失败任务，点击记录恢复详情。', 'The left rail keeps running, completed, and failed jobs; select one to restore details.'), petMessage: '提交后先看这里，任务状态和旧作品都不会丢。', petState: 'review' },
      { id: 't2i-prompt', targetSelector: '[data-tour-id="text-to-image-prompt"]', fallbackSelector: '[data-tour-id="bottom-input"]', mobileTargetId: 'mobile-prompt-input', placement: 'top', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['right'], parameterId: 'prompt', title: t('写清画面意图', 'Describe the visual intent'), description: t('说明主体、场景、构图和用途；复杂要求按优先级分段。', 'State subject, scene, composition, and purpose; split complex constraints by priority.'), petMessage: '先把主体和用途讲清楚，再补充风格细节。', petState: 'idle' },
      { id: 't2i-recipe', targetSelector: '[data-tour-id="text-to-image-recipe"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['right'], parameterId: 'recipe', title: t('选择灵感配方', 'Choose an inspiration recipe'), description: t('配方是一套可复用的风格规则，会与当前主题和参考图共同生效。', 'A recipe is a reusable style rule set that works with the current subject and references.'), petMessage: '配方负责稳定风格，你只需要描述这次要画什么。', petState: 'jumping' },
      { id: 't2i-output', targetSelector: '[data-tour-id="text-to-image-output"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', ensurePanels: ['right'], parameterId: 'output', title: t('配置模型与输出', 'Configure model and output'), description: t('依次确认模型、画幅、清晰度、质量和费用，再开始生成。', 'Confirm model, ratio, resolution, quality, and cost before generating.'), petMessage: '画幅决定构图，清晰度和质量决定最终输出规模。', petState: 'review' },
      { id: 't2i-result', targetSelector: '[data-tour-id="center-canvas"]', placement: 'top', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'history', allowMissingTarget: true, title: t('查看并继续使用结果', 'Inspect and continue with a result'), description: t('结果可放大、下载原图或导入图片编辑继续精修。', 'Results can be viewed full size, downloaded, or imported into Image Edit.'), petMessage: '成品不是终点，还可以继续精修或复用。', petState: 'review' },
    ],
  },
  {
    id: 'image-edit-workflow',
    group: 'image',
    icon: 'account_tree',
    route: '/image-edit',
    editorMode: 'IMAGE_EDIT',
    mobileAvailable: false,
    title: t('图片编辑工作流', 'Image-edit workflow'),
    summary: t('用可回溯节点组织多轮编辑、分支、参考关系与版本。', 'Organize multi-round edits, branches, references, and versions as traceable nodes.'),
    outcome: t('看完后，你能正确创建或打开工作流、导入图片、选择节点、建立分支、查看原图并管理记录。', 'After this chapter, you can create or open a workflow, import images, select nodes, branch, inspect originals, and manage records.'),
    parameters: [
      { id: 'recent', title: t('最近工作流', 'Recent workflows'), description: t('左侧记录可打开、改名和删除；当前记录会高亮，打开不会复制新记录。', 'Recent workflows can be opened, renamed, or deleted; the active record is highlighted and reopening never duplicates it.'), targetSelector: '[data-tour-id="image-edit-recent-workflows"]' },
      { id: 'import', title: t('导入图片', 'Import image'), description: t('可从本地、文生图或海报历史导入，并明确选择新建或加入现有工作流。', 'Import from local files, image history, or poster history and choose a new or existing workflow.'), targetSelector: '[data-tour-id="image-edit-import"]' },
      { id: 'canvas', title: t('节点画布', 'Node canvas'), description: t('拖动节点整理布局，缩放和平移查看分支，点击节点设为当前编辑基准。', 'Drag nodes to organize, zoom and pan across branches, and select a node as the current edit base.'), targetSelector: '[data-tour-id="center-canvas"]' },
      { id: 'branch', title: t('分支与参考图', 'Branches and references'), description: t('从当前节点生成会建立子节点；参考图依附当前步骤，不会冒充生成结果。', 'Generating from the active node creates a child; references attach to the step without becoming results.'), targetSelector: '[data-tour-id="bottom-input"]' },
      { id: 'preview', title: t('预览与原图', 'Preview and originals'), description: t('节点预览支持放大、平移与原图下载，避免使用模糊缩略图。', 'Node previews support zoom, pan, and original-image downloads rather than blurred thumbnails.'), targetSelector: '[data-tour-id="workflow-preview-actions"]' },
    ],
    workflow: [
      { id: 'create', title: t('新建或打开工作流', 'Create or open a workflow'), description: t('新建时先确认名称；打开历史时恢复原任务，不创建副本。', 'Name new workflows first; opening history restores the same task without duplication.') },
      { id: 'import', title: t('导入起始图片', 'Import a starting image'), description: t('将本地或历史图片设为根节点，再进入画布。', 'Set a local or historical image as the root node, then enter the canvas.') },
      { id: 'select', title: t('选择基准节点', 'Select a base node'), description: t('点击希望继续处理的节点，确认当前分支和上下文。', 'Select the node you want to continue from and confirm its branch context.') },
      { id: 'generate', title: t('编辑并生成分支', 'Edit and create a branch'), description: t('输入修改要求或进入单图精修，结果会作为新节点连接到基准节点。', 'Submit an edit or enter Image Retouch; the result becomes a child of the base node.') },
      { id: 'manage', title: t('管理与交付', 'Manage and deliver'), description: t('重命名、删除或切换工作流，并从节点预览下载原图。', 'Rename, delete, or switch workflows and download originals from node previews.') },
    ],
    tips: [
      t('打开工作流只应读取现有记录；只有明确点击“新建”才创建记录。', 'Opening a workflow must only read the existing record; only an explicit New action creates one.'),
      t('删除节点前确认其后代数量，避免误删整条创作分支。', 'Check descendant count before deleting a node to avoid removing an entire branch accidentally.'),
    ],
    commonIssues: [
      { id: 'duplicate-workflow', question: t('打开记录后出现重复工作流？', 'Opening a record creates a duplicate workflow?'), answer: t('先确认使用的是“打开”而非“新建/导入”；正常打开只恢复同一个任务 ID，不应创建任何新记录。', 'Confirm that Open, not New or Import, was used; reopening must restore the same task ID without creating a record.') },
    ],
    tourSteps: [
      { id: 'workflow-recent', targetSelector: '[data-tour-id="image-edit-recent-workflows"]', fallbackSelector: '[data-tour-id="left-panel"]', placement: 'right', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', ensurePanels: ['left'], parameterId: 'recent', title: t('打开最近工作流', 'Open a recent workflow'), description: t('这里集中显示工作流记录，可打开、改名、删除或新建。', 'This rail lists workflows for opening, renaming, deleting, or creating.'), petMessage: '打开记录不会新建副本，只有新建按钮会创建工作流。', petState: 'review' },
      { id: 'workflow-import', targetSelector: '[data-tour-id="image-edit-import"]', fallbackSelector: '[data-tour-id="center-canvas"]', placement: 'top', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', parameterId: 'import', allowMissingTarget: true, title: t('导入起始图片', 'Import a starting image'), description: t('从本地或已有作品导入，确认目标工作流后进入节点画布。', 'Import from local files or existing work, choose the target workflow, and enter the node canvas.'), petMessage: '每条工作流先有一张起始图，再从它延伸分支。', petState: 'idle' },
      { id: 'workflow-canvas', targetSelector: '[data-tour-id="center-canvas"]', placement: 'top', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', ensurePanels: ['left', 'right'], parameterId: 'canvas', title: t('选择并整理节点', 'Select and organize nodes'), description: t('点击节点切换编辑基准，拖动整理布局，缩放和平移查看完整分支。', 'Select a node as the edit base, drag to organize, and zoom or pan across branches.'), petMessage: '当前高亮节点就是下一次编辑的起点。', petState: 'review' },
      { id: 'workflow-branch', targetSelector: '[data-tour-id="bottom-input"]', placement: 'top', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', parameterId: 'branch', title: t('从当前节点继续生成', 'Generate from the active node'), description: t('输入修改要求并提交，加载卡完成后会成为当前节点的子节点。', 'Submit an edit; its loading card becomes a child of the active node when complete.'), petMessage: '每次提交都会留下来源清晰的新节点。', petState: 'jumping' },
    ],
  },
  {
    id: 'image-retouch',
    group: 'image',
    icon: 'auto_fix_high',
    route: '/image-edit',
    editorMode: 'IMAGE_EDIT',
    mobileAvailable: true,
    title: t('单图精修', 'Image Retouch'),
    summary: t('在一张图上完成选择、标注、局部修改、扩图、图层与导出。', 'Select, annotate, edit locally, outpaint, manage layers, and export one image.'),
    outcome: t('看完后，你能使用统一撤销历史完成选区、马赛克、文字、水印和 image2 修改，并理解图层与导出。', 'After this chapter, you can use one undo history for selections, mosaic, text, watermark, and image2 edits, then manage layers and exports.'),
    parameters: [
      { id: 'tool', title: t('编辑工具', 'Editing tool'), description: t('点选、画笔、框选、标注、马赛克、文字和水印都属于同一编辑历史。', 'Point, brush, box, annotation, mosaic, text, and watermark share one edit history.'), targetSelector: '[data-tour-id="retouch-tools"]', mobileTargetId: 'mobile-retouch-workbench' },
      { id: 'options', title: t('工具选项', 'Tool options'), description: t('样式、字号、颜色、强度等扩展选项显示在画布旁或图片下方，不挤进窄工具栏。', 'Style, size, color, and strength options appear beside or below the canvas instead of crowding the tool rail.'), targetSelector: '[data-tour-id="retouch-tool-options"]' },
      { id: 'prompt', title: t('自然语言修改', 'Natural-language edit'), description: t('选定区域后描述替换、移除、重绘或调整要求，再交给 image2。', 'After selecting an area, describe replacement, removal, redraw, or adjustment for image2.'), targetSelector: '[data-tour-id="retouch-prompt"]' },
      { id: 'outpaint', title: t('扩图', 'Outpainting'), description: t('选择常用比例或自定义画布范围，预览新增区域后提交。', 'Choose a common ratio or custom canvas bounds, preview the extension, then submit.'), targetSelector: '[data-tour-id="retouch-outpaint"]' },
      { id: 'undo', title: t('撤销与重做', 'Undo and redo'), description: t('所有标注和编辑共用同一变更栈，逐步撤销或重做。', 'Annotations and edits share one change stack for stepwise undo and redo.'), targetSelector: '[data-tour-id="retouch-undo-redo"]' },
      { id: 'layers', title: t('图层与导出', 'Layers and export'), description: t('管理可见性、活动图层和蒙版，并下载单图、图层包或交给 PS。', 'Manage visibility, active layers, and masks, then export an image, layer package, or Photoshop handoff.'), targetSelector: '[data-tour-id="right-panel"]' },
    ],
    workflow: [
      { id: 'open', title: t('打开图片', 'Open an image'), description: t('从工作流节点或导入入口进入单图精修。', 'Enter Image Retouch from a workflow node or import action.') },
      { id: 'choose', title: t('选择工具并定位', 'Choose and locate'), description: t('选择工具，再在图片上点选、涂抹、框选或添加元素。', 'Choose a tool, then point, brush, box-select, or add an element on the image.') },
      { id: 'configure', title: t('调整选项', 'Configure options'), description: t('设置工具样式，或为 image2 写明目标与保留项。', 'Set tool style or state the image2 goal and preservation constraints.') },
      { id: 'review', title: t('预览并撤销', 'Review and undo'), description: t('检查结果，使用统一撤销/重做修正全部编辑动作。', 'Review the result and correct any edit through unified undo and redo.') },
      { id: 'export', title: t('回到工作流或导出', 'Return or export'), description: t('AI 结果作为新节点回到工作流；也可直接下载或交给外部编辑。', 'AI results return as workflow nodes or can be downloaded and handed off externally.') },
    ],
    tips: [
      t('工具选项只在对应工具激活时出现，避免不同工具参数互相干扰。', 'Tool options appear only for the active tool so settings never conflict.'),
      t('复杂局部修改先小范围验证，再扩大选区，通常更容易保持主体一致。', 'Validate complex edits on a small region before expanding the selection to preserve consistency.'),
    ],
    commonIssues: [
      { id: 'undo-scope', question: t('为什么撤销没有回退刚才的马赛克或文字？', 'Why did undo not revert the mosaic or text edit?'), answer: t('确认编辑已进入统一变更历史；标注、文字、马赛克和 AI 修改应按发生顺序共用同一撤销/重做栈。', 'Ensure the action entered the unified change history; annotations, text, mosaic, and AI edits must share one chronological undo/redo stack.') },
    ],
    tourSteps: [
      { id: 'retouch-tools', targetSelector: '[data-tour-id="retouch-tools"]', fallbackSelector: '[data-tour-id="center-canvas"]', mobileTargetId: 'mobile-retouch-workbench', placement: 'right', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', parameterId: 'tool', allowMissingTarget: true, title: t('选择编辑工具', 'Choose an editing tool'), description: t('点选、画笔、框选、马赛克、文字与水印会进入同一编辑历史。', 'Point, brush, box, mosaic, text, and watermark actions share one edit history.'), petMessage: '先选工具，再在图片上完成定位。', petState: 'idle' },
      { id: 'retouch-options', targetSelector: '[data-tour-id="retouch-tool-options"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', ensurePanels: ['right'], parameterId: 'options', allowMissingTarget: true, title: t('调整当前工具参数', 'Adjust active-tool options'), description: t('这里显示当前工具专属的样式、大小、颜色或强度。', 'This area shows style, size, color, or strength for the active tool.'), petMessage: '不同工具只显示自己的参数，不会挤在一起。', petState: 'review' },
      { id: 'retouch-undo', targetSelector: '[data-tour-id="retouch-undo-redo"]', fallbackSelector: '[data-tour-id="center-canvas"]', placement: 'bottom', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', parameterId: 'undo', allowMissingTarget: true, title: t('统一撤销与重做', 'Unified undo and redo'), description: t('标注、文字、马赛克和 AI 编辑都按实际变更顺序撤销或恢复。', 'Annotations, text, mosaic, and AI edits undo or redo in their real change order.'), petMessage: '所有修改共用一条清晰的撤销历史。', petState: 'review' },
      { id: 'retouch-layers', targetSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', ensurePanels: ['right'], parameterId: 'layers', title: t('管理图层与导出', 'Manage layers and export'), description: t('切换图层可见性和活动层，完成后下载、打包或发送到 Photoshop。', 'Manage visibility and active layers, then download, package, or send to Photoshop.'), petMessage: '最后检查图层，再选择合适的交付方式。', petState: 'idle' },
    ],
  },
  {
    id: 'prompt-lens',
    group: 'discovery',
    icon: 'image_search',
    route: '/image-to-prompt',
    mobileAvailable: false,
    title: t('灵感反推', 'Prompt Lens'),
    summary: t('一次分析同时提取可复现提示词与可迁移风格，并在当前页面直接复现。', 'One analysis extracts both a reproducible prompt and a transferable style, then reproduces it inline.'),
    outcome: t('看完后，你能上传或恢复参考图、校对完整视觉分析、确认加入个人灵感配方，并用原图参考直接生成复现结果。', 'After this chapter, you can upload or restore a reference, review the full visual analysis, confirm a personal recipe, and reproduce with the original image attached.'),
    parameters: [
      { id: 'history', title: t('反推历史', 'Prompt Lens history'), description: t('历史保存原图、完整视觉分析、配方状态和复现产物，可重新打开或删除；旧模式记录也能继续使用。', 'History preserves the source, full visual analysis, recipe state, and reproductions; legacy mode records remain usable.'), targetSelector: '[data-tour-id="prompt-history"]' },
      { id: 'source', title: t('原始图片', 'Source image'), description: t('上传需要分析的清晰原图；它也会作为复现时的视觉参考。', 'Upload a clear source image; it is also used as the visual reference for reproduction.'), targetSelector: '[data-tour-id="prompt-upload"]' },
      { id: 'analysis-settings', title: t('分析设置', 'Analysis settings'), description: t('按需选择视觉模型后开始反推；单次分析会同时返回复现提示词和可迁移风格，不再需要切换目标。', 'Choose a vision model if needed, then analyze once to receive both the reproduction prompt and transferable style without switching modes.'), targetSelector: '[data-tour-id="prompt-analysis-settings"]' },
      { id: 'analysis', title: t('完整视觉分析', 'Complete visual analysis'), description: t('同时检查可复现提示词，以及主体、构图、光线、色彩、材质、镜头与负面约束等稳定风格规则。', 'Review the reproducible prompt together with stable rules for subject, composition, lighting, palette, material, camera, and negative constraints.'), targetSelector: '[data-tour-id="prompt-analysis"]' },
      { id: 'recipe', title: t('加入灵感配方', 'Add to inspiration recipes'), description: t('确认并编辑配方名称后保存；同一条分析只加入一次，旧历史缺少状态时按未保存处理。', 'Confirm and edit the recipe name before saving; each analysis is added once, while legacy records without status remain unsaved.'), targetSelector: '[data-tour-id="prompt-analysis"]' },
      { id: 'reproduce', title: t('页内复现', 'Inline reproduction'), description: t('选择模型、比例、清晰度和质量后直接生成，并在同页查看、取消、重试和下载原图。', 'Choose model, ratio, resolution, and quality, then generate, cancel, retry, inspect, and download inline.'), targetSelector: '[data-tour-id="prompt-result-settings"]' },
    ],
    workflow: [
      { id: 'open', title: t('打开历史或上传图片', 'Open history or upload'), description: t('恢复旧记录，或上传一张新图开始分析。', 'Restore a previous record or upload a new image.') },
      { id: 'analyze', title: t('一次完成视觉分析', 'Run one complete analysis'), description: t('选择视觉模型并运行 Agent，一次得到可编辑提示词与可迁移风格规则。', 'Choose a vision model and run the agent once to receive an editable prompt and transferable style rules.') },
      { id: 'review', title: t('校对提示词与风格', 'Review prompt and style'), description: t('检查关键描述是否与原图一致，并在复现前直接修改提示词。', 'Verify the key descriptions against the source and edit the prompt before reproduction.') },
      { id: 'save', title: t('确认加入灵感配方', 'Confirm the recipe'), description: t('需要复用风格时打开确认框，修改名称后加入自己的灵感配方。', 'When the style should be reusable, open the confirmation dialog, rename it, and add it to personal recipes.') },
      { id: 'generate', title: t('直接复现', 'Reproduce inline'), description: t('使用原图参考和当前参数生成，结果继续保存在同一历史记录。', 'Generate with the source reference and current settings; the result stays in the same history record.') },
    ],
    tips: [
      t('反推提示词不是逐像素复制；保留原图作为参考能明显提高构图和主体一致性。', 'A reverse prompt is not pixel-perfect cloning; keeping the source as a reference greatly improves composition and subject fidelity.'),
      t('灵感配方应描述稳定规则，避免把原图中的具体人物姓名或一次性文案写进配方。', 'A recipe should capture stable rules rather than source-specific names or one-off copy.'),
    ],
    commonIssues: [
      { id: 'reproduction-drift', question: t('复现结果与原图差异很大？', 'The reproduction differs greatly from the source?'), answer: t('保留原图作为参考，检查分析结果中的构图、镜头和主体描述，再选择更适合参考图一致性的模型。', 'Keep the source as a reference, correct composition, camera, and subject analysis, then choose a model with stronger reference fidelity.') },
    ],
    tourSteps: [
      { id: 'lens-history', targetSelector: '[data-tour-id="prompt-history"]', placement: 'right', navigateTo: '/image-to-prompt', parameterId: 'history', allowMissingTarget: true, title: t('管理反推历史', 'Manage Prompt Lens history'), description: t('重新打开原图、分析结果和复现图片，或删除不再需要的记录。', 'Reopen source images, analyses, and reproductions or delete obsolete records.'), petMessage: '每次反推和复现都保存在同一条记录里。', petState: 'review' },
      { id: 'lens-upload', targetSelector: '[data-tour-id="prompt-upload"]', fallbackSelector: '#prompt-lens-title', placement: 'right', navigateTo: '/image-to-prompt', parameterId: 'source', title: t('上传需要分析的图片', 'Upload an image to analyze'), description: t('选择清晰原图，它会同时用于视觉分析和后续页内复现。', 'Choose a clear source for both visual analysis and later inline reproduction.'), petMessage: '原图越清楚，构图、光线和材质分析越可靠。', petState: 'idle' },
      { id: 'lens-analysis-settings', targetSelector: '[data-tour-id="prompt-analysis-settings"]', fallbackSelector: '#prompt-lens-title', placement: 'bottom', navigateTo: '/image-to-prompt', parameterId: 'analysis-settings', allowMissingTarget: true, title: t('一次完成提示词与风格分析', 'Analyze prompt and style together'), description: t('选择视觉模型后开始反推，系统会同时输出可复现提示词和可迁移风格。', 'Choose a vision model and analyze once to receive both the reproduction prompt and transferable style.'), petMessage: '不再切换模式，一次分析就能用于复现和配方沉淀。', petState: 'jumping' },
      { id: 'lens-analysis', targetSelector: '[data-tour-id="prompt-analysis"]', fallbackSelector: '#prompt-lens-title', placement: 'left', navigateTo: '/image-to-prompt', parameterId: 'analysis', allowMissingTarget: true, title: t('校对完整视觉分析', 'Review the complete analysis'), description: t('分别检查可编辑提示词和可迁移风格中的主体、构图、用光、色彩、材质与镜头规则。', 'Review the editable prompt and the transferable rules for subject, composition, lighting, palette, material, and camera.'), petMessage: '生成前可以修改提示词，稳定风格则可以加入自己的配方。', petState: 'review' },
      { id: 'lens-recipe', targetSelector: '[data-tour-id="prompt-analysis"]', fallbackSelector: '#prompt-lens-title', placement: 'left', navigateTo: '/image-to-prompt', parameterId: 'recipe', allowMissingTarget: true, title: t('确认加入灵感配方', 'Confirm the inspiration recipe'), description: t('点击“加入灵感配方”，在磨砂确认框中修改名称后保存；已经加入的历史不会重复创建。', 'Choose Add to inspiration recipes, edit the name in the confirmation dialog, and save; existing recipes are not duplicated.'), petMessage: '保存的是一整套稳定风格规则，不只是复制提示词。', petState: 'review' },
      { id: 'lens-reproduce', targetSelector: '[data-tour-id="prompt-result-settings"]', fallbackSelector: '#prompt-lens-title', placement: 'left', navigateTo: '/image-to-prompt', parameterId: 'reproduce', allowMissingTarget: true, title: t('在当前页面直接复现', 'Reproduce on this page'), description: t('设置模型与输出规格后生成，进度、取消、重试、预览和原图下载都留在这里。', 'Set model and output, then keep progress, cancel, retry, preview, and original download on this page.'), petMessage: '不用跳到别的模块，分析完就能直接复现。', petState: 'running-right' },
    ],
  },
  {
    id: 'poster',
    group: 'image',
    icon: 'wall_art',
    route: '/poster',
    editorMode: 'POSTER_GEN',
    mobileAvailable: true,
    title: t('海报设计', 'Poster design'),
    summary: t('将主题、素材和参考风格规划成单张或系列海报。', 'Turn a theme, source material, and visual references into one poster or a coordinated series.'),
    outcome: t('看完后，你能配置海报主题、数量、尺寸、文案、参考图、附件、模型与灵感配方，并管理版本和下载。', 'After this chapter, you can configure theme, count, size, copy, references, attachments, model, and recipes, then manage versions and downloads.'),
    parameters: [
      { id: 'brief', title: t('主题与创作方向', 'Theme and direction'), description: t('说明活动、产品或信息目标、受众、核心卖点和必须出现的文字。', 'State campaign, product, or information goal, audience, key message, and required copy.'), targetSelector: '[data-tour-id="poster-form-settings"]', mobileTargetId: 'mobile-poster-form' },
      { id: 'count', title: t('数量与系列结构', 'Count and series structure'), description: t('选择 1、2、3 或 5 张；多张海报应保持统一母题并承担不同信息职责。', 'Choose 1, 2, 3, or 5 posters; a series shares a visual system while each item carries a distinct message.'), targetSelector: '[data-tour-id="poster-form-settings"]' },
      { id: 'format', title: t('尺寸与画幅', 'Format and ratio'), description: t('按社交媒体、印刷或屏幕用途选择比例，参考图尺寸可作为约束。', 'Choose a ratio for social, print, or screen use; reference dimensions can act as constraints.'), targetSelector: '[data-tour-id="poster-form-settings"]' },
      { id: 'references', title: t('参考图与附件', 'References and attachments'), description: t('参考图控制版式密度和视觉语言；附件提供真实文案、数据和素材。', 'References guide layout density and visual language; attachments provide factual copy, data, and assets.'), targetSelector: '[data-tour-id="poster-form-settings"]' },
      { id: 'recipe', title: t('灵感配方', 'Inspiration recipe'), description: t('选择完整海报风格模板，稳定字体层级、构图、材质和配色规则。', 'Apply a complete poster style template for typography, composition, material, and palette rules.'), targetSelector: '[data-tour-id="poster-form-settings"]' },
      { id: 'model', title: t('模型与输出质量', 'Model and output quality'), description: t('选择支持文字和参考图的模型，并确认清晰度、质量与费用。', 'Choose a model that handles typography and references, then confirm resolution, quality, and cost.'), targetSelector: '[data-tour-id="poster-form-settings"]' },
      { id: 'artifacts', title: t('版本与任务产物', 'Versions and artifacts'), description: t('每张海报保留版本、当前选择、继续编辑和原图下载。', 'Each poster keeps versions, current selection, continuation actions, and original downloads.'), targetSelector: '[data-tour-id="poster-results-panel"]' },
    ],
    workflow: [
      { id: 'brief', title: t('填写海报简报', 'Write the poster brief'), description: t('明确主题、受众、核心信息、文案和使用场景。', 'Define theme, audience, key message, copy, and use context.') },
      { id: 'structure', title: t('确定系列结构', 'Set the series structure'), description: t('选择数量、比例和每张海报的信息分工。', 'Choose count, ratio, and the message role of each poster.') },
      { id: 'assets', title: t('加入参考与素材', 'Add references and assets'), description: t('上传风格参考和内容附件，或选择灵感配方。', 'Upload style references and source documents or choose a recipe.') },
      { id: 'generate', title: t('规划并生成', 'Plan and generate'), description: t('Agent 先理解素材和系列关系，再逐张调用图片模型。', 'The agent understands source material and series relationships before generating each poster.') },
      { id: 'refine', title: t('选择、编辑与下载', 'Select, refine, and download'), description: t('检查每张海报，继续修改、切换版本并下载原图。', 'Review each poster, continue editing, switch versions, and download originals.') },
    ],
    tips: [
      t('海报文字应明确“必须准确呈现”和“仅作为视觉装饰”的区别。', 'Separate copy that must render accurately from text used only as visual texture.'),
      t('系列海报最好让每张承担一个核心信息，避免所有内容重复堆叠。', 'Give each poster one core message rather than repeating every detail across the series.'),
    ],
    commonIssues: [
      { id: 'poster-copy', question: t('海报文字错误或层级混乱？', 'Poster copy is wrong or hierarchy is unclear?'), answer: t('把必须准确的文字单独列出并减少单张信息量；使用附件提供真实文案，让每张系列海报只承担一个核心信息。', 'List exact copy separately, reduce per-poster density, provide source text as an attachment, and give each series item one core message.') },
    ],
    tourSteps: [
      { id: 'poster-history', targetSelector: '[data-tour-id="poster-history-panel"]', placement: 'right', navigateTo: '/poster', requiredMode: 'POSTER_GEN', ensurePanels: ['left'], title: t('海报任务历史', 'Poster task history'), description: t('从左栏恢复系列任务、生成状态和旧版本。', 'Restore series jobs, generation states, and earlier versions from the left rail.'), petMessage: '一组系列海报会作为同一个任务保存。', petState: 'review' },
      { id: 'poster-brief', targetSelector: '[data-tour-id="poster-form-settings"]', fallbackSelector: '[data-tour-id="poster-workspace-panel"]', mobileTargetId: 'mobile-poster-form', placement: 'right', navigateTo: '/poster', requiredMode: 'POSTER_GEN', parameterId: 'brief', title: t('填写主题与文案', 'Enter theme and copy'), description: t('先写清受众、卖点、必须出现的文字和每张海报的任务。', 'Define audience, message, required copy, and the role of each poster.'), petMessage: '海报先解决信息层级，再决定视觉风格。', petState: 'idle' },
      { id: 'poster-assets', targetSelector: '[data-tour-id="poster-form-settings"]', fallbackSelector: '[data-tour-id="poster-workspace-panel"]', placement: 'right', navigateTo: '/poster', requiredMode: 'POSTER_GEN', parameterId: 'references', allowMissingTarget: true, title: t('加入素材与风格约束', 'Add assets and style constraints'), description: t('参考图控制版式和风格，附件提供真实内容，灵感配方稳定整套规则。', 'References guide layout and style, attachments provide facts, and recipes stabilize the full rule set.'), petMessage: '素材负责内容，参考和配方负责视觉方向。', petState: 'jumping' },
      { id: 'poster-results', targetSelector: '[data-tour-id="poster-results-panel"]', placement: 'left', navigateTo: '/poster', requiredMode: 'POSTER_GEN', ensurePanels: ['right'], parameterId: 'artifacts', title: t('管理版本与产物', 'Manage versions and artifacts'), description: t('完成后在这里选择版本、继续编辑、预览并下载原图。', 'After completion, select versions, continue editing, preview, and download originals here.'), petMessage: '生成完成后别忘了检查每张海报的版本和下载项。', petState: 'review' },
    ],
  },
  {
    id: 'scientific-figure',
    group: 'image',
    icon: 'science',
    route: '/scientific-figure',
    editorMode: 'SCI_FIG',
    mobileAvailable: true,
    title: t('科研生图', 'Scientific figures'),
    summary: t('根据论文、数据和机制描述生成可编辑 SVG 或视觉科研图。', 'Generate editable SVG diagrams or visual scientific figures from papers, data, and mechanism descriptions.'),
    outcome: t('看完后，你能选择 SVG 或 image2 路线，配置图表目标、期刊风格、附件、模型和输出，并正确理解版本与格式。', 'After this chapter, you can choose SVG or image2, configure figure goals, journal style, attachments, models, and outputs, then manage versions and formats.'),
    parameters: [
      { id: 'mode', title: t('SVG 与 image2', 'SVG and image2'), description: t('SVG 适合可编辑结构图与数据图；image2 适合复杂材质、器官、微观和视觉机制图。', 'SVG suits editable schematics and data figures; image2 suits richer material, organ, microscopic, and visual mechanism imagery.'), targetSelector: '[data-tour-id="sci-fig-form-settings"]', mobileTargetId: 'mobile-scifig-form' },
      { id: 'goal', title: t('科研目标', 'Scientific goal'), description: t('说明研究对象、机制关系、变量、结论、受众和希望表达的因果链。', 'State the subject, mechanism, variables, conclusion, audience, and causal chain to communicate.'), targetSelector: '[data-tour-id="sci-fig-form-settings"]' },
      { id: 'type', title: t('图表类型与期刊风格', 'Figure type and journal style'), description: t('可让 AI 自适应，或指定流程图、机制图、数据图及 Nature、Science、Cell 等方向。', 'Let AI adapt or choose flowchart, mechanism, data figure, and Nature, Science, Cell, or other directions.'), targetSelector: '[data-tour-id="sci-fig-form-settings"]' },
      { id: 'attachments', title: t('论文与数据附件', 'Paper and data attachments'), description: t('上传论文、PDF、Word、PPT、表格、截图或参考图，系统先解析事实再规划。', 'Upload papers, PDFs, Word, PPT, tables, screenshots, or references; facts are parsed before planning.'), targetSelector: '[data-tour-id="sci-fig-form-settings"]' },
      { id: 'models', title: t('规划与生成模型', 'Planning and generation models'), description: t('文本模型负责理解和规划；SVG 或图像模型负责最终输出，费用分别展示。', 'A text model handles understanding and planning; SVG or image models produce output with separate cost labels.'), targetSelector: '[data-tour-id="sci-fig-form-settings"]' },
      { id: 'artifacts', title: t('版本与格式', 'Versions and formats'), description: t('保存 Agent 理解、版本历史及 SVG、PNG、PDF 等可用产物。', 'Preserve agent understanding, version history, and available SVG, PNG, or PDF artifacts.'), targetSelector: '[data-tour-id="sci-fig-results-panel"]' },
    ],
    workflow: [
      { id: 'goal', title: t('定义图表目标', 'Define the figure goal'), description: t('先说明论文要证明什么，以及读者应该按什么顺序理解。', 'State what the paper must demonstrate and the order readers should follow.') },
      { id: 'mode', title: t('选择输出路线', 'Choose an output route'), description: t('需要编辑和精确标签选 SVG，需要丰富视觉表达选 image2。', 'Choose SVG for editability and precise labels, or image2 for richer visuals.') },
      { id: 'evidence', title: t('上传证据材料', 'Upload evidence'), description: t('加入论文、数据和参考图，避免模型凭空补充科学事实。', 'Add papers, data, and references so the model does not invent scientific facts.') },
      { id: 'plan', title: t('检查 Agent 规划', 'Review agent planning'), description: t('确认机制、变量、箭头、面板层级和标签语言。', 'Verify mechanism, variables, arrows, panel hierarchy, and label language.') },
      { id: 'iterate', title: t('生成并迭代', 'Generate and iterate'), description: t('查看产物和格式，针对事实、结构或视觉问题继续编辑。', 'Inspect artifacts and formats, then refine factual, structural, or visual issues.') },
    ],
    tips: [
      t('科研图首先保证事实和关系正确，再追求视觉复杂度。', 'Scientific correctness and relationships come before visual complexity.'),
      t('附件中若有冲突数据，应在提示中明确采用哪个版本或时间点。', 'If attachments contain conflicting data, state which version or time point to use.'),
    ],
    commonIssues: [
      { id: 'scientific-inaccuracy', question: t('图像好看但科学关系不准确？', 'The figure looks good but the science is inaccurate?'), answer: t('返回 Agent 规划，明确变量、方向、因果和数据来源；需要精确标签与连线时优先改用可编辑 SVG 路线。', 'Return to the agent plan and specify variables, direction, causality, and sources; use editable SVG when labels and edges must be exact.') },
    ],
    tourSteps: [
      { id: 'science-history', targetSelector: '[data-tour-id="sci-fig-history-panel"]', placement: 'right', navigateTo: '/scientific-figure', requiredMode: 'SCI_FIG', ensurePanels: ['left'], title: t('科研任务历史', 'Scientific task history'), description: t('左栏保存生成阶段、旧版本和失败状态，可随时恢复。', 'The left rail preserves generation stages, versions, and failures for recovery.'), petMessage: '每个科研任务都会保留规划、版本和产物。', petState: 'review' },
      { id: 'science-mode', targetSelector: '[data-tour-id="sci-fig-form-settings"]', fallbackSelector: '[data-tour-id="sci-fig-workspace-panel"]', mobileTargetId: 'mobile-scifig-form', placement: 'right', navigateTo: '/scientific-figure', requiredMode: 'SCI_FIG', parameterId: 'mode', title: t('选择 SVG 或 image2', 'Choose SVG or image2'), description: t('按可编辑性、标签精度和视觉复杂度选择输出路线。', 'Choose the output route by editability, label precision, and visual complexity.'), petMessage: '结构清晰选 SVG，复杂视觉机制可以选 image2。', petState: 'idle' },
      { id: 'science-assets', targetSelector: '[data-tour-id="sci-fig-form-settings"]', fallbackSelector: '[data-tour-id="sci-fig-workspace-panel"]', placement: 'right', navigateTo: '/scientific-figure', requiredMode: 'SCI_FIG', parameterId: 'attachments', allowMissingTarget: true, title: t('上传论文与数据', 'Upload papers and data'), description: t('系统会先解析事实、变量和结论，再生成结构规划。', 'The system parses facts, variables, and conclusions before planning the figure.'), petMessage: '真实材料越完整，科研表达越可靠。', petState: 'review' },
      { id: 'science-results', targetSelector: '[data-tour-id="sci-fig-results-panel"]', placement: 'left', navigateTo: '/scientific-figure', requiredMode: 'SCI_FIG', ensurePanels: ['right'], parameterId: 'artifacts', title: t('检查版本与格式', 'Review versions and formats'), description: t('在右侧查看 Agent 理解、版本、继续编辑和 SVG、PNG、PDF 下载。', 'Use the right panel for agent interpretation, versions, continued edits, and SVG, PNG, or PDF downloads.'), petMessage: '交付前同时检查科学事实、标签和输出格式。', petState: 'review' },
    ],
  },
  {
    id: 'ppt-generation',
    group: 'presentation',
    icon: 'slideshow',
    route: '/ppt',
    editorMode: 'PPT_GEN',
    mobileAvailable: true,
    title: t('PPT 生成', 'PPT generation'),
    summary: t('从主题与资料生成可继续编辑、排序和多版本导出的演示文稿。', 'Create a presentation that remains editable, reorderable, and exportable in multiple versions.'),
    outcome: t('看完后，你能配置主题、受众、页数、模板方向、逐页要求、附件和模型，并完成预览编辑与 PPTX 导出。', 'After this chapter, you can configure topic, audience, slide count, template direction, per-slide requirements, attachments, and models, then edit previews and export PPTX.'),
    parameters: [
      { id: 'history', title: t('PPT 历史', 'PPT history'), description: t('左侧记录保存生成阶段、当前预览和已导出版本，可恢复同一任务继续编辑。', 'The left rail preserves generation state, current preview, and exported versions for continued editing.'), targetSelector: '[data-tour-id="ppt-history"]' },
      { id: 'topic', title: t('主题与受众', 'Topic and audience'), description: t('说明演示目的、听众、时长、语气和必须达成的结论。', 'State presentation goal, audience, duration, tone, and required conclusion.'), targetSelector: '[data-tour-id="ppt-form"]', mobileTargetId: 'mobile-ppt-form' },
      { id: 'pages', title: t('页数与结构', 'Slide count and structure'), description: t('选择常用页数或自定义，逐页提示可覆盖 AI 自动规划。', 'Choose a common or custom slide count; per-slide prompts can override automatic planning.'), targetSelector: '[data-tour-id="ppt-form"]' },
      { id: 'template', title: t('专业模板与设计方向', 'Template and design direction'), description: t('模板决定设计语言而非死板套版，可逐页浏览版式并结合主题动态排版。', 'Templates define a design language rather than a rigid layout; browse slide patterns and adapt them to the topic.'), targetSelector: '[data-tour-id="ppt-form"]' },
      { id: 'attachments', title: t('资料与参考图', 'Documents and references'), description: t('PDF、Word、PPT 提供内容结构和事实；参考图约束配色、密度和视觉语言。', 'PDF, Word, and PPT provide structure and facts; references guide palette, density, and visual language.'), targetSelector: '[data-tour-id="ppt-form"]' },
      { id: 'models', title: t('生成路线与模型', 'Generation route and models'), description: t('根据可编辑 PPT-master 或 image2 视觉路线选择模型和质量。', 'Choose models and quality for editable PPT-master or image2 visual generation routes.'), targetSelector: '[data-tour-id="ppt-form"]' },
      { id: 'workspace', title: t('页面工作区', 'Slide workspace'), description: t('生成后可查看、放大、删除、拖动排序、新增和编辑单页。', 'After generation, inspect, zoom, delete, reorder, add, and edit slides.'), targetSelector: '[data-tour-id="ppt-stage"]' },
      { id: 'artifacts', title: t('导出版本', 'Export versions'), description: t('每次导出创建新的 PPTX 产物，当前页面工作区继续保留。', 'Every export creates a new PPTX artifact while the current slide workspace remains editable.'), targetSelector: '[data-tour-id="ppt-artifacts"]' },
    ],
    workflow: [
      { id: 'brief', title: t('定义演示目标', 'Define the presentation goal'), description: t('确定受众、结论、时长、页数和整体设计方向。', 'Set audience, conclusion, duration, slide count, and overall design direction.') },
      { id: 'source', title: t('提供资料与版式参考', 'Provide source and layout references'), description: t('上传真实资料，并选择专业模板或参考图。', 'Upload factual source material and choose a professional template or visual reference.') },
      { id: 'plan', title: t('生成大纲与页面', 'Generate outline and slides'), description: t('Agent 先规划叙事，再逐页生成并显示进度。', 'The agent plans the narrative before generating slides with visible progress.') },
      { id: 'edit', title: t('在工作区调整', 'Edit in the workspace'), description: t('重排、删除、新增或编辑页面，并放大检查文字与素材。', 'Reorder, delete, add, or edit slides and inspect text and media at full size.') },
      { id: 'export', title: t('导出可编辑版本', 'Export an editable version'), description: t('确认预览后导出 PPTX；继续修改可再导出下一版。', 'Export PPTX after review, then keep editing and export another version if needed.') },
    ],
    tips: [
      t('逐页要求只写关键页；其余页面留给 Agent 按整体叙事补齐。', 'Specify only critical slides and let the agent complete the rest from the narrative.'),
      t('导出前检查最长标题、中文字体、图标与文字是否遮挡。', 'Before export, check long titles, Chinese fonts, and icon-text overlap.'),
    ],
    commonIssues: [
      { id: 'ppt-layout', question: t('页面空、重复套版或元素遮挡？', 'Slides are empty, repetitive, or overlapping?'), answer: t('补充该页的信息职责和关键素材，切换设计方向或版式；导出前逐页检查最长文字、图标边界和图片加载状态。', 'Clarify the slide role and key assets, switch design direction or layout, and inspect long text, icon bounds, and image loading before export.') },
    ],
    tourSteps: [
      { id: 'ppt-history', targetSelector: '[data-tour-id="ppt-history"]', placement: 'right', navigateTo: '/ppt', requiredMode: 'PPT_GEN', ensurePanels: ['left'], parameterId: 'history', title: t('恢复 PPT 任务', 'Restore a PPT task'), description: t('从历史打开同一生成任务，继续检查预览、版本和导出产物。', 'Open the same task from history to continue with previews, versions, and exports.'), petMessage: '每套 PPT 只保留一条任务记录和多个导出版本。', petState: 'review' },
      { id: 'ppt-brief', targetSelector: '[data-tour-id="ppt-form"]', fallbackSelector: '[data-tour-id="right-panel"]', mobileTargetId: 'mobile-ppt-form', placement: 'left', navigateTo: '/ppt', requiredMode: 'PPT_GEN', ensurePanels: ['right'], parameterId: 'topic', title: t('填写主题与受众', 'Enter topic and audience'), description: t('说明演示目标、受众、结论和语气，帮助 Agent 建立完整叙事。', 'State goal, audience, conclusion, and tone so the agent can build a coherent narrative.'), petMessage: '先讲清演示要说服谁、得出什么结论。', petState: 'idle' },
      { id: 'ppt-template', targetSelector: '[data-tour-id="ppt-form"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/ppt', requiredMode: 'PPT_GEN', ensurePanels: ['right'], parameterId: 'template', allowMissingTarget: true, title: t('选择设计方向', 'Choose a design direction'), description: t('专业模板提供可变的设计语言和版式集合，而不是重复套用一张模板。', 'Professional templates provide an adaptable design language and layout family, not one repeated frame.'), petMessage: '模板决定设计方向，页面会根据内容动态排版。', petState: 'jumping' },
      { id: 'ppt-workspace', targetSelector: '[data-tour-id="ppt-stage"]', fallbackSelector: '[data-tour-id="center-canvas"]', placement: 'top', navigateTo: '/ppt', requiredMode: 'PPT_GEN', parameterId: 'workspace', allowMissingTarget: true, title: t('编辑页面工作区', 'Edit the slide workspace'), description: t('生成后可重排、删除、新增和编辑页面，并放大检查。', 'After generation, reorder, delete, add, edit, and inspect slides.'), petMessage: '生成完成后仍然可以持续调整整套演示。', petState: 'review' },
      { id: 'ppt-artifacts', targetSelector: '[data-tour-id="ppt-artifacts"]', fallbackSelector: '[data-tour-id="right-panel"]', placement: 'left', navigateTo: '/ppt', requiredMode: 'PPT_GEN', ensurePanels: ['right'], parameterId: 'artifacts', allowMissingTarget: true, title: t('导出并管理版本', 'Export and manage versions'), description: t('每次导出都会新增 PPTX 版本，当前工作区不会被下载页替换。', 'Each export adds a PPTX version without replacing the current workspace.'), petMessage: '每次确认后导出一版，仍可继续修改下一版。', petState: 'review' },
    ],
  },
  {
    id: 'ppt-presentation',
    group: 'presentation',
    icon: 'co_present',
    route: '/presentations',
    mobileAvailable: false,
    title: t('PPT 演示', 'PPT presentation'),
    summary: t('打开站内生成或外部上传的演示文稿，并完成全屏放映。', 'Open generated or uploaded decks and present them fullscreen.'),
    outcome: t('看完后，你能上传并转换 PPT、PPTX 或 PDF，区分上传与生成记录，控制页面、缩略图、自动播放和全屏。', 'After this chapter, you can upload and convert PPT, PPTX, or PDF, distinguish uploaded and generated records, and control slides, thumbnails, autoplay, and fullscreen.'),
    parameters: [
      { id: 'upload', title: t('上传与转换', 'Upload and conversion'), description: t('支持 PPT、PPTX 和 PDF；转换完成后自动打开并保存上传记录。', 'Supports PPT, PPTX, and PDF; successful conversion opens and saves an upload record.'), targetSelector: '[data-tour-id="ppt-presentations-upload-button"]' },
      { id: 'uploaded', title: t('我的上传', 'Uploaded decks'), description: t('用户上传的文件独立于站内生成记录，后续可直接重新打开。', 'User uploads stay separate from generated records and can be reopened later.'), targetSelector: '[data-tour-id="ppt-presentations-upload-list"]' },
      { id: 'generated', title: t('最近生成', 'Generated decks'), description: t('站内导出的可演示 PPT 集中显示在生成列表。', 'Presentation-ready decks exported in the app appear in the generated list.'), targetSelector: '[data-tour-id="ppt-presentations-generated-list"]' },
      { id: 'stage', title: t('放映舞台', 'Presentation stage'), description: t('按原比例显示当前页，支持边缘翻页与滚轮切换。', 'Displays the current slide at its original ratio with edge and wheel navigation.'), targetSelector: '[data-tour-id="ppt-presentations-stage"]' },
      { id: 'controls', title: t('播放控制', 'Playback controls'), description: t('从头或当前页播放，切换缩略图、自动播放、上一页、下一页和全屏。', 'Play from first or current slide and control thumbnails, autoplay, navigation, and fullscreen.'), targetSelector: '[data-tour-id="ppt-presentations-controls"]' },
    ],
    workflow: [
      { id: 'choose', title: t('打开或上传', 'Open or upload'), description: t('从上传记录、生成记录或上传按钮选择演示文稿。', 'Choose a deck from uploads, generated records, or the upload action.') },
      { id: 'convert', title: t('等待转换', 'Wait for conversion'), description: t('外部文件转换后会自动打开第一页并写入记录。', 'Converted external files open on the first slide and create a record.') },
      { id: 'navigate', title: t('检查页面', 'Inspect slides'), description: t('使用滚轮、边缘按钮或缩略图浏览各页。', 'Browse with wheel, edge buttons, or thumbnails.') },
      { id: 'present', title: t('开始放映', 'Start presenting'), description: t('选择从头或当前页开始，并进入全屏。', 'Choose first or current slide and enter fullscreen.') },
      { id: 'control', title: t('控制与退出', 'Control and exit'), description: t('用播放栏或键盘翻页、自动播放、显示缩略图和退出全屏。', 'Use the playback bar or keyboard for navigation, autoplay, thumbnails, and fullscreen exit.') },
    ],
    tips: [
      t('正式演示前先完整翻页一次，确认转换后的字体、视频和比例。', 'Before presenting, review every slide for converted fonts, media, and ratios.'),
      t('全屏时控制栏会自动隐藏，将鼠标移到屏幕底部可再次显示。', 'Fullscreen controls auto-hide; move the pointer near the bottom to reveal them.'),
    ],
    commonIssues: [
      { id: 'presentation-conversion', question: t('上传后字体、比例或页面显示异常？', 'Fonts, ratio, or slides look wrong after upload?'), answer: t('先确认原文件能正常打开，再重新转换；正式演示前逐页检查，必要时导出 PDF 后再上传以固定版式。', 'Verify the source opens correctly and reconvert; inspect every slide and use PDF upload when layout must be fixed.') },
    ],
    tourSteps: [
      { id: 'presentation-upload', targetSelector: '[data-tour-id="ppt-presentations-upload-button"]', placement: 'bottom', navigateTo: '/presentations', parameterId: 'upload', title: t('上传或选择演示文稿', 'Upload or choose a deck'), description: t('上传 PPT、PPTX、PDF，或从已有生成记录中打开。', 'Upload PPT, PPTX, or PDF, or open an existing generated deck.'), petMessage: '上传记录和站内生成记录会分开保存。', petState: 'idle' },
      { id: 'presentation-records', targetSelector: '[data-tour-id="ppt-presentations-upload-list"]', fallbackSelector: '[data-tour-id="ppt-presentations-generated-list"]', placement: 'right', navigateTo: '/presentations', parameterId: 'uploaded', title: t('区分上传与生成记录', 'Distinguish upload and generated records'), description: t('左栏按来源分组，点击记录即可恢复同一演示文稿。', 'The left rail groups decks by source; select one to reopen it.'), petMessage: '先确认来源，再选择要播放的版本。', petState: 'review' },
      { id: 'presentation-stage', targetSelector: '[data-tour-id="ppt-presentations-stage"]', placement: 'top', navigateTo: '/presentations', parameterId: 'stage', title: t('浏览放映舞台', 'Navigate the presentation stage'), description: t('滚轮、边缘按钮和缩略图都可以切换当前页面。', 'Use the wheel, edge buttons, or thumbnails to change slides.'), petMessage: '正式播放前先快速检查所有页面。', petState: 'review' },
      { id: 'presentation-controls', targetSelector: '[data-tour-id="ppt-presentations-controls"]', placement: 'top', navigateTo: '/presentations', parameterId: 'controls', title: t('使用播放控制', 'Use playback controls'), description: t('从头或当前页播放，打开自动播放、缩略图或全屏。', 'Play from first or current slide and toggle autoplay, thumbnails, or fullscreen.'), petMessage: '全屏后把鼠标移到底部就能重新看到控制栏。', petState: 'jumping' },
    ],
  },
  {
    id: 'canvas-flow',
    group: 'image',
    icon: 'schema',
    route: '/canvas-flow',
    mobileAvailable: false,
    title: t('自由画布', 'Canvas flow'),
    summary: t('用无限画布、节点和连线搭建可复用的图片生成链路，底部导演岛台负责规划和精准修改。', 'Build reusable image-generation chains with an infinite canvas, nodes, and edges; the director dock plans and patches the graph.'),
    outcome: t('看完后，你能创建画布流，用岛台规划或改现有图，添加与连接节点，框选和复制子图，配置生成器，运行分支，并使用 Mini-map 和历史记录。', 'After this chapter, you can create a canvas, plan or edit with the director dock, add and connect nodes, select and copy subgraphs, configure generators, run branches, and use the Mini-map and history.'),
    parameters: [
      { id: 'home', title: t('画布流首页', 'Canvas-flow home'), description: t('首页只负责介绍、展示最近记录和新建画布；确认名称后才进入可编辑节点画布。', 'The home introduces Canvas Flow, shows recent records, and creates canvases; editing begins only after naming one.'), targetSelector: '[data-tour-id="canvas-home"]' },
      { id: 'history', title: t('最近画布流', 'Recent canvas flows'), description: t('新建时确认名称，记录支持打开、改名、删除和当前项高亮。', 'Name new canvases and open, rename, delete, or identify the active record.'), targetSelector: '[data-tour-id="canvas-history"]' },
      { id: 'nodes', title: t('节点类型', 'Node types'), description: t('提示词、图片、生成器、预览和备注节点承担不同数据职责。', 'Prompt, image, generator, preview, and note nodes carry different data roles.'), targetSelector: '[data-tour-id="canvas-tool-rail"]' },
      { id: 'edges', title: t('连线', 'Edges'), description: t('从输出拖到有效输入；连线可选中、重连、右键或 Delete 删除，循环依赖会被拦截。', 'Drag outputs to valid inputs; select, reconnect, right-click, or Delete edges while cycles are blocked.'), targetSelector: '[data-tour-id="canvas-stage"]' },
      { id: 'selection', title: t('框选与子图', 'Selection and subgraphs'), description: t('Shift 拖动框选节点，可整体移动、复制、剪切、粘贴和扩展上下游。', 'Shift-drag to box-select nodes, then move, copy, cut, paste, or expand upstream and downstream.'), targetSelector: '[data-tour-id="canvas-stage"]' },
      { id: 'generator', title: t('生成参数', 'Generator settings'), description: t('每个生成器独立配置模型、比例、清晰度、质量和暂停状态。', 'Each generator independently configures model, ratio, resolution, quality, and pause state.'), targetSelector: '[data-tour-id="canvas-stage"]' },
      { id: 'run', title: t('运行方式', 'Run modes'), description: t('智能运行只处理新增、失败或上游变化节点，也可运行所选分支或强制全部。', 'Smart Run processes new, failed, or stale nodes; selected branches and force-all are also available.'), targetSelector: '[data-tour-id="canvas-run"]' },
      { id: 'minimap', title: t('Mini-map 与视图', 'Mini-map and viewport'), description: t('Mini-map 定位整张画布，滚轮缩放，空白处拖动平移，F 聚焦选择。', 'Use the Mini-map for navigation, wheel for zoom, blank-space drag for pan, and F to focus selection.'), targetSelector: '[data-tour-id="canvas-stage"]' },
      { id: 'tutorial', title: t('使用指南', 'Built-in tutorial'), description: t('右下角指南可随时重播节点、连线、框选、运行和 Mini-map 的动画操作说明。', 'Replay the animated guide for nodes, edges, selection, runs, and Mini-map from the bottom-right launcher.'), targetSelector: '[data-tour-id="canvas-tutorial"]' },
      { id: 'director', title: t('导演岛台', 'Director dock'), description: t('空画布时选题材、国漫剧场和阶段来规划；有内容后直接打字改第三镜或加校规。只有「全部重来」才会清屏。', 'On an empty canvas, pick genre, look, and stage to plan. With nodes present, type a change such as shot 3 or a new rule. Only “start over” clears the canvas.'), targetSelector: '[data-tour-id="canvas-director"]' },
    ],
    workflow: [
      { id: 'create', title: t('创建并命名', 'Create and name'), description: t('从首页或历史栏新建画布流，确认名称后进入节点画布。', 'Create a canvas from the home or history rail and name it before entering.') },
      { id: 'plan', title: t('空画布规划', 'Plan on an empty canvas'), description: t('展开底部岛台，输入题材或粘贴/上传剧本，选择题材、画风和做到哪一步，让导演铺出故事卡、剧本和分镜。', 'Open the dock, type a topic or paste a script, then choose genre, look, and stage so the director lays out the story card, script, and shots.') },
      { id: 'edit', title: t('有画布编辑', 'Edit an existing canvas'), description: t('画布有内容后岛台自动换成大输入框。说「把第三镜对白改成你回头了」或「加一条校规」，导演只改点名的部分。', 'Once nodes exist, the dock becomes a single prompt. Say “change shot 3 dialogue” or “add a school rule” and only the named parts change.') },
      { id: 'compose', title: t('添加与连接节点', 'Add and connect nodes'), description: t('添加输入、生成器与预览节点，再按数据流方向连线。', 'Add inputs, generators, and previews, then connect them in data-flow order.') },
      { id: 'configure', title: t('配置生成器', 'Configure generators'), description: t('为每个生成器选择模型和输出规格，必要时暂停某个节点。', 'Choose model and output settings for each generator and pause nodes when needed.') },
      { id: 'organize', title: t('整理复杂分支', 'Organize complex branches'), description: t('框选、整体移动、复制子图，并用 Mini-map 快速定位。', 'Box-select, move, copy subgraphs, and navigate with the Mini-map.') },
      { id: 'run', title: t('运行并处理结果', 'Run and handle results'), description: t('运行全部或分支，查看成功、失败、跳过和脉冲连线状态。', 'Run all or a branch and inspect success, failure, skipped, and pulsing-edge states.') },
    ],
    tips: [
      t('先搭一条最短可运行链路，再逐步增加分支，比一次搭完整复杂图更容易排错。', 'Build the smallest runnable chain first, then add branches incrementally for easier debugging.'),
      t('复制子图会写入系统剪贴板，可跨画布粘贴；导出 JSON 适合长期备份和分享。', 'Subgraphs go to the system clipboard for cross-canvas paste; JSON export suits long-term backup and sharing.'),
      t('改现有漫剧时直接对岛台说话，不必切模式；只有「全部重来 / 换成董事会」才会推倒重铺。', 'Talk to the dock to edit an existing episode; only “start over” or “replace with the boardroom story” rebuilds the canvas.'),
    ],
    commonIssues: [
      { id: 'canvas-not-running', question: t('点击运行后没有节点执行？', 'No node runs after clicking Run?'), answer: t('检查生成器是否暂停、模型和参数是否完整、输入连线是否有效；智能运行会跳过未变化且已有成功结果的节点。', 'Check for paused generators, missing model settings, and invalid inputs; Smart Run skips unchanged nodes with successful results.') },
      { id: 'director-rebuild', question: t('只想改一镜，整张画布却被清空了？', 'The whole canvas cleared when you only wanted one shot changed?'), answer: t('有内容时岛台默认是编辑，不会清屏。只有指令里出现「全部重来、重新规划、换个故事、重铺」才会推倒重铺。改对白请说「把第三镜对白改成……」。', 'With nodes present the dock edits in place. Only phrases such as start over, replan, or rebuild clear the canvas. To change dialogue, say “change shot 3 dialogue to …”.') },
    ],
    tourSteps: [
      { id: 'canvas-home', targetSelector: '[data-tour-id="canvas-home"]', placement: 'top', navigateTo: '/canvas-flow', parameterId: 'home', allowMissingTarget: true, title: t('从画布流首页开始', 'Start from Canvas Flow home'), description: t('首页用于了解功能、打开记录或新建并命名画布流，不会直接创建节点。', 'Use the home to learn, open a record, or name a new canvas; it does not edit nodes directly.'), petMessage: '先在首页新建或打开记录，再进入真正的节点画布。', petState: 'idle' },
      { id: 'canvas-history', targetSelector: '[data-tour-id="canvas-history"]', placement: 'right', navigateTo: '/canvas-flow', parameterId: 'history', title: t('创建和管理画布流', 'Create and manage canvas flows'), description: t('确认名称后新建；历史记录可打开、改名、删除并显示当前项。', 'Name canvases before creation; history supports open, rename, delete, and active state.'), petMessage: '首页负责介绍和新建，进入记录后才开始搭节点。', petState: 'idle' },
      { id: 'canvas-nodes', targetSelector: '[data-tour-id="canvas-tool-rail"]', placement: 'left', navigateTo: '/canvas-flow', parameterId: 'nodes', title: t('添加需要的节点', 'Add the nodes you need'), description: t('从工具栏添加提示词、图片、生成器、预览和备注。', 'Add prompt, image, generator, preview, and note nodes from the tool rail.'), petMessage: '每种节点只承担一种清晰职责。', petState: 'jumping' },
      { id: 'canvas-connect', targetSelector: '[data-tour-id="canvas-stage"]', placement: 'top', navigateTo: '/canvas-flow', parameterId: 'edges', allowMissingTarget: true, title: t('连接、重连和删除', 'Connect, reconnect, and delete'), description: t('拖动端口建立连线；选中后可重连，右键或 Delete 可删除。', 'Drag ports to connect, move endpoints to reconnect, or right-click and Delete an edge.'), petMessage: '连线决定提示词和图片会送到哪个生成器。', petState: 'review' },
      { id: 'canvas-run', targetSelector: '[data-tour-id="canvas-run"]', placement: 'bottom', navigateTo: '/canvas-flow', parameterId: 'run', title: t('运行工作流', 'Run the workflow'), description: t('选择智能运行、所选分支或强制全部，并查看执行汇总。', 'Choose Smart Run, selected branch, or Force All and inspect the execution summary.'), petMessage: '先检查生成器参数，再从右上角运行。', petState: 'running-right' },
      { id: 'canvas-minimap', targetSelector: '[data-tour-id="canvas-stage"]', placement: 'right', navigateTo: '/canvas-flow', parameterId: 'minimap', title: t('定位复杂画布', 'Navigate a complex canvas'), description: t('点击或拖动 Mini-map 视窗快速定位，使用滚轮与拖动精细调整。', 'Click or drag the Mini-map viewport for fast navigation, then refine with zoom and pan.'), petMessage: '节点多时先看 Mini-map，再聚焦目标分支。', petState: 'review' },
      { id: 'canvas-tutorial', targetSelector: '[data-tour-id="canvas-tutorial"]', placement: 'top', navigateTo: '/canvas-flow', parameterId: 'tutorial', allowMissingTarget: true, title: t('随时重播动画指南', 'Replay the animated guide'), description: t('需要复习连线、框选、运行或视图操作时，点击指南重新观看。', 'Replay the guide whenever you need a refresher on edges, selection, runs, or navigation.'), petMessage: '复杂操作忘了也没关系，使用指南会一直保留。', petState: 'jumping' },
      { id: 'canvas-director', targetSelector: '[data-tour-id="canvas-director"]', placement: 'top', navigateTo: '/canvas-flow', parameterId: 'director', allowMissingTarget: true, title: t('用岛台规划或改画布', 'Plan or edit from the dock'), description: t('空画布选题材和画风来规划；有图后直接打字改第三镜或加校规，不必切换模式。', 'Pick genre and look on an empty canvas; with a graph present, type the change and skip mode switching.'), petMessage: '岛台会自己判断：没图就规划，有图就改。', petState: 'jumping' },
    ],
  },
  {
    id: 'gallery',
    group: 'discovery',
    icon: 'grid_view',
    route: '/gallery',
    mobileAvailable: true,
    title: t('灵感广场', 'Creation gallery'),
    summary: t('按视觉类型浏览作品，查看详情、互动并生成同款。', 'Browse work by visual type, inspect details, react, and generate similar results.'),
    outcome: t('看完后，你能使用类型筛选、作品详情、点赞收藏和生成同款，并理解作品对应的内部生成模块。', 'After this chapter, you can use type filters, work details, likes, favorites, and Generate Similar while understanding the underlying generation module.'),
    parameters: [
      { id: 'categories', title: t('图片类型分类', 'Visual categories'), description: t('按海报、角色、电影感、风景、科研、朋友圈等视觉用途分类，不按内部模块分栏。', 'Filter by visual use such as poster, character, cinematic, landscape, research, or social rather than internal modules.'), targetSelector: '[data-tour-id="gallery-filters"]', mobileTargetId: 'mobile-nav-gallery' },
      { id: 'works', title: t('作品瀑布流', 'Work gallery'), description: t('卡片展示真实配图、标题、标签和互动状态，支持懒加载与分页。', 'Cards show real images, titles, tags, and reaction state with lazy loading and pagination.'), targetSelector: '[data-tour-id="gallery-works"]' },
      { id: 'detail', title: t('作品详情', 'Work details'), description: t('放大查看原图、多图或 PPT 页面，并阅读生成信息和风格说明。', 'Inspect originals, image sets, or PPT pages and review generation and style details.'), targetSelector: '[data-tour-id="gallery-works"]' },
      { id: 'reactions', title: t('点赞与收藏', 'Likes and favorites'), description: t('登录用户可点赞、收藏并在专属视图中快速找回。', 'Signed-in users can like and favorite work for retrieval in dedicated views.'), targetSelector: '[data-tour-id="gallery-works"]' },
      { id: 'similar', title: t('生成同款', 'Generate Similar'), description: t('根据作品内部来源路由到正确模块，并带入提示词、配方和必要参数。', 'Routes to the correct underlying module with prompt, recipe, and required settings.'), targetSelector: '[data-tour-id="gallery-works"]' },
    ],
    workflow: [
      { id: 'filter', title: t('选择视觉类型', 'Choose a visual category'), description: t('先按用途筛选，再浏览不同构图和风格。', 'Filter by use case before comparing compositions and styles.') },
      { id: 'inspect', title: t('打开作品详情', 'Inspect a work'), description: t('查看原图、标签、风格说明和生成条件。', 'Review originals, tags, style notes, and generation conditions.') },
      { id: 'save', title: t('点赞或收藏', 'Like or favorite'), description: t('把有价值的作品沉淀到个人灵感视图。', 'Save useful work into personal inspiration views.') },
      { id: 'reuse', title: t('生成同款', 'Generate similar'), description: t('确认跳转模块和带入条件，再修改本次主题。', 'Confirm the target module and carried settings, then change the current subject.') },
    ],
    tips: [
      t('生成同款保留的是设计方法和必要条件，不要求复刻作品中的受版权保护内容。', 'Generate Similar preserves the design method and required setup without copying protected source content.'),
      t('收藏用于长期复用，点赞用于快速反馈；两者可在不同视图分别管理。', 'Favorites support long-term reuse while likes provide quick feedback; manage them in separate views.'),
    ],
    commonIssues: [
      { id: 'gallery-reaction', question: t('点赞、收藏或生成同款没有反应？', 'Likes, favorites, or Generate Similar do not respond?'), answer: t('确认登录状态和网络请求正常，再重新打开作品详情；生成同款会跳到作品对应的内部生成模块。', 'Verify sign-in and network state, then reopen details; Generate Similar routes to the work\'s underlying module.') },
    ],
    tourSteps: [
      { id: 'gallery-categories', targetSelector: '[data-tour-id="gallery-filters"]', mobileTargetId: 'mobile-nav-gallery', placement: 'bottom', navigateTo: '/gallery', parameterId: 'categories', allowMissingTarget: true, title: t('按视觉类型浏览', 'Browse by visual type'), description: t('用海报、角色、电影感、科研等分类快速缩小范围。', 'Use poster, character, cinematic, research, and other categories to narrow the gallery.'), petMessage: '先选用途，再找最适合的视觉方向。', petState: 'jumping' },
      { id: 'gallery-works', targetSelector: '[data-tour-id="gallery-works"]', placement: 'top', navigateTo: '/gallery', parameterId: 'works', allowMissingTarget: true, title: t('浏览真实作品', 'Browse real work'), description: t('瀑布流会懒加载更多图片，点击卡片进入完整详情。', 'The gallery lazy-loads more images; select a card for full details.'), petMessage: '看到喜欢的作品，先打开大图和生成信息。', petState: 'running' },
      { id: 'gallery-reuse', targetSelector: '[data-tour-id="gallery-works"]', placement: 'left', navigateTo: '/gallery', parameterId: 'similar', allowMissingTarget: true, title: t('互动或生成同款', 'React or generate similar'), description: t('点赞、收藏，或让系统带着完整条件进入正确的生成模块。', 'Like, favorite, or open the correct generation module with the full setup.'), petMessage: '生成同款会带入方法，你只需要替换这次的主题。', petState: 'review' },
    ],
  },
  {
    id: 'inspiration-recipes',
    group: 'discovery',
    icon: 'auto_awesome_motion',
    route: '/gallery',
    mobileAvailable: true,
    title: t('灵感配方', 'Inspiration recipes'),
    summary: t('将一整套风格、构图和限制封装成可直接复用的灵感配方。', 'Package a complete set of style, composition, and constraints into a reusable inspiration recipe.'),
    outcome: t('看完后，你能区分配方与普通提示词，浏览配方详情，直接应用配方，并管理从灵感反推保存的个人配方。', 'After this chapter, you can distinguish recipes from prompts, inspect recipe details, apply them directly, and manage personal recipes saved from Prompt Lens.'),
    parameters: [
      { id: 'surface', title: t('作品与配方切换', 'Work and recipe surfaces'), description: t('灵感广场包含作品展示和灵感配方两个板块，可在同一入口切换。', 'The gallery contains both work and recipe surfaces under one entry.'), targetSelector: '[data-tour-id="gallery-surface-switcher"]', mobileTargetId: 'mobile-nav-gallery' },
      { id: 'categories', title: t('配方分类', 'Recipe categories'), description: t('按海报、IP、电影感、科研、手撕画、朋友圈等用途浏览。', 'Browse recipes for posters, IP, cinematic work, research, zines, social sharing, and more.'), targetSelector: '[data-tour-id="gallery-filters"]' },
      { id: 'rules', title: t('完整规则', 'Complete rules'), description: t('配方包含视觉目标、构图、色彩、材质、镜头、文字区、禁止项和适用场景。', 'A recipe includes visual goal, composition, palette, material, camera, text zones, exclusions, and use cases.'), targetSelector: '[data-tour-id="gallery-skills"]' },
      { id: 'apply', title: t('应用配方', 'Apply a recipe'), description: t('无需复制长提示词，选择配方后补充本次主题或上传图片即可。', 'Choose a recipe and add the current subject or image without copying a long prompt.'), targetSelector: '[data-tour-id="gallery-skills"]' },
      { id: 'personal', title: t('个人配方', 'Personal recipes'), description: t('灵感反推提炼的风格可保存为用户私有配方，之后在兼容模块调用。', 'Styles extracted in Prompt Lens can be saved privately and reused in compatible modules.'), targetSelector: '[data-tour-id="gallery-skills"]' },
      { id: 'import', title: t('导入生图 Skill', 'Import an image-generation skill'), description: t('上传不超过 10 MB 的 ZIP 配方包或填写公开 GitHub 仓库；系统会隔离审核，只提炼生图视觉规则并清理临时文件。', 'Upload a ZIP recipe package up to 10 MB or provide a public GitHub repository; isolated review extracts image-generation rules and removes temporary files.'), targetSelector: '[data-tour-id="gallery-skill-import"]' },
    ],
    workflow: [
      { id: 'browse', title: t('进入配方板块', 'Open recipes'), description: t('从灵感广场切换到灵感配方，并按用途筛选。', 'Switch from gallery work to recipes and filter by use case.') },
      { id: 'inspect', title: t('查看配方能力', 'Inspect recipe capabilities'), description: t('查看示例图、适用输入、完整规则和兼容模块。', 'Review example images, expected inputs, full rules, and compatible modules.') },
      { id: 'apply', title: t('应用到创作', 'Apply to creation'), description: t('选择配方后进入对应模块，只补充本次主题或素材。', 'Open the matching module with the recipe and add only the current subject or material.') },
      { id: 'save', title: t('保存个人风格', 'Save a personal style'), description: t('从灵感反推提炼风格，命名后保存为私有配方。', 'Extract style in Prompt Lens, name it, and save it privately.') },
      { id: 'import', title: t('审核外部配方', 'Review an external recipe'), description: t('导入 ZIP 或 GitHub 后先查看生图相关性、安全检查、警告与提炼结果，确认后才加入技能广场。', 'Import a ZIP or GitHub source, review image-generation relevance, security checks, warnings, and extracted rules, then approve it for the skill gallery.') },
      { id: 'manage', title: t('管理与复用', 'Manage and reuse'), description: t('查看个人配方，按模块复用或删除不再需要的配方。', 'Review personal recipes and reuse them by module or delete obsolete ones.') },
    ],
    tips: [
      t('好的配方应该在更换主题后仍保持辨识度，而不是依赖某个具体人物或一句文案。', 'A strong recipe stays recognizable after changing the subject rather than depending on one person or line of copy.'),
      t('只上传图片也能使用支持图生图的配方，系统会按配方规则解释输入。', 'Image-to-image recipes can work from an upload alone because the recipe defines how to interpret it.'),
    ],
    commonIssues: [
      { id: 'recipe-too-literal', question: t('更换主题后配方效果失效？', 'The recipe fails after changing the subject?'), answer: t('删除具体人物、地点和一次性文案，保留构图、色彩、材质、镜头、文字区和禁止项等稳定规则。', 'Remove source-specific people, places, and copy while retaining stable composition, palette, material, camera, text-zone, and exclusion rules.') },
    ],
    tourSteps: [
      { id: 'recipes-switcher', targetSelector: '[data-tour-id="gallery-surface-switcher"]', mobileTargetId: 'mobile-nav-gallery', placement: 'bottom', navigateTo: '/gallery', parameterId: 'surface', allowMissingTarget: true, title: t('切换到灵感配方', 'Switch to inspiration recipes'), description: t('作品和配方共用灵感广场入口，但承担不同用途。', 'Work and recipes share the gallery entry but serve different purposes.'), petMessage: '作品用来欣赏和复用，配方用来稳定一整套创作方法。', petState: 'jumping' },
      { id: 'recipes-library', targetSelector: '[data-tour-id="gallery-skills"]', fallbackSelector: '[data-tour-id="gallery-filters"]', placement: 'top', navigateTo: '/gallery', parameterId: 'rules', allowMissingTarget: true, title: t('浏览完整风格模板', 'Browse complete style templates'), description: t('每张配方卡都应有示例图、用途、输入要求和完整规则。', 'Each recipe card provides examples, use cases, input requirements, and complete rules.'), petMessage: '配方不是一句提示词，而是一整套稳定约束。', petState: 'review' },
      { id: 'recipes-apply', targetSelector: '[data-tour-id="gallery-skills"]', placement: 'left', navigateTo: '/gallery', parameterId: 'apply', allowMissingTarget: true, title: t('一键应用到创作', 'Apply to creation'), description: t('系统会进入兼容模块并带入配方，你只需补充主题或图片。', 'The app opens a compatible module with the recipe; add only a subject or image.'), petMessage: '选择配方后，不需要重新复制长提示词。', petState: 'running-right' },
      { id: 'recipes-personal', targetSelector: '[data-tour-id="gallery-skills"]', placement: 'top', navigateTo: '/gallery', parameterId: 'personal', allowMissingTarget: true, title: t('管理个人配方', 'Manage personal recipes'), description: t('从灵感反推保存的风格会出现在个人配方中，可继续复用。', 'Styles saved from Prompt Lens appear in personal recipes for continued reuse.'), petMessage: '把经常使用的视觉方法沉淀成自己的配方库。', petState: 'idle' },
      { id: 'recipes-import', targetSelector: '[data-tour-id="gallery-skill-import"]', fallbackSelector: '[data-tour-id="gallery-surface-switcher"]', placement: 'bottom', navigateTo: '/gallery', parameterId: 'import', allowMissingTarget: true, title: t('从 ZIP 或 GitHub 导入', 'Import from ZIP or GitHub'), description: t('系统不会执行外部代码；只有审核为生图风格模板的内容，经过你确认后才会保存。', 'External code is never executed; only content approved as an image-generation style is saved after your confirmation.'), petMessage: '先看完审核结论，再决定是否加入自己的配方库。', petState: 'review' },
    ],
  },
  {
    id: 'workspace',
    group: 'system',
    icon: 'folder_open',
    route: '/text-to-image',
    editorMode: 'TEXT_TO_IMAGE',
    mobileAvailable: true,
    title: t('工作区与历史', 'Workspace and history'),
    summary: t('在不同模块中创建、恢复、重命名和删除长期任务。', 'Create, restore, rename, and delete long-running tasks across modules.'),
    outcome: t('看完后，你能区分工作流、画布流和生成会话，正确恢复记录，并理解自动保存、当前高亮和删除边界。', 'After this chapter, you can distinguish workflows, canvas flows, and generation conversations, restore records safely, and understand autosave, active state, and deletion.'),
    parameters: [
      { id: 'entry', title: t('工作区入口', 'Workspace entry'), description: t('顶栏入口汇总图片工作流、画布流和各生成模块的历史。', 'The header entry combines image workflows, canvas flows, and module histories.'), targetSelector: '[data-tour-id="workspace-trigger"]' },
      { id: 'types', title: t('记录类型', 'Record types'), description: t('图片工作流保存节点与分支；画布流保存节点连线；生成会话保存提示、产物和版本。', 'Image workflows save branches, canvas flows save graphs, and generation conversations save prompts, artifacts, and versions.'), targetSelector: '[data-tour-id="workspace-record-types"]' },
      { id: 'active', title: t('当前记录', 'Active record'), description: t('当前打开记录应高亮，切换只恢复已有状态，不会自动复制。', 'The active record is highlighted; switching restores existing state without creating a copy.'), targetSelector: '[data-tour-id="workspace-active-record"]' },
      { id: 'autosave', title: t('自动保存', 'Autosave'), description: t('节点、视图、图层和表单按模块保存；保存失败会给出状态和手动重试。', 'Nodes, viewport, layers, and forms save per module; failures expose status and a manual retry.'), targetSelector: '[data-tour-id="save-button"]' },
      { id: 'management', title: t('改名与删除', 'Rename and delete'), description: t('改名使用平台弹窗并支持中文输入；删除前显示影响范围。', 'Rename uses the product dialog with Chinese IME support; deletion confirms impact first.'), targetSelector: '[data-tour-id="workspace-record-actions"]' },
    ],
    workflow: [
      { id: 'open', title: t('打开工作区', 'Open the workspace'), description: t('从顶栏进入并选择记录类型。', 'Open the header workspace and choose a record type.') },
      { id: 'locate', title: t('定位当前任务', 'Locate the active task'), description: t('使用高亮和更新时间确认当前记录。', 'Use active styling and update time to identify the current record.') },
      { id: 'restore', title: t('恢复已有状态', 'Restore existing state'), description: t('点击记录加载已有节点、表单、版本或产物。', 'Select a record to load its nodes, form, versions, or artifacts.') },
      { id: 'save', title: t('观察保存状态', 'Watch save status'), description: t('等待自动保存完成，失败时再使用手动保存。', 'Wait for autosave and use manual save only after a failure.') },
      { id: 'organize', title: t('整理记录', 'Organize records'), description: t('按需要改名或删除，删除前确认关联内容。', 'Rename or delete as needed and confirm related content before deletion.') },
    ],
    tips: [
      t('“打开”和“新建”必须是两条明确路径，避免误操作产生重复记录。', 'Open and New must remain distinct paths to prevent duplicate records.'),
      t('删除工作流或画布流前先确认其中是否有尚未导出的原图或文档。', 'Before deletion, confirm that the workflow or canvas has no unexported originals or documents.'),
    ],
    commonIssues: [
      { id: 'record-conflict', question: t('切换记录时页面闪动或内容互相覆盖？', 'The page flickers or records overlap while switching?'), answer: t('等待当前记录保存完成再切换；加载新记录时应取消旧请求，并始终以路由中的任务 ID 作为唯一当前记录。', 'Wait for the current save, cancel stale loads during switching, and treat the route task ID as the single active record.') },
    ],
    tourSteps: [
      { id: 'workspace-entry', targetSelector: '[data-tour-id="workspace-trigger"]', placement: 'bottom', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'entry', title: t('打开工作区', 'Open the workspace'), description: t('从这里进入不同模块的任务与长期工作记录。', 'Use this entry for module tasks and long-running work records.'), petMessage: '需要找回旧任务时，先从工作区进入。', petState: 'idle' },
      { id: 'workspace-types', targetSelector: '[data-tour-id="workspace-record-types"]', fallbackSelector: '[data-tour-id="workspace-trigger"]', placement: 'right', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'types', allowMissingTarget: true, title: t('选择正确的记录类型', 'Choose the correct record type'), description: t('工作流、画布流和生成会话保存的数据结构不同。', 'Workflows, canvas flows, and generation conversations preserve different structures.'), petMessage: '按模块找记录，避免把不同任务混在一起。', petState: 'review' },
      { id: 'workspace-active', targetSelector: '[data-tour-id="workspace-active-record"]', fallbackSelector: '[data-tour-id="workspace-trigger"]', placement: 'right', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'active', allowMissingTarget: true, title: t('确认当前记录', 'Confirm the active record'), description: t('高亮项就是当前打开的任务，点击其他项只恢复记录，不会复制。', 'The highlighted item is active; selecting another restores it without duplication.'), petMessage: '先看高亮，再决定是否切换或新建。', petState: 'review' },
      { id: 'workspace-save', targetSelector: '[data-tour-id="save-button"]', placement: 'bottom', navigateTo: '/image-edit', requiredMode: 'IMAGE_EDIT', parameterId: 'autosave', allowMissingTarget: true, title: t('查看保存状态', 'Review save status'), description: t('自动保存会显示进行中、已保存或失败；失败时可手动重试。', 'Autosave shows saving, saved, or failed state, with manual retry on failure.'), petMessage: '保存完成后再关闭页面，长期任务会更稳妥。', petState: 'idle' },
    ],
  },
  {
    id: 'account',
    group: 'system',
    icon: 'account_circle',
    route: '/profile',
    mobileAvailable: true,
    title: t('账户与个人中心', 'Account and profile'),
    summary: t('管理资料、安全、算力、积分、桌宠和个人使用记录。', 'Manage profile, security, compute, credits, desktop pet, and personal usage.'),
    outcome: t('看完后，你能修改账户资料和安全设置，查看算力与积分记录，管理桌宠，并从任何模块回到个人中心。', 'After this chapter, you can update profile and security, inspect compute and credit records, manage the desktop pet, and reach Profile from any module.'),
    parameters: [
      { id: 'entry', title: t('个人中心入口', 'Profile entry'), description: t('顶栏最右侧账户按钮从任意桌面模块进入个人中心。', 'The rightmost account button opens Profile from any desktop module.'), targetSelector: '[data-tour-id="account-button"]', mobileTargetId: 'mobile-profile-guide-btn' },
      { id: 'profile', title: t('账户资料', 'Profile information'), description: t('查看邮箱、昵称、角色与账户状态，按权限修改可编辑字段。', 'Review email, display name, role, and account state and edit permitted fields.'), targetSelector: '[data-tour-id="profile-info"]' },
      { id: 'security', title: t('安全设置', 'Security'), description: t('修改密码、检查登录状态，并处理绑定或会话异常。', 'Change password, inspect sign-in state, and handle binding or session issues.'), targetSelector: '[data-tour-id="profile-security"]' },
      { id: 'compute', title: t('算力与计费', 'Compute and billing'), description: t('统一切换平台算力或 FoxAPI；使用平台算力时可继续选择按量积分或具体会员卡。', 'Switch between platform compute and FoxAPI, then choose pay-as-you-go credits or a specific membership card for platform billing.'), targetSelector: '[data-tour-id="profile-compute-section"]' },
      { id: 'pet', title: t('桌面宠物', 'Desktop pet'), description: t('桌面端可选择宠物形象、显示状态和陪伴交互。', 'The desktop app supports pet appearance, visibility, and companion interactions.'), targetSelector: '[data-tour-id="profile-pet-section"]' },
      { id: 'guide', title: t('手册与导览', 'Manual and tours'), description: t('随时重新打开平台手册，按章节启动深度导览并查看完成进度。', 'Reopen the platform manual, launch focused chapter tours, and review completion progress.'), targetSelector: '[data-tour-id="manual-button"]' },
    ],
    workflow: [
      { id: 'open', title: t('进入个人中心', 'Open Profile'), description: t('从顶栏账户按钮或移动端“我的”进入。', 'Use the header account button or mobile Profile tab.') },
      { id: 'review', title: t('核对账户状态', 'Review account state'), description: t('确认资料、角色、算力来源和余额。', 'Confirm profile, role, compute source, and balance.') },
      { id: 'secure', title: t('维护安全设置', 'Maintain security'), description: t('定期更新密码并处理异常登录。', 'Update passwords periodically and handle unusual sessions.') },
      { id: 'records', title: t('查看使用记录', 'Review usage'), description: t('按需要查看积分、充值或模型调用记录。', 'Inspect credit, recharge, or model usage records as needed.') },
      { id: 'personalize', title: t('个性化体验', 'Personalize the experience'), description: t('选择主题、语言和桌宠，并从手册继续学习。', 'Choose theme, language, and desktop pet and continue learning from the manual.') },
    ],
    tips: [
      t('共享设备使用后应退出账户，不要只关闭浏览器窗口。', 'Sign out after using a shared device rather than only closing the browser window.'),
      t('FoxAPI密钥只在算力设置中管理，不要写入提示词或上传到附件。', 'Manage FoxAPI keys only in compute settings and never place them in prompts or uploads.'),
    ],
    commonIssues: [
      { id: 'profile-unavailable', question: t('个人中心点击后没有进入或登录状态异常？', 'Profile does not open or the session looks invalid?'), answer: t('先刷新会话并确认登录未过期；仍异常时退出后重新登录，不要在多个标签页反复提交资料修改。', 'Refresh the session and confirm it has not expired; if needed, sign out and back in instead of submitting profile changes from multiple tabs.') },
    ],
    tourSteps: [
      { id: 'account-entry', targetSelector: '[data-tour-id="account-button"]', mobileTargetId: 'mobile-profile-guide-btn', placement: 'bottom', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', parameterId: 'entry', title: t('打开个人中心', 'Open Profile'), description: t('账户按钮固定在顶栏右侧，可从各个桌面模块进入。', 'The account button stays at the right side of desktop headers.'), petMessage: '资料、安全、算力和手册都能从个人中心找到。', petState: 'idle' },
      { id: 'account-profile', targetSelector: '[data-tour-id="profile-info"]', placement: 'right', navigateTo: '/profile', parameterId: 'profile', allowMissingTarget: true, title: t('检查账户资料', 'Review profile information'), description: t('确认昵称、邮箱、角色和账户状态。', 'Confirm display name, email, role, and account status.'), petMessage: '先确认账户信息，再检查安全和算力。', petState: 'review' },
      { id: 'account-compute', targetSelector: '[data-tour-id="profile-compute-section"]', placement: 'right', navigateTo: '/profile', parameterId: 'compute', allowMissingTarget: true, title: t('查看算力与使用记录', 'Review compute and usage'), description: t('在这里管理 FoxAPI 连接或积分余额、流水与充值。', 'Manage FoxAPI connection or credit balance, transactions, and recharge here.'), petMessage: '所有模型消费都应该能在记录中找到来源。', petState: 'review' },
      { id: 'account-pet-guide', targetSelector: '[data-tour-id="profile-pet-section"]', placement: 'right', navigateTo: '/profile', parameterId: 'pet', allowMissingTarget: true, title: t('个性化与继续学习', 'Personalize and keep learning'), description: t('桌面端可管理宠物；手册会保存章节完成状态，方便以后继续。', 'Manage the desktop pet and use chapter completion to continue learning later.'), petMessage: '选好陪伴你的桌宠，也可以随时重播导览。', petState: 'jumping' },
    ],
  },
  {
    id: 'download',
    group: 'system',
    icon: 'download',
    route: '/download',
    mobileAvailable: true,
    title: t('下载与桌面端', 'Downloads and desktop app'),
    summary: t('下载适合当前系统的客户端，获得本地资产、桌宠和专业协作能力。', 'Download the right desktop client for local assets, desktop pets, and professional handoff.'),
    outcome: t('看完后，你能选择正确安装包，理解网页端与桌面端差异，完成安装更新，并找到 PS 插件协作入口。', 'After this chapter, you can choose the correct installer, understand web versus desktop capabilities, complete installation and updates, and locate Photoshop collaboration.'),
    parameters: [
      { id: 'platform', title: t('系统版本', 'Platform build'), description: t('根据 Windows、macOS 和处理器架构选择安装包。', 'Choose an installer for Windows, macOS, and the correct processor architecture.'), targetSelector: '[data-tour-id="download-platforms"]' },
      { id: 'capabilities', title: t('桌面端能力', 'Desktop capabilities'), description: t('桌面端增加本地文件路径、系统通知、自动更新、桌宠和 PS 协作。', 'Desktop adds local paths, system notifications, auto-update, desktop pet, and Photoshop handoff.'), targetSelector: '[data-tour-id="download-capabilities"]' },
      { id: 'install', title: t('安装步骤', 'Installation'), description: t('下载后按系统提示安装，首次运行登录同一账户即可同步云端记录。', 'Install through the operating system and sign into the same account to access cloud records.'), targetSelector: '[data-tour-id="download-installation"]' },
      { id: 'updates', title: t('版本更新', 'Updates'), description: t('桌面端会检查更新；准备完成后查看更新说明并重启安装。', 'The desktop app checks for updates; review release notes and restart when ready.'), targetSelector: '[data-tour-id="download-updates"]' },
      { id: 'photoshop', title: t('Photoshop 插件', 'Photoshop plugin'), description: t('安装 UXP 插件后，可将图层发送到 Photoshop 并同步回工作流。', 'Install the UXP plugin to send layers to Photoshop and sync them back.'), targetSelector: '[data-tour-id="download-photoshop"]' },
    ],
    workflow: [
      { id: 'choose', title: t('选择安装包', 'Choose an installer'), description: t('确认操作系统和架构，下载对应版本。', 'Confirm operating system and architecture and download the matching build.') },
      { id: 'install', title: t('安装并登录', 'Install and sign in'), description: t('完成系统安装后，使用同一 Linggan 账户登录。', 'Complete system installation and sign in with the same Linggan account.') },
      { id: 'verify', title: t('检查桌面能力', 'Verify desktop features'), description: t('确认通知、文件访问、桌宠和更新状态正常。', 'Verify notifications, file access, desktop pet, and update state.') },
      { id: 'plugin', title: t('按需安装 PS 插件', 'Install the PS plugin if needed'), description: t('从设置页安装并检查 UXP 插件与 Photoshop 状态。', 'Install and verify the UXP plugin and Photoshop status from Settings.') },
      { id: 'update', title: t('保持版本最新', 'Keep current'), description: t('收到更新提示时查看说明，完成下载后重启安装。', 'Review release notes when prompted and restart after the update is ready.') },
    ],
    tips: [
      t('网页端适合随时访问；涉及长期项目、本地大文件和 PS 协作时优先使用桌面端。', 'Use the web for convenient access and desktop for long projects, large local files, and Photoshop handoff.'),
      t('安装包只从官方域名下载，更新时不要覆盖正在运行的生成任务。', 'Download installers only from the official domain and avoid updating during active generation jobs.'),
    ],
    commonIssues: [
      { id: 'wrong-installer', question: t('安装包无法运行或系统提示不兼容？', 'The installer does not run or is incompatible?'), answer: t('重新确认操作系统与处理器架构，下载对应安装包；更新前退出旧客户端并保留正在进行任务的服务端记录。', 'Confirm operating system and processor architecture, download the matching build, and close the old app before updating.') },
    ],
    tourSteps: [
      { id: 'download-entry', targetSelector: '[data-tour-id="download-desktop"]', fallbackSelector: '[data-tour-id="account-button"]', placement: 'bottom', navigateTo: '/text-to-image', requiredMode: 'TEXT_TO_IMAGE', title: t('进入桌面端下载', 'Open desktop downloads'), description: t('从顶栏或个人中心进入下载页，网页端创作记录不会丢失。', 'Open Downloads from the header or Profile without losing web creation records.'), petMessage: '需要本地资产和专业协作时，再下载桌面端。', petState: 'idle' },
      { id: 'download-platform', targetSelector: '[data-tour-id="download-platforms"]', placement: 'top', navigateTo: '/download', parameterId: 'platform', allowMissingTarget: true, title: t('选择正确安装包', 'Choose the correct installer'), description: t('按操作系统和处理器架构下载对应版本。', 'Download the build matching your operating system and processor architecture.'), petMessage: '先确认系统版本，避免下载错误安装包。', petState: 'review' },
      { id: 'download-features', targetSelector: '[data-tour-id="download-capabilities"]', placement: 'top', navigateTo: '/download', parameterId: 'capabilities', allowMissingTarget: true, title: t('了解桌面端能力', 'Understand desktop capabilities'), description: t('桌面端提供本地文件、系统通知、自动更新、桌宠和 PS 协作。', 'Desktop provides local files, system notifications, updates, desktop pet, and Photoshop handoff.'), petMessage: '网页和桌面共用账户，但桌面端更适合长期专业流程。', petState: 'jumping' },
      { id: 'download-photoshop', targetSelector: '[data-tour-id="download-photoshop"]', placement: 'top', navigateTo: '/download', parameterId: 'photoshop', allowMissingTarget: true, title: t('连接 Photoshop 工作流', 'Connect Photoshop workflow'), description: t('按需安装 UXP 插件，在单图精修中发送图层并同步结果。', 'Install the UXP plugin when needed, then send and sync layers from Image Retouch.'), petMessage: '需要精确蒙版和专业修图时，可以交给 Photoshop。', petState: 'review' },
    ],
  },
]

const GUIDE_CHAPTER_BY_ID = new Map<GuideChapterId, GuideChapter>(
  GUIDE_CHAPTERS.map(chapter => [chapter.id, chapter]),
)

export function isGuideChapterId(value: unknown): value is GuideChapterId {
  return typeof value === 'string' && GUIDE_CHAPTER_BY_ID.has(value as GuideChapterId)
}

export function getGuideChapter(id: GuideChapterId): GuideChapter {
  return GUIDE_CHAPTER_BY_ID.get(id) ?? GUIDE_CHAPTER_BY_ID.get(OVERVIEW_CHAPTER_ID)!
}

export function getLocalizedGuideText(text: LocalizedGuideText, lang: 'zh' | 'en'): string {
  return text[lang]
}
