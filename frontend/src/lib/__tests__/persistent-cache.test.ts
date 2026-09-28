import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({
  auth: { getUser: () => ({ id: 'user-1' }) },
}))

import { readPersistentCache, userScopedCacheKey, writePersistentCache } from '../persistent-cache'

describe('persistent cache', () => {
  beforeEach(() => localStorage.clear())

  it('returns cached data synchronously with its freshness timestamp', () => {
    writePersistentCache('history', [{ id: 'record-1' }], 1234)

    expect(readPersistentCache('history', [])).toEqual({
      value: [{ id: 'record-1' }],
      savedAt: 1234,
    })
  })

  it('reads legacy raw arrays without treating them as fresh', () => {
    localStorage.setItem('history', JSON.stringify([{ id: 'legacy' }]))

    expect(readPersistentCache('history', [])).toEqual({
      value: [{ id: 'legacy' }],
      savedAt: 0,
    })
  })

  it('isolates cache keys by user', () => {
    expect(userScopedCacheKey('poster-history')).toBe('poster-history:user-1')
  })
})
