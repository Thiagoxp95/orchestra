'use client'
import { useCallback, useEffect, useState } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'

const KEY = 'orchestra-web-token'

export function useAuth() {
  const convex = useConvex()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(localStorage.getItem(KEY))
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

  return { token, signIn, signOut }
}
