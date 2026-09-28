import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../../lib/auth'
import { formatCredits } from '../../lib/credits'
import { useThemeStore } from '../../lib/theme'
import { usePetStore } from '../../lib/pet-store'
import { getPetById } from '../../lib/pet-catalog'
import { isElectron } from '../../lib/electron'
import { ensureCreditBalanceEvents, useCreditBalanceStore } from '../../lib/credit-balance-store'

const LOW_CREDITS_THRESHOLD = 10
const REFRESH_INTERVAL_MS = 60_000

export function UserCenter() {
  const navigate = useNavigate()
  const { theme, toggle: toggleTheme } = useThemeStore()
  const credits = useCreditBalanceStore(state => state.balance)
  const refreshCredits = useCreditBalanceStore(state => state.refresh)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const user = auth.getUser()
  const isExternalComputeUser = auth.isExternalComputeUser(user)
  const externalComputeLabel = 'FoxAPI密钥'
  const { selectedPetId } = usePetStore()

  // 初始加载 + 每 60 秒刷新
  useEffect(() => {
    if (isExternalComputeUser) return
    ensureCreditBalanceEvents()
    void refreshCredits()
    const timer = setInterval(() => void refreshCredits(), REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isExternalComputeUser, refreshCredits])

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = () => {
    auth.clear({ intentional: true })
    navigate('/login')
  }

  const isLowCredits = !isExternalComputeUser && credits !== null && credits < LOW_CREDITS_THRESHOLD

  // 用户头像首字母
  const initials = user?.displayName
    ? user.displayName.slice(0, 1).toUpperCase()
    : user?.email?.slice(0, 1).toUpperCase() ?? '?'

  return (
    <div className="relative flex items-center gap-3" ref={dropdownRef}>
      {/* 积分余额显示 */}
      {isExternalComputeUser ? (
        <div className="flex items-center gap-1 border border-[var(--border-color)] bg-[var(--bg-container)] px-3 py-1 text-[11px] font-bold text-[var(--color-secondary)]">
          <span className="material-symbols-outlined text-[14px]">cloud_done</span>
          {externalComputeLabel}
        </div>
      ) : credits !== null && (
        <div
          className={[
            'flex items-center gap-1 px-3 py-1',
            'border border-[var(--border-color)]',
            'text-[11px] font-bold uppercase tracking-wider font-[\'Space_Grotesk\']',
            isLowCredits
              ? 'text-[var(--color-error)] border-[var(--color-error)] bg-[var(--color-error-container)]/20'
              : 'text-[var(--color-secondary)] bg-[var(--bg-container)]',
          ].join(' ')}
        >
          {isLowCredits && (
            <span
              className="material-symbols-outlined text-[14px]"
              style={{ fontVariationSettings: "'FILL' 1, 'wght' 400" }}
            >
              warning
            </span>
          )}
          <span
            className="material-symbols-outlined text-[14px]"
            style={{ fontVariationSettings: "'FILL' 1, 'wght' 400" }}
          >
            toll
          </span>
          {formatCredits(credits)}
        </div>
      )}

      {/* 主题切换按钮 */}
      <button
        onClick={toggleTheme}
        className={[
          'flex items-center justify-center w-8 h-8',
          'border border-[var(--border-color)] bg-[var(--bg-container)]',
          'text-[var(--text-variant)] hover:text-[var(--text-base)]',
          'hover:bg-[var(--bg-container-high)] transition-colors',
        ].join(' ')}
        title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
        aria-label="切换主题"
      >
        <span
          className="material-symbols-outlined text-[16px]"
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
        >
          {theme === 'dark' ? 'light_mode' : 'dark_mode'}
        </span>
      </button>

      {/* 用户头像按钮 */}
      <button
        onClick={() => setOpen(v => !v)}
        className={[
          'flex items-center gap-2 px-2 py-1',
          'border border-[var(--border-color)] bg-[var(--bg-container)]',
          'text-[var(--text-base)] hover:bg-[var(--bg-container-high)]',
          'transition-colors',
          open ? 'border-[var(--color-primary)]' : '',
        ].join(' ')}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {/* 头像 */}
        <div
          className={[
            'w-6 h-6 flex items-center justify-center',
            'bg-[var(--color-primary)] text-[var(--color-on-primary)]',
            'text-[10px] font-bold relative',
          ].join(' ')}
        >
          {initials}
          {selectedPetId && (() => {
            const pet = getPetById(selectedPetId)
            return pet ? (
              <div
                className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border border-[var(--border-color)] overflow-hidden"
                title={pet.name}
              >
                <img
                  src={pet.spritesheetUrl}
                  alt={pet.name}
                  className="w-[192px] h-[208px] object-cover"
                  style={{ transform: 'scale(0.15)', transformOrigin: 'top left' }}
                />
              </div>
            ) : null
          })()}
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-wider max-w-[80px] truncate">
          {user?.displayName ?? user?.email ?? '用户'}
        </span>
        <span
          className={`material-symbols-outlined text-[14px] text-[var(--text-variant)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 400" }}
        >
          expand_more
        </span>
      </button>

      {/* 下拉菜单 */}
      {open && (
        <div
          className={[
            'absolute right-0 top-full mt-1 w-48 z-50',
            'bg-[var(--bg-container)] border border-[var(--border-color)]',
            'shadow-[4px_4px_0px_var(--shadow-dark)]',
          ].join(' ')}
          role="menu"
        >
          {/* 用户信息 */}
          <div className="px-3 py-2 border-b border-[var(--border-color)]">
            <p className="text-[11px] font-bold text-[var(--text-base)] truncate">
              {user?.displayName ?? '用户'}
            </p>
            <p className="text-[10px] text-[var(--text-variant)] truncate">
              {user?.email}
            </p>
          </div>

          {/* 菜单项 */}
          <div className="py-1">
            <button
              onClick={() => { setOpen(false); navigate('/profile') }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-base)] hover:bg-[var(--bg-container-high)] transition-colors text-left"
              role="menuitem"
            >
              <span className="material-symbols-outlined text-[14px] text-[var(--text-variant)]">
                account_circle
              </span>
              账户信息
            </button>

            <button
              onClick={() => { setOpen(false); navigate('/recharge') }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-base)] hover:bg-[var(--bg-container-high)] transition-colors text-left"
              role="menuitem"
            >
              <span className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]">
                account_balance_wallet
              </span>
              算力与计费
              {isLowCredits && (
                <span className="ml-auto text-[10px] text-[var(--color-error)] font-bold">低余额</span>
              )}
            </button>
            <button
              onClick={() => { setOpen(false); navigate('/profile?tab=pet') }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-base)] hover:bg-[var(--bg-container-high)] transition-colors text-left"
              role="menuitem"
            >
              <span className="material-symbols-outlined text-[14px]" style={{ color: 'var(--color-primary)' }}>
                pets
              </span>
              宠物管理
              {selectedPetId ? (
                <span className="ml-auto text-[10px] text-[var(--color-primary)] font-bold">
                  {getPetById(selectedPetId)?.name ?? '已选'}
                </span>
              ) : (
                <span className="ml-auto text-[10px] text-[var(--text-variant)]">去选择</span>
              )}
            </button>

            {/* 网页端：桌面端下载提示 */}
            {!isElectron() && (
              <button
                onClick={() => { setOpen(false); navigate('/download') }}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-base)] hover:bg-[var(--bg-container-high)] transition-colors text-left"
                role="menuitem"
              >
                <span className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]">
                  desktop_windows
                </span>
                下载桌面端
                <span className="ml-auto text-[9px] text-[var(--color-primary)] font-bold px-1 py-0.5 rounded" style={{ background: 'var(--color-primary-container)' }}>
                  桌宠
                </span>
              </button>
            )}
          </div>

          {/* 退出 */}
          <div className="border-t border-[var(--border-color)] py-1">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--color-error)] hover:bg-[var(--color-error-container)]/20 transition-colors text-left"
              role="menuitem"
            >
              <span className="material-symbols-outlined text-[14px]">logout</span>
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
