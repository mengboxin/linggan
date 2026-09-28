import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('public legal routes', () => {
  it('keeps all four legal documents publicly reachable', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')

    expect(app).toContain('<Route path="/terms" element={<TermsPage />} />')
    expect(app).toContain('<Route path="/privacy" element={<PrivacyPage />} />')
    expect(app).toContain('<Route path="/ai-disclaimer" element={<AiDisclaimerPage />} />')
    expect(app).toContain('<Route path="/payment-terms" element={<PaymentTermsPage />} />')
  })
})
