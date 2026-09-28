import { useEffect, useState } from 'react'
import { LegalDocument } from './LegalDocument'
import { apiUrl, auth, LEGAL_RECONSENT_EVENT } from '../lib/auth'
import { legalAcceptanceClaim, type LegalDocumentSnapshot } from '../lib/legal'
import { navigateRoute } from '../lib/navigation'

type ReconsentDetail = {
  documents: LegalDocumentSnapshot[]
  reconsentAccessToken?: string | null
}

export default function LegalReconsentGate() {
  const [detail, setDetail] = useState<ReconsentDetail | null>(
    () => auth.getPendingLegalReconsent() as ReconsentDetail | null,
  )
  const [accepted, setAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<ReconsentDetail>).detail
      if (!next?.documents?.length) return
      setAccepted(false)
      setError('')
      setDetail(next)
    }
    window.addEventListener(LEGAL_RECONSENT_EVENT, handler)
    const pending = auth.getPendingLegalReconsent() as ReconsentDetail | null
    if (pending?.documents?.length) setDetail(pending)
    return () => window.removeEventListener(LEGAL_RECONSENT_EVENT, handler)
  }, [])

  if (!detail) return null

  const submit = async () => {
    if (!accepted || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(apiUrl('/api/legal/acceptances'), {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(detail.reconsentAccessToken
            ? { Authorization: `Bearer ${detail.reconsentAccessToken}` }
            : {}),
        },
        body: JSON.stringify({
          source: 'required-reconsent',
          items: detail.documents.map(legalAcceptanceClaim),
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.access_token || !payload.refresh_token || !payload.user) {
        throw new Error(payload?.detail?.message || payload?.detail || '协议确认失败，请稍后重试')
      }
      auth.save(payload.access_token, payload.refresh_token, payload.user)
      setDetail(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '协议确认失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  const leave = () => {
    auth.clear({ intentional: true })
    navigateRoute('/login', { replace: true })
  }

  return (
    <div className="fixed inset-0 z-[10000] overflow-y-auto bg-black/60 px-4 py-8 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="legal-reconsent-title">
      <div className="mx-auto max-w-3xl rounded-lg border border-white/15 bg-[var(--app-panel)] p-5 shadow-2xl sm:p-8">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase text-[var(--app-muted)]">重要协议更新</p>
          <h1 id="legal-reconsent-title" className="mt-2 text-2xl font-semibold text-[var(--app-text)]">确认后继续使用灵感</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--app-muted)]">请完整阅读下列当前生效文件。此确认不会自动包含付费服务或其他可选授权。</p>
        </header>
        <div className="max-h-[58vh] space-y-8 overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-surface)] p-4 sm:p-6">
          {detail.documents.map(document => (
            <LegalDocument key={`${document.documentType}:${document.version}`} type={document.documentType} document={document} compact />
          ))}
        </div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-[var(--app-text)]">
          <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} className="mt-1" />
          <span>我已阅读并同意上述当前版本的用户服务协议与隐私政策</span>
        </label>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={leave} className="rounded-md border border-[var(--app-border)] bg-[var(--app-control)] px-4 py-2.5 text-sm font-semibold text-[var(--app-muted)]">
            不同意并退出
          </button>
          <button type="button" disabled={!accepted || submitting} onClick={submit} className="rounded-md bg-[var(--app-primary)] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">
            {submitting ? '正在确认...' : '确认并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
