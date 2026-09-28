import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth, apiUrl } from '../lib/auth'
import { formatModelPrice, isExternalApiKeyModel } from '../lib/model-pricing'
import { useThemeStore } from '../lib/theme'
import { StudioAtmosphere } from '../components/ui/StudioAtmosphere'
import { BrandWordmark } from '../components/ui/BrandWordmark'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'

interface AIModel {
  id: string
  name: string
  category: string
  tags: string[]
  description: string
  cover_url: string
  provider: string
  price_type: 'free' | 'credits' | 'subscription'
  price_credits: number
  billing_mode?: string
  is_featured: boolean
  total_calls: number
  avg_duration_ms: number
}

const CATEGORY_META: Record<string, { label: string; color: string; bg: string }> = {
  segmentation: { label: '图层分割', color: 'text-purple-400',  bg: 'bg-purple-400/10 border-purple-400/20' },
  inpainting:   { label: '局部重绘', color: 'text-cyan-400',    bg: 'bg-cyan-400/10 border-cyan-400/20' },
  style:        { label: '风格化',   color: 'text-amber-400',   bg: 'bg-amber-400/10 border-amber-400/20' },
  enhance:      { label: '图像增强', color: 'text-emerald-400', bg: 'bg-emerald-400/10 border-emerald-400/20' },
  generate:     { label: '图像生成', color: 'text-rose-400',    bg: 'bg-rose-400/10 border-rose-400/20' },
  llm:          { label: '文本模型', color: 'text-cyan-400',    bg: 'bg-cyan-400/10 border-cyan-400/20' },
  vision:       { label: '视觉模型', color: 'text-emerald-400', bg: 'bg-emerald-400/10 border-emerald-400/20' },
  video:        { label: '视频生成', color: 'text-fuchsia-400', bg: 'bg-fuchsia-400/10 border-fuchsia-400/20' },
  other:        { label: '其他',     color: 'text-slate-400',   bg: 'bg-slate-400/10 border-slate-400/20' },
}

const PLATFORM_CATEGORIES = ['all', 'segmentation', 'inpainting', 'style', 'enhance', 'generate', 'llm', 'video']
const EXTERNAL_CATEGORIES = ['all', 'llm', 'vision', 'generate', 'video']

export default function ModelsPage() {
  const navigate = useNavigate()
  const user = auth.getUser()
  const externalCompute = auth.isExternalComputeUser(user)
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const categories = externalCompute ? EXTERNAL_CATEGORIES : PLATFORM_CATEGORIES

  const [models, setModels] = useState<AIModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<AIModel | null>(null)

  useEffect(() => {
    auth.fetchWithAuth(apiUrl('/api/models'))
      .then(r => {
        if (!r.ok) throw new Error('加载失败')
        return r.json()
      })
      .then(setModels)
      .catch(() => setError('加载模型列表失败，请检查后端服务'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = models.filter(m => {
    const matchCat = activeCategory === 'all' || m.category === activeCategory
    const q = search.trim().toLowerCase()
    const matchSearch = !q || m.name.toLowerCase().includes(q) || m.tags.some(t => t.toLowerCase().includes(q))
    return matchCat && matchSearch
  })

  const featured = filtered.filter(m => m.is_featured)
  const regular  = filtered.filter(m => !m.is_featured)

  return (
    <div
      className="models-page app-topbar-page relative isolate min-h-screen flex flex-col overflow-hidden"
      data-model-theme={isDark ? 'dark' : 'light'}
      style={{
        background: 'var(--app-workspace)',
        color: 'var(--app-text)',
        '--app-topbar-height': '64px',
      } as CSSProperties}
    >
      <StudioAtmosphere variant="gallery" />

      {/* 顶部导航 */}
      <FloatingTopBar height={64} className="models-header h-16 flex items-center justify-between px-4 sm:px-6 backdrop-blur-xl border-b">
        <div className="flex items-center gap-6">
          <button onClick={() => navigate('/editor')}
            className="flex items-center gap-2">
            <BrandWordmark className="brand-wordmark--compact" />
          </button>
          <nav className="hidden sm:flex items-center gap-1">
            <button onClick={() => navigate('/editor')}
              className="models-nav-button px-3 py-1.5 text-sm rounded-lg transition-colors">
              编辑器
            </button>
            <button className="models-nav-button is-active px-3 py-1.5 text-sm rounded-lg">
              模型广场
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {externalCompute && (
            <span className="models-status-pill rounded-md px-2 py-1 text-[11px] font-semibold">FoxAPI密钥</span>
          )}
          <span className="hidden max-w-[130px] truncate text-sm sm:block">{user?.displayName ?? user?.email}</span>
          <TopBarPinButton />
          <button onClick={() => { auth.clear({ intentional: true }); navigate('/login') }}
            className="models-icon-button p-2 rounded-lg transition-colors">
            <span className="material-symbols-outlined text-[20px]">logout</span>
          </button>
        </div>
      </FloatingTopBar>

      <main
        className="relative z-10 flex-1 max-w-6xl mx-auto w-full px-4 pb-8 sm:px-6 sm:pb-10"
        style={{ paddingTop: 'calc(var(--app-topbar-reserved-height) + 2.5rem)' }}
      >

        {/* 页头 */}
        <div className="mb-10">
          <p className="models-kicker mb-2 text-[11px] font-black tracking-[0.18em]">模型与算力</p>
          <h1 className="text-3xl font-black mb-2 font-['Space_Grotesk']">模型广场</h1>
          <p className="models-muted max-w-2xl text-sm leading-6">
            {externalCompute
              ? '当前展示你的 FoxAPI Key 可调用模型；文本、视觉与生图模型会出现在对应创作模块中'
              : '选择 AI 模型对图层进行处理，在编辑器中直接调用'}
          </p>
        </div>

        {/* 搜索 + 分类筛选 */}
        <div className="models-filter-bar flex flex-col sm:flex-row gap-4 mb-8">
          <div className="relative flex-1 max-w-sm">
            <span className="models-muted absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[18px]">search</span>
            <input
              type="text" placeholder="搜索模型名称或标签..."
              value={search} onChange={e => setSearch(e.target.value)}
              className="models-search w-full rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {categories.map(cat => (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                className={`models-category px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${activeCategory === cat ? 'is-active' : ''}`}>
                {cat === 'all' ? '全部' : CATEGORY_META[cat]?.label}
              </button>
            ))}
          </div>
        </div>

        {/* 状态 */}
        {loading && (
          <div className="models-muted flex items-center justify-center py-24 text-sm gap-2">
            <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            加载中...
          </div>
        )}
        {error && (
          <div className="models-muted flex flex-col items-center justify-center py-24 gap-3">
            <span className="material-symbols-outlined text-[40px] text-red-400/50">error</span>
            <p className="text-slate-400 text-sm">{error}</p>
            <button onClick={() => window.location.reload()}
              className="models-secondary-button px-4 py-2 rounded-lg text-sm transition-colors">
              重试
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="models-muted flex flex-col items-center justify-center py-24 gap-2">
            <span className="material-symbols-outlined text-[40px]">search_off</span>
            <p className="text-sm">没有找到匹配的模型</p>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* 推荐模型 */}
            {featured.length > 0 && (
              <section className="mb-10">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-outlined text-[16px] text-amber-400" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                  <span className="text-xs font-bold text-amber-400 tracking-widest uppercase">推荐模型</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {featured.map(m => <ModelCard key={m.id} model={m} onDetail={() => setDetail(m)} />)}
                </div>
              </section>
            )}

            {/* 全部模型 */}
            {regular.length > 0 && (
              <section>
                {featured.length > 0 && (
                  <div className="models-muted text-xs font-bold tracking-widest uppercase mb-4">全部模型</div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {regular.map(m => <ModelCard key={m.id} model={m} onDetail={() => setDetail(m)} />)}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {/* 详情弹窗 */}
      {detail && <ModelDetail model={detail} onClose={() => setDetail(null)} />}
      <style>{`
        .models-page .models-header { background: var(--app-glass); border-color: var(--app-border); box-shadow: var(--app-shadow-soft); }
        .models-page .models-header > div:first-child > button:first-child { color: var(--app-primary); }
        .models-page .models-nav-button { color: var(--app-muted); }
        .models-page .models-nav-button:hover { background: var(--app-control-hover); color: var(--app-text); }
        .models-page .models-nav-button.is-active { background: var(--app-primary-soft); color: var(--app-primary); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--app-panel-raised) 18%, transparent); }
        .models-page .models-status-pill { color: var(--app-primary); background: var(--app-primary-soft); border: 1px solid color-mix(in srgb, var(--app-primary) 24%, var(--app-border)); }
        .models-page .models-icon-button, .models-page .models-muted { color: var(--app-muted); }
        .models-page .models-icon-button:hover { color: var(--app-text); background: var(--app-control-hover); }
        .models-page .models-kicker { color: var(--app-primary); }
        .models-page .models-filter-bar { padding: 12px; border: 1px solid var(--app-border); border-radius: 16px; background: var(--app-glass); box-shadow: var(--app-shadow-soft); backdrop-filter: blur(16px); }
        .models-page .models-search { color: var(--app-text); background: var(--app-control); border: 1px solid var(--app-border); }
        .models-page .models-search::placeholder { color: var(--app-text-subtle); }
        .models-page .models-category { color: var(--app-muted); border-color: var(--app-border); }
        .models-page .models-category:hover, .models-page .models-category.is-active { color: var(--app-primary); background: var(--app-primary-soft); border-color: color-mix(in srgb, var(--app-primary) 30%, var(--app-border)); }
        .models-page .models-secondary-button { color: var(--app-text); background: var(--app-control); border: 1px solid var(--app-border); }
        .models-page .models-card { background: var(--app-glass-strong); border: 1px solid var(--app-border); box-shadow: var(--app-shadow-soft); backdrop-filter: blur(14px); }
        .models-page .models-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--app-primary) 38%, var(--app-border)); box-shadow: var(--app-shadow-raised); }
        .models-page .models-card-cover { background: linear-gradient(130deg, var(--app-primary-soft), color-mix(in srgb, var(--app-panel-inset) 74%, transparent)); }
        .models-page .models-card-cover::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 52%, color-mix(in srgb, var(--app-panel) 62%, transparent)); pointer-events: none; }
        .models-page .models-card .text-white, .models-page .models-detail .text-white { color: var(--app-text) !important; }
        .models-page .models-card .text-slate-400, .models-page .models-detail .text-slate-400 { color: var(--app-muted) !important; }
        .models-page .models-card .text-slate-500, .models-page .models-detail .text-slate-500 { color: var(--app-text-subtle) !important; }
        .models-page .models-card .text-slate-600, .models-page .models-detail .text-slate-600 { color: var(--app-text-subtle) !important; }
        .models-page .models-detail { background: var(--app-glass-strong); border: 1px solid var(--app-border-strong); box-shadow: var(--app-shadow-raised); }
        .models-page .models-detail .bg-surface-container { background: var(--app-panel-soft); border-color: var(--app-border); }
      `}</style>
    </div>
  )
}

// ─── 模型卡片 ──────────────────────────────────────────────────────────────────
function ModelCard({ model, onDetail }: { model: AIModel; onDetail: () => void }) {
  const cat = CATEGORY_META[model.category] ?? CATEGORY_META.other
  const avgSec = model.avg_duration_ms > 0 ? `~${(model.avg_duration_ms / 1000).toFixed(0)}s` : null

  return (
    <div className="models-card group rounded-2xl overflow-hidden transition-all cursor-pointer"
      onClick={onDetail}>
      {/* 封面 */}
      <div className="models-card-cover h-36 relative overflow-hidden">
        {model.cover_url
          ? <img src={model.cover_url} alt={model.name} className="w-full h-full object-cover" />
          : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="material-symbols-outlined text-[52px] text-slate-700">
                {model.category === 'segmentation' ? 'layers' : model.category === 'inpainting' ? 'brush' : model.category === 'style' ? 'palette' : model.category === 'enhance' ? 'hd' : 'auto_awesome'}
              </span>
            </div>
          )
        }
        {model.is_featured && (
          <span className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 bg-amber-400/20 border border-amber-400/30 rounded-md text-[10px] font-bold text-amber-400">
            <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>推荐
          </span>
        )}
      </div>

      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold border mb-1.5 ${cat.bg} ${cat.color}`}>
              {cat.label}
            </span>
            <h3 className="text-sm font-semibold text-white leading-tight">{model.name}</h3>
            {model.provider && <p className="text-xs text-slate-500 mt-0.5">{model.provider}</p>}
          </div>
          <PriceTag model={model} />
        </div>

        <p className="text-xs text-slate-500 leading-relaxed mb-3 line-clamp-2">{model.description}</p>

        {model.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {model.tags.slice(0, 4).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-slate-500">{tag}</span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-slate-600">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">bolt</span>
            {model.total_calls.toLocaleString()} 次调用
          </span>
          {avgSec && <span>{avgSec}/次</span>}
        </div>
      </div>
    </div>
  )
}

// ─── 定价标签 ──────────────────────────────────────────────────────────────────
function PriceTag({ model }: { model: AIModel }) {
  if (isExternalApiKeyModel(model)) {
    return <span className="shrink-0 px-2 py-0.5 bg-cyan-400/10 border border-cyan-400/20 rounded-md text-[10px] font-bold text-cyan-300">FoxAPI密钥</span>
  }
  if (model.price_type === 'free') {
    return <span className="shrink-0 px-2 py-0.5 bg-emerald-400/10 border border-emerald-400/20 rounded-md text-[10px] font-bold text-emerald-400">免费</span>
  }
  return <span className="shrink-0 px-2 py-0.5 bg-amber-400/10 border border-amber-400/20 rounded-md text-[10px] font-bold text-amber-400">{model.price_credits} 积分</span>
}

// ─── 详情弹窗 ──────────────────────────────────────────────────────────────────
function ModelDetail({ model, onClose }: { model: AIModel; onClose: () => void }) {
  const cat = CATEGORY_META[model.category] ?? CATEGORY_META.other
  const avgSec = model.avg_duration_ms > 0 ? (model.avg_duration_ms / 1000).toFixed(1) : '—'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}>
      <div className="models-detail w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}>

        {/* 封面 */}
        <div className="models-card-cover h-44 relative">
          {model.cover_url
            ? <img src={model.cover_url} alt={model.name} className="w-full h-full object-cover" />
            : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="material-symbols-outlined text-[72px] text-slate-700">
                  {model.category === 'segmentation' ? 'layers' : model.category === 'inpainting' ? 'brush' : 'auto_awesome'}
                </span>
              </div>
            )
          }
          <button onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold border mb-2 ${cat.bg} ${cat.color}`}>
                {cat.label}
              </span>
              <h2 className="text-xl font-bold text-white">{model.name}</h2>
              {model.provider && <p className="text-sm text-slate-400 mt-0.5">by {model.provider}</p>}
            </div>
            <PriceTag model={model} />
          </div>

          {/* 标签 */}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {model.tags.map(tag => (
                <span key={tag} className="px-2 py-0.5 bg-white/5 border border-white/8 rounded-lg text-xs text-slate-400">{tag}</span>
              ))}
            </div>
          )}

          <p className="text-sm text-slate-400 leading-relaxed mb-5">{model.description}</p>

          {/* 统计 */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: '累计调用', value: model.total_calls.toLocaleString() },
              { label: '平均耗时', value: `${avgSec}s` },
              { label: isExternalApiKeyModel(model) ? '调用方式' : '定价', value: formatModelPrice(model, 'zh') },
            ].map(s => (
              <div key={s.label} className="bg-surface-container border border-white/5 rounded-xl p-3 text-center">
                <div className="text-base font-bold text-white">{s.value}</div>
                <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-600 text-center">
            {isExternalApiKeyModel(model)
              ? '调用时使用当前账户的 FoxAPI Key，平台不扣积分'
              : '在编辑器中选中图层后可直接调用此模型'}
          </p>
        </div>
      </div>
    </div>
  )
}
