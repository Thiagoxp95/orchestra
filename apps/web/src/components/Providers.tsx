'use client'
import { ConvexProvider } from 'convex/react'
import { getConvexClient } from '../lib/convexClient'
import { useForegroundResync } from '../lib/foreground-resync'

// Mounted inside ConvexProvider so it can read the live client; reconnects the
// websocket the instant the page returns to the foreground (see useForegroundResync).
function ForegroundResync() {
  useForegroundResync()
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
