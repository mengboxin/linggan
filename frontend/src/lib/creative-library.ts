import type { PublicGalleryModule } from './public-gallery-presets'
import type { CreativeExecutionAdapter, CreativeStylePreset } from './creative-style-presets'

export interface CreativeLibraryItem {
  id: string
  title: string
  module: PublicGalleryModule
  moduleLabel: string
  description: string
  prompt: string
  sourceName: string
  sourceUrl: string
  license: string
  accent: string
  exampleImages?: string[]
  executionRules?: string[]
  featured?: boolean
  isPersonal?: boolean
}

// Skill definitions stay separate from gallery works: each entry describes an
// executable visual system and points to a locally optimized preview.
export const CREATIVE_LIBRARY: CreativeLibraryItem[] = [
  {
    id: 'library-high-concept-mythic-cinema',
    title: '高概念玄幻电影',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '图片生成',
    description: '把任意主题转化为拥有史诗尺度、单一奇观、强材质对比和电影摄影纪律的原创世界。无需提示词也可直接生成。',
    prompt: '执行高概念玄幻电影视觉系统：先从用户主题、参考图或默认命题中提炼一个可用一句话复述的世界规则，再选择唯一主奇观、唯一行动主体和唯一暖色能量源。构图必须建立清晰的前景尺度参照、中景行动和远景巨构；光线采用高反差硬光、体积云或真实环境光，主色限制为低饱和钢蓝、炭黑、灰绿或沙尘色，并只允许一处橙色、赭黄或深红暖色。材质必须具有风化金属、岩层、织物、氧化表面、尘埃或胶片颗粒等可触摸细节。根据题材选择 35mm、50mm 变形镜头或高位俯视镜头，保持真实景深、镜头光晕和电影级调色。禁止霓虹堆叠、卡通、现有影视游戏 IP、光滑玩具塑料、装饰性对称、无意义发光线路、过饱和色彩、文字、商标和水印。用户未提供任何输入时，默认创作“风暴云海上方的古老行星神殿与归来的荒漠骑手”。',
    sourceName: 'Linggan 高概念实验室',
    sourceUrl: '',
    license: '',
    accent: '#f97316',
    exampleImages: [
      '/creative-library/high-concept-cosmic-vortex.webp',
      '/creative-library/high-concept-orbital-forge.webp',
      '/creative-library/high-concept-desert-rider.webp',
      '/creative-library/high-concept-tiger-interceptor.webp',
    ],
    executionRules: [
      '先锁定一句话世界规则、唯一主奇观和唯一行动主体，再开始生成',
      '保持低饱和冷色主调，仅允许一处暖色能量或实用光源',
      '构图必须同时包含尺度参照、可触摸材质和电影摄影机位',
      '参考图只用于主体身份或结构，不复制其中的文字、商标和现有 IP',
    ],
    featured: true,
  },
  {
    id: 'library-image-editorial-light',
    title: '编辑感产品静物',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '适合产品首图、品牌封面和网页主视觉的杂志化构图。',
    prompt: '以一件产品为唯一主体，放在安静的建筑台面上；使用有方向感的晨光、可触摸的材质细节和克制阴影。为中文标题预留充足留白，整体像高级杂志的艺术指导，不生成水印、商标或额外文字。',
    sourceName: 'GPT Image 2 Skill',
    sourceUrl: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    accent: '#d97706',
  },
  {
    id: 'library-image-controlnet-composition',
    title: '结构约束构图',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用边缘、深度或姿态控制保持主体位置，适合连续视觉系列。',
    prompt: '明确一个稳定主体和清晰轮廓，使用有深度关系的光线与编辑式色块；前景、中景、背景分层，主体始终保持在同一视觉位置，为系列化画面保留一致镜头角度与负空间。',
    sourceName: 'ControlNet',
    sourceUrl: 'https://github.com/lllyasviel/ControlNet',
    license: 'Apache-2.0',
    accent: '#0891b2',
  },
  {
    id: 'library-image-adapter-style',
    title: '风格参考融合',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '提取参考图的色彩和构图气质，同时保留全新主题表达。',
    prompt: '只从参考图抽取配色、视觉节奏或光线中的一个维度；重新设计主体、动作和空间关系。使用明确的层级、柔和材质对比和当代艺术指导，不复制标志、文字或原有构图。',
    sourceName: 'T2I-Adapter',
    sourceUrl: 'https://github.com/TencentARC/T2I-Adapter',
    license: 'Apache-2.0',
    accent: '#7c3aed',
  },
  {
    id: 'library-image-gathered-scenes-zine',
    title: '实景杂志拼贴',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '将旅行和日常照片转化为有呼吸感的纸面杂志视觉。',
    prompt: '保留一处真实场景主体与关键空间关系，把重复细节压缩为少量大形抽象插画。照片和纸面之间需要明显手撕纸纤维边缘；只使用一块从场景形状延伸出来的高饱和结构色，并保留大面积安静纸面。',
    sourceName: 'Gathered Scenes Zine',
    sourceUrl: 'https://github.com/Zeejay0/gathered-scenes-zine-skill',
    license: 'MIT',
    accent: '#2563eb',
  },
  {
    id: 'library-image-cinema-storyboard',
    title: '电影叙事分镜',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '让“电影感”来自人物、空间和观察位置，而不是滤镜。',
    prompt: '先定义角色无法立即解决的选择，再确定观众站在事件内部、门外、反射里或受困位置。写清视线从何处进入、被什么放慢、落到何种决定性信息、又从哪里离开。颜色必须来自服装、天气、场景和真实光源。',
    sourceName: 'Cinema DNA 21:9 x 3',
    sourceUrl: 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3',
    license: '请按源仓库许可使用',
    accent: '#334155',
  },
  {
    id: 'library-image-comic-ip',
    title: '原创漫剧 IP 设定',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '同时建立角色、陪伴物、关键道具和世界规则，适合系列主视觉。',
    prompt: '先写清主角想完成什么、世界规则如何阻止他或她、以及一个尚未完成的决定。设计独立的角色外形、关键道具和空间压力，主视觉只保留一个故事钩子并预留片名安全区。不得借用任何现有动画、漫画、游戏或影视 IP。',
    sourceName: 'Cinema DNA 21:9 x 3',
    sourceUrl: 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3',
    license: '请按源仓库许可使用',
    accent: '#0f766e',
  },
  {
    id: 'library-image-xiaohei-explainer',
    title: '手绘怪诞解释图',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '适合公众号、朋友圈和产品文章的观点配图。',
    prompt: '横版白底手绘解释图：用一名黑色极简角色完成一个与主题有关的荒诞动作，只选择一个低科技物件作为隐喻。保留至少三分之一留白，黑色线稿为主，橙色只用于主路径，红色用于关键结果，蓝色只用于补充说明。不要做成 PPT、课程图或儿童插画。',
    sourceName: 'Ian 小黑怪诞正文配图',
    sourceUrl: '',
    license: '本地技能，请按当前环境授权使用',
    accent: '#ef4444',
  },
  {
    id: 'library-image-moments-photo-diary',
    title: '朋友圈三格摄影日记',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用一个场景、一个局部和一个动作组织朋友圈配图，比单张滤镜图更有连续性。',
    prompt: '为同一段生活记录设计三格方形摄影日记：第一格交代真实环境，第二格只拍最有触感的局部材质，第三格保留一个正在发生的小动作。三格共享自然光、同一组低饱和色彩和一致镜头距离，画面不生成文字、商标或水印。',
    sourceName: 'Gathered Scenes Zine',
    sourceUrl: 'https://github.com/Zeejay0/gathered-scenes-zine-skill',
    license: 'MIT',
    accent: '#0f766e',
  },
  {
    id: 'library-image-moments-diptych',
    title: '朋友圈双联对照',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用一个远景和一个局部细节制造节奏，适合旅行、展览、咖啡馆与日常观察。',
    prompt: '制作一张方形双联视觉：左侧为一个有明确空间关系的远景，右侧为同一场景中可触摸的局部细节。两侧共享同一光线和色温，使用干净留白作为间隔；不加入贴纸、边框文字、商标、强滤镜或无关道具。',
    sourceName: 'GPT Image Cookbook',
    sourceUrl: 'https://github.com/eugeniughelbur/gpt-image-cookbook',
    license: 'MIT',
    accent: '#b45309',
  },
  {
    id: 'library-image-moments-nine-grid',
    title: '朋友圈九宫格片段',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '围绕同一件小事收集环境、人物、器物、光线和收束镜头，适合完整记录一次体验。',
    prompt: '围绕同一个半天的经历设计九宫格照片叙事：按环境、抵达、局部、人物动作、器物、颜色、转场、安静时刻与收束镜头安排九个不同画面。所有画面共享相近色温和真实时间线，不做拼贴贴纸、假文字、过度磨皮或重复构图。',
    sourceName: 'GPT Image Cookbook',
    sourceUrl: 'https://github.com/eugeniughelbur/gpt-image-cookbook',
    license: 'MIT',
    accent: '#2563eb',
  },
  {
    id: 'library-image-quiet-architecture',
    title: '建筑光影散文',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '适合空间、酒店、展览或城市观察，用构图和材质而不是重滤镜制造氛围。',
    prompt: '选择一处有明确几何秩序的真实建筑空间，让一束自然光定义主路径；只保留一位远处人物作为尺度参照。以混凝土、木材、玻璃或石材中的两种主要质地构成画面，不做赛博灯光、HDR 油光或商业样板房效果。',
    sourceName: 'ComfyUI 创作工作流',
    sourceUrl: 'https://github.com/Comfy-Org/ComfyUI',
    license: 'GPL-3.0',
    accent: '#475569',
  },
  {
    id: 'library-image-documentary-still',
    title: '纪实电影静帧',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以人物动作和真实光源推进故事，避免只靠青橙调色做“电影感”。',
    prompt: '给人物一个尚未完成的决定和正在进行的动作，选择一个具有历史感或天气痕迹的真实空间。观众要能看清从何处进入画面、被什么细节停住、最后看向何处。颜色只能来自服装、灯光、天气和场景材质，不使用现有影视 IP、文字或商标。',
    sourceName: 'Cinema DNA 21:9 x 3',
    sourceUrl: 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3',
    license: '请按源仓库许可使用',
    accent: '#1e3a5f',
  },
  {
    id: 'library-image-contemporary-eastern-life',
    title: '当代东方生活方式',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用现代空间、自然材质与克制色彩表达东方气质，不靠金色、符号和滤镜堆砌。',
    prompt: '选取一件日常器物、一个自然材料和一束真实侧光作为全部视觉元素。空间保持现代、安静和可居住，色彩来自木材、陶土、布料与植物本身；预留大面积留白。避免国潮符号堆砌、伪书法、饱和金红配色、磨皮人像和油亮商业质感。',
    sourceName: '东方美术导演 Skill',
    sourceUrl: 'https://github.com/Litreily/codex-skill-eastern-beauty-director',
    license: 'MIT',
    accent: '#7c5c42',
  },
  {
    id: 'library-image-prompt-cookbook',
    title: '镜头与材质配方',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '先锁定用途、主体、镜头、光线和负面约束，再生成稳定的可复用画面。',
    prompt: '先明确产物用途、主体与唯一动作，再依次写清场景、镜头距离、视线方向、真实光源、色彩来源和材质细节。最后用负面约束排除文字、商标、重复主体、假景深和无关特效。每次只改变一个视觉变量，形成可比较的系列。',
    sourceName: 'GPT Image Cookbook',
    sourceUrl: 'https://github.com/eugeniughelbur/gpt-image-cookbook',
    license: 'MIT',
    accent: '#2563eb',
  },
  {
    id: 'library-science-method-figure',
    title: '科研方法流程图',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '把实验步骤拆成可复核的阶段、变量和输出，适合论文图和答辩页。',
    prompt: '以从左至右的单一实验路径组织画面，只保留必要的阶段、对照分支和输出。用统一线宽、克制的蓝橙配色和出版级留白建立层级，所有箭头必须表达可复核的变量关系，不添加装饰性模块。',
    sourceName: 'paper-image-ppt',
    sourceUrl: 'https://github.com/Libby5201234/paper-image-ppt',
    license: 'MIT',
    accent: '#2563eb',
  },
  {
    id: 'library-science-cellular-cutaway',
    title: '细胞与材料剖面',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '用剖面、放大框和标注线组织微观结构，适合材料、生物和医学主题。',
    prompt: '以一个主剖面承载核心结构，再设置不超过两个放大观察窗。主剖面与放大窗必须由精确引导线连接，使用暖白背景、青蓝与琥珀色点睛，结构可读、比例可信，不使用虚构数据或无关装饰。',
    sourceName: 'BioIcons',
    sourceUrl: 'https://github.com/bioicons/bioicons',
    license: '按图标授权',
    accent: '#059669',
  },
  {
    id: 'library-science-evidence-dashboard',
    title: '证据仪表盘',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '将关键指标、误差范围和结论放在同一张可扫描的证据页。',
    prompt: '先确立一项主结果，再用三项支持指标解释其可靠性。坐标、误差范围、对照关系和结论必须有清晰层级；保持色彩可访问、留白充足，不使用三维图表、装饰性仪表盘或夸大的视觉暗示。',
    sourceName: 'Matplotlib',
    sourceUrl: 'https://github.com/matplotlib/matplotlib',
    license: 'PSF',
    accent: '#0f766e',
  },
  {
    id: 'library-science-ecosystem-process',
    title: '生态连续过程图',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '将地貌、物质流与采样点组织成连续的环境科学叙事。',
    prompt: '从源头到下游建立连续地貌，使用一条水流、能量流或物质流串联关键过程；仅保留必要采样点和两枚放大观察窗。每个视觉元素都必须服务因果关系，避免儿童插画和图标堆叠。',
    sourceName: 'Storytelling Figures',
    sourceUrl: 'https://github.com/emorymao-hub/storytelling-figures',
    license: 'MIT',
    accent: '#0891b2',
  },
  {
    id: 'library-science-spatial-atlas',
    title: '空间分布图谱',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '适合细胞、组织、城市或地理数据，把样本位置与关键差异放在同一画面。',
    prompt: '先选择一个主空间底图，再用不超过三种视觉编码显示样本分布、重点区域和比较对象；必须保留比例尺、图例和低密度标签的位置。色彩只服务分类和差异，不用发光轮廓、伪三维或装饰性粒子。',
    sourceName: 'napari 可视化方法',
    sourceUrl: 'https://github.com/napari/napari',
    license: 'BSD-3-Clause',
    accent: '#7c3aed',
  },
  {
    id: 'library-science-comparison-evidence',
    title: '对照与证据页',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '将实验组、对照组和结论以可复核的方式放在一页，适合论文结果图。',
    prompt: '以对齐的实验组和对照组为骨架，用同一尺度展示样本、关键指标和差异位置。每组只保留一个核心结果和一条证据线，显著性、误差与样本量均需有真实可放置的位置；不虚构数据，不把装饰图标当作证据。',
    sourceName: 'Matplotlib',
    sourceUrl: 'https://github.com/matplotlib/matplotlib',
    license: 'PSF',
    accent: '#b45309',
  },
  {
    id: 'library-science-publication-figure',
    title: '出版级多面板图',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '为方法、原理、结果和结论建立可跳读的多面板学术图。',
    prompt: '采用 A 到 D 的四面板结构，但先定义一条从问题、方法、观察到结论的阅读顺序。各面板统一边距、线宽、配色和说明密度；图像面板与数据面板只通过必要引导线连接，预留真实图题与图注位置。',
    sourceName: 'ImageJ 生态',
    sourceUrl: 'https://github.com/imagej/ImageJ',
    license: 'Public Domain',
    accent: '#0369a1',
  },
  {
    id: 'library-science-conceptual-graphical-abstract',
    title: '概念图形摘要',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '把研究问题、干预、机制与意义压缩为一条可追踪的概念路径，明确不代表真实实验结果。',
    prompt: '先写清研究对象、干预、核心机制和研究意义，再以一条主路径依次连接它们。只设置必要的一个到两个放大观察窗；所有图像标注为概念示意，避免生成真实显微图、患者照片、统计图、具体数值或无法核实的因果关系。',
    sourceName: 'paper-image-ppt',
    sourceUrl: 'https://github.com/Libby5201234/paper-image-ppt',
    license: 'MIT',
    accent: '#0f766e',
  },
  {
    id: 'library-poster-brand-launch',
    title: '品牌发布海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '适合新品发布、活动主视觉和社交媒体首图的强标题版式。',
    prompt: '让产品或人物只占一个明确主视觉位置，在另一侧预留可排版的中文标题区；用模块化日期和地点信息位建立层级，控制重叠关系和印刷边距。模型只生成底图，不直接生成小字、商标或水印。',
    sourceName: 'GPT Image 2 开源提示词图库',
    sourceUrl: 'https://github.com/ChaosRealmsAI/gpt-image-2-gallery',
    license: 'MIT / CC BY 4.0',
    accent: '#ea580c',
  },
  {
    id: 'library-poster-exhibition-grid',
    title: '展览信息海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '用展览海报的网格、编号和留白处理复杂活动信息。',
    prompt: '使用不对称网格组织一件抽象主视觉和大面积留白；限制为黑、暖白和一枚电光色，标题、策展人、日期和场馆均预留后期排版位置。画面要像真实印刷设计，不要生成乱码、假标志或廉价特效。',
    sourceName: 'GPT Image 2 开源提示词图库',
    sourceUrl: 'https://github.com/ChaosRealmsAI/gpt-image-2-gallery',
    license: 'MIT / CC BY 4.0',
    accent: '#be123c',
  },
  {
    id: 'library-poster-illustration-collage',
    title: '插画拼贴海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '用可替换插画、色块和贴纸式标注构成轻快的活动传播物料。',
    prompt: '以清晰主体为中心，用两到三层纸张形状、简化插画和局部贴纸式标注组织画面。色彩明亮但受控，保留真正可用的中文标题与卖点安全区，加入细微印刷纹理，不生成水印。',
    sourceName: 'OpenMoji',
    sourceUrl: 'https://github.com/hfg-gmuend/openmoji',
    license: 'CC BY-SA 4.0',
    accent: '#db2777',
  },
  {
    id: 'library-poster-system-icons',
    title: '信息图标海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '适合产品功能、服务流程和公共信息的图标化海报。',
    prompt: '先定义一组统一笔画和比例的图标，再用五个以内功能区块建立阅读顺序。控制为两种主色，保持足够对比度和一致线宽，为标题与说明留出真实版式空间，不拼贴库存照片。',
    sourceName: 'Lucide',
    sourceUrl: 'https://github.com/lucide-icons/lucide',
    license: 'ISC',
    accent: '#4f46e5',
  },
  {
    id: 'library-poster-new-chinese',
    title: '新中式品牌主视觉',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以一件实物和一件东方意象构成克制的商业视觉。',
    prompt: '让真实产品成为主体，用山形、器物、花枝或月色等一个东方意象建立前后层次；色彩从物件和自然光中产生，顶部保留中文标题安全区。避免符号堆砌、伪书法、金色滥用和传统元素大杂烩。',
    sourceName: 'Linggan 精选',
    sourceUrl: '',
    license: '平台原创配方',
    accent: '#a16207',
  },
  {
    id: 'library-poster-cultural-program',
    title: '文化节目主视觉',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '适合展览、音乐会、公共活动与书店主题月，强调清晰层级而不是堆符号。',
    prompt: '选择一件能代表主题的物体、身体姿态或空间切片作为唯一主视觉，用不对称网格、两级排版安全区和一枚强调色组织画面。材质应有真实纸张、油墨或摄影质感，避免伪书法、复杂花纹、乱码文字和廉价金属光泽。',
    sourceName: 'GPT Image 2 开源提示词图库',
    sourceUrl: 'https://github.com/ChaosRealmsAI/gpt-image-2-gallery',
    license: 'MIT / CC BY 4.0',
    accent: '#9333ea',
  },
  {
    id: 'library-poster-product-editorial',
    title: '编辑式产品海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '把产品拍成有观点的杂志封面，适合香氛、器物、数码和食品新品。',
    prompt: '让产品占据唯一主角位置，用一个有质感的台面和一个意外但克制的辅助道具建立叙事。使用方向明确的自然光、真实材质和大量留白，标题与卖点区需在后期排版而非让模型直接生成。',
    sourceName: 'GPT Image 2 Skill',
    sourceUrl: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    accent: '#0f766e',
  },
  {
    id: 'library-poster-data-story',
    title: '数据叙事海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '把一个核心数字、一个趋势和一个行动信息做成可扫描的传播页。',
    prompt: '只选择一个主数字或主结论，让它成为最大的视觉锚点；用一条趋势、三个以内支持指标和清晰的行动区组织阅读。图标使用统一线宽和比例，正文和数值均预留后期真实排版区域，不生成假数据、商标或水印。',
    sourceName: 'Lucide',
    sourceUrl: 'https://github.com/lucide-icons/lucide',
    license: 'ISC',
    accent: '#2563eb',
  },
  {
    id: 'library-poster-ad-visual-system',
    title: '广告关键视觉系统',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '用一个强主角、一项视觉承诺和清晰安全区制作投放级主视觉，而不是把所有卖点塞进一张图。',
    prompt: '先定义受众、唯一主角、核心承诺和投放位置，再选一个可被一眼识别的场景动作。主角与背景保持明确层级，标题、价格和行动信息仅预留后期安全区。避免包装文案、商标、水印、过多道具和无法阅读的小字。',
    sourceName: 'AI 广告提示词指南',
    sourceUrl: 'https://github.com/creatify-ai/ai-ad-prompt-guide',
    license: 'MIT',
    accent: '#be123c',
  },
  {
    id: 'library-image-canghe-material-study',
    title: '材质微观特写',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用一种主材质、一个观察距离和一束真实光，做有触感的概念图。',
    prompt: '先选一种可被近距离观察的主材质，例如釉质、纸纤维、织物、玻璃或氧化金属；让它占据画面大部分，只用一个小尺度细节说明大小。使用低角度侧光展现表面起伏，背景压低为单一安静色面。避免霓虹特效、杂乱道具、假文字和不相关主体。',
    sourceName: 'GPT-Image2 Gallery 材质案例方法',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2',
    license: '开源项目，按源仓库许可使用',
    accent: '#0f766e',
  },
  {
    id: 'library-image-canghe-space-frame',
    title: '框景空间叙事',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用门洞、窗框、廊柱或前景物做第一层空间，把主体放入第二层。',
    prompt: '让门洞、窗框、廊柱或遮挡物占据近景边缘，作为观众进入画面的框景；中景只保留一个人物或物体，远景用建筑、天空或自然地貌打开深度。先确定主视线和人物尺度，再决定光线从何处穿过前景。不要使用过度广角、HDR、密集人群或无意义装饰。',
    sourceName: 'GPT-Image2 Gallery 空间模板',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2/blob/main/docs/templates.md#tpl-architecture',
    license: '开源项目，按源仓库许可使用',
    accent: '#475569',
  },
  {
    id: 'library-image-youmind-travel-grid',
    title: '旅行多镜头叙事',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '把旅行照片从单张美景升级成场景、人物、细节和收束镜头的完整记录。',
    prompt: '围绕同一段旅行安排四个不同镜头：空间建立镜头、人物与环境关系、可触摸的当地细节、安静的收束画面。所有镜头共享同一时段、色温和真实地理线索，画面之间以干净留白或自然间隔连接。不要贴纸、假文字、过饱和滤镜、旅游广告式大字或重复姿势。',
    sourceName: 'YouMind 旅行照片编辑合集',
    sourceUrl: 'https://youmind.com/zh-TW/prompts-pack/travel-photo-edit',
    license: '公开提示词合集，按来源页面使用',
    accent: '#2563eb',
  },
  {
    id: 'library-image-youmind-ms-paint',
    title: '刻意粗糙涂鸦重绘',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '把参考主体转成带幽默感的低技术涂鸦，不丢失最关键轮廓。',
    prompt: '保留参考图中最重要的主体轮廓、姿态和大色块，将细节转为明显的鼠标线条、笨拙色块、轻微错位比例和少量蜡笔涂抹。背景保持简单，保证主体仍一眼可认。不要生成软件界面、说明文字、品牌、复杂阴影或逼真摄影材质。',
    sourceName: 'YouMind MS Paint 重绘合集',
    sourceUrl: 'https://youmind.com/zh-TW/prompts-pack/ms-paint-style',
    license: '公开提示词合集，按来源页面使用',
    accent: '#ec4899',
  },
  {
    id: 'library-poster-canghe-product-detail',
    title: '冷调产品花材陈列',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '把产品放进同色系植物与织物中，用柔焦逆光形成电商高级感。',
    prompt: '让产品保留清晰外观，放在同一冷调色系的植物、织带和低对比背景中。使用逆光柔焦、低饱和渐变留白和浅景深，主体边缘必须清楚，辅助花材只形成框景。为标题与卖点留出整洁安全区，不让模型生成包装文案、价格、品牌或水印。',
    sourceName: 'GPT-Image2 Gallery 电商案例',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2/blob/main/docs/gallery-part-2.md#case-519',
    license: '开源项目，按源仓库许可使用',
    accent: '#10b981',
  },
  {
    id: 'library-poster-canghe-document-system',
    title: '出版物页面系统',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '适合白皮书、手册、百科页和展览说明，把图像与排版安全区分层处理。',
    prompt: '把页面拆成主图区域、标题安全区、摘要安全区和两个以内辅助图解区域；先设计统一边距与阅读顺序，再确定一张主视觉。主图使用真实纸张、摄影或图解质感，文字和数字只留后期排版位置。避免模型生成密集正文、假数据、商标、页码或不可读标签。',
    sourceName: 'GPT-Image2 Gallery 文档模板',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2/blob/main/docs/templates.md#tpl-document',
    license: '开源项目，按源仓库许可使用',
    accent: '#7c3aed',
  },
  {
    id: 'library-canghe-lunar-apparel',
    title: '月面探索服装视觉',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以单一服装或布料物件承载太空叙事，适合潮流服饰、展览周边和图案方向探索。',
    prompt: '深海军蓝色服装平铺在月球岩面上，衣服图案是一名侧坐的原创宇航员，厚重宇航服与月面尘埃有清晰材质关系，冷冽侧光，画面留出干净负空间，无品牌、无水印、无可读文字。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#1e3a5f',
  },
  {
    id: 'library-canghe-scent-editorial',
    title: '冷调香氛花材陈列',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以一件产品、少量花材和冷调留白做出细腻的电商主视觉。',
    prompt: '一只无品牌香氛玻璃瓶置于薄荷绿花材和米色织带之间，冷调渐变背景，柔焦逆光，主产品边缘清晰，植物只形成松弛框景，为后期标题预留留白，无包装文字、无价格、无水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#10b981',
  },
  {
    id: 'library-canghe-rubber-sculpture',
    title: '工业软管雕塑渲染',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用可弯折的工业材料搭建精确造型，适合科技品牌和产品概念图。',
    prompt: '将厚实的哑光工业软管弯折成一个简洁的原创抽象符号，结构致密、弧线饱满、接口细节可信，单色工作室背景，柔和轮廓光，超精细三维材质渲染，无品牌、无文字。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#475569',
  },
  {
    id: 'library-canghe-vintage-travel',
    title: '复古电影旅行海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以地标、人物和颗粒纸张建立带年代感的旅行叙事。',
    prompt: '竖版复古电影旅行海报：温暖日落下的原创城市地标、远处山脊和一位行旅者，丝网印刷颗粒、有限色板、纸张轻微磨损，构图中心明确并预留标题安全区，不生成任何文字、商标或水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#b45309',
  },
  {
    id: 'library-canghe-hard-edge-portrait',
    title: '硬边丝网人物像',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '通过色块、套印误差与纸张质地塑造强视觉人物像。',
    prompt: '一位原创人物的三分之二侧脸肖像，硬边现代艺术风格，哑光档案纸、可见丝网印刷层、轻微套印错位和两到三种高对比色块，面部轮廓简洁克制，无文字、无品牌、无水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#7c3aed',
  },
  {
    id: 'library-canghe-travel-notebook',
    title: '单色旅行手账插画',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以黑色手绘线条和一抹强调色记录地点与日常细节。',
    prompt: '为一座虚构海边小城绘制旅行手账插画，黑色粗细不一的毡笔线条、少量单色点缀、手绘建筑和植物细节、留白充足、纸张纹理自然，像私人速写本而非旅游广告，无可读文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#2563eb',
  },
  {
    id: 'library-canghe-brutalist-character',
    title: '粗野未来角色设定',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用石质盔甲、几何头盔和姿态稿建立原创角色的世界观。',
    prompt: '原创未来角色设定板：石质粗野风格护甲、几何面罩、分层机能服、三种清晰姿态和两处道具细节，灰白工作纸背景，版面留出说明区但不生成任何文字、标志或现有角色元素。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#334155',
  },
  {
    id: 'library-canghe-skeuomorphic-icon',
    title: '拟物应用图标',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '从单一物件出发，控制材质、阴影与边距，适合产品图标方向。',
    prompt: '方形应用图标，中心是一只原创的白色小犬陶瓷摆件，圆角连续、柔和环境阴影、浅色桌面和充足边距，轻拟物高光与真实材质并存，构图干净，不生成文字、界面或品牌标识。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#0f766e',
  },
  {
    id: 'library-canghe-crochet-doll',
    title: '钩织收藏玩偶',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以毛线针脚与道具细节构建有温度的收藏玩偶摄影。',
    prompt: '一只原创小动物钩织玩偶，柔软毛线针脚清晰可见，奶油色与一枚饱和强调色搭配，手持微小道具，置于安静的木质居家场景，柔和自然光，真实手作质感，无文字、无品牌。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#b45309',
  },
  {
    id: 'library-canghe-neon-designer',
    title: '霓虹创作者关键视觉',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '用一位主角和工作环境形成数字创作者的高对比主视觉。',
    prompt: '竖版数字创作者海报：原创年轻设计师站在未来感蓝色工作室中央，宽松深色服装、少量发光工具和清晰空间透视，冷蓝与一枚荧光色点亮画面，为后期标题保留整洁安全区，无文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#2563eb',
  },
  {
    id: 'library-canghe-watercolor-city',
    title: '单色水彩城市旅行',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以单一水彩色和细墨线收束城市地标，画面克制耐看。',
    prompt: '竖版城市旅行插画：虚构湖畔城市的屋顶、桥梁和远山，以单一靛蓝水彩和细墨线完成，色彩由深到浅自然晕染，纸张留白丰富，构图安静，为后期标题预留顶部空间，无文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#0369a1',
  },
  {
    id: 'library-canghe-storybook-stroll',
    title: '故事书城市漫步',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用手绘街景、人物动作和暖色阴影组织轻盈的城市叙事。',
    prompt: '故事书插画：一位原创旅人在石板街上散步，手持咖啡，周围是小店雨棚、路灯和春日植物，线条温柔，暖灰与砖红配色，人物表情自然，画面有阅读节奏，无文字、无品牌、无水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#d97706',
  },
  {
    id: 'library-canghe-electric-bus',
    title: '电动交通工程信息图',
    module: 'SCI_FIG',
    moduleLabel: '科研',
    description: '把整车、动力路径与三类关键部件收束为可阅读的工程说明图。',
    prompt: '方形可持续交通工程信息图：原创电动城市巴士居中，以克制的等距视角展示电池、驱动、电控和能量流，三处放大观察框由细引导线连接，青蓝与暖灰配色，出版级留白，不虚构数据或文字。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#0891b2',
  },
  {
    id: 'library-canghe-miniature-map',
    title: '微缩城市地图场景',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '让道路从纸质地图中生长出来，适合旅行、城市活动和叙事主视觉。',
    prompt: '俯视微缩旅行场景：一辆原创小巴沿着从旧纸质城市地图中自然隆起的高架道路行驶，周围有简化地标、树木和微小人物，真实微缩模型质感，暖日光和浅景深，无可读地图文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#7c5c42',
  },
  {
    id: 'library-canghe-pharmacy-storyboard',
    title: '药妆商业分镜封面',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以克制产品、真实材质和横幅镜头关系建立商业片的开场视觉。',
    prompt: '横版护肤品商业片分镜封面：无品牌的白色防晒霜瓶置于药房玻璃和柔软亚麻之间，35mm 变形宽银幕构图，冷静的日光、细腻触感、真实环境反射，主体明确并预留文案安全区，无包装文字。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#475569',
  },
  {
    id: 'library-canghe-fashion-catalog',
    title: '时尚目录拼贴',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '通过多帧姿态、纸张边界与克制调色营造杂志目录的节奏。',
    prompt: '竖版时尚目录拼贴：同一位原创模特以三种不同姿态分布在纸张边界内，酒红与象牙白服装、干净影棚光、轻微胶片颗粒和不规则裁切，版面层级清晰，为后期排版保留空白，无文字、无品牌。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#9f1239',
  },
  {
    id: 'library-canghe-neon-doodle',
    title: '霓虹涂鸦黑白肖像',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '把黑白写实肖像与少量荧光手绘批注结合，制造街头编辑感。',
    prompt: '高对比黑白街头肖像，一位原创人物身着深色夹克，局部叠加荧光绿色和橙色的手绘箭头、涂鸦线条与颜料飞溅，背景保持简洁混凝土质感，人物轮廓清晰，无文字、无品牌、无水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#65a30d',
  },
  {
    id: 'library-canghe-self-gaze',
    title: '自我凝视概念画面',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以人物、镜面和重复空间构成内省感十足的活动主视觉。',
    prompt: '概念时尚海报：一位原创人物坐在极简空间中，面前的镜面延伸出多个微妙错位的自我视角，米色、灰蓝和一抹亮黄构成配色，真实光影与超现实结构平衡，预留标题安全区，无文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#ca8a04',
  },
  {
    id: 'library-canghe-spring-scrapbook',
    title: '春日剪贴簿海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以柔和配色、纸张边缘与花园人物构建轻快的春季活动视觉。',
    prompt: '春日剪贴簿海报：原创人物站在盛开的花园中，奶油针织、浅蓝天空、花瓣、手撕纸边缘和少量贴纸感图形组成画面，轻盈柔焦、低饱和粉彩配色，顶部留出标题空间，不生成文字或商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#ec4899',
  },
  {
    id: 'library-canghe-paper-collage',
    title: '杂志纸艺拼贴',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '将人物或物件归纳为温暖纸材形状，适合品牌配图与社媒封面。',
    prompt: '极简纸艺拼贴插画：一个原创主体由暖白、赭石、深蓝和橄榄绿纸张剪影构成，保留关键动作和轮廓，手工裁边可见纤维，阴影轻柔，背景留白，画面不含文字、标志、水印或复杂花纹。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#b45309',
  },
  {
    id: 'library-canghe-sandwich-editorial',
    title: '夹层编辑海报',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '让主体穿插在前景纸面与背景色块之间，形成有层次的编辑设计。',
    prompt: '高级编辑海报：一个与主题相关的原创主视觉从两层半透明纸面之间穿插而过，前景图形、主体和背景色块具有清晰纵深，版面使用两级留白和一枚强调色，构图强而克制，无文字、无商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#0f766e',
  },
  {
    id: 'library-canghe-latte-miniature',
    title: '拿铁微缩人物',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用真实杯具、柔和泡沫与小比例人物创造轻松的日常奇想。',
    prompt: '一位原创微缩人物靠在热拿铁杯沿上休息，奶油泡沫、陶瓷釉面和针织衣物材质细腻可信，清晨窗边自然光，暖白与焦糖配色，画面轻盈有趣，无文字、无品牌、无水印。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#a16207',
  },
  {
    id: 'library-canghe-packaging-board',
    title: '动物包装结构板',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用主渲染、局部结构和材质样片展示完整的包装设计思路。',
    prompt: '专业包装设计结构板：一只原创海鸟造型礼盒的中心三维渲染，周围仅保留两处折叠展开图和一处纸材纹理样片，工作室柔光、结构比例准确、布局清晰，为说明预留位置但不生成文字或品牌。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#0f766e',
  },
  {
    id: 'library-canghe-four-city-series',
    title: '四城极简旅行系列',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '以统一比例、平面色块和不同地标组合一组可延展的旅行视觉。',
    prompt: '四张纵向极简旅行海报组成一组系列：每张为不同虚构城市的湖泊、桥梁、山谷或海岸地标，斯堪的纳维亚平面插画、低饱和粉彩、柔和天空和统一网格，图像之间有一致节奏，不生成城市名或商标。',
    sourceName: 'Canghe GPT-Image2 Gallery',
    sourceUrl: 'https://gpt-image2.canghe.ai',
    license: '',
    accent: '#2563eb',
  },
  {
    id: 'library-image-eastern-epic-space',
    title: '东方巨构幻想空间',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以建筑秩序、云海尺度和单一人物锚点组织安静而宏大的东方幻想场景。',
    prompt: '原创东方巨构幻想场景：一座尺度难以估量的中式建筑悬于层叠云海与远山之间，前景以门洞、廊柱或悬桥作为取景框，中景只保留一位原创人物作为尺度锚点，远景出现克制的巨大月体或山体。画面强调真实石材、风化金属与薄雾的层次，宽幅电影镜头、低饱和青灰和暖金点缀，留出平静的负空间，不生成文字、商标、水印或已有 IP。',
    sourceName: 'awesome-gpt-image-2',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2',
    license: 'MIT',
    accent: '#64748b',
  },
  {
    id: 'library-image-material-creature-closeup',
    title: '材料生物特写',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '用可触摸的材质层、局部硬光与唯一色彩焦点制作概念生物的近距离肖像。',
    prompt: '原创概念生物侧脸特写：以金属鳞片、瓷质沉积、湿润岩层和细密网状结构构成未知生物表面，单只眼睛或器官成为唯一亮点；背景保持低调的岩壁灰和环境雾气。使用微距真实光学、硬朗边缘光和受控景深，强调材质过渡与微表面细节，不使用现有影视或游戏 IP，不生成文字、商标和水印。',
    sourceName: 'GPT-Image2-Skill',
    sourceUrl: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    accent: '#475569',
  },
  {
    id: 'library-image-culinary-tabletop',
    title: '顶视食物编辑摄影',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '以一件食品为视觉中心，用器物、香料和光影组织可直接用于电商与社媒的顶视画面。',
    prompt: '方形顶视食品编辑摄影：一件原创食品或调味品位于中心，周围只安排少量同类原料、器皿和工具，严格控制物体间距和留白。使用带颗粒感的木质或石材台面、方向明确的柔硬阴影与浓郁但克制的食物色彩；包装文字和品牌均留给后期，不由模型生成。',
    sourceName: 'awesome-gpt-image-2',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2',
    license: 'MIT',
    accent: '#b45309',
  },
  {
    id: 'library-image-rainy-harbor-zine',
    title: '雨港手帐叙事',
    module: 'TEXT_TO_IMAGE',
    moduleLabel: '文生图',
    description: '把一个真实观察瞬间与少量纸张、票根和铅笔线组合成安静的独立杂志视觉。',
    prompt: '竖幅原创旅行手帐拼贴：雨后傍晚的港口小镇，一位原创人物停在旧书摊或码头边；真实场景承担叙事，象牙白撕纸、低饱和蓝色剪纸、票根碎片和铅笔路线只用于补充触感。使用克制的雨天自然光和胶片颗粒，画面安静、层次清楚，不生成文字、地名、商标或水印。',
    sourceName: 'awesome-gpt-image-2',
    sourceUrl: 'https://github.com/freestylefly/awesome-gpt-image-2',
    license: 'MIT',
    accent: '#526a7a',
  },
  {
    id: 'library-poster-playful-3d-world',
    title: '轻量 3D 游戏世界',
    module: 'POSTER_GEN',
    moduleLabel: '海报',
    description: '用低复杂度的几何体、明亮比例关系与单一动作主体完成轻快的活动主视觉。',
    prompt: '竖幅原创轻量 3D 游戏世界海报：彩色圆角积木搭出明确的前景、中景和背景结构，一位原创角色或物体正在完成单一动作，使用简洁天光、软塑料材质和有限的糖果色。为标题和活动信息留下安全留白，不使用真实游戏品牌、角色、文字、商标或水印。',
    sourceName: 'GPT-Image2-Skill',
    sourceUrl: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    accent: '#7c3aed',
  },
  {
    id: 'library-science-environmental-cutaway',
    title: '环境过程连续剖面',
    module: 'SCI_FIG',
    moduleLabel: '科研绘图',
    description: '以单条连续因果路径连接地表、根系、土层与深层结构，适合概念型环境科学图。',
    prompt: '横版原创环境科学概念剖面：从地表植被、根系和分层土壤延伸到深层稳定结构，用一条连续的可读路径连接关键阶段，并只设置两到三个无文字的放大观察窗。使用暖白纸质背景、泥土棕、叶绿、炭黑与低饱和蓝色，明确为概念示意，不生成实验数据、图表、显微照片、公式、文字、商标或水印。',
    sourceName: 'GPT-Image2-Skill',
    sourceUrl: 'https://github.com/wuyoscar/GPT-Image2-Skill',
    license: 'MIT',
    accent: '#6b7280',
  },
]

const CREATIVE_LIBRARY_PREVIEWS: Record<string, string> = {
  'library-high-concept-mythic-cinema': '/creative-library/high-concept-cosmic-vortex.webp',
  'library-image-editorial-light': '/creative-library/gallery-meigen-fashion-editorial.webp',
  'library-image-controlnet-composition': '/creative-library/gallery-architecture-library-stairwell.webp',
  'library-image-adapter-style': '/creative-library/gallery-coastal-paper-map.webp',
  'library-image-gathered-scenes-zine': '/creative-library/gallery-zine-mountain-lake.webp',
  'library-image-cinema-storyboard': '/creative-library/gallery-cinema-harbor-key-art.webp',
  'library-image-comic-ip': '/creative-library/gallery-character-bible-cloud-lantern.webp',
  'library-image-xiaohei-explainer': '/creative-library/gallery-meigen-candy-game.webp',
  'library-image-moments-photo-diary': '/creative-library/gallery-moments-photo-diary.webp',
  'library-image-moments-diptych': '/creative-library/gallery-moments-solar-term.webp',
  'library-image-moments-nine-grid': '/creative-library/gallery-meigen-chili-food.webp',
  'library-image-quiet-architecture': '/creative-library/gallery-architecture-library-stairwell.webp',
  'library-image-documentary-still': '/creative-library/gallery-cinema-harbor-shot-3.webp',
  'library-image-contemporary-eastern-life': '/creative-library/gallery-eastern-still-life-plum.webp',
  'library-image-prompt-cookbook': '/creative-library/gallery-natural-history-butterfly.webp',
  'library-science-method-figure': '/creative-library/gallery-science-organ-chip.webp',
  'library-science-cellular-cutaway': '/creative-library/gallery-science-materials-cutaway.webp',
  'library-science-evidence-dashboard': '/creative-library/gallery-science-photonic-sensor.webp',
  'library-science-ecosystem-process': '/creative-library/gallery-science-ecosystem.webp',
  'library-science-spatial-atlas': '/creative-library/gallery-science-cool-roofs.webp',
  'library-science-comparison-evidence': '/creative-library/gallery-science-hydrogel-repair.webp',
  'library-science-publication-figure': '/creative-library/gallery-science-polymer-cycle.webp',
  'library-science-conceptual-graphical-abstract': '/creative-library/gallery-science-nanocarrier.webp',
  'library-poster-brand-launch': '/creative-library/canghe-519.webp',
  'library-poster-exhibition-grid': '/creative-library/gallery-poster-swiss-grid.webp',
  'library-poster-illustration-collage': '/creative-library/gallery-poster-citrus-collage.webp',
  'library-poster-system-icons': '/creative-library/gallery-poster-night-run.webp',
  'library-poster-new-chinese': '/creative-library/gallery-poster-new-chinese-tea.webp',
  'library-poster-cultural-program': '/creative-library/gallery-poster-swiss-grid.webp',
  'library-poster-product-editorial': '/creative-library/canghe-519.webp',
  'library-poster-data-story': '/creative-library/canghe-494.webp',
  'library-poster-ad-visual-system': '/creative-library/canghe-519.webp',
  'library-image-canghe-material-study': '/creative-library/canghe-516.webp',
  'library-image-canghe-space-frame': '/creative-library/gallery-architecture-library-stairwell.webp',
  'library-image-youmind-travel-grid': '/creative-library/canghe-513.webp',
  'library-image-youmind-ms-paint': '/creative-library/canghe-479.webp',
  'library-poster-canghe-product-detail': '/creative-library/canghe-519.webp',
  'library-poster-canghe-document-system': '/creative-library/canghe-478.webp',
  'library-canghe-lunar-apparel': '/creative-library/canghe-520.webp',
  'library-canghe-scent-editorial': '/creative-library/canghe-519.webp',
  'library-canghe-rubber-sculpture': '/creative-library/canghe-516.webp',
  'library-canghe-vintage-travel': '/creative-library/canghe-515.webp',
  'library-canghe-hard-edge-portrait': '/creative-library/canghe-514.webp',
  'library-canghe-travel-notebook': '/creative-library/canghe-513.webp',
  'library-canghe-brutalist-character': '/creative-library/canghe-512.webp',
  'library-canghe-skeuomorphic-icon': '/creative-library/canghe-510.webp',
  'library-canghe-crochet-doll': '/creative-library/canghe-507.webp',
  'library-canghe-neon-designer': '/creative-library/canghe-503.webp',
  'library-canghe-watercolor-city': '/creative-library/canghe-497.webp',
  'library-canghe-storybook-stroll': '/creative-library/canghe-495.webp',
  'library-canghe-electric-bus': '/creative-library/canghe-494.webp',
  'library-canghe-miniature-map': '/creative-library/canghe-489.webp',
  'library-canghe-pharmacy-storyboard': '/creative-library/canghe-487.webp',
  'library-canghe-fashion-catalog': '/creative-library/canghe-485.webp',
  'library-canghe-neon-doodle': '/creative-library/canghe-484.webp',
  'library-canghe-self-gaze': '/creative-library/canghe-482.webp',
  'library-canghe-spring-scrapbook': '/creative-library/canghe-481.webp',
  'library-canghe-paper-collage': '/creative-library/canghe-479.webp',
  'library-canghe-sandwich-editorial': '/creative-library/canghe-478.webp',
  'library-canghe-latte-miniature': '/creative-library/canghe-476.webp',
  'library-canghe-packaging-board': '/creative-library/canghe-475.webp',
  'library-canghe-four-city-series': '/creative-library/canghe-474.webp',
  'library-image-eastern-epic-space': '/creative-library/gallery-meigen-tang-fantasy.webp',
  'library-image-material-creature-closeup': '/creative-library/gallery-meigen-dragon-portrait.webp',
  'library-image-culinary-tabletop': '/creative-library/gallery-meigen-chili-food.webp',
  'library-image-rainy-harbor-zine': '/creative-library/welcome-zine-rainy-harbor.webp',
  'library-poster-playful-3d-world': '/creative-library/gallery-meigen-candy-game.webp',
  'library-science-environmental-cutaway': '/creative-library/gallery-science-soil-carbon-cycle.webp',
}

export function creativeLibraryPreview(item: CreativeLibraryItem): string {
  return CREATIVE_LIBRARY_PREVIEWS[item.id] || '/creative-library/gallery-zine-mountain-lake.webp'
}

const SERVER_SKILL_IDS: Record<string, string> = {
  'library-high-concept-mythic-cinema': 'high-concept-mythic-cinema',
  'library-image-editorial-light': 'product-editorial-still',
  'library-image-controlnet-composition': 'quiet-architecture',
  'library-image-gathered-scenes-zine': 'gathered-scenes-zine',
  'library-image-cinema-storyboard': 'cinema-dna-storyboard',
  'library-image-comic-ip': 'character-bible',
  'library-image-moments-photo-diary': 'moments-photo-diary',
  'library-image-moments-diptych': 'structured-camera-recipe',
  'library-image-moments-nine-grid': 'structured-camera-recipe',
  'library-image-quiet-architecture': 'quiet-architecture',
  'library-image-documentary-still': 'documentary-still',
  'library-image-contemporary-eastern-life': 'moments-photo-diary',
  'library-image-prompt-cookbook': 'structured-camera-recipe',
  'library-science-method-figure': 'method-flow',
  'library-science-cellular-cutaway': 'evidence-comparison',
  'library-science-ecosystem-process': 'spatial-atlas',
  'library-science-spatial-atlas': 'spatial-atlas',
  'library-science-comparison-evidence': 'evidence-comparison',
  'library-science-publication-figure': 'method-flow',
  'library-science-conceptual-graphical-abstract': 'conceptual-graphical-abstract',
  'library-poster-exhibition-grid': 'cultural-program',
  'library-poster-cultural-program': 'cultural-program',
  'library-poster-product-editorial': 'poster-new-chinese-brand',
  'library-poster-data-story': 'data-story-poster',
  'library-poster-illustration-collage': 'editorial-collage',
  'library-poster-system-icons': 'icon-system-poster',
  'library-poster-new-chinese': 'poster-new-chinese-brand',
  'library-poster-ad-visual-system': 'editorial-collage',
  'library-canghe-paper-collage': 'editorial-collage',
}

const REMOTE_SKILL_FAMILY_IDS: Record<string, string> = {
  'moments-solar-term': 'moments-photo-diary',
  'contemporary-eastern-life': 'moments-photo-diary',
  'moments-diptych': 'structured-camera-recipe',
  'moments-nine-grid': 'structured-camera-recipe',
  'poster-paper-collage': 'editorial-collage',
  'ad-key-visual-system': 'editorial-collage',
  'poster-swiss-exhibition': 'cultural-program',
  'product-editorial-poster': 'poster-new-chinese-brand',
  'new-chinese-product': 'poster-new-chinese-brand',
  'science-delivery-mechanism': 'method-flow',
  'publication-panels': 'method-flow',
  'scientific-hero': 'method-flow',
  'science-materials-cutaway': 'evidence-comparison',
  'materials-lens': 'evidence-comparison',
  'science-ecosystem-process': 'spatial-atlas',
  'urban-ecology': 'spatial-atlas',
}

const STATIC_SKILL_FAMILY_IDS: Record<string, string> = {
  'library-image-controlnet-composition': 'quiet-architecture',
  'library-image-canghe-space-frame': 'quiet-architecture',
  'library-image-youmind-travel-grid': 'library-image-youmind-travel-grid',
  'library-canghe-travel-notebook': 'library-image-youmind-travel-grid',
  'library-image-youmind-ms-paint': 'editorial-collage',
  'library-canghe-paper-collage': 'editorial-collage',
}

const STATIC_SKILL_FAMILY_REPRESENTATIVES: Record<string, string> = {
  'quiet-architecture': 'library-image-quiet-architecture',
  'library-image-youmind-travel-grid': 'library-image-youmind-travel-grid',
  'editorial-collage': 'library-poster-illustration-collage',
}

export function creativeStyleCanonicalSkillId(style: Pick<CreativeStylePreset, 'id' | 'isPersonal'>): string {
  if (style.isPersonal) return style.id
  return REMOTE_SKILL_FAMILY_IDS[style.id] || style.id
}

export function creativeLibraryServerSkillId(itemOrId: CreativeLibraryItem | string): string {
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id
  const serverId = SERVER_SKILL_IDS[id] || id
  return REMOTE_SKILL_FAMILY_IDS[serverId] || serverId
}

function creativeLibraryCatalogFamilyId(item: CreativeLibraryItem) {
  return STATIC_SKILL_FAMILY_IDS[item.id] || creativeLibraryServerSkillId(item)
}

function normalizedCatalogLabel(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function creativeLibraryPreviewIdentity(item: CreativeLibraryItem) {
  const explicitPreview = item.exampleImages?.find(source => Boolean(source.trim()))
  if (explicitPreview) return explicitPreview.trim().toLocaleLowerCase()
  return CREATIVE_LIBRARY_PREVIEWS[item.id]?.trim().toLocaleLowerCase() || ''
}

function dedupeCreativeLibraryVisualFamilies(items: CreativeLibraryItem[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    const preview = creativeLibraryPreviewIdentity(item)
    // A preview is the gallery's visual promise. Do not expose several skills
    // from different source repositories when they resolve to the same image.
    if (!preview) return true
    const identity = `${item.module}|${preview}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function creativeStyleToLibraryItem(style: CreativeStylePreset): CreativeLibraryItem | null {
  if (!['TEXT_TO_IMAGE', 'POSTER_GEN', 'SCI_FIG'].includes(style.module)) return null
  const moduleLabel = style.module === 'POSTER_GEN' ? '海报' : style.module === 'SCI_FIG' ? '科研图' : '图片生成'
  const accent = style.module === 'POSTER_GEN' ? '#d97706' : style.module === 'SCI_FIG' ? '#71717a' : '#78716c'
  return {
    id: style.id,
    title: style.name,
    module: style.module,
    moduleLabel,
    description: style.description,
    prompt: style.executionInstructions || style.promptTemplate,
    sourceName: style.sourceName,
    sourceUrl: style.sourceUrl,
    license: '',
    accent,
    exampleImages: style.previewUrl ? [style.previewUrl] : undefined,
    isPersonal: style.isPersonal,
  }
}

/**
 * Compose the display catalog by explicit canonical identity. Display names are
 * only used to choose between static entries already declared as aliases; they
 * never make unrelated records equivalent.
 */
export function mergeCreativeSkillCatalog(
  curatedItems: CreativeLibraryItem[],
  remotePresets: CreativeStylePreset[],
): CreativeLibraryItem[] {
  const remoteById = new Map<string, CreativeStylePreset>()
  for (const style of remotePresets) {
    const canonicalId = creativeStyleCanonicalSkillId(style)
    const current = remoteById.get(canonicalId)
    if (!current || style.id === canonicalId) remoteById.set(canonicalId, style)
  }
  const curatedByCanonicalId = new Map<string, CreativeLibraryItem[]>()
  for (const item of curatedItems) {
    const canonicalId = creativeLibraryCatalogFamilyId(item)
    const group = curatedByCanonicalId.get(canonicalId)
    if (group) group.push(item)
    else curatedByCanonicalId.set(canonicalId, [item])
  }

  const representedCanonicalIds = new Set<string>()
  const uniqueCurated: CreativeLibraryItem[] = []
  for (const [canonicalId, candidates] of curatedByCanonicalId) {
    const remote = remoteById.get(canonicalId)
    const preferred = remote
      ? candidates.find(item => normalizedCatalogLabel(item.title) === normalizedCatalogLabel(remote.name))
      : undefined
    const representativeId = STATIC_SKILL_FAMILY_REPRESENTATIVES[canonicalId]
    const representative = representativeId ? candidates.find(item => item.id === representativeId) : undefined
    uniqueCurated.push(preferred || representative || candidates[0])
    if (remote) representedCanonicalIds.add(canonicalId)
  }

  const managed = Array.from(remoteById.entries())
    .filter(([canonicalId]) => !representedCanonicalIds.has(canonicalId))
    .map(([, style]) => style)
    .map(creativeStyleToLibraryItem)
    .filter((item): item is CreativeLibraryItem => Boolean(item))

  return dedupeCreativeLibraryVisualFamilies([
    ...managed.filter(item => item.isPersonal),
    ...uniqueCurated,
    ...managed.filter(item => !item.isPersonal),
  ])
}

export function partitionCreativeSkillCatalog(items: CreativeLibraryItem[], featuredCount = 3) {
  const explicitlyFeatured = items.filter(item => item.featured)
  const selectedIds = new Set(explicitlyFeatured.map(item => item.id))
  const featured = [
    ...explicitlyFeatured,
    ...items.filter(item => !item.isPersonal && !selectedIds.has(item.id)),
  ].slice(0, Math.max(0, featuredCount))
  const featuredIds = new Set(featured.map(item => item.id))
  return {
    featured,
    remaining: items.filter(item => !featuredIds.has(item.id)),
  }
}

const IMAGE_REQUIRED_SKILLS = new Set([
  'library-image-adapter-style',
  'library-image-comic-ip',
  'library-canghe-hard-edge-portrait',
  'library-canghe-brutalist-character',
  'library-canghe-crochet-doll',
  'library-canghe-fashion-catalog',
  'library-canghe-self-gaze',
  'library-canghe-packaging-board',
])

function executionAdapterForModule(module: PublicGalleryModule): CreativeExecutionAdapter {
  if (module === 'POSTER_GEN') return 'poster'
  if (module === 'SCI_FIG') return 'sci_fig'
  if (module === 'IMAGE_EDIT') return 'image_edit'
  return 'image_generate'
}

export function creativeLibrarySkillPreset(item: CreativeLibraryItem): CreativeStylePreset {
  const imageRequired = IMAGE_REQUIRED_SKILLS.has(item.id)
  const serverSkillId = creativeLibraryServerSkillId(item)
  const styleModule = ['TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'SCI_FIG'].includes(item.module)
    ? item.module as CreativeStylePreset['module']
    : 'TEXT_TO_IMAGE'
  return {
    id: serverSkillId,
    name: item.title,
    module: styleModule,
    description: item.description,
    promptTemplate: item.prompt,
    styleHint: '',
    tags: [item.moduleLabel, imageRequired ? '图片输入' : '免提示词'],
    previewUrl: creativeLibraryPreview(item),
    sourceName: 'Linggan 技能广场',
    sourceUrl: '',
    enabled: true,
    sortOrder: 0,
    schemaVersion: 2,
    revision: 1,
    executionAdapter: executionAdapterForModule(item.module),
    executionInstructions: item.prompt,
    inputContract: {
      prompt: { required: false, maxLength: 4000 },
      images: {
        min: imageRequired ? 1 : 0,
        max: imageRequired ? 1 : 8,
        roles: imageRequired ? ['source'] : ['reference'],
        mime: ['image/jpeg', 'image/png', 'image/webp'],
      },
    },
    constraints: {
      guardrails: item.executionRules?.length ? item.executionRules : [
        '完整执行该技能的构图、材质、色彩与交付结构，不得只追加几个风格词',
        imageRequired ? '以用户上传图片为主体依据，保持可识别特征与核心轮廓' : '用户未补充文字时，直接按技能默认主题完成一版可用结果',
        '不生成水印、平台标识或无关品牌文字',
      ],
      user_overrides: ['output_resolution', 'image_quality', 'aspect_ratio'],
      max_outputs: 1,
    },
    defaultParams: {
      output_resolution: '2k',
      image_quality: 'high',
      count: 1,
      ...(item.module === 'SCI_FIG' ? { gen_mode: 'image2', output_format: 'png' } : {}),
    },
    showInGallery: true,
  }
}

export function findCreativeLibrarySkill(skillId: string): CreativeStylePreset | null {
  const item = CREATIVE_LIBRARY.find(candidate => candidate.id === skillId)
  return item ? creativeLibrarySkillPreset(item) : null
}

export function creativeLibrarySkillInputLabel(item: CreativeLibraryItem) {
  return IMAGE_REQUIRED_SKILLS.has(item.id) ? '上传 1 张图片即可使用' : '可直接使用，文字与参考图均可选'
}
