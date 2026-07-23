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
import { useForegroundNonce } from '../lib/foreground-resync'
import { useNow } from '../hooks/use-now'
import { bridgeLiveness, formatSecondsAgo } from '../lib/bridge-liveness'
import { LinearTicketButton, type LinearIssueDetail } from '../components/LinearTicketButton'

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

  // Re-anchor the terminal on foreground: bumping this remounts TerminalPane
  // (fresh attach + seed) when the PWA un-backgrounds or the phone unlocks, so a
  // stranded cursor or half-open socket can't leave the mirror frozen until a
  // manual close+reopen.
  const resyncNonce = useForegroundNonce()

  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | {
        activeSessionId?: string | null
        sessions?: Record<string, { cols?: number; rows?: number }>
        workspaces?: { trees: { rootDir: string; sessionIds: string[]; displayName?: string; branch?: string; linearIssue?: LinearIssueDetail }[] }[]
        geometryOwner?: 'desktop' | 'web'
        updatedAt?: number
      }
    | null
    | undefined
  const activeSessionId = state?.activeSessionId ?? null
  const geometryOwner = state?.geometryOwner ?? 'desktop'

  // Liveness: the desktop bridge heartbeats every 10s. If updatedAt falls behind
  // the wall clock, the bridge has stopped consuming commands — so attaching
  // (which seeds the terminal) and spawning silently do nothing, and the user is
  // left staring at a black screen. A ticking clock re-evaluates this even when
  // the mirrored data is frozen. Only meaningful once a session is mirrored;
  // before that the empty-state copy already explains there's nothing connected.
  const now = useNow(5_000)
  const hasState = !!state?.updatedAt
  const liveness = bridgeLiveness(state?.updatedAt, now)
  const selectedGeo = selected ? state?.sessions?.[selected] : undefined

  // The worktree (branch) the open session lives in — shown centered in the header,
  // along with its linked Linear ticket (if any) for the header's Linear button.
  // Computed inline (cheap) rather than memoized: `selected` is updated during
  // render below, which the React-compiler lint forbids as a memo dependency.
  const current = ((): { name: string | null; issue: LinearIssueDetail | null } => {
    if (!selected || !state?.workspaces) return { name: null, issue: null }
    for (const ws of state.workspaces) {
      for (const tree of ws.trees) {
        if (tree.sessionIds.includes(selected)) {
          return {
            name: tree.branch ?? tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? null,
            issue: tree.linearIssue ?? null,
          }
        }
      }
    }
    return { name: null, issue: null }
  })()
  const currentWorktree = current.name

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
      {/* Re-anchor the sidebar on foreground for the same reason as the terminal:
          the mobile drawer is a base-ui modal Dialog whose open/close animation
          state can be stranded when the PWA is backgrounded mid-transition (the
          lost `transitionend` leaves its transition state machine stuck, so the
          drawer silently refuses to reopen). Keying AppSidebar — a child of
          SidebarProvider, not the provider itself — remounts that Dialog cleanly
          on un-background, the automatic equivalent of the manual "close and
          reopen the PWA" recovery. Keying the child (not the provider) keeps the
          desktop sidebar's open/collapse state intact. */}
      <AppSidebar
        key={resyncNonce}
        token={token}
        selectedId={selected}
        onSelect={setSelected}
        onClose={(sid) => setSelected((cur) => (cur === sid ? null : cur))}
        onWorktreeFired={onActionFired}
      />
      <SidebarInset className="h-svh min-h-0">
        <header className="relative flex h-10 shrink-0 items-center border-b px-2">
          <SidebarTrigger />
          <span className="pointer-events-none absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate text-sm font-medium text-foreground">
            {currentWorktree ?? (selected ? 'Session' : 'Select a session')}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <LinearTicketButton token={token} sessionId={selected} issue={current.issue} />
            <EnableNotifications token={token} />
          </div>
        </header>
        {hasState && liveness.stale && (
          <div
            role="status"
            className="flex shrink-0 items-center justify-center gap-1.5 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-center text-xs text-amber-200"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>
              Desktop offline{liveness.secondsAgo != null ? ` — last seen ${formatSecondsAgo(liveness.secondsAgo)} ago` : ''}.
              Reopen Orchestra on your computer to reconnect.
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {selected ? (
            <TerminalPane key={`${selected}:${resyncNonce}`} token={token} sessionId={selected} cols={selectedGeo?.cols} rows={selectedGeo?.rows} owner={geometryOwner} onActionFired={onActionFired} />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">Select a session</div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
