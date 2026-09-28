import { isElectron } from './electron'

export function usesHashRouting(): boolean {
  if (typeof window === 'undefined') return false
  return isElectron() || window.location.protocol === 'file:'
}

export function routeHref(path: string): string {
  if (!path.startsWith('/')) return path
  return usesHashRouting() ? `#${path}` : path
}

export function navigateRoute(path: string, options: { replace?: boolean } = {}) {
  const href = routeHref(path)
  if (options.replace) {
    window.location.replace(href)
  } else {
    window.location.href = href
  }
}
