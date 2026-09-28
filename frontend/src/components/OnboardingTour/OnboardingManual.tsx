import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18nStore, type Lang } from '../../lib/i18n'
import { useThemeStore } from '../../lib/theme'
import { GUIDE_CHAPTERS, type GuideChapterId } from './guide-catalog'
import { useTourStore } from './tour-store'
import './onboarding-manual.css'

type LocalizedText = { zh: string; en: string }

interface ManualChapter {
  id: GuideChapterId
  group: string | LocalizedText
  icon: string
  title: LocalizedText
  summary: LocalizedText
  outcome: LocalizedText
  parameters: readonly unknown[]
  workflow: readonly unknown[]
  tips: readonly unknown[]
  commonIssues?: readonly unknown[]
  tourSteps: readonly unknown[]
}

const CHAPTERS = GUIDE_CHAPTERS as unknown as readonly ManualChapter[]

const GROUP_LABELS: Record<string, LocalizedText> = {
  start: { zh: '快速开始', en: 'Getting started' },
  overview: { zh: '快速开始', en: 'Getting started' },
  foundation: { zh: '快速开始', en: 'Getting started' },
  'getting-started': { zh: '快速开始', en: 'Getting started' },
  image: { zh: '图片创作', en: 'Image creation' },
  generation: { zh: '图片创作', en: 'Image creation' },
  'image-generation': { zh: '图片创作', en: 'Image creation' },
  edit: { zh: '编辑与工作流', en: 'Editing and workflows' },
  editing: { zh: '编辑与工作流', en: 'Editing and workflows' },
  workflow: { zh: '编辑与工作流', en: 'Editing and workflows' },
  canvas: { zh: '画布与演示', en: 'Canvas and presentations' },
  presentation: { zh: '画布与演示', en: 'Canvas and presentations' },
  'canvas-presentation': { zh: '画布与演示', en: 'Canvas and presentations' },
  discover: { zh: '发现与管理', en: 'Discover and manage' },
  discovery: { zh: '发现与管理', en: 'Discover and manage' },
  manage: { zh: '发现与管理', en: 'Discover and manage' },
  assets: { zh: '发现与管理', en: 'Discover and manage' },
  system: { zh: '账户与系统', en: 'Account and system' },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLocalizedText(value: unknown): value is LocalizedText {
  return isRecord(value) && typeof value.zh === 'string' && typeof value.en === 'string'
}

function localize(value: unknown, lang: Lang): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isLocalizedText(value)) return value[lang]
  return ''
}

function firstLocalized(record: Record<string, unknown>, keys: string[], lang: Lang): string {
  for (const key of keys) {
    const value = localize(record[key], lang)
    if (value) return value
  }
  return ''
}

function itemTitle(item: unknown, index: number, lang: Lang, fallback: string): string {
  if (isLocalizedText(item) || typeof item === 'string') return localize(item, lang)
  if (!isRecord(item)) return `${fallback} ${index + 1}`
  return firstLocalized(item, ['label', 'title', 'name', 'action', 'question', 'issue'], lang)
    || `${fallback} ${index + 1}`
}

function itemBody(item: unknown, lang: Lang): string {
  if (isLocalizedText(item) || typeof item === 'string') return ''
  if (!isRecord(item)) return ''
  return firstLocalized(item, ['description', 'summary', 'detail', 'value', 'answer', 'solution', 'note', 'content', 'text'], lang)
}

function itemOptions(item: unknown, lang: Lang): string[] {
  if (!isRecord(item)) return []
  const options = item.options ?? item.values ?? item.items
  if (!Array.isArray(options)) return []
  return options.map(value => {
    if (isRecord(value) && !isLocalizedText(value)) {
      return firstLocalized(value, ['label', 'title', 'name', 'value'], lang)
    }
    return localize(value, lang)
  }).filter(Boolean)
}

function collectSearchText(value: unknown, lang: Lang, output: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value))
    return
  }
  if (isLocalizedText(value)) {
    output.push(value[lang])
    return
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectSearchText(item, lang, output))
    return
  }
  if (isRecord(value)) {
    Object.values(value).forEach(item => collectSearchText(item, lang, output))
  }
}

function groupLabel(group: ManualChapter['group'], lang: Lang): string {
  if (isLocalizedText(group)) return group[lang]
  return GROUP_LABELS[group]?.[lang] ?? group
}

function readCompletedIds(state: unknown): string[] {
  if (!isRecord(state)) return []
  const value = state.completedChapterIds
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  if (value instanceof Set) return Array.from(value).filter((id): id is string => typeof id === 'string')
  return []
}

function chapterIcon(icon: string) {
  return (
    <span className="material-symbols-outlined" aria-hidden="true">
      {icon || 'school'}
    </span>
  )
}

export function OnboardingManual() {
  const rawTourState = useTourStore()
  const tourState = rawTourState as typeof rawTourState & {
    isManualOpen?: boolean
    manualOpen?: boolean
    manualChapterId?: string | null
    completedChapterIds?: string[]
    closeManual?: () => void
    startChapterTour?: (chapterId: GuideChapterId) => void
    markChapterComplete?: (chapterId: GuideChapterId) => void
  }
  const isManualOpen = tourState.isManualOpen ?? tourState.manualOpen ?? false
  const { manualChapterId = null } = tourState
  const closeManual = tourState.closeManual ?? (() => undefined)
  const startChapterTour = tourState.startChapterTour ?? (() => undefined)
  const markChapterComplete = tourState.markChapterComplete ?? (() => undefined)
  const { lang } = useI18nStore()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<GuideChapterId | ''>(CHAPTERS[0]?.id ?? '')
  const [mobileDirectoryOpen, setMobileDirectoryOpen] = useState(false)
  const [locallyCompleted, setLocallyCompleted] = useState<string[]>([])
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const completedIds = useMemo(() => {
    return new Set([...readCompletedIds(tourState), ...locallyCompleted])
  }, [locallyCompleted, tourState])

  useEffect(() => {
    if (!isManualOpen) return
    const requestedChapter = CHAPTERS.find(chapter => chapter.id === manualChapterId)?.id
      ?? CHAPTERS[0]?.id
    if (requestedChapter) setSelectedId(requestedChapter)
    setQuery('')
    setMobileDirectoryOpen(false)
  }, [isManualOpen, manualChapterId])

  useEffect(() => {
    if (!isManualOpen) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 80)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeManual()
        return
      }

      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], details > summary, [tabindex]:not([tabindex="-1"])',
      )).filter(element => element.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus()
    }
  }, [closeManual, isManualOpen])

  const filteredChapters = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(lang === 'zh' ? 'zh-CN' : 'en-US')
    if (!normalizedQuery) return [...CHAPTERS]
    return CHAPTERS.filter(chapter => {
      const values: string[] = []
      collectSearchText(chapter, lang, values)
      values.push(groupLabel(chapter.group, lang))
      return values.join(' ').toLocaleLowerCase(lang === 'zh' ? 'zh-CN' : 'en-US').includes(normalizedQuery)
    })
  }, [lang, query])

  const groupedChapters = useMemo(() => {
    const groups: Array<{ key: string; label: string; chapters: ManualChapter[] }> = []
    filteredChapters.forEach(chapter => {
      const label = groupLabel(chapter.group, lang)
      const key = typeof chapter.group === 'string' ? chapter.group : label
      const existing = groups.find(group => group.key === key)
      if (existing) existing.chapters.push(chapter)
      else groups.push({ key, label, chapters: [chapter] })
    })
    return groups
  }, [filteredChapters, lang])

  const activeChapter = filteredChapters.find(chapter => chapter.id === selectedId)
    ?? filteredChapters[0]
    ?? CHAPTERS.find(chapter => chapter.id === selectedId)
    ?? CHAPTERS[0]
  const activeIndex = activeChapter ? CHAPTERS.findIndex(chapter => chapter.id === activeChapter.id) : -1
  const previousChapter = activeIndex > 0 ? CHAPTERS[activeIndex - 1] : null
  const nextChapter = activeIndex >= 0 && activeIndex < CHAPTERS.length - 1 ? CHAPTERS[activeIndex + 1] : null
  const completionPercent = CHAPTERS.length > 0 ? Math.round((completedIds.size / CHAPTERS.length) * 100) : 0

  if (!isManualOpen || !activeChapter) return null

  const selectChapter = (id: GuideChapterId) => {
    setSelectedId(id)
    setMobileDirectoryOpen(false)
  }

  const completeChapter = () => {
    markChapterComplete(activeChapter.id)
    setLocallyCompleted(current => current.includes(activeChapter.id) ? current : [...current, activeChapter.id])
  }

  const launchChapterTour = () => {
    startChapterTour(activeChapter.id)
  }

  const copy = lang === 'zh'
    ? {
        title: '灵感学习中心',
        subtitle: '从第一次生成，到能独立完成复杂创作链路',
        search: '搜索功能、参数或问题',
        searchResults: `找到 ${filteredChapters.length} 个相关章节`,
        noResults: '没有找到相关内容',
        noResultsHint: '试试搜索“模型”“参考图”“历史记录”或“下载”。',
        clearSearch: '清除搜索',
        close: '关闭学习中心',
        directory: '章节目录',
        progress: '学习进度',
        completed: '已完成',
        steps: '个实操步骤',
        outcome: '学完本章，你可以',
        parameters: '参数与控件',
        workflow: '标准操作流程',
        tips: '实用提示',
        issues: '常见问题',
        markComplete: '标记为已学会',
        learned: '本章已学会',
        startTour: '开始本章实操导览',
        noTour: '本章暂无实操步骤',
        previous: '上一章',
        next: '下一章',
        parameter: '参数',
        step: '步骤',
        tip: '提示',
        issue: '问题',
      }
    : {
        title: 'Linggan Learning Center',
        subtitle: 'From your first generation to complete creative workflows',
        search: 'Search features, parameters, or questions',
        searchResults: `${filteredChapters.length} matching chapters`,
        noResults: 'No matching content',
        noResultsHint: 'Try “model”, “reference”, “history”, or “download”.',
        clearSearch: 'Clear search',
        close: 'Close learning center',
        directory: 'Chapter directory',
        progress: 'Learning progress',
        completed: 'completed',
        steps: 'guided steps',
        outcome: 'After this chapter, you can',
        parameters: 'Parameters and controls',
        workflow: 'Standard workflow',
        tips: 'Practical tips',
        issues: 'Common questions',
        markComplete: 'Mark as learned',
        learned: 'Chapter learned',
        startTour: 'Start guided practice',
        noTour: 'No guided steps in this chapter',
        previous: 'Previous',
        next: 'Next',
        parameter: 'Parameter',
        step: 'Step',
        tip: 'Tip',
        issue: 'Question',
      }

  return (
    <div
      className={`onboarding-manual-overlay onboarding-manual--${isDark ? 'dark' : 'light'}`}
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeManual()
      }}
    >
      <div
        ref={panelRef}
        className="onboarding-manual"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-manual-title"
        aria-describedby="onboarding-manual-subtitle"
      >
        <header className="onboarding-manual__header">
          <div className="onboarding-manual__brand">
            <span className="onboarding-manual__brand-mark" aria-hidden="true">
              <span className="material-symbols-outlined">menu_book</span>
            </span>
            <div className="onboarding-manual__brand-copy">
              <h2 id="onboarding-manual-title">{copy.title}</h2>
              <p id="onboarding-manual-subtitle">{copy.subtitle}</p>
            </div>
          </div>

          <label className="onboarding-manual__search">
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={copy.search}
              aria-label={copy.search}
            />
            <kbd>/</kbd>
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label={copy.clearSearch}>
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            )}
          </label>

          <div className="onboarding-manual__header-actions">
            <button
              type="button"
              className="onboarding-manual__directory-toggle"
              onClick={() => setMobileDirectoryOpen(open => !open)}
              aria-expanded={mobileDirectoryOpen}
              aria-controls="onboarding-manual-directory"
            >
              <span className="material-symbols-outlined" aria-hidden="true">format_list_bulleted</span>
              <span>{copy.directory}</span>
            </button>
            <button type="button" className="onboarding-manual__icon-button" onClick={closeManual} aria-label={copy.close}>
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
        </header>

        <div className="onboarding-manual__body">
          <aside
            id="onboarding-manual-directory"
            className="onboarding-manual__sidebar"
            data-mobile-open={mobileDirectoryOpen ? 'true' : 'false'}
            aria-label={copy.directory}
          >
            <div className="onboarding-manual__progress-block">
              <div className="onboarding-manual__progress-heading">
                <span>{copy.progress}</span>
                <strong>{completedIds.size} / {CHAPTERS.length}</strong>
              </div>
              <div
                className="onboarding-manual__progress-track"
                role="progressbar"
                aria-label={copy.progress}
                aria-valuemin={0}
                aria-valuemax={CHAPTERS.length}
                aria-valuenow={completedIds.size}
              >
                <span style={{ width: `${completionPercent}%` }} />
              </div>
              <p>{completionPercent}% {copy.completed}</p>
            </div>

            {query && (
              <p className="onboarding-manual__search-count" role="status" aria-live="polite">
                {copy.searchResults}
              </p>
            )}

            <nav className="onboarding-manual__groups">
              {groupedChapters.map(group => (
                <section key={group.key} className="onboarding-manual__group">
                  <h3>{group.label}</h3>
                  <div className="onboarding-manual__chapter-list">
                    {group.chapters.map(chapter => {
                      const active = activeChapter.id === chapter.id
                      const complete = completedIds.has(chapter.id)
                      return (
                        <button
                          key={chapter.id}
                          type="button"
                          className="onboarding-manual__chapter-button"
                          data-active={active ? 'true' : 'false'}
                          onClick={() => selectChapter(chapter.id)}
                          aria-current={active ? 'page' : undefined}
                        >
                          <span className="onboarding-manual__chapter-icon">{chapterIcon(chapter.icon)}</span>
                          <span className="onboarding-manual__chapter-copy">
                            <strong>{localize(chapter.title, lang)}</strong>
                            <small>{chapter.tourSteps.length} {copy.steps}</small>
                          </span>
                          {complete && (
                            <span className="onboarding-manual__chapter-complete" title={copy.learned}>
                              <span className="material-symbols-outlined" aria-hidden="true">check</span>
                              <span className="onboarding-manual__sr-only">{copy.learned}</span>
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </nav>

            {filteredChapters.length === 0 && (
              <div className="onboarding-manual__empty">
                <span className="material-symbols-outlined" aria-hidden="true">search_off</span>
                <strong>{copy.noResults}</strong>
                <p>{copy.noResultsHint}</p>
                <button type="button" onClick={() => setQuery('')}>{copy.clearSearch}</button>
              </div>
            )}
          </aside>

          <main className="onboarding-manual__content" key={activeChapter.id}>
            {filteredChapters.length === 0 ? (
              <div className="onboarding-manual__content-empty" role="status">
                <span className="material-symbols-outlined" aria-hidden="true">search_off</span>
                <h1>{copy.noResults}</h1>
                <p>{copy.noResultsHint}</p>
                <button type="button" onClick={() => setQuery('')}>{copy.clearSearch}</button>
              </div>
            ) : (
              <>
            <div className="onboarding-manual__content-scroll">
              <div className="onboarding-manual__chapter-heading">
                <span className="onboarding-manual__chapter-hero-icon">{chapterIcon(activeChapter.icon)}</span>
                <div>
                  <p className="onboarding-manual__breadcrumb">
                    {groupLabel(activeChapter.group, lang)} · {String(activeIndex + 1).padStart(2, '0')}
                  </p>
                  <h1>{localize(activeChapter.title, lang)}</h1>
                  <p>{localize(activeChapter.summary, lang)}</p>
                </div>
              </div>

              <section className="onboarding-manual__outcome" aria-labelledby="manual-outcome-title">
                <span className="material-symbols-outlined" aria-hidden="true">flag</span>
                <div>
                  <h2 id="manual-outcome-title">{copy.outcome}</h2>
                  <p>{localize(activeChapter.outcome, lang)}</p>
                </div>
              </section>

              {activeChapter.parameters.length > 0 && (
                <section className="onboarding-manual__section" aria-labelledby="manual-parameters-title">
                  <div className="onboarding-manual__section-heading">
                    <span className="material-symbols-outlined" aria-hidden="true">tune</span>
                    <h2 id="manual-parameters-title">{copy.parameters}</h2>
                    <span>{activeChapter.parameters.length}</span>
                  </div>
                  <div className="onboarding-manual__parameter-grid">
                    {activeChapter.parameters.map((parameter, index) => {
                      const options = itemOptions(parameter, lang)
                      return (
                        <article key={`${activeChapter.id}-parameter-${index}`} className="onboarding-manual__parameter-card">
                          <div className="onboarding-manual__parameter-index">{String(index + 1).padStart(2, '0')}</div>
                          <div>
                            <h3>{itemTitle(parameter, index, lang, copy.parameter)}</h3>
                            {itemBody(parameter, lang) && <p>{itemBody(parameter, lang)}</p>}
                            {options.length > 0 && (
                              <div className="onboarding-manual__option-list">
                                {options.map(option => <span key={option}>{option}</span>)}
                              </div>
                            )}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </section>
              )}

              {activeChapter.workflow.length > 0 && (
                <section className="onboarding-manual__section" aria-labelledby="manual-workflow-title">
                  <div className="onboarding-manual__section-heading">
                    <span className="material-symbols-outlined" aria-hidden="true">route</span>
                    <h2 id="manual-workflow-title">{copy.workflow}</h2>
                    <span>{activeChapter.workflow.length}</span>
                  </div>
                  <ol className="onboarding-manual__workflow-list">
                    {activeChapter.workflow.map((workflowStep, index) => (
                      <li key={`${activeChapter.id}-workflow-${index}`}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <div>
                          <h3>{itemTitle(workflowStep, index, lang, copy.step)}</h3>
                          {itemBody(workflowStep, lang) && <p>{itemBody(workflowStep, lang)}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {activeChapter.tips.length > 0 && (
                <section className="onboarding-manual__section" aria-labelledby="manual-tips-title">
                  <div className="onboarding-manual__section-heading">
                    <span className="material-symbols-outlined" aria-hidden="true">lightbulb</span>
                    <h2 id="manual-tips-title">{copy.tips}</h2>
                  </div>
                  <div className="onboarding-manual__tip-list">
                    {activeChapter.tips.map((tip, index) => (
                      <div key={`${activeChapter.id}-tip-${index}`}>
                        <span className="material-symbols-outlined" aria-hidden="true">check_circle</span>
                        <p>{itemBody(tip, lang) || itemTitle(tip, index, lang, copy.tip)}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(activeChapter.commonIssues?.length ?? 0) > 0 && (
                <section className="onboarding-manual__section" aria-labelledby="manual-issues-title">
                  <div className="onboarding-manual__section-heading">
                    <span className="material-symbols-outlined" aria-hidden="true">help</span>
                    <h2 id="manual-issues-title">{copy.issues}</h2>
                  </div>
                  <div className="onboarding-manual__issue-list">
                    {activeChapter.commonIssues?.map((issue, index) => (
                      <details key={`${activeChapter.id}-issue-${index}`}>
                        <summary>
                          <span>{itemTitle(issue, index, lang, copy.issue)}</span>
                          <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
                        </summary>
                        <p>{itemBody(issue, lang)}</p>
                      </details>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <footer className="onboarding-manual__footer">
              <div className="onboarding-manual__chapter-pager">
                <button
                  type="button"
                  onClick={() => previousChapter && selectChapter(previousChapter.id)}
                  disabled={!previousChapter}
                  aria-label={copy.previous}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
                  <span>{previousChapter ? localize(previousChapter.title, lang) : copy.previous}</span>
                </button>
                <button
                  type="button"
                  onClick={() => nextChapter && selectChapter(nextChapter.id)}
                  disabled={!nextChapter}
                  aria-label={copy.next}
                >
                  <span>{nextChapter ? localize(nextChapter.title, lang) : copy.next}</span>
                  <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                </button>
              </div>

              <div className="onboarding-manual__primary-actions">
                <button
                  type="button"
                  className="onboarding-manual__complete-button"
                  data-complete={completedIds.has(activeChapter.id) ? 'true' : 'false'}
                  onClick={completeChapter}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">check_circle</span>
                  {completedIds.has(activeChapter.id) ? copy.learned : copy.markComplete}
                </button>
                <button
                  type="button"
                  className="onboarding-manual__tour-button"
                  onClick={launchChapterTour}
                  disabled={activeChapter.tourSteps.length === 0}
                  aria-label={copy.startTour}
                  title={activeChapter.tourSteps.length === 0 ? copy.noTour : undefined}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">play_arrow</span>
                  {copy.startTour}
                  <small>{activeChapter.tourSteps.length}</small>
                </button>
              </div>
            </footer>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

export default OnboardingManual
