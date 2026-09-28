import { Check, ChevronDown, CloudUpload, HardDrive } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isElectron, type StorageWorkspace } from '../../lib/electron'
import { TOPBAR_COLLAPSED_EVENT } from '../../lib/topbar-preference'
import {
  getStorageWorkspace,
  listenForStorageWorkspaceChanges,
  reconcileStorageWorkspace,
  switchStorageWorkspace,
} from '../../lib/storage-workspace'

const OPTIONS: Array<{
  id: StorageWorkspace
  label: string
  description: string
  icon: typeof HardDrive
}> = [
  {
    id: 'local',
    label: '本地',
    description: '记录与工作流仅保存在这台电脑',
    icon: HardDrive,
  },
  {
    id: 'cloud',
    label: '云端',
    description: '记录保存到账号云空间，可跨设备使用',
    icon: CloudUpload,
  },
]

export function StorageWorkspaceSwitcher() {
  const [workspace, setWorkspace] = useState<StorageWorkspace>(getStorageWorkspace)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isElectron()) return
    void reconcileStorageWorkspace().then(setWorkspace)
    return listenForStorageWorkspaceChanges(setWorkspace)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    const closeForFloatingTopbar = () => setOpen(false)
    window.addEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
    return () => window.removeEventListener(TOPBAR_COLLAPSED_EVENT, closeForFloatingTopbar)
  }, [])

  if (!isElectron()) return null

  const active = OPTIONS.find(option => option.id === workspace) || OPTIONS[0]
  const ActiveIcon = active.icon
  const choose = async (next: StorageWorkspace) => {
    if (switching || next === workspace) {
      setOpen(false)
      return
    }
    setSwitching(true)
    try {
      const changed = await switchStorageWorkspace(next)
      if (!changed) return
      setWorkspace(next)
      setOpen(false)
      window.location.reload()
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0" data-tour-id="desktop-storage-workspace">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-2.5 text-[11px] font-black text-[var(--app-text)] shadow-[var(--app-shadow-soft)] transition-colors hover:bg-[var(--app-control-hover)]"
        title="切换记录保存位置"
      >
        <ActiveIcon size={17} strokeWidth={2.25} />
        <span>{active.label}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="记录保存位置"
          className="absolute right-0 top-[calc(100%+8px)] z-[90] w-72 rounded-lg border border-[var(--app-border)] bg-[var(--app-glass-strong)] p-2 text-[var(--app-text)] shadow-[var(--app-shadow-raised)] backdrop-blur-2xl"
        >
          <div className="px-2 pb-2 pt-1">
            <div className="text-[12px] font-black">记录保存位置</div>
            <p className="mt-1 text-[10px] leading-4 text-[var(--app-muted)]">
              两个空间完全隔离，切换不会复制或同步已有记录。
            </p>
          </div>
          <div className="space-y-1">
            {OPTIONS.map(option => {
              const OptionIcon = option.icon
              const selected = option.id === workspace
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={switching}
                  onClick={() => void choose(option.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-55 ${
                    selected
                      ? 'border-[var(--app-primary)] bg-[var(--app-primary-soft)]'
                      : 'border-transparent hover:bg-[var(--app-control-hover)]'
                  }`}
                >
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                    selected
                      ? 'bg-[var(--app-primary)] text-[var(--app-on-primary)]'
                      : 'bg-[var(--app-control)] text-[var(--app-muted)] shadow-sm'
                  }`}>
                    <OptionIcon size={19} strokeWidth={2.15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-[12px]">{option.label}存储</strong>
                    <span className="mt-0.5 block text-[10px] leading-4 text-[var(--app-muted)]">
                      {option.description}
                    </span>
                  </span>
                  {selected && <Check size={15} className="text-[var(--app-primary)]" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
