'use client'
import { useEffect, useState } from 'react'
import { useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { useAuth } from '../lib/useAuth'
import { SignIn } from '../components/SignIn'
import { AppSidebar } from '../components/Sidebar'
import { TerminalPane } from '../components/Terminal'
import { EnableNotifications } from '../components/EnableNotifications'

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

  // Wire push-notification tap-to-attach: listen for the "attach-session"
  // custom event dispatched by usePushNotifications, and handle the
  // ?session= query param that the SW opens when no focused client exists.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (id) setSelected(id)
    }
    window.addEventListener('attach-session', onAttach)

    const sid = new URLSearchParams(window.location.search).get('session')
    if (sid) {
      setSelected(sid)
      window.history.replaceState(null, '', window.location.pathname)
    }

    return () => window.removeEventListener('attach-session', onAttach)
  }, [])

  // Auto-attach: after firing an action, attach to whichever session the
  // desktop focuses next (mirrored as activeSessionId). Arming on tap (rather
  // than always following activeSessionId) keeps the desktop user's own session
  // switches from hijacking the web view.
  const [pendingAttach, setPendingAttach] = useState(false)
  const onActionFired = () => setPendingAttach(true)

  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | {
        activeSessionId?: string | null
        sessions?: Record<string, { cols?: number; rows?: number }>
        workspaces?: { trees: { rootDir: string; sessionIds: string[]; displayName?: string; branch?: string }[] }[]
      }
    | null
    | undefined
  const activeSessionId = state?.activeSessionId ?? null
  const selectedGeo = selected ? state?.sessions?.[selected] : undefined

  // The worktree (branch) the open session lives in — shown centered in the header.
  // Computed inline (cheap) rather than memoized: `selected` is updated during
  // render below, which the React-compiler lint forbids as a memo dependency.
  const currentWorktree = ((): string | null => {
    if (!selected || !state?.workspaces) return null
    for (const ws of state.workspaces) {
      for (const tree of ws.trees) {
        if (tree.sessionIds.includes(selected)) {
          return tree.branch ?? tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? null
        }
      }
    }
    return null
  })()

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
        <header className="relative flex h-10 shrink-0 items-center border-b px-2">
          <SidebarTrigger />
          <span className="pointer-events-none absolute left-1/2 max-w-[60%] -translate-x-1/2 truncate text-sm font-medium text-foreground">
            {currentWorktree ?? (selected ? 'Session' : 'Select a session')}
          </span>
          <div className="ml-auto">
            <EnableNotifications token={token} />
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {selected ? (
            <TerminalPane key={selected} token={token} sessionId={selected} cols={selectedGeo?.cols} rows={selectedGeo?.rows} onActionFired={onActionFired} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Select a session</div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
