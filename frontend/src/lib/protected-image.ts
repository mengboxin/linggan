import { apiUrl, auth } from './auth'

export function protectedImageUrl(url?: string) {
  if (!url) return ''
  if (/^(https?:|blob:|data:)/i.test(url)) return url
  const fullUrl = apiUrl(url)
  if (!url.startsWith('/api/assets/')) return fullUrl
  const token = auth.getAccessToken()
  if (!token) return fullUrl
  const sep = fullUrl.includes('?') ? '&' : '?'
  return `${fullUrl}${sep}token=${encodeURIComponent(token)}`
}
