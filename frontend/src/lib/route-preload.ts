export type PreloadableCreationRoute =
  | 'PRESENTATION'
  | 'GALLERY'
  | 'IMAGE_PROMPT'
  | 'CANVAS_FLOW'

export type PreloadableAccountRoute =
  | 'PROFILE'
  | 'RECHARGE'
  | 'DOWNLOAD'

const loaders: Record<PreloadableCreationRoute, () => Promise<unknown>> = {
  PRESENTATION: () => import('../pages/PPTPresentationPage'),
  GALLERY: () => import('../pages/PublicGalleryPage'),
  IMAGE_PROMPT: () => import('../pages/ImagePromptPage'),
  CANVAS_FLOW: () => import('../pages/CanvasFlowPage'),
}

export const loadProfileRoute = () => import('../pages/ProfilePage')

export function preloadProfileRoute() {
  void loadProfileRoute().catch(() => undefined)
}

const accountLoaders: Record<PreloadableAccountRoute, () => Promise<unknown>> = {
  PROFILE: loadProfileRoute,
  RECHARGE: () => import('../pages/RechargePage'),
  DOWNLOAD: () => import('../pages/DownloadPage'),
}

export function preloadCreationRoute(route: PreloadableCreationRoute) {
  void loaders[route]().catch(() => undefined)
}

export function preloadPrimaryCreationRoutes() {
  for (const route of Object.keys(loaders) as PreloadableCreationRoute[]) {
    preloadCreationRoute(route)
  }
}

export function preloadAccountRoute(route: PreloadableAccountRoute) {
  void accountLoaders[route]().catch(() => undefined)
}
