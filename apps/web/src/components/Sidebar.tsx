'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { DynamicIcon, sessionIconToken } from './DynamicIcon'
import { AgentIconMorph } from './AgentIconMorph'
import { isAgentSession } from '@/lib/session-overview'
import { BranchGlyph } from './BranchGlyph'
import { PRGlyph } from './PRGlyph'
import { WorktreeDialog, type WorktreeDialogResult } from './WorktreeDialog'
import { WorktreeActionSheet, type WorktreeActionChoice } from './WorktreeActionSheet'
import { TrashIcon } from './TrashIcon'
import { useSwipeToReveal } from '@/hooks/useSwipeToReveal'
import { buildCreateWorktreePayload, buildSpawnInTreePayload, type SafeAction } from '@/lib/actions'
import { workspaceDisplayEmoji } from '@/lib/workspace-emoji'
import { applyAttentionAck } from '@/lib/attention-ack'
import { sessionDisplayLabel, orderTreeSessions } from '@/lib/session-roll'
import { useSessionMeta } from '@/hooks/useSessionMeta'
import { ConfirmSheet } from './ConfirmSheet'
import { ServersGroup } from './ServersGroup'
import { safeServers, serversForTree, type MirroredServer } from '@/lib/servers'

interface GitPRInfo {
  number: number
  /** OPEN | DRAFT | CLOSED | MERGED — mirrored verbatim from the desktop's `gh` lookup. */
  state: string
  title: string
  url: string
}

interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
  branch?: string
  pr?: GitPRInfo
}

/** Label for a worktree row: branch, else the user's display name, else the folder name. */
function treeLabel(tree: SafeTree): string {
  return tree.branch ?? tree.displayName ?? tree.rootDir.split('/').filter(Boolean).pop() ?? tree.rootDir
}

/**
 * Label for the base tree (main repo) row: the checked-out branch. Falls back to the
 * folder name only when the branch can't be read — never the workspace display name,
 * which would just repeat the workspace header above it.
 */
function baseTreeLabel(tree: SafeTree): string {
  return tree.branch ?? tree.rootDir.split('/').filter(Boolean).pop() ?? tree.rootDir
}
interface SafeWorkspace {
  id: string
  name: string
  color: string
  emoji?: string
  trees: SafeTree[]
  activeTreeIndex: number
  customActions?: SafeAction[]
}
interface SafeSession {
  label: string
  processStatus: string
  cwd: string
  workspaceId: string
  actionIcon?: string
  /** Pinned by the user; sorts above the rest of its worktree. */
  pinned?: boolean
  /** A user-typed title; wins over `label` and over liveStatus.label. */
  customLabel?: string
}
interface LiveStatus {
  work?: 'idle' | 'working'
  exited?: boolean
  label?: string
  // Whether the session is waiting on the user (reply or approval). Mirrored from
  // the desktop so the workspace header can show a "needs input" count.
  attention?: 'input' | 'approval'
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M2 4c0-.6.4-1 1-1h3.6l1.4 2H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4z" />
    </svg>
  )
}

type AgentKind = 'claude' | 'codex' | 'cursor'

const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

function asAgentKind(processStatus: string): AgentKind | null {
  return processStatus === 'claude' || processStatus === 'codex' || processStatus === 'cursor'
    ? processStatus
    : null
}

// Count active agents across every worktree in a workspace: working vs. waiting on
// the user, plus which agent stands in for each bucket (the first one found) so the
// badge can show that agent's own logo. Reads the same mirrored liveStatus the
// session rows do; non-agent sessions (plain terminals) never count.
function workspaceAgentCounts(
  ws: SafeWorkspace,
  sessions: Record<string, SafeSession>,
  liveStatus: Record<string, LiveStatus>,
): { thinking: number; needsInput: number; thinkingAgent: AgentKind | null; needsInputAgent: AgentKind | null } {
  let thinking = 0
  let needsInput = 0
  let thinkingAgent: AgentKind | null = null
  let needsInputAgent: AgentKind | null = null
  for (const tree of ws.trees) {
    for (const sid of tree.sessionIds) {
      const s = liveStatus[sid]
      if (!s || s.exited) continue
      const kind = sessions[sid] ? asAgentKind(sessions[sid].processStatus) : null
      if (!kind) continue
      if (s.attention) {
        needsInput++
        if (!needsInputAgent) needsInputAgent = kind
      } else if (s.work === 'working') {
        thinking++
        if (!thinkingAgent) thinkingAgent = kind
      }
    }
  }
  return { thinking, needsInput, thinkingAgent, needsInputAgent }
}

// Workspace-level aggregate of active agents, one level up from the per-session
// dots and wearing the agent's own logo (never a generic star): it spins while
// agents work and bounces while they wait on you. Mirrors the desktop sidebar.
// Renders nothing when the workspace is quiet.
function WorkspaceAgentBadge({
  thinking,
  needsInput,
  thinkingAgent,
  needsInputAgent,
}: {
  thinking: number
  needsInput: number
  thinkingAgent: AgentKind | null
  needsInputAgent: AgentKind | null
}) {
  if (thinking === 0 && needsInput === 0) return null
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {thinking > 0 && thinkingAgent && (
        <span
          className="flex items-center gap-1 text-foreground/80"
          title={`${thinking} ${AGENT_LABEL[thinkingAgent]} session${thinking === 1 ? '' : 's'} working`}
        >
          {/* Spin the logo only — the count beside it has to stay readable. */}
          <span className="flex shrink-0 animate-spin">
            <DynamicIcon name={sessionIconToken(thinkingAgent)} size={11} />
          </span>
          <span className="text-[10px] font-semibold tabular-nums leading-none">{thinking}</span>
        </span>
      )}
      {needsInput > 0 && needsInputAgent && (
        <span
          className="animate-agent-jump flex items-center gap-1 text-amber-400"
          title={`${needsInput} ${AGENT_LABEL[needsInputAgent]} session${needsInput === 1 ? '' : 's'} waiting for you`}
        >
          <DynamicIcon name={sessionIconToken(needsInputAgent)} size={11} />
          <span className="text-[10px] font-semibold tabular-nums leading-none">{needsInput}</span>
        </span>
      )}
    </span>
  )
}

// True while the session is waiting on you and hasn't exited. The row it belongs
// to may still be the one you're looking at — see SessionRow for why that case
// keeps the colour but drops the bounce.
function needsYou(status?: LiveStatus): boolean {
  return Boolean(status?.attention) && !status?.exited
}

// A sidebar row that reveals a trash button when swiped left (when `deletable`).
// Tapping a closed row fires onTap; tapping an open row snaps it shut.
function SwipeableRow({
  deletable,
  deleteLabel,
  onTap,
  onDelete,
  children,
}: {
  deletable: boolean
  deleteLabel: string
  onTap: () => void
  onDelete: () => void
  children: React.ReactNode
}) {
  const { dx, open, dragging, moved, revealed, close, touch } = useSwipeToReveal(deletable)

  const handleClick = () => {
    if (open) {
      close()
      return
    }
    if (moved.current) return
    onTap()
  }

  return (
    <SidebarMenuItem className="relative overflow-hidden">
      {revealed && (
        <button
          type="button"
          aria-label={deleteLabel}
          tabIndex={open ? 0 : -1}
          onClick={onDelete}
          className="absolute inset-y-0 right-0 flex w-16 items-center justify-center bg-destructive text-white"
        >
          <TrashIcon />
        </button>
      )}
      <div
        className="relative bg-sidebar"
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform 0.2s ease' }}
        onTouchStart={touch.onTouchStart}
        onTouchMove={touch.onTouchMove}
        onTouchEnd={touch.onTouchEnd}
        onTouchCancel={touch.onTouchCancel}
        onClick={handleClick}
      >
        {children}
      </div>
    </SidebarMenuItem>
  )
}

/** The pin mark: filled when pinned, outlined when it's only an offer. */
export function PinGlyph({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}

function SwipeableSessionRow({
  label,
  iconToken,
  isAgent,
  status,
  isActive,
  pinned,
  onSelect,
  onDelete,
  onTogglePin,
}: {
  label: string
  iconToken: string
  /** Agent sessions get the dot-bloom morph while working; terminals keep a static icon. */
  isAgent: boolean
  status?: LiveStatus
  isActive: boolean
  pinned?: boolean
  onSelect: () => void
  onDelete: () => void
  onTogglePin: () => void
}) {
  // Shimmer the label while an agent is actively working — mirrors the desktop
  // sidebar (SessionItem.tsx). 'working' is only ever set for agent sessions
  // (the bridge's claude-work-state tap), so terminals never shimmer.
  const isWorking = status?.work === 'working' && !status?.exited
  // Bounce the icon while this session waits on you, so the workspace badge's
  // count leads to a row you can pick out. Skipped for the session already on
  // screen (desktop SessionItem does the same): you're looking at the question.
  const jump = needsYou(status) && !isActive
  const pinTouchX = useRef<number | null>(null)
  const pinDragged = useRef(false)
  return (
    <SwipeableRow deletable deleteLabel="Close session" onTap={onSelect} onDelete={onDelete}>
      {/* The pin is a SIBLING of the row button, laid over its right edge — never a
          child of it. SidebarMenuButton renders a <button>, and a <button> nested
          in a <button> is invalid HTML: the parser that reads the server-rendered
          markup hoists the inner one out, React hydrates onto the rearranged DOM,
          and the pin paints in roughly the right place with no click handler
          attached. Which is exactly how it shipped broken. */}
      <div className="relative">
      <SidebarMenuButton isActive={isActive} className="pointer-events-none pr-8">
        {/* The overview cards run the same morph (SessionOverview), so a working
            agent looks identical in the sidebar and on the sessions page. The
            wrapper keeps the fixed-size morph from being squeezed by the flex row. */}
        {isAgent ? (
          <span className={cn('flex shrink-0', jump && 'animate-session-attention')}>
            <AgentIconMorph icon={iconToken} size={16} working={isWorking} />
          </span>
        ) : (
          <span className={cn('flex shrink-0', jump && 'animate-session-attention')}>
            <DynamicIcon name={iconToken} size={16} />
          </span>
        )}
        {/* The icon carries the whole state: it spins while the agent works and
            bounces while it waits on you. A trailing status dot would only say
            the same thing again, so the row ends at the label. */}
        <span className={cn('truncate', isWorking && 'shimmer-active')}>{label}</span>
      </SidebarMenuButton>
        {/* Left-swipe is already the delete gesture on these rows, so the pin is a
            tap target instead. */}
        <button
          type="button"
          aria-label={pinned ? 'Unpin session' : 'Pin session'}
          aria-pressed={pinned}
          // The row's own swipe-to-trash starts wherever your finger lands, this
          // button included — so a left-drag that began here would swipe AND fire
          // this click on release. Remember where the touch started and ignore the
          // click if it travelled; a tap still gets through.
          onTouchStart={(e) => { pinTouchX.current = e.touches[0]?.clientX ?? null }}
          onTouchEnd={(e) => {
            const start = pinTouchX.current
            const end = e.changedTouches[0]?.clientX
            pinDragged.current = start != null && end != null && Math.abs(end - start) > 8
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (pinDragged.current) {
              pinDragged.current = false
              return
            }
            onTogglePin()
          }}
          className={cn(
            'absolute right-0 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded transition-opacity',
            pinned ? 'text-foreground opacity-90' : 'text-muted-foreground opacity-40',
          )}
        >
          <PinGlyph filled={Boolean(pinned)} size={13} />
        </button>
      </div>
    </SwipeableRow>
  )
}

// The worktree's pull request, mirrored from the desktop's `gh` lookup: the same
// glyph + number the desktop sidebar shows next to a branch. Tapping it opens the
// PR on GitHub rather than the row's action sheet, so the touch target stops the
// tap from reaching the row underneath.
function PRBadge({ pr }: { pr: GitPRInfo }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={pr.title || `PR #${pr.number}`}
      aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ''}`}
      className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground"
    >
      <PRGlyph state={pr.state} size={12} />
      <span className="text-[11px] tabular-nums leading-none">#{pr.number}</span>
    </a>
  )
}

// A worktree (tree) row: larger touch-friendly font, branch label, PR badge, tap
// to open its action sheet, swipe-left to delete (worktrees only — the main repo
// at index 0 is not deletable). The active tree is marked by the brighter label,
// not by a dot — a dot reads as a session status signal.
function SwipeableTreeRow({
  label,
  pr,
  isActiveTree,
  deletable,
  isBase,
  onTap,
  onDelete,
}: {
  label: string
  pr?: GitPRInfo
  isActiveTree: boolean
  deletable: boolean
  // The base tree (the main repo, index 0) shows a folder icon; worktrees show a branch icon.
  isBase: boolean
  onTap: () => void
  onDelete: () => void
}) {
  return (
    <SwipeableRow deletable={deletable} deleteLabel="Delete worktree" onTap={onTap} onDelete={onDelete}>
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-2 text-[15px]',
          isActiveTree ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {isBase ? <FolderIcon /> : <BranchGlyph size={13} />}
        <span className="truncate">{label}</span>
        {pr && <PRBadge pr={pr} />}
      </div>
    </SwipeableRow>
  )
}

export function AppSidebar({
  token,
  selectedId,
  onSelect,
  onClose,
  onWorktreeFired,
  acknowledged,
}: {
  token: string
  selectedId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  /** Arms the page's auto-attach for the workspace the fired action targets. */
  onWorktreeFired: (workspaceId: string) => void
  /**
   * Sessions whose needs-input signal the user has already read on screen (see
   * useAttentionAck). The page owns the set; the drawer takes it so its rows and
   * workspace badges count the same asks the session cards do.
   */
  acknowledged: ReadonlySet<string>
}) {
  const convex = useConvex()
  const state = useQuery(anyApi.remote.getRemoteState, { token })

  // On mobile the sidebar is a drawer over the terminal, so anything that opens a
  // session has to dismiss it — otherwise the drawer keeps covering the session it
  // just opened and the user has to swipe it away by hand.
  const { setOpenMobile } = useSidebar()

  // Auto-attach lands here as a `selectedId` change a beat after a spawn command
  // is sent (the desktop focuses the new session, the mirror reports it, the page
  // attaches). Closing on that change covers spawns; the tap/fire handlers below
  // close immediately so the drawer doesn't linger during the round-trip.
  // The mount run is skipped: AppSidebar is keyed by the foreground resync nonce,
  // so a remount must not slam shut a drawer the user just opened.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (selectedId) setOpenMobile(false)
  }, [selectedId, setOpenMobile])

  // Re-tapping the already-attached session leaves `selectedId` unchanged, so the
  // effect above never fires — close here as well.
  const selectSession = useCallback(
    (sid: string) => {
      onSelect(sid)
      setOpenMobile(false)
    },
    [onSelect, setOpenMobile],
  )

  const workspaces = (state?.workspaces ?? []) as SafeWorkspace[]
  const sessions = (state?.sessions ?? {}) as Record<string, SafeSession>
  const liveStatus = applyAttentionAck(
    (state?.liveStatus ?? {}) as Record<string, LiveStatus>,
    acknowledged,
  )

  // Optimistically hide killed rows: the kill round-trips through the desktop
  // (kill → deleteSession → state push) before the row drops from synced state,
  // which takes ~1s. Hiding immediately makes the swipe-to-trash feel instant;
  // the synced state catches up and removes the session for good.
  const [killed, setKilled] = useState<Set<string>>(new Set())

  // Which workspace's "New worktree" dialog is open (null = closed).
  const [worktreeFor, setWorktreeFor] = useState<SafeWorkspace | null>(null)

  const submitWorktree = useCallback(
    (workspaceId: string, { branch, selectedActionIds, spinUp }: WorktreeDialogResult) => {
      setWorktreeFor(null)
      // Only a worktree that spins something up ends in an attached session; a bare
      // worktree just adds a row, so leave the drawer open to show it.
      if (spinUp) setOpenMobile(false)
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'createWorktree',
        payload: buildCreateWorktreePayload(workspaceId, branch, selectedActionIds, spinUp),
      })
      onWorktreeFired(workspaceId)
    },
    [convex, token, onWorktreeFired, setOpenMobile],
  )

  // Swiping a row left and tapping the trash is two easy gestures away from
  // killing an agent mid-run — but only for a pinned session, the one mark that
  // says "keep this". Pinned closes ask here; everything else kills on the tap.
  const [confirmKill, setConfirmKill] = useState<{ sid: string; label: string } | null>(null)

  const killSession = useCallback(
    (sid: string) => {
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: sid,
        kind: 'kill',
        payload: {},
      })
      setKilled((prev) => new Set(prev).add(sid))
      onClose(sid)
    },
    [convex, token, onClose],
  )

  const { setPinned } = useSessionMeta(token)

  // Match the desktop: only one workspace is expanded at a time. Default to the
  // desktop's active workspace; tapping a collapsed workspace header expands it.
  const activeWorkspaceId = (state?.activeWorkspaceId ?? null) as string | null
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const effectiveExpanded = expandedId ?? activeWorkspaceId

  // Whenever the open session moves to a different workspace — tapping a session,
  // a push-notification attach, or the auto-attach that follows an action fired
  // here — expand that workspace, so reopening the drawer shows where the phone
  // actually is instead of the workspace it was last browsing. A manual tap still
  // wins until the open session moves again. (Render-time adjustment: React's
  // "store info from previous render" pattern, as in page.tsx.)
  const selectedWorkspaceId = selectedId ? sessions[selectedId]?.workspaceId ?? null : null
  const [prevSelectedWorkspaceId, setPrevSelectedWorkspaceId] = useState<string | null>(null)
  if (selectedWorkspaceId !== prevSelectedWorkspaceId) {
    setPrevSelectedWorkspaceId(selectedWorkspaceId)
    if (selectedWorkspaceId) setExpandedId(selectedWorkspaceId)
  }

  // The worktree whose action sheet is open (tap a worktree row to open it).
  const [sheetFor, setSheetFor] = useState<{ ws: SafeWorkspace; treeIdx: number; tree: SafeTree } | null>(null)

  const spawnInTree = useCallback(
    (workspaceId: string, treeIdx: number, choice: WorktreeActionChoice) => {
      setSheetFor(null)
      setOpenMobile(false)
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'spawnInTree',
        payload: buildSpawnInTreePayload(workspaceId, treeIdx, choice),
      })
      onWorktreeFired(workspaceId) // arm auto-attach to the session spawned there
    },
    [convex, token, onWorktreeFired, setOpenMobile],
  )

  // Dev servers the desktop detected, grouped per worktree below. Killing one
  // round-trips through the bridge; hide the row at once so the tap lands.
  const servers = safeServers((state as { servers?: unknown } | null | undefined)?.servers)
  const [killedServers, setKilledServers] = useState<Set<string>>(new Set())
  const [confirmServer, setConfirmServer] = useState<MirroredServer | null>(null)

  const killServer = useCallback(
    (server: MirroredServer) => {
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'killServer',
        payload: { pid: server.pid, port: server.port },
      })
      setKilledServers((prev) => new Set(prev).add(server.id))
    },
    [convex, token],
  )

  const removeWorktree = useCallback(
    (workspaceId: string, treeIdx: number) => {
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'removeWorktree',
        payload: { workspaceId, treeIndex: treeIdx },
      })
    },
    [convex, token],
  )

  return (
    <Sidebar>
      <SidebarHeader className="px-3 py-2 text-sm font-semibold">Orchestra Web</SidebarHeader>
      <SidebarContent>
        {state === undefined && <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>}
        {state === null && (
          <div className="px-3 py-2 text-sm text-muted-foreground">Desktop not connected</div>
        )}
        {workspaces.map((ws, wsIdx) => {
          const expanded = ws.id === effectiveExpanded
          const agentCounts = workspaceAgentCounts(ws, sessions, liveStatus)
          return (
            <SidebarGroup
              key={ws.id}
              className={cn(
                'border-b border-sidebar-border/60 py-1.5',
                wsIdx === 0 && 'border-t',
              )}
            >
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? '' : ws.id)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground',
                  expanded && 'bg-sidebar-accent',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {`${workspaceDisplayEmoji(ws.emoji, wsIdx)} `}
                  {ws.name}
                </span>
                <WorkspaceAgentBadge
                  thinking={agentCounts.thinking}
                  needsInput={agentCounts.needsInput}
                  thinkingAgent={agentCounts.thinkingAgent}
                  needsInputAgent={agentCounts.needsInputAgent}
                />
              </button>
              {expanded && (
                <SidebarGroupContent>
                  <button
                    type="button"
                    onClick={() => setWorktreeFor(ws)}
                    className="mb-1 mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-sidebar-border py-1 text-xs text-muted-foreground transition-opacity hover:opacity-80"
                  >
                    <span>+</span>
                    <span>New worktree</span>
                  </button>
                  {ws.trees.map((tree, treeIdx) => {
                    // Pinned first, each block keeping its order — same grouping the
                    // desktop sidebar and the roll use.
                    const treeSessions = orderTreeSessions(tree.sessionIds, sessions)
                      .map((sid) => ({ sid, s: sessions[sid] }))
                      .filter(({ sid, s }) => s && !killed.has(sid))
                    return (
                      <div key={tree.rootDir} className="mb-0.5">
                        <SidebarMenu>
                          <SwipeableTreeRow
                            label={treeIdx === 0 ? baseTreeLabel(tree) : treeLabel(tree)}
                            pr={tree.pr}
                            isActiveTree={treeIdx === ws.activeTreeIndex}
                            deletable={treeIdx !== 0}
                            isBase={treeIdx === 0}
                            onTap={() => setSheetFor({ ws, treeIdx, tree })}
                            onDelete={() => removeWorktree(ws.id, treeIdx)}
                          />
                        </SidebarMenu>
                        {treeSessions.length > 0 && (
                          <SidebarMenu className="pl-3">
                            {treeSessions.map(({ sid, s }) => {
                              const status = liveStatus[sid]
                              return (
                                <SwipeableSessionRow
                                  key={sid}
                                  label={sessionDisplayLabel(s, status)}
                                  iconToken={sessionIconToken(s.processStatus, s.actionIcon)}
                                  isAgent={isAgentSession(s.processStatus)}
                                  status={status}
                                  isActive={sid === selectedId}
                                  pinned={s.pinned}
                                  onSelect={() => selectSession(sid)}
                                  onDelete={() => {
                                    if (s.pinned) {
                                      setConfirmKill({
                                        sid,
                                        label: sessionDisplayLabel(s, status),
                                      })
                                    } else {
                                      killSession(sid)
                                    }
                                  }}
                                  onTogglePin={() => setPinned(sid, !s.pinned)}
                                />
                              )
                            })}
                          </SidebarMenu>
                        )}
                        <ServersGroup
                          servers={serversForTree(servers, tree.sessionIds).filter(
                            (srv) => !killedServers.has(srv.id),
                          )}
                          onKill={(srv) => setConfirmServer(srv)}
                        />
                      </div>
                    )
                  })}
                </SidebarGroupContent>
              )}
            </SidebarGroup>
          )
        })}
      </SidebarContent>
      {worktreeFor && (
        <WorktreeDialog
          workspaceName={`${workspaceDisplayEmoji(
            worktreeFor.emoji,
            workspaces.findIndex((w) => w.id === worktreeFor.id),
          )} ${worktreeFor.name}`}
          actions={worktreeFor.customActions ?? []}
          onConfirm={(result) => submitWorktree(worktreeFor.id, result)}
          onCancel={() => setWorktreeFor(null)}
        />
      )}
      {sheetFor && (
        <WorktreeActionSheet
          title={treeLabel(sheetFor.tree)}
          actions={sheetFor.ws.customActions ?? []}
          onChoose={(choice) => spawnInTree(sheetFor.ws.id, sheetFor.treeIdx, choice)}
          onCancel={() => setSheetFor(null)}
        />
      )}
      {confirmServer && (
        <ConfirmSheet
          title="Kill this server?"
          body={
            <>
              <span className="font-medium text-foreground">{confirmServer.name}</span> on port{' '}
              <span className="font-medium text-foreground">{confirmServer.port}</span> will be
              stopped and its port freed. Whatever task started it keeps running.
            </>
          }
          confirmLabel="Kill server"
          onCancel={() => setConfirmServer(null)}
          onConfirm={() => {
            killServer(confirmServer)
            setConfirmServer(null)
          }}
        />
      )}
      {confirmKill && (
        <ConfirmSheet
          title="Close this pinned session?"
          body={
            <>
              <span className="font-medium text-foreground">{confirmKill.label}</span> is pinned and
              will be terminated. Anything the agent has in flight is lost — the conversation can
              still be resumed later.
            </>
          }
          confirmLabel="Close session"
          onCancel={() => setConfirmKill(null)}
          onConfirm={() => {
            killSession(confirmKill.sid)
            setConfirmKill(null)
          }}
        />
      )}
    </Sidebar>
  )
}
