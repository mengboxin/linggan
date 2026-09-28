CREATE TABLE IF NOT EXISTS creative_style_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    module          TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    prompt_template TEXT NOT NULL DEFAULT '',
    style_hint      TEXT NOT NULL DEFAULT '',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    preview_url     TEXT NOT NULL DEFAULT '',
    source_name     TEXT NOT NULL DEFAULT '',
    source_url      TEXT NOT NULL DEFAULT '',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT creative_style_presets_module_check
        CHECK (module IN ('TEXT_TO_IMAGE', 'IMAGE_EDIT', 'POSTER_GEN', 'SCI_FIG'))
);

CREATE INDEX IF NOT EXISTS idx_creative_style_presets_active
    ON creative_style_presets (module, enabled, sort_order ASC, created_at ASC);

INSERT INTO creative_style_presets (
    id, name, module, description, prompt_template, style_hint, tags,
    preview_url, source_name, source_url, enabled, sort_order
) VALUES
    (
        'cinema-dna-storyboard', '电影叙事分镜', 'TEXT_TO_IMAGE',
        '用人物与空间的关系、真实光源和未完成事件组织单帧或三联叙事。',
        '先定义角色当前无法立刻解决的选择，再确定观众位置和一条视线流量：从什么进入，被什么放慢，落到什么信息，最后从哪里离开。颜色必须来自服装、天气、场景或实景光源。',
        '避免游戏主视觉、广告摆拍、泛青橙调色、过度光晕和任何现有影视或动画 IP。',
        ARRAY['电影感', '分镜', '叙事'], '/gallery-cinema-harbor-key-art.png',
        '电影叙事方法（Cinema DNA）', 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3', TRUE, 10
    ),
    (
        'gathered-scenes-zine', '实景杂志拼贴', 'TEXT_TO_IMAGE',
        '把真实场景锚点、抽象纸面插画、单一结构色和撕纸边界做成安静的旅行杂志视觉。',
        '保留一个能辨识场景的真实主体和空间关系；将复杂细节压缩为少量大形，照片与插画以手撕纸纤维边界交接。让一块高饱和色沿场景形状延伸，并保留大面积纸面留白。',
        '避免全景描摹、装饰性贴纸、密集叶片、多个互相竞争的颜色和可读文字。',
        ARRAY['旅行', '拼贴', '杂志'], '/gallery-zine-mountain-lake.png',
        '实景杂志拼贴（Gathered Scenes Zine）', 'https://github.com/Zeejay0/gathered-scenes-zine-skill', TRUE, 20
    ),
    (
        'moments-solar-term', '节气生活静物', 'TEXT_TO_IMAGE',
        '适合朋友圈、小红书封面和生活方式内容的自然光静物。',
        '选择一件季节性饮品或日常物件作为主体，用窗边自然光、少量植物和一块干净背景组织画面；画面必须为后期中文短句预留安静区域。',
        '使用克制、真实的材质和色彩，避免商业硬广、模型生成文字和堆叠道具。',
        ARRAY['朋友圈', '节气', '静物'], '/gallery-moments-solar-term.png',
        'PixelScribe 精选', '', TRUE, 30
    ),
    (
        'fantasy-cloud-market', '奇趣幻想漫游', 'TEXT_TO_IMAGE',
        '用原创角色、单一任务和可辨识世界规则形成适合社媒传播的奇趣幻想画面。',
        '为主角设计一个正在完成的具体动作，并给世界只保留一个反常规则；用前景主体、中景行动和远景世界建立故事，不依赖现有角色、影视作品或游戏设定。',
        '避免恐怖元素、模板化赛博霓虹、满画面特效、商标和任何现有 IP 角色。',
        ARRAY['幻想', '角色', '社媒'], '/gallery-fantasy-cloud-market.png',
        'PixelScribe 原创配方', '', TRUE, 40
    ),
    (
        'comic-ip-design', '漫剧 IP 设计', 'TEXT_TO_IMAGE',
        '用于原创角色、世界观主视觉和短剧发行底图，先建立角色矛盾再决定镜头。',
        '明确主角、陪伴物、关键道具、世界规则和一个未完成的选择。角色必须在行动中，主视觉只保留一个故事钩子，并预留标题安全区。',
        '不得仿制任何现有动画、漫画、游戏或影视 IP；角色、道具、场景和配色必须独立原创。',
        ARRAY['漫剧', 'IP设计', '角色'], '/gallery-cinema-harbor-key-art.png',
        '电影叙事方法（Cinema DNA）', 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3', TRUE, 50
    ),
    (
        'poster-paper-collage', '插画纸艺拼贴', 'POSTER_GEN',
        '适合新品、活动和社媒的明亮纸艺海报，保留真正可排版的中文信息区域。',
        '确立一个清晰产品或活动主体，用两到三层纸艺形状、局部贴纸式注释和印刷颗粒建立层次；在标题、日期和卖点位置留出干净安全区。',
        '避免模型直接生成大量文字、满画面贴纸、廉价渐变和商标。',
        ARRAY['海报', '拼贴', '新品'], '/gallery-poster-citrus-collage.png',
        'PixelScribe 精选', '', TRUE, 10
    ),
    (
        'poster-swiss-exhibition', '瑞士网格展览', 'POSTER_GEN',
        '用克制网格、大留白和一枚高饱和点睛色组织当代展览或发布会主视觉。',
        '选择一个抽象雕塑、物件或空间作为唯一主视觉；用极细网格和大面积暖白留白建立信息层级，将高饱和色限制为一个小型结构点。',
        '避免大段模型文字、过度对称、游戏感特效和多种高饱和颜色。',
        ARRAY['海报', '展览', '网格'], '/gallery-poster-swiss-grid.png',
        'GPT Image 2 开源提示词图库', 'https://github.com/ChaosRealmsAI/gpt-image-2-gallery', TRUE, 20
    ),
    (
        'poster-new-chinese-brand', '新中式品牌主视觉', 'POSTER_GEN',
        '用东方留白、真实产品质感和单一意象建立克制的中国风商业海报。',
        '让产品与一件东方意象形成前后层次，例如水墨山形、器物、花枝或月色；产品必须清晰，标题区保持留白，颜色从实物、自然光和材质本身产生。',
        '避免符号堆砌、金色滥用、伪书法乱码和传统元素拼贴。',
        ARRAY['海报', '新中式', '品牌'], '/gallery-poster-new-chinese-tea.png',
        'PixelScribe 精选', '', TRUE, 30
    ),
    (
        'science-delivery-mechanism', '递送机制图文摘要', 'SCI_FIG',
        '适合生物医学机制、药物递送和细胞过程的可读科研视觉。',
        '以一条连续机制路径连接载体、细胞屏障、关键作用位点和结果；最多设置两枚放大观察窗，所有箭头与引导线必须服务于主路径。',
        '暖白背景、克制双色加一枚强调色；避免伪数据、过度装饰、不可读小字和复杂无关器官。',
        ARRAY['科研', '机制图', '生物医学'], '/gallery-science-nanocarrier.png',
        '科研叙事图方法（Storytelling Figures）', 'https://github.com/emorymao-hub/storytelling-figures', TRUE, 10
    ),
    (
        'science-materials-cutaway', '材料微观剖面', 'SCI_FIG',
        '适合电池、薄膜、复合材料和器件结构的层级剖面展示。',
        '从宏观器件剖面进入一个微观放大窗，清楚展示层间关系、孔隙或粒子结构和一条核心输运路径；宏观与微观必须由同一逻辑连接。',
        '保持科学绘图的比例感和留白，避免科幻 UI、炫光和与材料无关的机械零件。',
        ARRAY['科研', '材料', '剖面'], '/gallery-science-materials-cutaway.png',
        '科研叙事图方法（Storytelling Figures）', 'https://github.com/emorymao-hub/storytelling-figures', TRUE, 20
    ),
    (
        'science-ecosystem-process', '生态过程图', 'SCI_FIG',
        '用连续地貌剖面和可追踪流线表达流域、湿地、气候或环境监测过程。',
        '让地貌从源头到下游形成一个连续过程，用单条水流、能量或物质路径串联关键采样与过滤环节；只保留必要的两个放大说明窗口。',
        '避免儿童插画、装饰性图标堆叠和不具因果关系的箭头。',
        ARRAY['科研', '生态', '过程图'], '/gallery-science-ecosystem.png',
        '科研叙事图方法（Storytelling Figures）', 'https://github.com/emorymao-hub/storytelling-figures', TRUE, 30
    )
ON CONFLICT (id) DO NOTHING;
