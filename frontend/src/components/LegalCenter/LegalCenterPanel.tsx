import {
  legalDocumentMeta,
  legalDocumentStatusLabel,
  legalDocumentTypes,
} from '../LegalDocument'
import { routeHref } from '../../lib/navigation'
import './legal-center-panel.css'

const SUPPORT_WECHAT = 'wj040204520'
const SUPPORT_EMAIL = '2558212076@qq.com'

export default function LegalCenterPanel({
  variant = 'desktop',
  returnTo,
}: {
  variant?: 'desktop' | 'mobile'
  returnTo: string
}) {
  const buildDocumentHref = (path: string) => routeHref(`${path}?from=${encodeURIComponent(returnTo)}`)

  return (
    <section
      className={`legal-center legal-center--${variant}`}
      aria-labelledby={`legal-center-title-${variant}`}
    >
      <header className="legal-center__header">
        <span className="legal-center__mark material-symbols-outlined" aria-hidden="true">policy</span>
        <div>
          <h2 id={`legal-center-title-${variant}`}>协议与隐私</h2>
          <p>查看灵感的使用、隐私、AI 内容与付费说明。</p>
        </div>
      </header>

      <div className="legal-center__grid">
        {legalDocumentTypes.map(type => {
          const document = legalDocumentMeta[type]
          return (
            <a
              key={type}
              href={buildDocumentHref(document.path)}
              className="legal-center__card"
              aria-label={`查看${document.title}`}
            >
              <span className="legal-center__card-icon material-symbols-outlined" aria-hidden="true">
                {document.icon}
              </span>
              <span className="legal-center__card-copy">
                <strong>{document.title}</strong>
                <small>{document.subtitle}</small>
                <span className="legal-center__meta">
                  <em>{legalDocumentStatusLabel[document.status]}</em>
                  <span>版本 {document.version}</span>
                </span>
              </span>
              <span className="legal-center__arrow material-symbols-outlined" aria-hidden="true">arrow_outward</span>
            </a>
          )
        })}
      </div>

      <footer className="legal-center__footer">
        <span className="material-symbols-outlined" aria-hidden="true">chat</span>
        <div>
          <strong>联系支持</strong>
          <p>微信：{SUPPORT_WECHAT}</p>
          <p>邮箱：<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
        </div>
      </footer>
    </section>
  )
}
