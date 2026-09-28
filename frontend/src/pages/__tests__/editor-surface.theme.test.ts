import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/pages/editor-surface.css'),
  'utf8',
)

describe('image editor light theme controls', () => {
  it('uses the configured light accent for the active workflow view', () => {
    const lightRulesStart = stylesheet.indexOf(".image-edit-mode-switcher__button[data-active='true'],")
    const darkRulesStart = stylesheet.indexOf('.dark .image-edit-mode-switcher,')
    const lightRules = stylesheet.slice(lightRulesStart, darkRulesStart)

    expect(lightRulesStart).toBeGreaterThan(-1)
    expect(darkRulesStart).toBeGreaterThan(lightRulesStart)
    expect(lightRules).toContain('var(--app-accent-gradient')
    expect(lightRules).toContain('var(--app-on-accent')
  })
})
