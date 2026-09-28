import { useMemo } from 'react'
import { imageSrc } from '../../lib/image-url'
import { useI18nStore } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import { StableIcon } from '../ui/StableIcon'

export interface WorkflowConversationEntry {
  id: string
  label: string
  prompt: string
  previewSrc?: string
  timestamp: number
  parentId?: string
  branchLabel?: string
  selected?: boolean
}

interface WorkflowConversationPanelProps {
  entries: WorkflowConversationEntry[]
  isGenerating: boolean
  statusMessage?: string
  onEntrySelect?: (id: string) => void
  contentWidth?: number
}

interface WorkflowHistoryRow extends WorkflowConversationEntry {
  lane: number
  parentIndex: number | null
  parentLabel: string
  siblingIndex: number
  siblingCount: number
}

const HISTORY_ROW_HEIGHT = 74
const HISTORY_ROW_GAP = 8
const HISTORY_ROW_STEP = HISTORY_ROW_HEIGHT + HISTORY_ROW_GAP
const BRANCH_COLORS = ['#e87921', '#16857d', '#a45ac5', '#c04c64', '#4676c7']
export const WORKFLOW_HISTORY_DETAIL_MIN_WIDTH = 176

function chronological(left: WorkflowConversationEntry, right: WorkflowConversationEntry) {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id)
}

// Keep parents before their descendants and siblings grouped by their common
// parent. This is the same topological ordering a graph log needs, unlike a
// timestamp-only list which makes unrelated revisions look like one branch.
export function orderWorkflowHistory(entries: WorkflowConversationEntry[]): WorkflowHistoryRow[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const children = new Map<string, WorkflowConversationEntry[]>()

  entries.forEach(entry => {
    if (!entry.parentId || !byId.has(entry.parentId)) return
    const group = children.get(entry.parentId) || []
    group.push(entry)
    children.set(entry.parentId, group)
  })
  children.forEach(group => group.sort(chronological))

  const roots = entries
    .filter(entry => !entry.parentId || !byId.has(entry.parentId))
    .sort(chronological)
  const ordered: Array<WorkflowConversationEntry & { lane: number }> = []
  const visited = new Set<string>()

  const visit = (entry: WorkflowConversationEntry, lane: number, nextLane: { value: number }) => {
    if (visited.has(entry.id)) return
    visited.add(entry.id)
    ordered.push({ ...entry, lane })
    const descendants = children.get(entry.id) || []
    descendants.forEach((child, index) => {
      visit(child, index === 0 ? lane : ++nextLane.value, nextLane)
    })
  }

  const nextLane = { value: 0 }
  roots.forEach((root, index) => visit(root, index === 0 ? 0 : ++nextLane.value, nextLane))
  // Corrupted legacy snapshots can contain a parent cycle. Keep them visible
  // as independent roots rather than losing their history entirely.
  entries.slice().sort(chronological).forEach(entry => visit(entry, ++nextLane.value, nextLane))

  const indexById = new Map(ordered.map((entry, index) => [entry.id, index]))
  return ordered.map(entry => {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined
    const parentIndex = parent ? (indexById.get(parent.id) ?? null) : null
    const siblings = parent ? (children.get(parent.id) || []) : []
    const siblingIndex = parent ? Math.max(0, siblings.findIndex(child => child.id === entry.id)) : 0
    return {
      ...entry,
      parentIndex,
      parentLabel: parent?.label || '',
      siblingIndex,
      siblingCount: siblings.length,
    }
  })
}

export function WorkflowConversationPanel({
  entries,
  isGenerating,
  statusMessage,
  onEntrySelect,
  contentWidth,
}: WorkflowConversationPanelProps) {
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const textMain = isDark ? 'var(--app-text, #edf3f3)' : 'var(--app-text, #2d2a26)'
  const textMuted = isDark ? 'var(--app-muted, #93a0a2)' : 'var(--app-muted, #887968)'
  const line = isDark ? 'var(--app-border, rgba(255,255,255,0.1))' : 'var(--app-border, rgba(92,67,35,0.13))'
  const accent = isDark ? 'var(--app-accent, #d4d4d8)' : 'var(--app-accent, #b56b10)'
  const accentSoft = 'var(--app-primary-soft, rgba(82,82,91,0.12))'
  const cardBg = isDark ? 'var(--app-panel-soft, rgba(255,255,255,0.025))' : 'var(--app-panel-soft, rgba(255,255,255,0.38))'
  const rows = useMemo(() => orderWorkflowHistory(entries), [entries])
  const compact = typeof contentWidth === 'number' && contentWidth < WORKFLOW_HISTORY_DETAIL_MIN_WIDTH
  const railWidth = compact ? 18 : 32
  const railX = compact ? 9 : 15
  const rowHeight = compact ? 74 : HISTORY_ROW_HEIGHT
  const rowStep = rowHeight + HISTORY_ROW_GAP
  const rowY = (index: number) => index * rowStep + rowHeight / 2

  return (
    <section
      className="workflow-history-panel flex h-full min-h-0 flex-col"
      aria-label={lang === 'zh' ? '图片编辑记录' : 'Image editing history'}
      data-compact={compact ? 'true' : 'false'}
    >
      <header className={`workflow-history-panel__header flex shrink-0 items-center gap-2 border-b ${compact ? 'h-[74px] justify-center px-1.5' : 'h-14 px-3'}`} style={{ borderColor: line }}>
        <span
          className="flex h-8 w-8 items-center justify-center rounded-md text-[17px]"
          style={{ background: accentSoft, color: accent }}
        >
          <StableIcon name="account_tree" />
        </span>
        {compact ? (
          <div className="workflow-history-mini-dashboard" title={lang === 'zh' ? '编辑记录' : 'Edit history'}>
            <span className="workflow-history-mini-dashboard__label">
              {lang === 'zh' ? '编辑记录' : 'History'}
            </span>
            <span className="workflow-history-mini-dashboard__count" aria-label={lang === 'zh' ? `${entries.length} 条记录` : `${entries.length} entries`}>
              {entries.length}
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold" style={{ color: textMain }}>
              {lang === 'zh' ? '编辑记录' : 'Edit history'}
            </p>
            <p className="truncate text-[10px]" style={{ color: textMuted }}>
              {lang === 'zh' ? '版本时间线' : 'Version timeline'}
            </p>
          </div>
        )}
        {entries.length > 0 && !compact && (
          <span
            className="flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-[10px] font-bold"
            style={{ border: `1px solid ${line}`, color: textMuted, background: cardBg }}
            aria-label={lang === 'zh' ? `${entries.length} 条记录` : `${entries.length} entries`}
          >
            {entries.length}
          </span>
        )}
      </header>

      <div className={`min-h-0 flex-1 overflow-y-auto py-3 custom-scrollbar ${compact ? 'px-2' : 'px-3'}`}>
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" style={{ color: textMuted }}>
            <span className="flex h-10 w-10 items-center justify-center rounded-md" style={{ background: cardBg, color: accent }}>
              <StableIcon name="image" className="text-[19px]" />
            </span>
            <p className="text-[11px] leading-5">
              {lang === 'zh' ? '从一张主图开始，每次修改都会成为可回溯的版本。' : 'Each revision becomes a traceable version from the source image.'}
            </p>
          </div>
        ) : (
          <div className="relative" style={{ minHeight: rows.length * rowStep - HISTORY_ROW_GAP }}>
            <svg
              aria-hidden="true"
              data-testid="workflow-history-graph"
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              width={railWidth}
              height={rows.length * rowStep - HISTORY_ROW_GAP}
            >
              {rows.length > 1 && (
                <line
                  data-testid="workflow-history-rail"
                  x1={railX}
                  x2={railX}
                  y1={rowY(0)}
                  y2={rowY(rows.length - 1)}
                  stroke={line}
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              )}
              {rows.map((row, index) => {
                const color = BRANCH_COLORS[row.lane % BRANCH_COLORS.length]
                return (
                  <circle
                    key={`${row.id}-node`}
                    data-testid={`workflow-history-node-${row.id}`}
                    cx={railX}
                    cy={rowY(index)}
                    r={row.selected ? 5 : 4}
                    fill={color}
                    stroke={row.selected ? accent : 'var(--app-panel-inset)'}
                    strokeWidth={row.selected ? 3 : 2}
                  />
                )
              })}
            </svg>

            <div className="grid" style={{ gridAutoRows: rowHeight, gap: HISTORY_ROW_GAP }}>
              {rows.map(row => {
                const isSelected = Boolean(row.selected)
                const branchText = !row.parentId
                  ? (lang === 'zh' ? '起始图' : 'Source image')
                  : row.siblingCount > 1 && row.siblingIndex > 0
                    ? (lang === 'zh' ? `从 ${row.parentLabel} 分出` : `branched from ${row.parentLabel}`)
                    : (lang === 'zh' ? `延续 ${row.parentLabel}` : `continues ${row.parentLabel}`)
                const branchColor = BRANCH_COLORS[row.lane % BRANCH_COLORS.length]
                return (
                  <button
                    key={row.id}
                    type="button"
                    data-testid={`workflow-history-${row.id}`}
                    onClick={() => onEntrySelect?.(row.id)}
                    title={compact ? `${row.branchLabel || row.label} · ${row.prompt || branchText}` : undefined}
                    className={`workflow-history-card ${isSelected ? 'workflow-history-card--selected' : ''} group relative ml-0 flex min-w-0 border text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${compact ? 'flex-col items-center justify-center gap-1 px-1.5 py-1.5' : 'items-center gap-2 px-2 py-2'}`}
                    style={{
                      marginLeft: railWidth,
                      width: `calc(100% - ${railWidth}px)`,
                      borderColor: isSelected
                        ? 'color-mix(in srgb, var(--app-accent) 34%, transparent)'
                        : line,
                      borderLeftWidth: isSelected ? 3 : 1,
                      borderRadius: compact ? 11 : 10,
                      outlineColor: accent,
                    }}
                  >
                    <div className="shrink-0">
                      {row.previewSrc ? (
                        <img
                          src={imageSrc(row.previewSrc)}
                          alt={row.label}
                          className="h-10 w-10 rounded-md object-cover transition-transform duration-300 group-hover:scale-105"
                          style={{ border: `1px solid ${isSelected ? accent : line}`, background: 'var(--app-panel)' }}
                        />
                      ) : (
                        <span
                          className="flex h-10 w-10 items-center justify-center rounded-md text-[17px]"
                          style={{ border: `1px solid ${line}`, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(92,67,35,0.06)', color: textMuted }}
                        >
                          <StableIcon name="image" />
                        </span>
                      )}
                    </div>

                    {compact ? (
                      <div className="flex min-w-0 max-w-full items-center gap-1">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-transform duration-300 ${isSelected ? 'animate-pulse' : 'group-hover:scale-125'}`} style={{ background: branchColor }} />
                        <span className="min-w-0 truncate text-center text-[9px] font-bold" style={{ color: isSelected ? accent : textMain }}>
                          {row.branchLabel || row.label}
                        </span>
                      </div>
                    ) : (
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-bold" style={{ color: isSelected ? accent : textMain }}>
                          {row.label}
                        </span>
                        <time className="shrink-0 text-[10px]" style={{ color: textMuted }}>
                          {new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </time>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: branchColor }} />
                        <span className="min-w-0 truncate text-[9px] font-semibold" style={{ color: branchColor }}>
                          {branchText}
                        </span>
                      </div>
                      <p
                        className="mt-1 truncate text-[10px] leading-4"
                        style={{
                          color: textMuted,
                          overflow: 'hidden',
                        }}
                      >
                        {row.prompt || (lang === 'zh' ? '已添加到工作流' : 'Added to workflow')}
                      </p>
                    </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {isGenerating && (
          <div
            role="status"
            aria-live="polite"
            className="workflow-history-generating mt-3 flex items-start gap-2 border px-3 py-2.5 text-[11px] leading-5"
            style={{ borderColor: 'color-mix(in srgb, var(--app-accent) 40%, transparent)', borderRadius: 8, background: accentSoft, color: textMain }}
          >
            <StableIcon name="loader" className="mt-0.5 animate-spin text-[14px]" style={{ color: accent }} />
            <span>{statusMessage || (lang === 'zh' ? '正在生成新版本…' : 'Generating a new revision...')}</span>
          </div>
        )}
      </div>
    </section>
  )
}
