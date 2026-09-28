import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('account center surfaces', () => {
  it('presents billing inside the account dashboard shell', () => {
    const rechargePage = readSource('src/pages/RechargePage.tsx')

    expect(rechargePage).toContain('className="recharge-account-layout')
    expect(rechargePage).toContain('className="recharge-account-sidebar')
    expect(rechargePage).toContain('className="recharge-account-content')
    expect(rechargePage).toContain('data-billing-section="compute"')
    expect(rechargePage).toContain('data-billing-section="membership"')
    expect(rechargePage).toContain('data-billing-section="credits"')
    expect(rechargePage).toContain('data-billing-section="orders"')
  })

  it('uses semantic theme surfaces throughout the pet selector', () => {
    const petSelector = readSource('src/components/PetSelector/PetSelector.tsx')
    const mobilePet = readSource('src/components/Mobile/MobilePet.tsx')
    const petHistory = readSource('src/components/PetChatHistory/PetChatHistory.tsx')

    expect(petSelector).toContain('var(--app-control)')
    expect(petSelector).toContain('var(--app-panel-raised)')
    expect(petSelector).not.toContain('rgba(255,183,77')
    expect(mobilePet).not.toContain('rgba(255,183,77')
    expect(petHistory).not.toMatch(/#(?:F9ECDF|FFF8E8|EEE0D4)/i)
  })
})
