import { apiUrl } from './auth'

export type LegalDocumentType = 'terms' | 'privacy' | 'ai' | 'payment'

export interface LegalDocumentSnapshot {
  documentType: LegalDocumentType
  version: string
  title: string
  summary: string
  contentHash: string
  publishedOn: string
  effectiveOn: string
  requiresReacceptance: boolean
  requiredAtLogin: boolean
  contentMarkdown: string
}

export interface LegalAcceptanceClaim {
  documentType: LegalDocumentType
  version: string
  contentHash: string
}

function isLegalDocumentType(value: unknown): value is LegalDocumentType {
  return value === 'terms' || value === 'privacy' || value === 'ai' || value === 'payment'
}

function parseLegalDocument(value: unknown): LegalDocumentSnapshot {
  const document = value as Partial<LegalDocumentSnapshot> | null
  if (
    !document ||
    !isLegalDocumentType(document.documentType) ||
    typeof document.version !== 'string' ||
    typeof document.title !== 'string' ||
    typeof document.summary !== 'string' ||
    typeof document.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(document.contentHash) ||
    typeof document.contentMarkdown !== 'string'
  ) {
    throw new Error('法律文件响应格式不正确')
  }

  return {
    documentType: document.documentType,
    version: document.version,
    title: document.title,
    summary: document.summary,
    contentHash: document.contentHash,
    publishedOn: String(document.publishedOn || ''),
    effectiveOn: String(document.effectiveOn || ''),
    requiresReacceptance: Boolean(document.requiresReacceptance),
    requiredAtLogin: Boolean(document.requiredAtLogin),
    contentMarkdown: document.contentMarkdown,
  }
}

export async function fetchLegalDocument(
  documentType: LegalDocumentType,
  signal?: AbortSignal,
): Promise<LegalDocumentSnapshot> {
  const response = await fetch(apiUrl(`/api/legal/documents/${documentType}`), {
    cache: 'no-store',
    signal,
  })
  if (response.status === 404) {
    const { bundledLegalDocument } = await import('../components/LegalDocument')
    return bundledLegalDocument(documentType)
  }
  if (!response.ok) throw new Error('法律文件暂时无法加载')
  return parseLegalDocument(await response.json())
}

export async function fetchLegalDocuments(
  documentTypes: readonly LegalDocumentType[],
  signal?: AbortSignal,
): Promise<LegalDocumentSnapshot[]> {
  return Promise.all(documentTypes.map(documentType => fetchLegalDocument(documentType, signal)))
}

export function legalAcceptanceClaim(document: LegalDocumentSnapshot): LegalAcceptanceClaim {
  return {
    documentType: document.documentType,
    version: document.version,
    contentHash: document.contentHash,
  }
}
