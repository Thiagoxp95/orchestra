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
import { chromeVars, CHROME_VAR_KEYS } from '../lib/workspace-color'
import { useAppViewport } from '../lib/viewport'
import { useMotionClaim } from '../hooks/useMotionClaim'
import { resolveAttachTarget, ATTACH_ARM_MS, type PendingAttach } from '../lib/attach-target'
import { SessionRoll } from '../components/SessionRoll'
import { UsageStrip } from '../components/UsageStrip'
import { BranchGlyph } from '../components/BranchGlyph'
import { flattenRoll, type RollStatusLike } from '../lib/session-roll'

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

  // Track the visual viewport so the phone's soft keyboard shrinks the shell
  // instead of covering its bottom (terminal input line, key bar, actions).
  useAppViewport()

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

  // Re-anchor the terminal on foreground: bumping this remounts TerminalPane
  // (fresh attach + seed) when the PWA un-backgrounds or the phone unlocks, so a
  // stranded cursor or half-open socket can't leave the mirror frozen until a
  // manual close+reopen.
  const resyncNonce = useForegroundNonce()

  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | {
        activeSessionId?: string | null
        sessions?: Record<string, { cols?: number; rows?: number; workspaceId: string; label: string; processStatus: string; actionIcon?: string }>
        liveStatus?: Record<string, RollStatusLike>
        workspaces?: { id: string; name: string; emoji?: string; color?: string; trees: { rootDir: string; sessionIds: string[]; displayName?: string; branch?: string; linearIssue?: LinearIssueDetail }[] }[]
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
  const current = ((): { name: string | null; issue: LinearIssueDetail | null; color: string | null } => {
    if (!selected || !state?.workspaces) return { name: null, issue: null, color: null }
    for (const ws of state.workspaces) {
      for (const tree of ws.trees) {
        if (tree.sessionIds.includes(selected)) {
          return {
            name: tree.branch ?? tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? null,
            issue: tree.linearIssue ?? null,
            color: ws.color ?? null,
          }
        }
      }
    }
    return { name: null, issue: null, color: null }
  })()
  const currentWorktree = current.name

  // The session's own title, centered in the header: the same text the sidebar row
  // shows — the last thing sent to the agent. The mirrored liveStatus label tracks
  // it; the session's spawn label is the fallback (see Sidebar/flattenRoll).
  const sessionLabel = selected
    ? state?.liveStatus?.[selected]?.label ?? selectedGeo?.label ?? null
    : null

  // Every mirrored session flattened into one sidebar-ordered list — the running
  // order of the two-finger session roll (see components/SessionRoll).
  const rollItems = flattenRoll(state?.workspaces ?? [], state?.sessions ?? {}, state?.liveStatus ?? {})

  // Tint the whole web chrome (sidebar, header, main area, borders, muted text) to
  // the active workspace's color, matching the desktop — where every surface keys
  // off workspace.color + textColor(color). Rather than restyle each shadcn
  // component, re-derive the shadcn CSS variables from the color and set them on
  // :root: inline custom properties there override the .dark stylesheet and cascade
  // to both the desktop sidebar and the mobile drawer (a Sheet that portals to
  // <body>, outside the SidebarProvider). The terminal keeps its own inline theme.
  // Removing exactly CHROME_VAR_KEYS (no active session) restores the dark default.
  const activeColor = current.color
  useEffect(() => {
    const root = document.documentElement
    const vars = chromeVars(activeColor)
    if (vars) {
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    } else {
      for (const k of CHROME_VAR_KEYS) root.style.removeProperty(k)
    }
    return () => {
      for (const k of CHROME_VAR_KEYS) root.style.removeProperty(k)
    }
  }, [activeColor])

  // Auto-attach: firing an action from the web (worktree sheet, new worktree,
  // action bar) arms an attach for the workspace that action targets, so opening a
  // session in another workspace takes the phone there instead of leaving it on
  // the one it was already in. Arming on tap — and only following the armed
  // workspace — keeps the desktop user's own session switches from hijacking the
  // web view. See resolveAttachTarget for how the target session is picked.
  const sessions = state?.sessions ?? {}
  const selectedWorkspaceId = selected ? sessions[selected]?.workspaceId ?? null : null
  const [pending, setPending] = useState<PendingAttach | null>(null)

  // Tapping the worktree name in the header claims the shared PTY for the phone:
  // the bridge resizes every session to this viewport and the terminal re-renders
  // 1:1 instead of scaled down to the desktop's width. The mirror image of the
  // desktop, which takes the size back on any click over there — so whichever
  // screen you last touched is the one the shell is wrapped for.
  const [claimNonce, setClaimNonce] = useState(0)

  // …and picking the phone up does the same thing without the tap. Handling the
  // device while this page is in the foreground is the same statement the header
  // tap makes ("I'm reading this on my phone now"), so it routes through the
  // identical claim path. Disarmed once the phone already owns the geometry —
  // there's nothing left to claim, and the sensor listener goes with it.
  useMotionClaim(!!selected && geometryOwner !== 'web', () => setClaimNonce((n) => n + 1))
  const onActionFired = (workspaceId: string | null) =>
    setPending({ workspaceId, known: Object.keys(sessions) })

  // Give up on an armed attach that never resolved (action failed, desktop offline)
  // rather than following that workspace forever.
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending(null), ATTACH_ARM_MS)
    return () => clearTimeout(timer)
  }, [pending])

  // Adjust selection during render while an attach is armed (React's "store info
  // from previous render" pattern — preferred over a setState-in-effect).
  if (pending) {
    const target = resolveAttachTarget(pending, sessions, activeSessionId, selectedWorkspaceId)
    if (target) {
      if (target.sessionId !== selected) setSelected(target.sessionId)
      // Unsettled targets stay armed: the phone has moved to the right workspace,
      // but the session the action is spawning hasn't been mirrored yet.
      if (target.settled) setPending(null)
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
      {/* Sized to the visual viewport (--app-h/--app-top, published by
          useAppViewport) so the soft keyboard shrinks the layout rather than
          hiding its bottom. The svh fallback is what SSR, the first paint before
          the effect runs, and any browser without visualViewport get. */}
      <SidebarInset
        className="min-h-0"
        style={{ height: 'var(--app-h, 100svh)', marginTop: 'var(--app-top, 0px)' }}
      >
        {/* pt-status-bar, not h-10: full-bleed PWA, so a bare 40px bar hides under
            the iOS status bar along with the sidebar trigger (see globals.css).
            Three in-flow groups rather than an absolutely-centered title: the
            worktree chip sits next to the drawer trigger, and the session title
            centers in what's left over — so a long branch shortens the title
            instead of colliding with it. */}
        <header className="pt-status-bar flex shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          {/* Tapping the worktree claims the shared PTY for this phone (see claimNonce).
              Dropped entirely with no session open, so its gap doesn't push the title. */}
          {currentWorktree && (
            <button
              type="button"
              onClick={() => setClaimNonce((n) => n + 1)}
              title="Resize this session to fit your phone"
              className="flex max-w-[38%] shrink-0 items-center gap-1 text-xs text-muted-foreground transition-opacity active:opacity-50"
            >
              <BranchGlyph size={12} />
              <span className="truncate">{currentWorktree}</span>
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-center text-sm font-medium text-foreground">
            {sessionLabel ?? (selected ? 'Session' : 'Select a session')}
          </span>
          <div className="flex shrink-0 items-center gap-1">
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
        {/* Two fingers up/down cycles through every mirrored session without opening
            the drawer — one finger stays the terminal's own (scrollback, TUI scroll,
            long-press selection). */}
        <div className="min-h-0 flex-1">
          <SessionRoll items={rollItems} selectedId={selected} onSelect={setSelected}>
            {selected ? (
              <TerminalPane key={`${selected}:${resyncNonce}`} token={token} sessionId={selected} cols={selectedGeo?.cols} rows={selectedGeo?.rows} owner={geometryOwner} color={current.color ?? undefined} claimNonce={claimNonce} onActionFired={onActionFired} />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                Select a session — or swipe up with two fingers to roll through them.
              </div>
            )}
          </SessionRoll>
        </div>
        {/* With a session open the terminal renders this strip itself, below its
            own key/action bars. With nothing open there is no terminal, and the
            strip still has to be there — resuming a closed session is exactly
            what you reach for from an empty screen. */}
        {!selected && <UsageStrip token={token} onResumed={onActionFired} />}
      </SidebarInset>
    </SidebarProvider>
  )
}
