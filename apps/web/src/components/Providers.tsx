'use client'
import { SyncProvider, useForegroundResync } from '../lib/sync'
import { useBuildFreshness } from '../lib/build-freshness'

// Mounted inside SyncProvider so it can read the live client; reconnects the
// websocket the instant the page returns to the foreground (see
// useForegroundResync), and reloads the page when that foreground return
// reveals a newer desktop build (see useBuildFreshness — a data resync alone
// never refreshes CODE on a long-lived PWA).
function ForegroundResync() {
  useForegroundResync()
  useBuildFreshness()
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider>
      <ForegroundResync />
      {children}
    </SyncProvider>
  )
}
