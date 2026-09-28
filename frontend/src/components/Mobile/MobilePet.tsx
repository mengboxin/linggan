import { useState } from 'react'
import { usePetStore } from '../../lib/pet-store'
import { PET_CATALOG, getPetById } from '../../lib/pet-catalog'
import PetSprite from '../PetSprite/PetSprite'

const PET_PAGE_SIZE = 24

export default function MobilePet() {
  const { selectedPetId, setSelectedPetId, customName, setCustomName } = usePetStore()
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(PET_PAGE_SIZE)

  const accent = 'var(--app-accent)'
  const accentSoft = 'var(--app-accent-soft)'
  const panelBg = 'var(--app-glass-strong)'
  const textColor = 'var(--app-text)'
  const mutedColor = 'var(--app-muted)'
  const borderColor = 'var(--app-border)'
  const inputBg = 'var(--app-control)'

  const selectedPet = selectedPetId ? getPetById(selectedPetId) : null

  const filtered = searchTerm
    ? PET_CATALOG.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.tags.some(t => t.includes(searchTerm)))
    : PET_CATALOG
  const visiblePets = filtered.slice(0, visibleCount)

  return (
    <div className="p-4 space-y-4">
      {/* 当前宠物展示 */}
      {selectedPet ? (
        <div className="rounded-xl p-4 text-center" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
          <div className="flex justify-center">
            <PetSprite src={selectedPet.spritesheetUrl} state="idle" scale={0.8} animate />
          </div>
          <p className="font-bold text-sm mt-2" style={{ color: textColor }}>
            {customName || selectedPet.name}
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: mutedColor }}>
            {selectedPet.tags.join(' · ')}
          </p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <input
              type="text"
              placeholder="给宠物取个名字..."
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: inputBg, border: `1px solid ${borderColor}`, color: textColor, width: 160 }}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-xl p-6 text-center" style={{ background: panelBg, border: `1px solid ${borderColor}` }}>
          <span className="material-symbols-outlined block mx-auto mb-2" style={{ fontSize: 48, color: accent }}>pets</span>
          <p className="text-sm font-semibold" style={{ color: textColor }}>还没有选择宠物</p>
          <p className="text-xs mt-1" style={{ color: mutedColor }}>从下面选择一个喜欢的宠物吧</p>
        </div>
      )}

      {/* 搜索 */}
      <input
        type="text"
        placeholder="搜索宠物名称或标签..."
        value={searchTerm}
        onChange={e => {
          setSearchTerm(e.target.value)
          setVisibleCount(PET_PAGE_SIZE)
        }}
        className="w-full px-3 py-2 rounded-lg text-xs"
        style={{ background: inputBg, border: `1px solid ${borderColor}`, color: textColor }}
      />

      {/* 宠物列表 */}
      <div className="grid grid-cols-4 gap-2">
        {visiblePets.map(pet => {
          const isSelected = pet.id === selectedPetId
          return (
            <button
              key={pet.id}
              onClick={() => setSelectedPetId(pet.id)}
              className="rounded-lg p-1.5 flex flex-col items-center transition-all"
              style={{
                border: `2px solid ${isSelected ? accent : borderColor}`,
                background: isSelected ? accentSoft : panelBg,
              }}
            >
              <div className="w-14 h-14 flex items-center justify-center overflow-hidden">
                <PetSprite src={pet.spritesheetUrl} state="idle" scale={0.35} animate={isSelected} />
              </div>
              <p className="text-[9px] mt-0.5 truncate w-full text-center" style={{ color: isSelected ? accent : mutedColor }}>
                {pet.name}
              </p>
            </button>
          )
        })}
      </div>

      {visibleCount < filtered.length && (
        <button
          type="button"
          onClick={() => setVisibleCount(prev => Math.min(prev + PET_PAGE_SIZE, filtered.length))}
          className="w-full rounded-xl py-2.5 text-xs font-bold"
          style={{ background: panelBg, border: `1px solid ${borderColor}`, color: accent }}
        >
          加载更多（{visiblePets.length}/{filtered.length}）
        </button>
      )}

      <p className="text-center text-[10px]" style={{ color: mutedColor, opacity: 0.5 }}>
        共 {filtered.length} 种宠物可选
      </p>
    </div>
  )
}
