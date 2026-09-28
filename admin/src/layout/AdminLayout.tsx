import { useEffect, useState } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import AdminIcon from '../components/AdminIcon'

const NAV_GROUPS = [
  {
    label: '运营总览',
    items: [
      { to: '/dashboard', icon: 'dashboard', label: '总览' },
      { to: '/usage', icon: 'bar_chart', label: '用量统计' },
      { to: '/users', icon: 'api', label: '用户与调用来源' },
    ],
  },
  {
    label: '计费与资源',
    items: [
      { to: '/finance', icon: 'account_balance', label: '财务统计' },
      { to: '/payments', icon: 'payments', label: '支付管理' },
      { to: '/subscriptions', icon: 'star', label: '订阅管理' },
      { to: '/credits', icon: 'toll', label: '积分管理' },
      { to: '/models', icon: 'model_training', label: '模型配置' },
      { to: '/storage', icon: 'database', label: '存储监管' },
    ],
  },
  {
    label: '内容与系统',
    items: [
      { to: '/gallery-review', icon: 'image', label: '广场管理' },
      { to: '/creative-styles', icon: 'auto_awesome', label: '风格配方' },
      { to: '/announcements', icon: 'campaign', label: '公告通知' },
      { to: '/settings', icon: 'settings', label: '系统设置' },
      { to: '/pet', icon: 'pets', label: '桌宠配置' },
      { to: '/download', icon: 'download', label: '客户端下载' },
    ],
  },
]

const MOBILE_PRIMARY_PATHS = new Set(['/dashboard', '/users', '/usage'])

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)

  useEffect(() => {
    setMobileNavOpen(false)
    setMobileMoreOpen(false)
  }, [location.pathname])

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-bg">

      {/* ── 侧边栏 ── */}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[min(86vw,20rem)] -translate-x-full flex-col border-r border-border bg-surface shadow-2xl transition-transform duration-200 lg:relative lg:inset-auto lg:w-64 lg:translate-x-0 lg:shadow-none ${mobileNavOpen ? 'translate-x-0' : ''}`}>
        {/* Logo */}
        <div className="flex h-[4.5rem] items-center gap-3 border-b border-border px-4 sm:px-6 lg:py-5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-cyan-400 flex items-center justify-center shrink-0">
            <AdminIcon name="layers" className="text-white text-[20px]" />
          </div>
          <div>
            <div className="text-base font-bold text-on-surface font-display">像素印记</div>
            <div className="text-xs text-muted mt-0.5">管理后台</div>
          </div>
        </div>

        {/* 导航 */}
        <nav className="min-h-0 flex-1 overflow-y-auto p-3 lg:p-4">
          <div className="mb-5 lg:hidden">
            <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted/70">监管中心</div>
            <div className="flex flex-col gap-1">
              {NAV_GROUPS.flatMap(group => group.items).filter(item => MOBILE_PRIMARY_PATHS.has(item.to)).map(({ to, icon, label }) => (
                <NavLink key={to} to={to} onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${isActive ? 'border border-primary/20 bg-primary/15 text-primary' : 'text-muted hover:bg-white/5 hover:text-on-surface'}`}>
                  <AdminIcon name={icon} className="text-[19px]" />
                  <span className="truncate">{label}</span>
                </NavLink>
              ))}
            </div>
            <button type="button" onClick={() => setMobileMoreOpen(open => !open)} aria-expanded={mobileMoreOpen}
              className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-white/5 hover:text-on-surface">
              <AdminIcon name="tune" className="text-[19px]" />
              <span className="flex-1 text-left">更多配置</span>
              <AdminIcon name={mobileMoreOpen ? 'expand_less' : 'expand_more'} className="text-[19px]" />
            </button>
            {mobileMoreOpen && (
              <div className="mt-1 border-l border-border pl-2">
                {NAV_GROUPS.flatMap(group => group.items).filter(item => !MOBILE_PRIMARY_PATHS.has(item.to)).map(({ to, icon, label }) => (
                  <NavLink key={to} to={to} onClick={() => setMobileNavOpen(false)}
                    className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${isActive ? 'border border-primary/20 bg-primary/15 text-primary' : 'text-muted hover:bg-white/5 hover:text-on-surface'}`}>
                    <AdminIcon name={icon} className="text-[18px]" />
                    <span className="truncate">{label}</span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="mb-5 hidden last:mb-0 lg:block">
              <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted/70">{group.label}</div>
              <div className="flex flex-col gap-1">
                {group.items.map(({ to, icon, label }) => (
                  <NavLink key={to} to={to} onClick={() => setMobileNavOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all lg:px-4 lg:py-3 ${
                        isActive
                          ? 'border border-primary/20 bg-primary/15 text-primary'
                          : 'text-muted hover:bg-white/5 hover:text-on-surface'
                      }`
                    }>
                    <AdminIcon name={icon} className="text-[19px]" />
                    <span className="truncate">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* 底部用户信息 */}
        <div className="hidden p-4 border-t border-border lg:block">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 cursor-pointer transition-colors"
            onClick={() => navigate('/login')}>
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500/30 to-cyan-400/30 border border-white/10 flex items-center justify-center shrink-0">
              <AdminIcon name="admin_panel_settings" className="text-[18px] text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-on-surface font-medium">Admin</div>
              <div className="text-xs text-muted mt-0.5">超级管理员</div>
            </div>
            <AdminIcon name="logout" className="text-[18px] text-muted" />
          </div>
        </div>
      </aside>
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭导航菜单"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      {/* ── 主内容区 ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶栏 */}
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6 lg:h-16 lg:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" aria-label="打开导航菜单" onClick={() => setMobileNavOpen(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/5 hover:text-on-surface lg:hidden">
              <AdminIcon name="menu" className="text-[20px]" />
            </button>
            <div className="min-w-0 truncate text-lg font-semibold text-on-surface font-display lg:text-xl" id="page-title" />
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-border bg-surface-high px-4 py-2 text-sm text-muted sm:flex">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              后端在线
            </div>
            <button aria-label="查看通知" className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-on-surface">
              <AdminIcon name="notifications" className="text-[22px]" />
            </button>
          </div>
        </header>

        {/* 页面内容 */}
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
