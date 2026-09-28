/**
 * 快捷键管理器
 */
import { useState } from 'react'

export interface Shortcut {
  id: string
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  description: string
  category: string
  action: () => void | Promise<void>
  enabled: boolean
  global?: boolean
}

export class ShortcutManager {
  private shortcuts = new Map<string, Shortcut>()
  private registeredHandlers = new Map<string, (e: KeyboardEvent) => void>()

  constructor() {
    this.registerDefaultShortcuts()
  }

  private registerDefaultShortcuts(): void {
    const defaults: Omit<Shortcut, 'action'>[] = [
      { id: 'save-project', key: 's', ctrl: true,               description: '保存项目', category: '文件', enabled: true, global: true },
      { id: 'save-as',      key: 's', ctrl: true, shift: true,  description: '另存为',   category: '文件', enabled: true },
      { id: 'undo',         key: 'z', ctrl: true,               description: '撤销',     category: '编辑', enabled: true, global: true },
      { id: 'redo',         key: 'y', ctrl: true,               description: '重做',     category: '编辑', enabled: true },
      { id: 'zoom-in',      key: '+', ctrl: true,               description: '放大画布', category: '画布', enabled: true },
      { id: 'zoom-out',     key: '-', ctrl: true,               description: '缩小画布', category: '画布', enabled: true },
      { id: 'zoom-reset',   key: '0', ctrl: true,               description: '重置缩放', category: '画布', enabled: true },
      { id: 'delete-layer', key: 'Delete',                       description: '删除图层', category: '图层', enabled: true },
      { id: 'tab-layers',   key: '1',                            description: '图层面板', category: '界面', enabled: true },
      { id: 'tab-ai',       key: '2',                            description: 'AI面板',   category: '界面', enabled: true },
      { id: 'tab-props',    key: '3',                            description: '属性面板', category: '界面', enabled: true },
    ]

    defaults.forEach(s => {
      this.addShortcut({
        ...s,
        action: () => { window.dispatchEvent(new CustomEvent(`shortcut:${s.id}`)) },
      })
    })
  }

  addShortcut(shortcut: Shortcut): void {
    this.shortcuts.set(shortcut.id, shortcut)
    if (shortcut.enabled) this.registerHandler(shortcut)
  }

  removeShortcut(id: string): void {
    this.unregisterHandler(id)
    this.shortcuts.delete(id)
  }

  private registerHandler(shortcut: Shortcut): void {
    const handler = (e: KeyboardEvent) => {
      if (!shortcut.global) {
        const t = e.target as HTMLElement
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      }
      if (this.matches(e, shortcut)) {
        e.preventDefault()
        try {
          const r = shortcut.action()
          if (r instanceof Promise) r.catch(console.error)
        } catch (err) { console.error(err) }
      }
    }
    window.addEventListener('keydown', handler)
    this.registeredHandlers.set(shortcut.id, handler)
  }

  private unregisterHandler(id: string): void {
    const h = this.registeredHandlers.get(id)
    if (h) { window.removeEventListener('keydown', h); this.registeredHandlers.delete(id) }
  }

  private matches(e: KeyboardEvent, s: Shortcut): boolean {
    if (!e.key || !s.key) return false
    if (e.key.toLowerCase() !== s.key.toLowerCase()) return false
    if (s.ctrl  !== undefined && e.ctrlKey  !== s.ctrl)  return false
    if (s.alt   !== undefined && e.altKey   !== s.alt)   return false
    if (s.shift !== undefined && e.shiftKey !== s.shift) return false
    if (s.meta  !== undefined && e.metaKey  !== s.meta)  return false
    return true
  }

  getShortcuts(): Shortcut[] {
    return Array.from(this.shortcuts.values())
  }

  formatKey(s: Shortcut): string {
    const parts: string[] = []
    if (s.ctrl)  parts.push('Ctrl')
    if (s.alt)   parts.push('Alt')
    if (s.shift) parts.push('Shift')
    if (s.meta)  parts.push('Meta')
    parts.push(s.key.toUpperCase())
    return parts.join('+')
  }
}

export const shortcutManager = new ShortcutManager()

export function useShortcut() {
  return shortcutManager
}

export function ShortcutMenu() {
  const [show, setShow] = useState(false)
  const shortcuts = shortcutManager.getShortcuts()

  return (
    <div className="relative">
      <button onClick={() => setShow(v => !v)} className="p-2 text-slate-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors" title="快捷键">
        <span className="material-symbols-outlined text-[20px]">keyboard</span>
      </button>
      {show && (
        <div className="absolute top-full right-0 mt-2 bg-surface-container-lowest border border-white/10 rounded-xl shadow-2xl z-50 w-72 p-3">
          <div className="text-xs font-bold text-slate-400 mb-2 px-1">快捷键</div>
          <div className="max-h-80 overflow-y-auto flex flex-col gap-0.5">
            {shortcuts.map(s => (
              <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5">
                <kbd className="px-1.5 py-0.5 bg-surface-container-high rounded text-[10px] font-mono text-slate-300 shrink-0">
                  {shortcutManager.formatKey(s)}
                </kbd>
                <span className="text-xs text-slate-400">{s.description}</span>
              </div>
            ))}
          </div>
          <button onClick={() => setShow(false)} className="mt-2 w-full py-1.5 bg-white/5 rounded-lg text-xs text-slate-400 hover:bg-white/10 transition-colors">
            关闭
          </button>
        </div>
      )}
    </div>
  )
}
