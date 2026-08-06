'use client'
import { useEffect, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
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
import { chromeVars, CHROME_VAR_KEYS, isLightColor } from '../lib/workspace-color'
import { useAppViewport } from '../lib/viewport'
import { useMotionClaim } from '../hooks/useMotionClaim'
import { resolveAttachTarget, ATTACH_ARM_MS, type PendingAttach } from '../lib/attach-target'
import { SessionRoll } from '../components/SessionRoll'
import { ChatPane } from '../components/ChatPane'
import { SessionOverview } from '../components/SessionOverview'
import { UsageStrip } from '../components/UsageStrip'
import { BranchGlyph } from '../components/BranchGlyph'
import { WorktreeActionSheet, type WorktreeActionChoice } from '../components/WorktreeActionSheet'
import { WorkspaceActionSheet, type WorkspaceSpawn } from '../components/WorkspaceActionSheet'
import { buildCreateWorktreePayload, buildSpawnInTreePayload, type SafeAction } from '../lib/actions'
import { flattenRoll, treeOptions, type RollStatusLike } from '../lib/session-roll'
import { useCloseSession } from '../hooks/useCloseSession'

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
        workspaces?: { id: string; name: string; emoji?: string; color?: string; customActions?: SafeAction[]; trees: { rootDir: string; sessionIds: string[]; displayName?: string; branch?: string; linearIssue?: LinearIssueDetail }[] }[]
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
  // along with its linked Linear ticket (if any) for the header's Linear button, and
  // the coordinates (workspace + tree index) plus custom actions the header's branch
  // chip needs to spin something new up in that same tree.
  // Computed inline (cheap) rather than memoized: `selected` is updated during
  // render below, which the React-compiler lint forbids as a memo dependency.
  const empty = {
    name: null,
    issue: null,
    color: null,
    workspaceId: null,
    treeIndex: null,
    actions: [] as SafeAction[],
  }
  const current = ((): {
    name: string | null
    issue: LinearIssueDetail | null
    color: string | null
    workspaceId: string | null
    treeIndex: number | null
    actions: SafeAction[]
  } => {
    if (!selected || !state?.workspaces) return empty
    for (const ws of state.workspaces) {
      for (const [treeIndex, tree] of ws.trees.entries()) {
        if (tree.sessionIds.includes(selected)) {
          return {
            name: tree.branch ?? tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? null,
            issue: tree.linearIssue ?? null,
            color: ws.color ?? null,
            workspaceId: ws.id,
            treeIndex,
            actions: ws.customActions ?? [],
          }
        }
      }
    }
    return empty
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
  // Leftward two-finger swipe on the roll. Clears the selection the same way the
  // sidebar's swipe-to-trash does, so the phone lands on the empty screen (with the
  // resume strip) instead of holding a terminal whose PTY is already dead.
  const closeSession = useCloseSession(token)

  // How the open session reads: as the structured chat conversation (default —
  // the phone is a reading surface first) or as the raw terminal grid. Chat is
  // an overlay over the always-mounted TerminalPane (see its chatOverlay prop),
  // so flipping costs nothing and the PTY never detaches. Persisted because the
  // choice is a habit, not a per-session decision. RemoteApp only ever renders
  // client-side (Page gates on `hydrated`), so localStorage is safe here.
  const [viewMode, setViewMode] = useState<'chat' | 'term'>(() => {
    try {
      return localStorage.getItem('orchestra.viewMode') === 'term' ? 'term' : 'chat'
    } catch {
      return 'chat'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('orchestra.viewMode', viewMode)
    } catch {
      // Private-mode storage: the preference just doesn't stick.
    }
  }, [viewMode])

  // Pinched out of a session (see SessionRoll → classifyTwoFinger). The overview
  // covers the terminal rather than replacing it: the session stays attached, so
  // pinching back in — or tapping the card you came from — costs nothing. With
  // no session open the overview IS the screen, so this flag is irrelevant then.
  const [overviewOpen, setOverviewOpen] = useState(false)
  const showOverview = overviewOpen || !selected
  // Opening a session from anywhere else (a push tap, the drawer, an armed
  // attach) means the overview has served its purpose — don't leave it covering
  // the terminal the user just asked for.
  useEffect(() => {
    if (selected) setOverviewOpen(false)
  }, [selected])

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
    // Light-vs-dark tint verdict for CSS that can't branch on a var — shiki's
    // dual-theme code tokens pick their palette off this attribute.
    root.dataset.tint = activeColor && isLightColor(activeColor) ? 'light' : 'dark'
    return () => {
      for (const k of CHROME_VAR_KEYS) root.style.removeProperty(k)
      delete root.dataset.tint
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

  // …and the same tap doubles as the header's "spin something up here" button: it
  // opens the same action sheet the sidebar's worktree rows open, so starting
  // another agent or terminal in the tree you're already reading doesn't cost a
  // round trip through the drawer.
  const [treeSheetOpen, setTreeSheetOpen] = useState(false)

  // …and picking the phone up does the same thing without the tap. Handling the
  // device while this page is in the foreground is the same statement the header
  // tap makes ("I'm reading this on my phone now"), so it routes through the
  // identical claim path. Disarmed once the phone already owns the geometry —
  // there's nothing left to claim, and the sensor listener goes with it.
  useMotionClaim(!!selected && geometryOwner !== 'web', () => setClaimNonce((n) => n + 1))
  const onActionFired = (workspaceId: string | null) =>
    setPending({ workspaceId, known: Object.keys(sessions) })

  // Fire the header sheet's choice at the worktree the open session lives in —
  // the same `spawnInTree` command the sidebar sends, arming auto-attach so the
  // phone follows the session it spawns.
  const convex = useConvex()
  const spawnInCurrentTree = (choice: WorktreeActionChoice) => {
    setTreeSheetOpen(false)
    if (!current.workspaceId || current.treeIndex == null) return
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId: '',
      kind: 'spawnInTree',
      payload: buildSpawnInTreePayload(current.workspaceId, current.treeIndex, choice),
    })
    onActionFired(current.workspaceId)
  }

  // Tapping a workspace header on the overview opens that workspace's sheet:
  // pick a worktree (or name a new one) and what to run in it.
  const [workspaceSheetId, setWorkspaceSheetId] = useState<string | null>(null)
  const workspaceSheet = workspaceSheetId
    ? state?.workspaces?.find((ws) => ws.id === workspaceSheetId) ?? null
    : null

  // One sheet, two commands: an existing tree spawns straight into it, while the
  // picker's "+ New worktree" creates the tree first and lets the same choice
  // ride along as its spin-up (an agent) or its on-creation action.
  const spawnInWorkspace = (workspaceId: string, spawn: WorkspaceSpawn) => {
    setWorkspaceSheetId(null)
    const command =
      'branch' in spawn
        ? ({
            kind: 'createWorktree',
            payload: buildCreateWorktreePayload(
              workspaceId,
              spawn.branch,
              'actionId' in spawn.target ? [spawn.target.actionId] : [],
              'agent' in spawn.target ? spawn.target.agent : null,
            ),
          } as const)
        : ({
            kind: 'spawnInTree',
            payload: buildSpawnInTreePayload(workspaceId, spawn.treeIndex, spawn.target),
          } as const)
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId: '',
      kind: command.kind,
      payload: command.payload,
    })
    onActionFired(workspaceId)
  }

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
          the effect runs, and any browser without visualViewport get.
          Terminal view only: the TUI's input line is just painted cells, so
          nothing but this shrink keeps it visible above the keyboard. The chat
          composer is a real form control the browser itself keeps in view
          (iOS pans the visual viewport to a focused element), and stacking
          the shrink on top of that native avoidance left a dead band of
          background between the composer and the keyboard. It still takes the
          *measured* full height (--app-full-h) rather than 100svh: an installed
          iOS PWA under-reports svh by about a toolbar's height, which left the
          usage strip floating well clear of the bottom of the screen. */}
      <SidebarInset
        className="min-h-0"
        style={
          selected && viewMode === 'chat'
            ? { height: 'var(--app-full-h, 100svh)' }
            : { height: 'var(--app-h, 100svh)', marginTop: 'var(--app-top, 0px)' }
        }
      >
        {/* pt-status-bar, not h-10: full-bleed PWA, so a bare 40px bar hides under
            the iOS status bar along with the sidebar trigger (see globals.css).
            Three in-flow groups rather than an absolutely-centered title: the
            worktree chip sits next to the drawer trigger, and the session title
            centers in what's left over — so a long branch shortens the title
            instead of colliding with it. */}
        <header className="pt-status-bar flex shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          {/* Tapping the worktree opens its action sheet (spin up an agent, terminal
              or custom action in this same tree) and claims the shared PTY for this
              phone on the way (see claimNonce). Dropped entirely with no session
              open, so its gap doesn't push the title. */}
          {currentWorktree && !showOverview && (
            <button
              type="button"
              onClick={() => {
                setClaimNonce((n) => n + 1)
                setTreeSheetOpen(true)
              }}
              title={`Start something new in ${currentWorktree}`}
              className="flex max-w-[38%] shrink-0 items-center gap-1 text-xs text-muted-foreground transition-opacity active:opacity-50"
            >
              <BranchGlyph size={12} />
              <span className="truncate">{currentWorktree}</span>
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-center text-sm font-medium text-foreground">
            {showOverview ? 'Sessions' : sessionLabel ?? 'Session'}
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
            long-press selection). Pinched inward they zoom out to the overview,
            which covers the terminal without detaching it. */}
        <div className="relative min-h-0 flex-1">
          <SessionRoll
            items={rollItems}
            selectedId={selected}
            onSelect={setSelected}
            onCloseSession={(sid) => {
              closeSession(sid)
              setSelected((cur) => (cur === sid ? null : cur))
            }}
            onOverview={() => setOverviewOpen(true)}
          >
            {selected ? (
              <TerminalPane
                key={`${selected}:${resyncNonce}`}
                token={token}
                sessionId={selected}
                cols={selectedGeo?.cols}
                rows={selectedGeo?.rows}
                owner={geometryOwner}
                color={current.color ?? undefined}
                claimNonce={claimNonce}
                onActionFired={onActionFired}
                chatOverlay={
                  viewMode === 'chat' ? (
                    <ChatPane
                      token={token}
                      sessionId={selected}
                      color={current.color ?? undefined}
                      working={state?.liveStatus?.[selected]?.work === 'working'}
                      agent={
                        selectedGeo?.processStatus === 'claude' || selectedGeo?.processStatus === 'codex'
                          ? selectedGeo.processStatus
                          : undefined
                      }
                      mirroredModel={state?.liveStatus?.[selected]?.model}
                      mirroredEffort={state?.liveStatus?.[selected]?.effort}
                      contextTokens={state?.liveStatus?.[selected]?.contextTokens}
                      contextWindow={state?.liveStatus?.[selected]?.contextWindow}
                      exited={Boolean(state?.liveStatus?.[selected]?.exited)}
                      onShowTerminal={() => setViewMode('term')}
                    />
                  ) : undefined
                }
              />
            ) : null}
          </SessionRoll>
          {/* Chat ⌁ Term switch. Floating over the pane rather than in the
              header: the header's center is already contested (worktree chip +
              session title + Linear/notification buttons), and top-center of
              the pane collides with nothing — the terminal's Copy button floats
              top-RIGHT, dictation toasts bottom. Below the overview's z-20, and
              hidden with it, since the overview has no view to switch. */}
          {selected && !showOverview && (
            <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 overflow-hidden rounded-full border border-border bg-background/75 text-[11px] font-medium shadow-sm backdrop-blur">
              {(['chat', 'term'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={viewMode === mode}
                  onClick={() => setViewMode(mode)}
                  className={
                    viewMode === mode
                      ? 'bg-accent px-3 py-1 text-foreground'
                      : 'px-3 py-1 text-muted-foreground'
                  }
                >
                  {mode === 'chat' ? 'Chat' : 'Term'}
                </button>
              ))}
            </div>
          )}
          {/* Laid over the roll rather than swapped for it, so the session the user
              pinched out of is still attached when they pinch back in. With nothing
              open it's the only thing here — the empty state IS the overview. */}
          {showOverview && (
            <div className="absolute inset-0 z-20">
              <SessionOverview
                items={rollItems}
                selectedId={selected}
                onSelect={(sid) => {
                  setSelected(sid)
                  setOverviewOpen(false)
                }}
                // Swipe a card left, tap the bin: the same kill the sidebar's
                // swipe-to-trash and the roll's leftward pull send. Clearing the
                // selection matters here too — killing the session you have open
                // from its own card must not leave the terminal attached to a
                // dead PTY behind the overview.
                onCloseSession={(sid) => {
                  closeSession(sid)
                  setSelected((cur) => (cur === sid ? null : cur))
                }}
                onWorkspaceMenu={setWorkspaceSheetId}
                onDismiss={selected ? () => setOverviewOpen(false) : null}
              />
            </div>
          )}
        </div>
        {/* With a session open the terminal renders this strip itself, below its
            own key/action bars. With nothing open there is no terminal, and the
            strip still has to be there — resuming a closed session is exactly
            what you reach for from an empty screen. */}
        {!selected && <UsageStrip token={token} onResumed={onActionFired} />}
        {/* Gated on currentWorktree as well: if the open session goes away while the
            sheet is up there is no tree left to spawn into, so it closes itself. */}
        {treeSheetOpen && currentWorktree && (
          <WorktreeActionSheet
            title={currentWorktree}
            actions={current.actions}
            onChoose={spawnInCurrentTree}
            onCancel={() => setTreeSheetOpen(false)}
          />
        )}
        {/* The workspace's own sheet, from the overview's headers. Gated on the
            workspace still being mirrored: if it goes away while the sheet is up
            there is nothing left to spawn into. */}
        {workspaceSheet && (
          <WorkspaceActionSheet
            workspaceName={workspaceSheet.name}
            trees={treeOptions(workspaceSheet)}
            actions={workspaceSheet.customActions ?? []}
            // Open on the tree the phone is already in, when that's this workspace.
            initialTreeIndex={
              current.workspaceId === workspaceSheet.id ? current.treeIndex ?? undefined : undefined
            }
            onSpawn={(spawn) => spawnInWorkspace(workspaceSheet.id, spawn)}
            onCancel={() => setWorkspaceSheetId(null)}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
