import { useEffect, useMemo, useState } from 'react'
import { PET_CATALOG, PET_TAGS, getPetsByTag } from '../../lib/pet-catalog'
import PetSprite from '../PetSprite/PetSprite'
import { isElectron } from '../../lib/electron'
import { usePetStore } from '../../lib/pet-store'
import { routeHref } from '../../lib/navigation'
import { auth, apiUrl } from '../../lib/auth'
import { useI18nStore } from '../../lib/i18n'

interface PetSelectorProps {
  selectedPetId: string | null
  onSelect: (petId: string | null) => void
  accent: string
  isDark: boolean
}

const PAGE_SIZE = 24

const PET_TAG_EN: Record<string, string> = {
  '全部': 'All', '猫咪': 'Cats', '狗狗': 'Dogs', '小动物': 'Small pets', '幻想': 'Fantasy', '其他': 'Other',
}

interface PetChatModel {
  id: string
  name: string
  category: string
}

export default function PetSelector({ selectedPetId, onSelect, accent, isDark }: PetSelectorProps) {
  const { lang } = useI18nStore()
  const [activeTag, setActiveTag] = useState('全部')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const customName = usePetStore(s => s.customName)
  const setCustomName = usePetStore(s => s.setCustomName)

  const selectedPet = selectedPetId ? PET_CATALOG.find(p => p.id === selectedPetId) : null
  const displayName = customName || selectedPet?.name || ''
  const [chatModels, setChatModels] = useState<PetChatModel[]>([])
  const [chatModelId, setChatModelId] = useState('')
  const [loadingChatModels, setLoadingChatModels] = useState(false)
  const [savingChatModel, setSavingChatModel] = useState(false)
  const [chatModelMsg, setChatModelMsg] = useState('')

  useEffect(() => {
    if (!auth.isLoggedIn()) return
    let cancelled = false
    setLoadingChatModels(true)
    auth.fetchWithAuth(apiUrl('/api/pet/config'))
      .then(async res => {
        if (!res.ok) throw new Error('load failed')
        return res.json()
      })
      .then(data => {
        if (cancelled) return
        const models = Array.isArray(data.available_models) ? data.available_models : []
        setChatModels(models.filter((model: PetChatModel) => model.category === 'llm'))
        setChatModelId(String(data.config?.model_id || ''))
      })
      .catch(() => {
        if (!cancelled) setChatModelMsg(lang === 'zh' ? '聊天模型加载失败' : 'Unable to load chat models')
      })
      .finally(() => {
        if (!cancelled) setLoadingChatModels(false)
      })
    return () => { cancelled = true }
  }, [lang])

  const filteredPets = useMemo(() => {
    let list = getPetsByTag(activeTag)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
    }
    return list
  }, [activeTag, search])

  const totalPages = Math.ceil(filteredPets.length / PAGE_SIZE)
  const pagedPets = filteredPets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const cardBg = 'var(--app-glass-strong)'
  const border = 'var(--app-border)'
  const text = 'var(--app-text)'
  const muted = 'var(--app-muted)'
  const cardSoft = 'var(--app-panel-raised)'
  const controlBg = 'var(--app-control)'
  const onAccent = 'var(--app-on-accent)'

  const handleTagChange = (tag: string) => {
    setActiveTag(tag)
    setPage(1)
  }

  const handleChatModelChange = async (modelId: string) => {
    setChatModelId(modelId)
    setSavingChatModel(true)
    setChatModelMsg('')
    try {
      const res = await auth.fetchWithAuth(apiUrl('/api/pet/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          model_category: 'llm',
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'save failed')
      }
      setChatModelMsg(lang === 'zh' ? '聊天模型已保存' : 'Chat model saved')
      setTimeout(() => setChatModelMsg(''), 1800)
    } catch {
      setChatModelMsg(lang === 'zh' ? '聊天模型保存失败' : 'Unable to save chat model')
    } finally {
      setSavingChatModel(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 网页端提示下载客户端 */}
      {!isElectron() && (
        <div
          className="flex items-center gap-3 p-4 rounded-xl"
          style={{
            background: 'var(--app-panel-soft)',
            border: `1px dashed ${border}`,
          }}
        >
          <span className="material-symbols-outlined text-[28px]" style={{ color: accent }}>
            desktop_windows
          </span>
          <div className="flex-1">
            <p className="text-[12px] font-semibold" style={{ color: text }}>
              {lang === 'zh' ? '想让宠物陪你创作？' : 'Want a creative companion?'}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: muted }}>
              {lang === 'zh' ? '下载灵感桌面客户端，宠物会在桌面上陪伴你，随着你的操作做出各种可爱反应！' : 'Download the LINGGAN desktop app. Your pet stays with you and reacts as you create.'}
            </p>
            <a
              href={routeHref('/download')}
              className="inline-flex items-center gap-1 mt-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors"
              style={{
                background: accent,
                 color: onAccent,
              }}
            >
              <span className="material-symbols-outlined text-[14px]">download</span>
              {lang === 'zh' ? '下载桌面端' : 'Download desktop app'}
            </a>
          </div>
        </div>
      )}

      {/* Preview area */}
      <div
        className="flex flex-col items-center justify-center p-6 rounded-xl"
        style={{ background: cardBg, border: `1px solid ${border}` }}
      >
        {selectedPet ? (
          <div className="flex flex-col items-center gap-3">
            <div className="p-4 rounded-xl" style={{ background: cardSoft }}>
              <PetSprite src={selectedPet.spritesheetUrl} state="idle" scale={0.7} animate={true} />
            </div>
            <div className="text-center">
              {editingName ? (
                <div className="flex items-center gap-2 justify-center">
                  <input
                    type="text"
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        setCustomName(nameInput.trim())
                        setEditingName(false)
                      }
                      if (e.key === 'Escape') setEditingName(false)
                    }}
                    onBlur={() => {
                      setCustomName(nameInput.trim())
                      setEditingName(false)
                    }}
                    autoFocus
                    maxLength={12}
                    className="px-2 py-1 rounded-lg text-[15px] font-bold text-center outline-none"
                    style={{
             background: controlBg,
                      border: `1.5px solid ${accent}`,
                      color: text,
                      width: 140,
                      fontFamily: 'Manrope, sans-serif',
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 justify-center group cursor-pointer" onClick={() => {
                  setNameInput(customName || selectedPet.name)
                  setEditingName(true)
                }}>
                  <span className="text-[16px] font-bold" style={{ color: text, fontFamily: 'Manrope, sans-serif' }}>
                    {displayName}
                  </span>
                  <span
                    className="material-symbols-outlined text-[14px] opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: muted }}
                  >
                    edit
                  </span>
                </div>
              )}
              <div className="text-[12px] mt-1" style={{ color: isDark ? '#4ade80' : '#16a34a' }}>
                {lang === 'zh' ? '✓ 当前选中 · 点击名字可改名' : '✓ Selected · click the name to rename'}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-10" style={{ color: muted }}>
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center"
              style={{ background: cardSoft, border: `2px dashed ${border}` }}
            >
              <span className="material-symbols-outlined text-[36px]" style={{ opacity: 0.5 }}>pets</span>
            </div>
            <div className="text-center">
              <p className="text-[14px] font-semibold mb-1" style={{ color: text }}>{lang === 'zh' ? '还没有选择宠物' : 'No pet selected'}</p>
              <p className="text-[12px] leading-relaxed" style={{ color: muted }}>
                {lang === 'zh' ? '在下方选择一个宠物伙伴，它会在桌面上陪伴你创作' : 'Choose a companion below to join you on the desktop.'}
              </p>
            </div>
          </div>
        )}
      </div>

      <div
        className="flex flex-col gap-3 p-4 rounded-xl"
        style={{ background: cardBg, border: `1px solid ${border}` }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold" style={{ color: text, fontFamily: 'Manrope, sans-serif' }}>
              {lang === 'zh' ? '桌宠聊天模型' : 'Desktop pet chat model'}
            </h3>
            <p className="mt-0.5 text-[11px]" style={{ color: muted }}>
              {lang === 'zh' ? '用于桌面宠物对话和平台助手回答' : 'Used by the desktop pet and assistant replies'}
            </p>
          </div>
          <span className="material-symbols-outlined text-[20px]" style={{ color: accent }}>psychology</span>
        </div>
        <select
          value={chatModelId}
          disabled={loadingChatModels || savingChatModel || chatModels.length === 0}
          onChange={e => handleChatModelChange(e.target.value)}
          className="w-full rounded-lg px-3 py-2 text-[12px] outline-none transition-colors"
          style={{
            background: cardSoft,
            border: `1px solid ${border}`,
            color: text,
          }}
        >
          <option value="" disabled>
            {loadingChatModels ? (lang === 'zh' ? '加载模型中...' : 'Loading models...') : (lang === 'zh' ? '选择聊天模型' : 'Choose a chat model')}
          </option>
          {chatModels.map(model => (
            <option key={model.id} value={model.id}>
              {model.name || model.id}
            </option>
          ))}
        </select>
        <div className="flex min-h-[18px] items-center justify-between gap-3 text-[11px]" style={{ color: muted }}>
          <span>{chatModelMsg}</span>
          {savingChatModel && <span>{lang === 'zh' ? '保存中...' : 'Saving...'}</span>}
        </div>
      </div>

      {/* Action buttons */}
      {selectedPetId && (
        <button
          onClick={() => onSelect(null)}
          className="w-fit px-4 py-2 rounded-lg text-[12px] font-semibold transition-colors"
          style={{
            background: `${isDark ? '#f87171' : '#BA1A1A'}18`,
            border: `1px solid ${isDark ? '#f87171' : '#BA1A1A'}33`,
            color: isDark ? '#f87171' : '#BA1A1A',
          }}
        >
          {lang === 'zh' ? '取消选择宠物' : 'Remove selected pet'}
        </button>
      )}

      {/* Search + Tags */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[13px] font-semibold" style={{ color: text, fontFamily: 'Manrope, sans-serif' }}>
            {lang === 'zh' ? '选择宠物形象' : 'Choose a pet'}
          </h3>
          <span className="text-[11px]" style={{ color: muted }}>
            {lang === 'zh' ? `${filteredPets.length} 个可用` : `${filteredPets.length} available`}
          </span>
        </div>

        {/* Search */}
        <div className="mb-3">
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder={lang === 'zh' ? '搜索宠物名称...' : 'Search pets...'}
            className="w-full px-3 py-2 rounded-lg text-[12px] focus:outline-none focus:ring-2"
            style={{
               background: controlBg,
              border: `1px solid ${border}`,
              color: text,
            }}
          />
        </div>

        {/* Tag filter */}
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {PET_TAGS.map(tag => {
            const active = activeTag === tag
            return (
              <button
                key={tag}
                onClick={() => handleTagChange(tag)}
                className="px-3 py-1 rounded-full text-[11px] font-medium transition-all"
                style={{
                   background: active ? accent : controlBg,
                   color: active ? onAccent : muted,
                  border: `1px solid ${active ? accent : border}`,
                }}
              >
                  {lang === 'zh' ? tag : (PET_TAG_EN[tag] || tag)}
              </button>
            )
          })}
        </div>

        {/* Pet grid — thumbnails are static (no animation) */}
        <div className="grid grid-cols-4 gap-2">
          {pagedPets.map(pet => {
            const isSelected = selectedPetId === pet.id
            return (
              <button
                key={pet.id}
                onClick={() => onSelect(pet.id)}
                className="relative flex flex-col items-center p-2 rounded-lg transition-all cursor-pointer"
                style={{
                  background: isSelected ? `color-mix(in srgb, ${accent} 10%, transparent)` : cardSoft,
                  border: `2px solid ${isSelected ? accent : 'transparent'}`,
                }}
              >
                <div className="w-full aspect-square flex items-center justify-center overflow-hidden rounded-md">
                  <PetSprite src={pet.spritesheetUrl} state="idle" scale={0.22} animate={false} />
                </div>
                <span
                  className="text-[10px] mt-1 truncate w-full text-center font-medium"
                  style={{ color: isSelected ? accent : muted }}
                >
                  {pet.name}
                </span>
                {isSelected && (
                  <div
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ background: accent, color: 'var(--app-on-accent)' }}
                  >
                    <span className="material-symbols-outlined text-[10px]">check</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {pagedPets.length === 0 && (
          <div className="text-center py-8 text-[13px]" style={{ color: muted }}>
            {lang === 'zh' ? '没有找到匹配的宠物' : 'No matching pets'}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] transition-colors disabled:opacity-30"
              style={{ background: cardSoft, color: text, border: `1px solid ${border}` }}
            >
              <span className="material-symbols-outlined text-[16px]">chevron_left</span>
            </button>
            <span className="text-[12px] font-mono" style={{ color: muted }}>
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] transition-colors disabled:opacity-30"
              style={{ background: cardSoft, color: text, border: `1px solid ${border}` }}
            >
              <span className="material-symbols-outlined text-[16px]">chevron_right</span>
            </button>
          </div>
        )}
      </div>

      {/* Credits */}
      <div className="text-[11px] text-center" style={{ color: muted }}>
        {lang === 'zh' ? '宠物素材来自 ' : 'Pet assets by '}<a href="https://petdex.crafter.run" target="_blank" rel="noopener noreferrer" style={{ color: accent }}>Petdex</a> (MIT License)
      </div>

    </div>
  )
}
