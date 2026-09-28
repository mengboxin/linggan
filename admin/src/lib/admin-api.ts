/**
 * 管理后台 API 客户端
 * - 统一带上 admin_token
 * - 401 时自动跳转登录页
 */

function getToken(): string | null {
  return localStorage.getItem('admin_token')
}

function clearAndRedirect() {
  localStorage.removeItem('admin_token')
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
}

export async function adminFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    clearAndRedirect()
  }
  return res
}

export async function adminFetchJson<T = unknown>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await adminFetch(input, init)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`${res.status}: ${errText || res.statusText}`)
  }
  return res.json() as Promise<T>
}
