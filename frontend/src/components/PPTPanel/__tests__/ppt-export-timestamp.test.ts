import { describe, expect, it } from 'vitest'
import { formatPptExportTimestamp } from '../ppt-export-timestamp'

describe('formatPptExportTimestamp', () => {
  it('renders an exported PPT timestamp without raw ISO metadata', () => {
    const rendered = formatPptExportTimestamp('2026-08-31T06:26:57.947545+00:00')
    expect(rendered).toMatch(/^\d{2}\/\d{2}\s+\d{2}:\d{2}$/)
    expect(rendered).not.toContain('T')
    expect(rendered).not.toContain('+00:00')
  })

  it('omits an invalid timestamp instead of exposing backend data', () => {
    expect(formatPptExportTimestamp('not-a-timestamp')).toBe('')
  })
})
