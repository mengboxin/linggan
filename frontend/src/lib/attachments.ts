import { auth, apiUrl } from './auth'

export interface ParsedAttachment {
  filename: string
  kind: string
  text: string
  size: number
  warnings?: string[]
}

export const ATTACHMENT_ACCEPT = [
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.xlsx',
  '.xls',
].join(',')

function parseErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const detail = (payload as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail.trim()
  return ''
}

function attachmentParseError(status: number, payload: unknown): string {
  const detail = parseErrorDetail(payload)
  if (detail) return detail
  if (status === 404) return '附件解析服务暂不可用，请刷新后重试。'
  if (status === 413) return '附件过大，当前无法上传解析。'
  if (status >= 500) return '附件解析服务暂时异常，请稍后重试。'
  return '附件无法读取，请确认文件未损坏后重试。'
}

export async function parseAttachments(files: File[]): Promise<ParsedAttachment[]> {
  if (!files.length) return []
  const form = new FormData()
  files.forEach(file => form.append('files', file, file.name))
  const res = await auth.fetchWithAuth(apiUrl('/api/attachments/parse'), {
    method: 'POST',
    body: form,
  })
  const raw = await res.text()
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    throw new Error(attachmentParseError(res.status, data))
  }
  const attachments = data && typeof data === 'object' && Array.isArray((data as { attachments?: unknown }).attachments)
    ? (data as { attachments: ParsedAttachment[] }).attachments
    : []
  if (!attachments.length) throw new Error('附件未返回可用内容，请重新选择文件。')
  return attachments
}

export function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}
