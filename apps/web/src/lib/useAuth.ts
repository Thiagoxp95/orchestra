'use client'
import { useCallback, useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'

const KEY = 'orchestra-web-token'

export function useAuth() {
  const convex = useConvex()
  // Start null on both server and first client render so the SSR HTML matches
  // the initial client render (no hydration mismatch). The persisted token is
  // read only after mount, in the effect below; consumers gate UI on `hydrated`.
  const [token, setToken] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    // Reading client-only storage post-mount is the correct SSR-safe hydration
    // pattern; the set-state-in-effect rule does not account for it here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(localStorage.getItem(KEY))
    setHydrated(true)
  }, [])

  const signIn = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      const res = await convex.action(anyApi.remoteAuth.signIn, { email, password })
      if (res && 'token' in res) {
        localStorage.setItem(KEY, res.token)
        setToken(res.token)
        return res.token
      }
      return null
    },
    [convex],
  )

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY)
    setToken(null)
  }, [])

  return { token, hydrated, signIn, signOut }
}
