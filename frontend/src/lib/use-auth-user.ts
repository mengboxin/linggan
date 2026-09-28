import { useEffect, useState } from 'react'
import { AUTH_CHANGED_EVENT, auth, type AuthUser } from './auth'

export function useAuthUser(): AuthUser | null {
  const [user, setUser] = useState<AuthUser | null>(() => auth.getUser())

  useEffect(() => {
    const syncUser = () => setUser(auth.getUser())
    syncUser()
    window.addEventListener(AUTH_CHANGED_EVENT, syncUser)
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, syncUser)
  }, [])

  return user
}
