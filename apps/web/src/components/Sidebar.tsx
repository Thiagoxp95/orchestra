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
import { BranchGlyph } from './BranchGlyph'
import { WorktreeDialog, type WorktreeDialogResult } from './WorktreeDialog'
import { WorktreeActionSheet, type WorktreeActionChoice } from './WorktreeActionSheet'
import { buildCreateWorktreePayload, buildSpawnInTreePayload, type SafeAction } from '@/lib/actions'

interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
  branch?: string
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

function StatusDot({ status }: { status?: LiveStatus }) {
  const cls = status?.exited
    ? 'bg-muted-foreground/40'
    : status?.work === 'working'
      ? 'bg-green-500 animate-pulse'
      : 'bg-muted-foreground/30'
  return <span className={cn('ml-auto size-2 shrink-0 rounded-full', cls)} />
}

function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M5 4l.5 9c0 .6.4 1 1 1h3c.6 0 1-.4 1-1L11 4M6.5 6.5v5M9.5 6.5v5" />
    </svg>
  )
}

// Width of the trash action revealed behind a row when swiped left.
const REVEAL_PX = 64

// Swipe-left-to-reveal gesture shared by session and worktree rows. When `enabled`
// is false the row does not swipe (e.g. the main repo can't be deleted).
function useSwipeToReveal(enabled: boolean) {
  const [dx, setDx] = useState(0)
  const [open, setOpen] = useState(false)
  // While dragging, the row tracks the finger with no transition; on release the
  // snap (open/closed) animates. `dragging` drives that, `start` holds the origin.
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; base: number } | null>(null)
  const moved = useRef(false)

  const clamp = (v: number) => Math.max(-REVEAL_PX, Math.min(0, v))

  const onTouchStart = (e: React.TouchEvent) => {
    if (!enabled) return
    start.current = { x: e.touches[0].clientX, base: dx }
    moved.current = false
    setDragging(true)
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!start.current) return
    const delta = e.touches[0].clientX - start.current.x
    if (Math.abs(delta) > 6) moved.current = true
    setDx(clamp(start.current.base + delta))
  }
  const onTouchEnd = () => {
    start.current = null
    setDragging(false)
    const willOpen = dx < -REVEAL_PX / 2
    setOpen(willOpen)
    setDx(willOpen ? -REVEAL_PX : 0)
  }
  const onTouchCancel = () => {
    start.current = null
    setDragging(false)
    setOpen(false)
    setDx(0)
  }

  const close = () => {
    setOpen(false)
    setDx(0)
  }

  // The destructive action sits behind the row; mount it only while the row is
  // actually swiped or being dragged so it can never bleed at the right edge.
  const revealed = enabled && (dragging || dx < 0)

  return { dx, open, dragging, moved, revealed, close, touch: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } }
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

function SwipeableSessionRow({
  label,
  iconToken,
  status,
  isActive,
  onSelect,
  onDelete,
}: {
  label: string
  iconToken: string
  status?: LiveStatus
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  // Shimmer the label while an agent is actively working — mirrors the desktop
  // sidebar (SessionItem.tsx). 'working' is only ever set for agent sessions
  // (the bridge's claude-work-state tap), so terminals never shimmer.
  const isWorking = status?.work === 'working' && !status?.exited
  return (
    <SwipeableRow deletable deleteLabel="Close session" onTap={onSelect} onDelete={onDelete}>
      <SidebarMenuButton isActive={isActive} className="pointer-events-none">
        <DynamicIcon name={iconToken} size={16} />
        {/* Keep the explicit `truncate`: StatusDot (not this label) is span:last-child,
            so the parent's [&>span:last-child]:truncate rule does not reach the label. */}
        <span className={cn('truncate', isWorking && 'shimmer-active')}>{label}</span>
        <StatusDot status={status} />
      </SidebarMenuButton>
    </SwipeableRow>
  )
}

// A worktree (tree) row: larger touch-friendly font, branch label, active-tree
// dot, tap to open its action sheet, swipe-left to delete (worktrees only — the
// main repo at index 0 is not deletable).
function SwipeableTreeRow({
  label,
  isActiveTree,
  deletable,
  isBase,
  onTap,
  onDelete,
}: {
  label: string
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
        {isActiveTree && <span className="ml-auto size-2 shrink-0 rounded-full bg-muted-foreground/50" />}
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
}: {
  token: string
  selectedId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  /** Arms the page's auto-attach for the workspace the fired action targets. */
  onWorktreeFired: (workspaceId: string) => void
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
  const liveStatus = (state?.liveStatus ?? {}) as Record<string, LiveStatus>

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
                  {ws.emoji ? `${ws.emoji} ` : ''}
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
                    const treeSessions = tree.sessionIds
                      .map((sid) => ({ sid, s: sessions[sid] }))
                      .filter(({ sid, s }) => s && !killed.has(sid))
                    return (
                      <div key={tree.rootDir} className="mb-0.5">
                        <SidebarMenu>
                          <SwipeableTreeRow
                            label={treeIdx === 0 ? baseTreeLabel(tree) : treeLabel(tree)}
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
                                  label={status?.label ?? s.label}
                                  iconToken={sessionIconToken(s.processStatus, s.actionIcon)}
                                  status={status}
                                  isActive={sid === selectedId}
                                  onSelect={() => selectSession(sid)}
                                  onDelete={() => killSession(sid)}
                                />
                              )
                            })}
                          </SidebarMenu>
                        )}
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
          workspaceName={`${worktreeFor.emoji ? `${worktreeFor.emoji} ` : ''}${worktreeFor.name}`}
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
    </Sidebar>
  )
}
