import { useEffect, useId, useRef, useState } from 'react'
import { apiUrl, auth } from '../../lib/auth'
import { normalizeCreativeStylePreset, type CreativeStylePreset } from '../../lib/creative-style-presets'
import { StableIcon } from '../ui/StableIcon'

type ImportSource = 'zip' | 'github'
type ImportPhase = 'idle' | 'inspecting' | 'review' | 'importing' | 'success'

interface CreativeSkillCandidate {
  name: string
  visual_summary: string
  style_tags: string[]
  composition: string
  lighting: string
  palette: string[]
  materials: string
  camera: string
  negative_prompt: string
  execution_instructions: string
  source_name?: string
  source_url?: string
  preview_url?: string
}

interface SkillImportReview {
  category?: string
  confidence?: number
  checks?: Array<{ id?: string; label: string; passed: boolean }>
  warnings?: string[]
}

interface SkillInspectResult {
  accepted: boolean
  review_token?: string
  candidate?: CreativeSkillCandidate
  review?: SkillImportReview
  cleanup?: { temporary_upload_deleted?: boolean }
}

interface CreativeSkillImportDialogProps {
  open: boolean
  isDark: boolean
  onClose: () => void
  onImported: (style: CreativeStylePreset) => void
}

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    if (typeof payload?.detail === 'string' && payload.detail.trim()) return payload.detail.trim()
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim()
  } catch {
    // Use the product-level error below when the server did not return JSON.
  }
  return ''
}

function reviewConfidence(review?: SkillImportReview) {
  const raw = Number(review?.confidence || 0)
  return Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)))
}

export function CreativeSkillImportDialog({
  open,
  isDark,
  onClose,
  onImported,
}: CreativeSkillImportDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<ImportSource>('zip')
  const [archive, setArchive] = useState<File | null>(null)
  const [githubUrl, setGithubUrl] = useState('')
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [result, setResult] = useState<SkillInspectResult | null>(null)
  const [error, setError] = useState('')

  const busy = phase === 'inspecting' || phase === 'importing'
  const candidate = result?.candidate
  const review = result?.review
  const reviewToken = result?.review_token?.trim() || ''

  const clearArchiveSelection = () => {
    setArchive(null)
    if (archiveInputRef.current) archiveInputRef.current.value = ''
  }

  const resetReview = (nextSource = source) => {
    if (nextSource !== 'zip') clearArchiveSelection()
    setSource(nextSource)
    setPhase('idle')
    setResult(null)
    setError('')
  }

  useEffect(() => {
    if (!open) return
    setPhase('idle')
    setResult(null)
    setError('')
    setGithubUrl('')
    clearArchiveSelection()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  if (!open) return null

  const inspect = async () => {
    setError('')
    if (source === 'zip') {
      if (!archive) {
        setError('请先选择 ZIP 配方包')
        return
      }
      if (!archive.name.toLocaleLowerCase().endsWith('.zip')) {
        setError('仅支持 ZIP 格式的配方包')
        return
      }
      if (archive.size > MAX_ARCHIVE_BYTES) {
        setError('ZIP 配方包不能超过 10 MB')
        return
      }
    } else {
      let parsed: URL
      try {
        parsed = new URL(githubUrl.trim())
      } catch {
        setError('请输入完整的 GitHub 仓库地址')
        return
      }
      if (parsed.protocol !== 'https:' || parsed.hostname.toLocaleLowerCase() !== 'github.com') {
        setError('仅支持 github.com 的 HTTPS 仓库地址')
        return
      }
    }

    setPhase('inspecting')
    setResult(null)
    try {
      const form = new FormData()
      if (source === 'zip' && archive) form.append('archive', archive)
      if (source === 'github') form.append('github_url', githubUrl.trim())
      const response = await auth.fetchWithAuth(apiUrl('/api/creative-styles/import/inspect'), {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        const detail = await responseError(response)
        throw new Error(response.status === 422 ? '未解析到生图相关的风格模板' : detail || '配方审核失败，请稍后重试')
      }
      const payload = await response.json() as SkillInspectResult
      if (!payload.accepted || !payload.candidate) {
        throw new Error('未解析到生图相关的风格模板')
      }
      setResult(payload)
      setPhase('review')
      if (!payload.review_token?.trim()) setError('审核结果已失效，请重新检查配方')
    } catch (reason) {
      setPhase('idle')
      setError(reason instanceof Error ? reason.message : '配方审核失败，请稍后重试')
    } finally {
      if (source === 'zip') clearArchiveSelection()
    }
  }

  const confirmImport = async () => {
    if (!candidate) return
    if (!reviewToken) {
      setError('审核结果已失效，请重新检查配方')
      return
    }
    setError('')
    setPhase('importing')
    try {
      const response = await auth.fetchWithAuth(apiUrl('/api/creative-styles/import/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_token: reviewToken }),
      })
      if (!response.ok) throw new Error(await responseError(response) || '配方保存失败，请稍后重试')
      const payload = await response.json()
      const style = normalizeCreativeStylePreset(payload?.item)
      if (!style) throw new Error('服务端返回的配方信息不完整')
      onImported(style)
      setPhase('success')
    } catch (reason) {
      setPhase('review')
      setError(reason instanceof Error ? reason.message : '配方保存失败，请稍后重试')
    }
  }

  const close = () => {
    if (busy) return
    onClose()
  }

  const textMain = 'text-[var(--app-text)]'
  const textMuted = 'text-[var(--app-muted)]'
  const border = 'border-[var(--app-border)]'
  const softPanel = 'border-[var(--app-border)] bg-[var(--app-panel-soft)]'

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/48 p-0 backdrop-blur-md sm:items-center sm:p-6"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') close()
          if (event.key === 'Tab') {
            const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ) || []).filter(element => element.offsetParent !== null)
            if (!focusable.length) return
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
        }}
        className={`relative max-h-[92vh] w-full overflow-hidden rounded-t-[26px] border bg-[var(--app-glass-strong)] shadow-[var(--app-shadow-raised)] outline-none sm:max-w-[760px] sm:rounded-[26px] ${border}`}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,var(--app-primary-soft),transparent_38%)]" />
        <div className="relative flex max-h-[92vh] flex-col">
          <header className={`flex items-start justify-between gap-4 border-b px-5 py-5 sm:px-7 ${border}`}>
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-primary-soft)] text-[var(--app-primary)] shadow-sm">
                <StableIcon name="auto_awesome" className="text-[20px]" />
              </span>
              <div className="min-w-0">
                <h2 id={titleId} className={`text-[19px] font-black ${textMain}`}>导入生图灵感配方</h2>
                <p id={descriptionId} className={`mt-1 max-w-xl text-[11px] leading-5 ${textMuted}`}>
                  上传 ZIP 配方包或填写 GitHub 仓库。系统只提炼生图相关的视觉规则，并在隔离审核后清理临时文件。
                </p>
              </div>
            </div>
            <button type="button" onClick={close} disabled={busy} aria-label="关闭导入配方" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)] disabled:opacity-35">
              <StableIcon name="close" className="text-[18px]" />
            </button>
          </header>

          <div className="custom-scrollbar overflow-y-auto px-5 py-5 sm:px-7">
            {phase === 'success' ? (
              <div className="flex min-h-[310px] flex-col items-center justify-center text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--app-border)] bg-[var(--app-primary-soft)] text-[var(--app-primary)]">
                  <StableIcon name="check_circle" className="text-[30px]" />
                </span>
                <h3 className={`mt-5 text-[20px] font-black ${textMain}`}>灵感配方已导入</h3>
                <p className={`mt-2 max-w-md text-[11px] leading-5 ${textMuted}`}>它已经出现在技能广场中，下一次只需选择配方并提供主题或参考图即可复用完整视觉规则。</p>
                <button type="button" onClick={onClose} className="mt-6 h-11 rounded-xl bg-[var(--app-primary-gradient)] px-6 text-[11px] font-black text-[var(--app-on-primary)] hover:brightness-105">完成</button>
              </div>
            ) : (
              <>
                <div role="group" aria-label="配方来源" className={`grid grid-cols-2 gap-1 rounded-2xl border p-1 ${softPanel}`}>
                  {([
                    ['zip', 'ZIP 配方包', 'upload_image'],
                    ['github', 'GitHub 仓库', 'account_tree'],
                  ] as const).map(([id, label, icon]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={source === id}
                      onClick={() => resetReview(id)}
                      disabled={busy}
                      className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[11px] font-black transition ${source === id ? 'bg-[var(--app-control)] text-[var(--app-text)] shadow-sm' : textMuted}`}
                    >
                      <StableIcon name={icon} className="text-[16px]" />
                      {label}
                    </button>
                  ))}
                </div>

                <section className={`mt-4 rounded-2xl border p-4 sm:p-5 ${softPanel}`}>
                  {source === 'zip' ? (
                    <div>
                      <label htmlFor="creative-skill-archive" className="group flex min-h-[130px] cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel-soft)] px-4 text-center transition hover:border-[var(--app-primary)] hover:bg-[var(--app-control-hover)]">
                        <StableIcon name="upload_image" className="text-[28px] text-[var(--app-primary)]" />
                        <span className={`mt-2 text-[12px] font-black ${textMain}`}>{archive?.name || '选择 ZIP 配方包'}</span>
                        <span className={`mt-1 text-[10px] ${textMuted}`}>最大 10 MB，仅提取说明、示例和视觉规则</span>
                      </label>
                      <input
                        id="creative-skill-archive"
                        ref={archiveInputRef}
                        aria-label="选择 ZIP 配方包"
                        className="sr-only"
                        type="file"
                        accept=".zip,application/zip,application/x-zip-compressed"
                        onChange={event => {
                          setArchive(event.target.files?.[0] || null)
                          setResult(null)
                          setPhase('idle')
                          setError('')
                        }}
                      />
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="creative-skill-github" className={`text-[11px] font-black ${textMain}`}>GitHub 仓库地址</label>
                      <div className={`mt-2 flex items-center gap-2 rounded-xl border bg-[var(--app-control)] px-3 ${border}`}>
                        <StableIcon name="account_tree" className={`text-[17px] ${textMuted}`} />
                        <input
                          id="creative-skill-github"
                          aria-label="GitHub 仓库地址"
                          value={githubUrl}
                          onChange={event => {
                            setGithubUrl(event.target.value)
                            setResult(null)
                            setPhase('idle')
                            setError('')
                          }}
                          placeholder="https://github.com/owner/image-skill"
                          className={`h-12 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-45 ${textMain}`}
                        />
                      </div>
                      <p className={`mt-2 text-[10px] leading-5 ${textMuted}`}>只读取公开仓库内容，不执行仓库中的脚本、安装命令或二进制文件。</p>
                    </div>
                  )}
                </section>

                {candidate && phase !== 'idle' && phase !== 'inspecting' && (
                  <section className={`mt-4 overflow-hidden rounded-2xl border bg-[var(--app-panel-soft)] ${border}`}>
                    <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_110px] sm:p-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-primary-soft)] px-2.5 py-1 text-[9px] font-black text-[var(--app-primary)]">生图风格模板</span>
                          {(candidate.style_tags || []).slice(0, 4).map(tag => <span key={tag} className={`text-[9px] font-bold ${textMuted}`}>#{tag}</span>)}
                        </div>
                        <h3 className={`mt-3 text-[18px] font-black ${textMain}`}>{candidate.name}</h3>
                        <p className={`mt-2 text-[11px] leading-5 ${textMuted}`}>{candidate.visual_summary}</p>
                      </div>
                      <div className={`flex min-h-[86px] flex-col items-center justify-center rounded-2xl border ${softPanel}`}>
                        <strong className={`text-[24px] font-black ${textMain}`}>{reviewConfidence(review)}%</strong>
                        <span className={`mt-1 text-[9px] font-bold ${textMuted}`}>审核置信度</span>
                      </div>
                    </div>
                    <div className={`grid gap-2 border-t p-4 sm:grid-cols-2 sm:p-5 ${border}`}>
                      {(review?.checks || []).map((check, index) => (
                        <div key={check.id || `${check.label}-${index}`} className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${softPanel}`}>
                          <StableIcon name={check.passed ? 'check_circle' : 'error'} className={`mt-0.5 text-[15px] ${check.passed ? 'text-[var(--app-primary)]' : 'text-rose-500'}`} />
                          <span className={`text-[10px] font-bold leading-5 ${textMain}`}>{check.label}</span>
                        </div>
                      ))}
                    </div>
                    {(review?.warnings?.length || result?.cleanup?.temporary_upload_deleted) && (
                      <div className={`border-t px-4 py-3 sm:px-5 ${border}`}>
                        {review?.warnings?.map(warning => <p key={warning} className={`text-[10px] leading-5 ${textMuted}`}>{warning}</p>)}
                        {result?.cleanup?.temporary_upload_deleted && (
                          <p className="mt-1 inline-flex items-center gap-1.5 text-[10px] font-black text-[var(--app-text)]">
                            <StableIcon name="delete_sweep" className="text-[14px]" />
                            临时上传文件已清理
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {error && <div role="alert" className={`mt-4 rounded-xl border px-3 py-2.5 text-[11px] font-bold ${isDark ? 'border-rose-300/20 bg-rose-300/8 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>{error}</div>}

                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button type="button" onClick={close} disabled={busy} className={`h-11 rounded-xl border bg-[var(--app-control)] px-5 text-[11px] font-black text-[var(--app-muted)] transition hover:bg-[var(--app-control-hover)] hover:text-[var(--app-text)] disabled:opacity-35 ${border}`}>取消</button>
                  {candidate && phase === 'review' ? (
                    <button type="button" onClick={() => void confirmImport()} disabled={!reviewToken} title={!reviewToken ? '审核结果已失效，请重新检查配方' : undefined} className="h-11 rounded-xl bg-[var(--app-primary-gradient)] px-5 text-[11px] font-black text-[var(--app-on-primary)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40">确认导入</button>
                  ) : (
                    <button type="button" onClick={() => void inspect()} disabled={busy} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--app-primary-gradient)] px-5 text-[11px] font-black text-[var(--app-on-primary)] transition hover:brightness-105 disabled:cursor-wait disabled:opacity-55">
                      {phase === 'inspecting' && <StableIcon name="loader" className="animate-spin text-[15px]" />}
                      {phase === 'inspecting' ? '正在隔离审核' : '检查配方'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
