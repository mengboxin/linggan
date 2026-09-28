import type { AuthUser } from './auth'
import { useAuthUser } from './use-auth-user'

export function getComputeSourceIdentity(user: AuthUser | null): string {
  return [
    user?.id || '',
    user?.billingMode || 'platform_credits',
    user?.apiKeyFingerprint || '',
    user?.apiKeyStatus || '',
    user?.foxapiModelCount || 0,
    user?.foxapiLastVerifiedAt || '',
    user?.grokApiKeyFingerprint || '',
    user?.grokApiKeyStatus || '',
    user?.grokModelCount || 0,
    user?.grokLastVerifiedAt || '',
    user?.grokEnabled === false ? 'off' : 'on',
  ].join(':')
}

export function useComputeSourceIdentity(): string {
  return getComputeSourceIdentity(useAuthUser())
}
