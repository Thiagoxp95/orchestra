'use client'
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useAuth } from '../lib/useAuth'
import { SignIn } from '../components/SignIn'
import { AppSidebar } from '../components/Sidebar'
import { TerminalPane } from '../components/Terminal'

export default function Page() {
  const { token, hydrated } = useAuth()

  // Until the stored token is read post-mount, render nothing — this keeps the
  // server HTML and first client render identical (no hydration mismatch) and
  // avoids flashing the sign-in form to an already-authenticated user.
  if (!hydrated) return null

  if (!token) return <SignIn onSignedIn={() => location.reload()} />

  return <RemoteApp token={token} />
}

function RemoteApp({ token }: { token: string }) {
  const [selected, setSelected] = useState<string | null>(null)

  // Auto-attach: after firing an action, attach to whichever session the
  // desktop focuses next (mirrored as activeSessionId). Arming on tap (rather
  // than always following activeSessionId) keeps the desktop user's own session
  // switches from hijacking the web view.
  const [pendingAttach, setPendingAttach] = useState(false)
  const onActionFired = () => setPendingAttach(true)

  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | { activeSessionId?: string | null }
    | null
    | undefined
  const activeSessionId = state?.activeSessionId ?? null

  // Adjust selection during render when the desktop's focused session changes
  // while an attach is armed (React's "store info from previous render" pattern
  // — preferred over a setState-in-effect).
  const [prevActive, setPrevActive] = useState<string | null>(null)
  if (activeSessionId !== prevActive) {
    setPrevActive(activeSessionId)
    if (pendingAttach && activeSessionId && activeSessionId !== selected) {
      setPendingAttach(false)
      setSelected(activeSessionId)
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar
        token={token}
        selectedId={selected}
        onSelect={setSelected}
        onClose={(sid) => setSelected((cur) => (cur === sid ? null : cur))}
        onWorktreeFired={onActionFired}
      />
      <SidebarInset className="h-svh min-h-0">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          <span className="truncate text-sm text-muted-foreground">
            {selected ? 'Session' : 'Select a session'}
          </span>
        </header>
        <div className="min-h-0 flex-1">
          {selected ? (
            <TerminalPane key={selected} token={token} sessionId={selected} onActionFired={onActionFired} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Select a session</div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
