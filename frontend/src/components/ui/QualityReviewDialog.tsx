import type { ReactNode } from 'react'

export interface QualityReviewDecision {
  message?: string
  issues?: string[]
  repair_prompt?: string
  current_result_available?: boolean
}

interface QualityReviewDialogProps {
  review: QualityReviewDecision | null
  previewSrc?: string
  isDark: boolean
  onKeep: () => void
  onCreateRevision: () => void | Promise<void>
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="material-symbols-outlined text-[17px]">{children}</span>
}

/** A user decision gate after QA; it never retries the completed task itself. */
export function QualityReviewDialog({
  review,
  previewSrc = '',
  onKeep,
  onCreateRevision,
}: QualityReviewDialogProps) {
  if (!review) return null
  const issues = (review.issues || []).filter(Boolean).slice(0, 4)
  const bg = 'var(--app-panel)'
  const border = 'var(--app-border)'
  const muted = 'var(--app-muted)'
  const accent = 'var(--app-primary)'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--app-overlay)] p-4" role="dialog" aria-modal="true" aria-label="结果检查建议">
      <section className="w-full max-w-[560px] border shadow-2xl" style={{ background: bg, borderColor: border }}>
        <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: border }}>
          <span className="flex h-7 w-7 items-center justify-center" style={{ color: accent, background: 'var(--app-accent-soft)' }}>
            <Icon>fact_check</Icon>
          </span>
          <div>
            <h2 className="text-[13px] font-bold" style={{ color: 'var(--app-text)' }}>结果已生成</h2>
            <p className="mt-0.5 text-[10px]" style={{ color: muted }}>检查建议不会自动重新生成</p>
          </div>
        </header>
        <div className="flex gap-4 p-4">
          {previewSrc && (
            <img src={previewSrc} alt="当前生成结果" className="h-[142px] w-[142px] shrink-0 border object-cover" style={{ borderColor: border }} />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-5" style={{ color: 'var(--app-text)' }}>
              {review.message || '当前结果已经可用，检查发现还有可选的优化方向。'}
            </p>
            {issues.length > 0 && (
              <ul className="mt-2 space-y-1 text-[10px] leading-4" style={{ color: muted }}>
                {issues.map(issue => <li key={issue}>- {issue}</li>)}
              </ul>
            )}
            {review.repair_prompt && (
              <p className="mt-2 border-l-2 pl-2 text-[10px] leading-4" style={{ borderColor: accent, color: muted }}>
                建议修订：{review.repair_prompt}
              </p>
            )}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: border }}>
          <button type="button" onClick={onKeep} className="border px-3 py-1.5 text-[11px] font-bold" style={{ color: muted, borderColor: border }}>
            保留当前结果
          </button>
          <button type="button" onClick={() => void onCreateRevision()} className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold" style={{ color: 'var(--app-on-accent)', background: accent }}>
            <Icon>auto_fix</Icon>
            生成修订版
          </button>
        </footer>
      </section>
    </div>
  )
}
