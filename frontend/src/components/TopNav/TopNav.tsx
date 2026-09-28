/**
 * TopNav — 直接从 blackdesign/code.html 的 <header> 移植
 * 原始结构：Logo + EDITOR/SOLO 切换 + 右侧操作按钮
 */
import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEditorStore, type EditorMode } from '../../lib/editor-store'
import { useThemeStore } from '../../lib/theme'
import { usePetStore } from '../../lib/pet-store'
import { useNotificationStore } from '../../lib/notification-store'
import { isElectron } from '../../lib/electron'
import { auth } from '../../lib/auth'
import { formatCredits } from '../../lib/credits'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../../lib/credit-balance-store'
import { ensureDesktopUpdateEvents, useDesktopUpdateStore } from '../../lib/desktop-update-store'
import { BrandWordmark } from '../ui/BrandWordmark'

const LOW_CREDITS_THRESHOLD = 10
const REFRESH_INTERVAL_MS = 300_000  // 5 分钟兜底轮询（SSE 实时推送为主）

export function TopNav() {
  const navigate = useNavigate()
  const { mode, setMode } = useEditorStore()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const { visible: petVisible, closing: petClosing, toggleVisible: togglePet, setClosing: setPetClosing } = usePetStore()
  const { notifications, unreadCount, markRead, markAllRead, dismiss } = useNotificationStore()
  const credits = useCreditBalanceStore(state => state.balance)
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const updateState = useDesktopUpdateStore(state => state.state)
  const updateMinimized = useDesktopUpdateStore(state => state.minimized)
  const openUpdateDialog = useDesktopUpdateStore(state => state.openDialog)
  const checkDesktopUpdate = useDesktopUpdateStore(state => state.checkNow)
  const updateVersion = updateState.version || ''
  const updateProgress = Math.round(Number(updateState.progress?.percent || 0))
  const updateReady = updateState.status === 'ready'
  const updateManual = updateState.status === 'manual-download'
  const updateDownloading = updateState.status === 'downloading' || updateState.status === 'available'
  const updateChecking = updateState.status === 'checking'
  const menuRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)
  const user = auth.getUser()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const externalComputeLabel = 'FoxAPI 已连接'

  useEffect(() => {
    if (isExternalComputeUser) return
    ensureCreditBalanceEvents()
    void refreshCredits()
    const t = setInterval(() => void refreshCredits(), REFRESH_INTERVAL_MS)
    return () => clearInterval(t)
  }, [isExternalComputeUser, refreshCredits])

  // 获取应用版本号（仅桌面端）
  useEffect(() => {
    if (isElectron()) {
      window.electronAPI?.getVersion?.().then(v => setAppVersion(v || '')).catch(() => {})
    }
  }, [])

  // 自动更新事件监听（仅桌面端）
  useEffect(() => {
    if (!isElectron()) return
    ensureDesktopUpdateEvents()
  }, [])  // 只挂载一次，事件回调通过闭包访问最新状态

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const notifIcon = (type: string) => {
    switch (type) {
      case 'payment_success': return 'add_circle'
      case 'task_complete': return 'check_circle'
      case 'low_balance': return 'warning'
      case 'error': return 'error'
      default: return 'info'
    }
  }

  const notifColor = (type: string) => {
    switch (type) {
      case 'payment_success': return '#34d399'
      case 'task_complete': return '#60a5fa'
      case 'low_balance': return '#fbbf24'
      case 'error': return '#f87171'
      default: return '#94a3b8'
    }
  }

  const isLowCredits = credits !== null && credits < LOW_CREDITS_THRESHOLD
  const initials = user?.displayName?.slice(0, 1).toUpperCase() ?? user?.email?.slice(0, 1).toUpperCase() ?? '?'

  return (
    <>
    {/* 直接复制设计稿 header 的 class */}
    <header className="fixed inset-x-0 top-0 flex justify-between items-center w-full px-4 h-12 z-50 bg-zinc-950 border-b-2 border-zinc-800">

      {/* 左侧：Logo + EDITOR/SOLO 切换 */}
      <div className="flex items-center gap-4">
        <BrandWordmark style={{ color: 'var(--app-primary)' }} />
        {/* 版本号（仅桌面端） */}
        {isElectron() && appVersion && (
          <span className="text-[10px] font-mono text-zinc-500 select-none">
            v{appVersion}
          </span>
        )}

        {/* 自动更新指示器（仅桌面端，放左上角） */}
        {isElectron() && (
          <button
            onClick={() => {
              if (updateReady || updateManual) {
                openUpdateDialog()
              } else if (!updateDownloading && !updateChecking) {
                void checkDesktopUpdate()
              }
            }}
            disabled={(updateDownloading || updateChecking) && !updateReady && !updateManual}
            className={`p-1 rounded-lg transition-colors relative ${
              (updateDownloading || updateChecking) && !updateReady && !updateManual
                ? 'text-zinc-600 cursor-default'
                : updateReady || updateManual
                  ? 'text-orange-400 hover:bg-orange-400/10 cursor-pointer'
                  : 'text-zinc-500 hover:bg-zinc-800 hover:text-orange-400 cursor-pointer'
            }`}
            title={
              updateManual
                ? `版本 ${updateVersion || appVersion} 安装包可下载`
                : updateReady
                  ? (updateMinimized ? '新版本已准备好，点击查看更新说明' : `新版本 ${updateVersion} 已准备好，点击查看更新说明`)
                  : updateDownloading
                    ? `正在准备新版本 ${updateProgress}%`
                    : updateChecking
                      ? '正在检查更新'
                      : '检查更新'
            }
          >
            <span className="material-symbols-outlined text-[18px]">
              {updateDownloading && !updateReady && !updateManual ? 'downloading' : updateChecking ? 'hourglass_top' : 'download'}
            </span>
            {(updateVersion || updateManual) && !updateChecking && (!updateDownloading || updateReady || updateManual) && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
            )}
            {updateDownloading && !updateReady && !updateManual && (
              <span
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[2px] bg-orange-500 rounded-full transition-all duration-300"
                style={{ width: `${Math.max(4, updateProgress * 0.14)}px` }}
              />
            )}
          </button>
        )}

        {/* EDITOR / SOLO 模式切换（设计稿原版 pill 样式） */}
        <div className="flex items-center bg-surface-container-highest p-1 rounded-full border-2 border-outline-variant ml-4">
          <button
            onClick={() => setMode('TEXT_TO_IMAGE')}
            className={[
              'px-4 py-1 font-[\'Space_Grotesk\'] text-[11px] uppercase font-black rounded-full transition-all active:translate-y-[1px]',
              mode === 'TEXT_TO_IMAGE'
                ? 'bg-primary text-on-primary shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]'
                : 'text-on-surface-variant hover:text-on-surface',
            ].join(' ')}
          >
            文生图
          </button>
          <button
            onClick={() => setMode('IMAGE_EDIT')}
            className={[
              'px-4 py-1 font-[\'Space_Grotesk\'] text-[11px] uppercase font-black rounded-full transition-all active:translate-y-[1px]',
              mode === 'IMAGE_EDIT'
                ? 'bg-primary text-on-primary shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]'
                : 'text-on-surface-variant hover:text-on-surface',
            ].join(' ')}
          >
            图片编辑
          </button>
        </div>
      </div>

      {/* 右侧：积分 + 主题切换 + 用户 */}
      <div className="flex items-center gap-2" ref={menuRef}>

        {/* 积分余额 */}
        {isExternalComputeUser ? (
          <div
            data-compute-source-status
            className="flex items-center gap-1.5 rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-control)] px-2.5 py-1 text-[11px] font-bold text-[var(--app-text)] shadow-[var(--app-shadow-soft)]"
            title={externalComputeLabel}
          >
            <span className="material-symbols-outlined text-[14px] text-[var(--app-primary)]">cloud_done</span>
            <span>{externalComputeLabel}</span>
          </div>
        ) : credits !== null && (
          <button
            onClick={() => navigate('/recharge')}
            className={[
              'flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold font-[\'Space_Grotesk\'] rounded-lg transition-all hover:opacity-80 cursor-pointer',
              isLowCredits ? 'text-red-400 bg-red-400/10' : 'text-secondary bg-secondary/10',
            ].join(' ')}
            title="打开算力与计费中心"
          >
            {isLowCredits && (
              <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
            )}
            <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>toll</span>
            <span>{formatCredits(credits)}</span>
            <span className="h-3 w-px bg-current opacity-30" />
            <span>会员中心</span>
          </button>
        )}

        {/* 主题切换 */}
        <button
          onClick={toggleTheme}
          className="p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-cyan-300 transition-colors"
          title={theme === 'dark' ? '切换亮色' : '切换暗色'}
        >
          <span className="material-symbols-outlined text-[20px]">
            {theme === 'dark' ? 'light_mode' : 'dark_mode'}
          </span>
        </button>

        {/* 桌宠开关 */}
        {isElectron() && (
          <button
            onClick={() => {
              if (petClosing) return
              const next = !petVisible
              togglePet()
              if (!next) setPetClosing(true)
              window.electronAPI?.petToggle({ visible: next })
            }}
            className={`p-1.5 transition-colors hover:bg-[var(--app-control-hover)] ${
              petVisible
                ? 'text-[var(--app-primary)]'
                : 'text-[var(--app-muted)] hover:text-[var(--app-primary)]'
            }`}
            title={petVisible ? '隐藏桌宠' : '显示桌宠'}
          >
            <span className="material-symbols-outlined text-[20px]">pets</span>
          </button>
        )}

        {/* 通知铃铛 */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => { setNotifOpen(v => !v); setMenuOpen(false) }}
            className="p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-cyan-300 transition-colors relative"
            title="通知"
          >
            <span className="material-symbols-outlined text-[20px]">notifications</span>
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {/* 通知面板 */}
          {notifOpen && (
            <div className="absolute right-0 top-12 w-80 max-h-96 bg-zinc-900 border border-zinc-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.8)] z-50 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
                <span className="text-[12px] font-bold text-zinc-100">通知</span>
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300"
                  >
                    全部已读
                  </button>
                )}
              </div>
              <div className="overflow-y-auto max-h-80">
                {notifications.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-zinc-500">
                    暂无通知
                  </div>
                ) : (
                  notifications.map(n => (
                    <div
                      key={n.id}
                      className={`flex items-start gap-2 px-3 py-2.5 border-b border-zinc-800 transition-colors ${
                        !n.read ? 'bg-zinc-800/50' : ''
                      }`}
                      onClick={() => markRead(n.id)}
                    >
                      <span
                        className="material-symbols-outlined text-[16px] mt-0.5 shrink-0"
                        style={{ color: notifColor(n.type), fontVariationSettings: "'FILL' 1" }}
                      >
                        {notifIcon(n.type)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[12px] font-medium text-zinc-100 truncate">{n.title}</span>
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />}
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{n.message}</p>
                        <span className="text-[10px] text-zinc-600 mt-1 block">
                          {new Date(n.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); dismiss(n.id) }}
                        className="p-0.5 text-zinc-600 hover:text-zinc-400 shrink-0"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* 用户按钮 */}
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-cyan-300 transition-colors relative"
        >
          <span className="material-symbols-outlined text-[20px]">account_circle</span>
        </button>

        {/* 下拉菜单 */}
        {menuOpen && (
          <div className="absolute right-4 top-12 w-44 bg-zinc-900 border border-zinc-700 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.8)] z-50">
            <div className="px-3 py-2 border-b border-zinc-700">
              <p className="text-[11px] font-bold text-zinc-100 truncate">{user?.displayName ?? '用户'}</p>
              <p className="text-[10px] text-zinc-500 truncate">{user?.email}</p>
            </div>
            <button
              onClick={() => { setMenuOpen(false); navigate('/profile') }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-300 hover:bg-zinc-800 hover:text-cyan-300 transition-colors text-left"
            >
              <span className="material-symbols-outlined text-[14px]">account_circle</span>
              账户信息
            </button>
            {!isExternalComputeUser && (
            <button
              onClick={() => { setMenuOpen(false); navigate('/recharge') }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-300 hover:bg-zinc-800 hover:text-cyan-300 transition-colors text-left"
            >
              <span className="material-symbols-outlined text-[14px]">workspace_premium</span>
              算力与计费
            </button>
            )}
            <div className="border-t border-zinc-700">
              <button
                onClick={() => { auth.clear({ intentional: true }); navigate('/login') }}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="material-symbols-outlined text-[14px]">logout</span>
                退出登录
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
    </>
  )
}
