'use client'
import { ConvexProvider } from 'convex/react'
import { getConvexClient } from '../lib/convexClient'
import { useForegroundResync } from '../lib/foreground-resync'
import { useBuildFreshness } from '../lib/build-freshness'

// Mounted inside ConvexProvider so it can read the live client; reconnects the
// websocket the instant the page returns to the foreground (see useForegroundResync),
// and reloads the page when that foreground return reveals a newer deployed build
// (see useBuildFreshness — data resync alone never refreshes CODE on a long-lived PWA).
function ForegroundResync() {
  useForegroundResync()
  useBuildFreshness()
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProvider client={getConvexClient()}>
      <ForegroundResync />
      {children}
    </ConvexProvider>
  )
}
