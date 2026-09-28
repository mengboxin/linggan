import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('profile route readiness', () => {
  it('shares one preloadable profile loader between React.lazy and idle preloading', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
    const preload = readFileSync(join(process.cwd(), 'src/lib/route-preload.ts'), 'utf8')

    expect(preload).toContain('loadProfileRoute')
    expect(preload).toContain('preloadProfileRoute')
    expect(app).toContain('lazy(loadProfileRoute)')
    expect(app).toContain('preloadProfileRoute()')
  })

  it('uses access-token readiness rather than waiting for user metadata on every protected route mount', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')

    expect(app).toContain('auth.ensureAccessSession()')
    expect(app).not.toMatch(/function RequireAuth[\s\S]*?auth\.ensureValidSession\(\)[\s\S]*?return \<\>\{children\}\<\/>/)
  })

  it('keeps the profile header sticky in the document scroll container', () => {
    const profilePage = readFileSync(join(process.cwd(), 'src/pages/ProfilePage.tsx'), 'utf8')

    expect(profilePage).toContain('className="profile-header fixed inset-x-0 top-0 z-[100] h-14')
    expect(profilePage).not.toMatch(/className="profile-page[^\"]*overflow-hidden/)
    expect(profilePage).toContain('className="profile-dashboard-layout')
    expect(profilePage).toContain('className="profile-dashboard-sidebar')
    expect(profilePage).toContain('className="profile-activity-grid')
  })
})
