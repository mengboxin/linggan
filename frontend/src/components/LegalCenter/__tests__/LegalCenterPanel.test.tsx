import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import LegalCenterPanel from '../LegalCenterPanel'
import { LEGAL_VERSION, legalDocumentMeta, legalDocumentTypes } from '../../LegalDocument'

describe('LegalCenterPanel', () => {
  it('lists every current legal document with a versioned public link', () => {
    render(<LegalCenterPanel variant="desktop" returnTo="/profile?tab=legal" />)

    expect(legalDocumentTypes).toEqual(['terms', 'privacy', 'ai', 'payment'])
    expect(new Set(legalDocumentTypes.map(type => legalDocumentMeta[type].version))).toEqual(new Set([LEGAL_VERSION]))

    legalDocumentTypes.forEach(type => {
      const document = legalDocumentMeta[type]
      const link = screen.getByRole('link', { name: `查看${document.title}` })
      expect(link).toHaveAttribute('href', `${document.path}?from=%2Fprofile%3Ftab%3Dlegal`)
    })
    expect(screen.getByText('联系支持')).toBeInTheDocument()
    expect(screen.getByText('微信：wj040204520')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '2558212076@qq.com' })).toHaveAttribute('href', 'mailto:2558212076@qq.com')
    expect(screen.queryByText(/备案信息/)).not.toBeInTheDocument()
  })

})
