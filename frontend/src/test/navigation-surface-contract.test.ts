import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('navigation and selected surfaces', () => {
  it('keeps workflow and creation-mode selections theme-driven instead of solid black', () => {
    const editorSurface = source('src/pages/editor-surface.css')
    const globalSurface = source('src/index.css')

    expect(editorSurface).toMatch(/\.image-edit-view-switcher__button\[data-active='true'\][\s\S]*?background:\s*var\(--app-control\)/)
    expect(globalSurface).toMatch(/\.studio-mode-switcher__item--active\s*\{[\s\S]*?background:\s*var\(--app-control\)/)
    expect(editorSurface).not.toMatch(/\.image-edit-view-switcher__button\[data-active='true'\][\s\S]*?background:\s*var\(--app-primary-gradient\)/)
    expect(globalSurface).not.toMatch(/\.studio-mode-switcher__item--active\s*\{[\s\S]*?background:\s*var\(--app-primary-gradient\)/)
  })

  it('labels recharge back navigation as personal-center navigation and avoids the missing glyph', () => {
    const recharge = source('src/pages/RechargePage.tsx')

    expect(recharge).toContain("lang === 'zh' ? '返回个人中心' : 'Personal center'")
    expect(recharge).not.toContain('arrow_outward')
  })
})
