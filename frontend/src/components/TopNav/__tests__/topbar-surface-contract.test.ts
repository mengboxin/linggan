import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_TOPBAR_SURFACES = [
  'pages/EditorPage.tsx',
  'pages/CanvasFlowPage.tsx',
  'pages/PPTPresentationPage.tsx',
  'pages/PublicGalleryPage.tsx',
  'pages/ImagePromptPage.tsx',
  'pages/ProfilePage.tsx',
  'pages/RechargePage.tsx',
  'pages/ModelsPage.tsx',
  'pages/DownloadPage.tsx',
  'pages/PsPluginSetupPage.tsx',
]

describe('desktop topbar surface contract', () => {
  it.each(DESKTOP_TOPBAR_SURFACES)('%s uses the shared floating topbar', relativePath => {
    const source = readFileSync(resolve(process.cwd(), 'src', relativePath), 'utf8')
    expect(source).toContain('FloatingTopBar')
    expect(source).toContain('TopBarPinButton')
    expect(source).toContain('app-topbar-page')
  })

  it.each([
    'pages/PPTPresentationPage.tsx',
    'components/TopNav/TopNav.tsx',
  ])('%s uses appearance tokens for the own-key status', relativePath => {
    const source = readFileSync(resolve(process.cwd(), 'src', relativePath), 'utf8')
    const statusTag = source.match(/<div\s+data-compute-source-status[\s\S]*?>/)?.[0] || ''
    expect(statusTag).toContain('var(--app-control)')
    expect(statusTag).toContain('var(--app-text)')
    expect(statusTag).not.toMatch(/(?:emerald|cyan)-\d/)
  })
})
