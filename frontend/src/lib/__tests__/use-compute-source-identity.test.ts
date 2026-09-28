import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../auth'
import { getComputeSourceIdentity } from '../use-compute-source-identity'

const baseUser: AuthUser = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User',
  role: 'user',
  billingMode: 'platform_credits',
}

describe('getComputeSourceIdentity', () => {
  it('changes when billing mode or connected key changes', () => {
    const platform = getComputeSourceIdentity(baseUser)
    const external = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'key-a',
      apiKeyStatus: 'active',
      foxapiModelCount: 4,
    })
    const replacement = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'key-b',
      apiKeyStatus: 'active',
      foxapiModelCount: 6,
    })

    expect(external).not.toBe(platform)
    expect(replacement).not.toBe(external)
  })

  it('changes when the Grok key or Grok billing mode changes', () => {
    const platform = getComputeSourceIdentity(baseUser)
    const grok = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grok-a',
      grokApiKeyStatus: 'active',
      grokModelCount: 3,
    })
    const replacement = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grok-b',
      grokApiKeyStatus: 'active',
      grokModelCount: 5,
    })

    expect(grok).not.toBe(platform)
    expect(replacement).not.toBe(grok)
  })

  it('changes when the Grok channel is taken offline', () => {
    const grok = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grok-a',
      grokEnabled: true,
    })
    const offline = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'grok_api_key',
      grokApiKeyFingerprint: 'grok-a',
      grokEnabled: false,
    })

    expect(offline).not.toBe(grok)
  })

  it('changes when a FoxAPI catalog is refreshed even when the model count is unchanged', () => {
    const beforeRefresh = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'key-a',
      apiKeyStatus: 'active',
      foxapiModelCount: 4,
      foxapiLastVerifiedAt: '2026-09-13T14:00:00Z',
    })
    const afterRefresh = getComputeSourceIdentity({
      ...baseUser,
      billingMode: 'external_api_key',
      apiKeyFingerprint: 'key-a',
      apiKeyStatus: 'active',
      foxapiModelCount: 4,
      foxapiLastVerifiedAt: '2026-09-13T14:01:00Z',
    })

    expect(afterRefresh).not.toBe(beforeRefresh)
  })
})
