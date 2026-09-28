import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useThemeStore } from '../lib/theme'
import { auth } from '../lib/auth'
import { LegalDocument, type LegalDocumentType } from './LegalDocument'
import { fetchLegalDocument, type LegalDocumentSnapshot } from '../lib/legal'

export function LegalPageShell({ type }: { type: LegalDocumentType }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'
  const [document, setDocument] = useState<LegalDocumentSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setDocument(null)
    setLoadError('')
    void fetchLegalDocument(type, controller.signal)
      .then(setDocument)
      .catch(error => {
        if (controller.signal.aborted) return
        setLoadError(error instanceof Error ? error.message : '法律文件暂时无法加载')
      })
    return () => controller.abort()
  }, [type])

  const goBack = () => {
    const from = searchParams.get('from')
    if (from?.startsWith('/') && !from.startsWith('//')) {
      navigate(from, { replace: true })
      return
    }
    navigate(auth.isLoggedIn() ? '/profile?tab=legal' : '/login', { replace: true })
  }

  return (
    <div
      className="min-h-screen px-4 py-8 sm:py-12"
      style={{ background: 'var(--app-workspace)', color: 'var(--app-text)' }}
    >
      <div
        className="mx-auto max-w-3xl rounded-2xl p-5 sm:p-8"
        style={{
          background: 'var(--app-glass-strong)',
          border: '1px solid var(--app-border)',
          boxShadow: 'var(--app-shadow)',
          backdropFilter: 'blur(24px) saturate(125%)',
        }}
      >
        {document ? (
          <LegalDocument type={type} document={document} isDark={isDark} />
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center" role={loadError ? 'alert' : 'status'}>
            <span className="material-symbols-outlined text-[28px] text-[var(--app-muted)]">
              {loadError ? 'cloud_off' : 'progress_activity'}
            </span>
            <strong className="text-sm text-[var(--app-text)]">
              {loadError || '正在加载当前生效的法律文件...'}
            </strong>
            {loadError && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control)] px-4 py-2 text-xs font-semibold text-[var(--app-text)]"
              >
                重新加载
              </button>
            )}
          </div>
        )}

        <div className="mt-8 border-t pt-6 text-center" style={{ borderColor: 'var(--app-border)' }}>
          <button
            type="button"
            onClick={goBack}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors"
            style={{
              background: 'var(--app-control)',
              border: '1px solid var(--app-border-strong)',
              color: 'var(--app-text)',
            }}
          >
            <span className="material-symbols-outlined text-[17px]">arrow_back</span>
            返回
          </button>
        </div>
      </div>
    </div>
  )
}
