import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useThemeStore } from '../lib/theme'
import { apiUrl } from '../lib/auth'
import { PET_CATALOG } from '../lib/pet-catalog'
import PetSprite from '../components/PetSprite/PetSprite'
import { InteractiveDotField } from '../components/ui/InteractiveDotField'
import { BrandWordmark } from '../components/ui/BrandWordmark'
import { FloatingTopBar, TopBarPinButton } from '../components/TopNav/FloatingTopBar'
import './download-page.css'

interface DownloadConfig {
  windows_url: string
  mac_url: string
  version: string
  changelog: string
}

type DesktopSection = 'overview' | 'workspace' | 'plugins' | 'recent'

const PET_IDS = ['snow-shadow-doll', 'nezuko', 'luffy', 'chiikawa', 'pixel-panda']

const DEFAULT_CHANGELOG_ITEMS = [
  '首页和登录页升级为新的品牌展示入口，创作功能、作品展示和登录区更清晰。',
  '桌面端更新安装改为静默执行，下载完成后重启即可自动完成更新。',
  '优化更新弹窗和更新说明展示，减少安装过程中的打扰。',
  '优化首页导航、品牌图标和下载页布局，整体视觉更贴近平台风格。',
  '系统设置类开关保存更稳定，刷新后状态展示更一致。',
]

const SECTION_CONTENT: Record<DesktopSection, {
  title: string
  summary: string
  highlights: Array<{ icon: string; title: string; body: string }>
}> = {
  overview: {
    title: '为什么推荐桌面端',
    summary: '桌面端更适合长时间创作、连续导出、多任务并行和本地协作。',
    highlights: [
      { icon: 'auto_awesome', title: '生成链路更完整', body: '文生图、科研生图、海报和 PPT 可以在同一工作区里持续接力，不需要来回切换页面。' },
      { icon: 'schedule', title: '长任务更稳', body: '更适合挂着长时间生成、反复预览、导出和继续编辑。' },
      { icon: 'download', title: '下载体验更顺手', body: '生成完成后直接导出、保存到本地项目，后续继续整理不会断。' },
    ],
  },
  workspace: {
    title: '桌面端新增了什么',
    summary: '重点不是“能打开”，而是把创作工作区做完整。',
    highlights: [
      { icon: 'folder_open', title: '本地项目管理', body: '项目、任务、导出文件和历史结果都能稳定留在本地，适合反复回看和迭代。' },
      { icon: 'view_sidebar', title: '多栏协作布局', body: '适合边看历史、边调参数、边预览结果，复杂任务比移动端更从容。' },
      { icon: 'history', title: '任务承接更连续', body: '从生成、编辑到下载可以在同一台设备上接续完成，不容易丢上下文。' },
    ],
  },
  plugins: {
    title: '为什么要下载桌面端',
    summary: '如果你会频繁导出、要连 PS 插件、要保留本地资产，桌面端价值会很明显。',
    highlights: [
      { icon: 'extension', title: '插件与外部编辑器', body: '更方便和 Photoshop、Illustrator 之类的桌面工具联动，少一次上传下载。' },
      { icon: 'save', title: '本地保存更自然', body: '图片、PPT、科研图和海报结果都能顺手收进本地目录，后续继续整理更轻松。' },
      { icon: 'pets', title: '桌宠与导览体验完整', body: '导览、桌宠和桌面侧的陪伴式工作流在桌面端更完整，适合长期使用。' },
    ],
  },
  recent: {
    title: '当前版本看点',
    summary: '这里会展示当前版本号和最近更新重点，方便你决定是否现在安装。',
    highlights: [
      { icon: 'new_releases', title: '版本信息', body: '当前下载包会直接显示版本号，方便你和网页版、历史包对照。' },
      { icon: 'sync', title: '更新节奏清晰', body: '后续新增桌面能力、生成链路优化和导出体验更新，都会集中列在这里。' },
      { icon: 'tips_and_updates', title: '安装前能先看重点', body: '不用下载完才知道改了什么，先看亮点，再决定安装或更新。' },
    ],
  },
}

const SECTION_ORDER: DesktopSection[] = ['overview', 'workspace', 'plugins', 'recent']

export default function DownloadPage() {
  const navigate = useNavigate()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [config, setConfig] = useState<DownloadConfig | null>(null)
  const [activeSection, setActiveSection] = useState<DesktopSection>('overview')

  useEffect(() => {
    fetch(apiUrl('/api/system/download-config'))
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setConfig(data) })
      .catch(() => {})
  }, [])

  const ui = useMemo(() => {
    const accent = 'var(--app-primary)'
    const bg = 'var(--app-workspace)'
    const accentWithOpacity = (opacity: number) =>
      `color-mix(in srgb, var(--app-primary) ${opacity * 100}%, transparent)`
    return {
      accent,
      heroGlow: accentWithOpacity(0.12),
      badgeBg: accentWithOpacity(0x18 / 0xff),
      noticeBg: accentWithOpacity(0x12 / 0xff),
      activeBg: accentWithOpacity(0x14 / 0xff),
      noticeBorder: accentWithOpacity(0x44 / 0xff),
      activeBorder: accentWithOpacity(0x55 / 0xff),
      accentGradient: 'var(--app-primary-gradient)',
      onAccent: 'var(--app-on-primary)',
      bgGradient: `radial-gradient(circle at top left, ${accentWithOpacity(isDark ? 0.1 : 0.14)}, transparent 34%), linear-gradient(180deg, ${bg} 0%, var(--app-bg) 100%)`,
      panel: 'var(--app-glass)',
      card: 'var(--app-glass-strong)',
      border: 'var(--app-border)',
      text: 'var(--app-text)',
      muted: 'var(--app-muted)',
      shadow: 'var(--app-shadow-raised)',
    }
  }, [isDark])

  const pets = PET_IDS
    .map(id => PET_CATALOG.find(pet => pet.id === id))
    .filter(Boolean)

  const changelogItems = ((config?.changelog || '').trim()
    ? (config?.changelog || '')
    : DEFAULT_CHANGELOG_ITEMS.join('\n'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 6)

  const activeContent = SECTION_CONTENT[activeSection]

  return (
    <div
      className="download-page app-topbar-page relative isolate min-h-screen overflow-hidden"
      style={{ background: ui.bgGradient, color: ui.text, '--app-topbar-height': '64px' } as CSSProperties}
    >
      <InteractiveDotField tone={isDark ? 'neutral' : 'warm'} />
      <FloatingTopBar height={64} className="download-page__topbar border-b backdrop-blur-xl" style={{ background: ui.panel, borderColor: ui.border }}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: ui.muted }}>
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            返回
          </button>
          <div className="flex items-center gap-3">
            <img src="/linggan-mark.svg?v=20260811-centered" alt="" aria-hidden="true" className="h-8 w-8 object-contain" />
            <div>
              <BrandWordmark className="brand-wordmark--compact" />
              <div className="text-[11px]" style={{ color: ui.muted }}>Desktop</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-medium" style={{ color: ui.muted }}>
              {config?.version ? `v${config.version}` : '桌面客户端下载'}
            </div>
            <TopBarPinButton />
          </div>
        </div>
      </FloatingTopBar>

      <main
        className="relative z-10 mx-auto max-w-6xl px-5 pb-10"
        style={{ paddingTop: 'calc(var(--app-topbar-reserved-height) + 2.5rem)' }}
      >
        <section
          data-tour-id="download-platforms"
          className="download-page__hero relative overflow-hidden rounded-[28px] border"
          style={{ background: ui.panel, borderColor: ui.border, boxShadow: ui.shadow }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: `radial-gradient(circle at 18% 16%, ${ui.heroGlow}, transparent 34%)` }}
          />
          <div className="relative grid gap-8 p-8 lg:grid-cols-[1.15fr_0.85fr] lg:p-10">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[12px] font-semibold" style={{ background: ui.badgeBg, color: ui.accent }}>
                <span className="material-symbols-outlined text-[14px]">desktop_windows</span>
                {config?.version ? `桌面端 v${config.version}` : '桌面客户端下载'}
              </div>

              <div className="space-y-4">
                <h1 className="text-[34px] font-black leading-tight" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  把创作流程留在一台设备上
                </h1>
                <p className="max-w-2xl text-[15px] leading-7" style={{ color: ui.muted }}>
                  如果你平时会连续做文生图、科研生图、海报和 PPT，桌面端会明显更顺手。
                  它不是单纯的下载入口，而是把项目、历史、预览、导出和外部工具联动都放在一个稳定工作区里。
                </p>
              </div>

              <div
                className="rounded-2xl px-4 py-3 text-[13px] leading-6"
                style={{ background: ui.noticeBg, border: `1px solid ${ui.noticeBorder}`, color: ui.text }}
              >
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined mt-0.5 text-[18px]" style={{ color: ui.accent }}>cloud_off</span>
                  <div>
                    <div className="font-bold">桌面端记录、预览和原图全部保存在本地，不占用云端空间</div>
                    <div className="mt-1" style={{ color: ui.muted }}>
                      网页端云端历史会按策略定期清理；长期项目、超大图片和 PPT 素材建议使用桌面端保存到本机。
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {config?.windows_url ? (
                  <a
                    href={config.windows_url}
                    className="inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition-all hover:-translate-y-0.5"
                    style={{ background: ui.accentGradient, color: ui.onAccent, boxShadow: `0 14px 30px ${isDark ? 'rgba(212, 212, 216,0.16)' : 'rgba(251,146,60,0.24)'}` }}
                  >
                    <span className="material-symbols-outlined text-[18px]">download</span>
                    下载 Windows 版
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold" style={{ background: ui.card, color: ui.muted, border: `1px dashed ${ui.border}` }}>
                    <span className="material-symbols-outlined text-[18px]">schedule</span>
                    Windows 安装包暂未上线
                  </span>
                )}

                {config?.mac_url ? (
                  <a
                    href={config.mac_url}
                    className="inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition-all hover:-translate-y-0.5"
                    style={{ background: ui.card, color: ui.text, border: `1px solid ${ui.border}` }}
                  >
                    <span className="material-symbols-outlined text-[18px]">laptop_mac</span>
                    下载 macOS 版
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold" style={{ background: ui.card, color: ui.muted, border: `1px dashed ${ui.border}` }}>
                    <span className="material-symbols-outlined text-[18px]">schedule</span>
                    macOS 安装包暂未上线
                  </span>
                )}
              </div>

              <div data-tour-id="download-capabilities" className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl p-4" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                  <span className="material-symbols-outlined text-[20px]" style={{ color: ui.accent }}>space_dashboard</span>
                  <div className="mt-3 text-[13px] font-semibold">更完整的工作区</div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: ui.muted }}>适合同时打开历史、参数、预览和导出操作。</div>
                </div>
                <div className="rounded-2xl p-4" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                  <span className="material-symbols-outlined text-[20px]" style={{ color: ui.accent }}>folder_special</span>
                  <div className="mt-3 text-[13px] font-semibold">本地资产更稳</div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: ui.muted }}>更适合长期项目、连续导出和本地归档。</div>
                </div>
                <div className="rounded-2xl p-4" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                  <span className="material-symbols-outlined text-[20px]" style={{ color: ui.accent }}>extension</span>
                  <div className="mt-3 text-[13px] font-semibold">插件和外部联动</div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: ui.muted }}>更方便接 Photoshop 插件和桌面工具链。</div>
                </div>
              </div>
            </div>

            <div className="grid content-start gap-4">
              <div data-tour-id="download-updates" className="rounded-[24px] p-5" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-semibold">桌面端角色</div>
                    <div className="mt-1 text-[11px]" style={{ color: ui.muted }}>
                      适合长期创作的完整工作环境
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-[18px]" style={{ color: ui.accent }}>widgets</span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {pets.slice(0, 4).map((pet, index) => (
                    pet ? (
                      <div key={pet.id} className="rounded-2xl p-3 text-center" style={{ background: `var(--app-panel-soft, ${isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.72)'})` }}>
                        <div className="mx-auto flex h-16 w-16 items-center justify-center">
                          <PetSprite src={pet.spritesheetUrl} state={index % 2 === 0 ? 'idle' : 'waving'} scale={0.28} animate />
                        </div>
                        <div className="mt-2 text-[11px]" style={{ color: ui.muted }}>{pet.name}</div>
                      </div>
                    ) : null
                  ))}
                </div>
              </div>

              <div className="rounded-[24px] p-5" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-semibold">最近更新</div>
                    <div className="mt-1 text-[11px]" style={{ color: ui.muted }}>
                      {config?.version ? `当前版本 ${config.version}` : '等待发布配置'}
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-[18px]" style={{ color: ui.accent }}>new_releases</span>
                </div>
                <div className="mt-4 space-y-2">
                  {changelogItems.map(item => (
                    <div key={item} className="flex items-start gap-2 text-[12px]" style={{ color: ui.muted }}>
                      <span style={{ color: ui.accent }}>•</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section data-tour-id="download-installation" className="download-page__guide mt-8 grid gap-6 lg:grid-cols-[240px_1fr]">
          <div className="rounded-[24px] p-3" style={{ background: ui.panel, border: `1px solid ${ui.border}` }}>
            <div className="px-3 py-2 text-[12px] font-bold" style={{ color: ui.muted }}>
              桌面端导览
            </div>
            <div className="mt-1 space-y-1">
              {SECTION_ORDER.map(section => {
                const item = SECTION_CONTENT[section]
                const active = activeSection === section
                return (
                  <button
                    key={section}
                    data-tour-id={section === 'plugins' ? 'download-photoshop' : undefined}
                    type="button"
                    onClick={() => setActiveSection(section)}
                    className="w-full rounded-2xl px-4 py-3 text-left transition-all"
                    style={{
                      background: active ? ui.activeBg : 'transparent',
                      border: `1px solid ${active ? ui.activeBorder : 'transparent'}`,
                      color: active ? ui.text : ui.muted,
                    }}
                  >
                    <div className="text-[13px] font-semibold">{item.title}</div>
                    <div className="mt-1 text-[11px] leading-5">{item.summary}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="rounded-[24px] p-6" style={{ background: ui.panel, border: `1px solid ${ui.border}` }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[22px] font-black" style={{ fontFamily: 'Manrope, sans-serif' }}>{activeContent.title}</div>
                <p className="mt-2 max-w-2xl text-[14px] leading-7" style={{ color: ui.muted }}>
                  {activeContent.summary}
                </p>
              </div>
              <div className="hidden rounded-2xl px-3 py-2 text-[11px] font-semibold md:block" style={{ background: ui.noticeBg, color: ui.accent }}>
                第 {SECTION_ORDER.indexOf(activeSection) + 1} 页
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {activeContent.highlights.map(item => (
                <div key={item.title} className="rounded-2xl p-4" style={{ background: ui.card, border: `1px solid ${ui.border}` }}>
                  <span className="material-symbols-outlined text-[20px]" style={{ color: ui.accent }}>{item.icon}</span>
                  <div className="mt-3 text-[14px] font-semibold">{item.title}</div>
                  <div className="mt-2 text-[12px] leading-6" style={{ color: ui.muted }}>{item.body}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {SECTION_ORDER.map(section => (
                <button
                  key={section}
                  type="button"
                  onClick={() => setActiveSection(section)}
                  className="h-8 rounded-xl px-3 text-[11px] font-semibold transition-all"
                  style={{
                    background: activeSection === section ? ui.accent : 'transparent',
                    color: activeSection === section ? ui.onAccent : ui.muted,
                    border: `1px solid ${activeSection === section ? ui.accent : ui.border}`,
                  }}
                >
                  {SECTION_CONTENT[section].title}
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
