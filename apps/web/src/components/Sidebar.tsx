'use client'
import { useCallback, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { DynamicIcon, sessionIconToken } from './DynamicIcon'
import { WorktreeDialog, type WorktreeDialogResult } from './WorktreeDialog'
import { buildCreateWorktreePayload, type SafeAction } from '@/lib/actions'

interface SafeTree {
  rootDir: string
  sessionIds: string[]
  displayName?: string
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
}

function FolderIcon({ color }: { color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M2 4c0-.6.4-1 1-1h3.6l1.4 2H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4z" />
    </svg>
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

// A sidebar row that reveals a trash (close) button when swiped left. Tapping a
// closed row selects it; tapping an open row snaps it shut instead of selecting.
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
  const [dx, setDx] = useState(0)
  const [open, setOpen] = useState(false)
  // While dragging, the row tracks the finger with no transition; on release the
  // snap (open/closed) animates. `dragging` drives that, `start` holds the origin.
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; base: number } | null>(null)
  const moved = useRef(false)

  const clamp = (v: number) => Math.max(-REVEAL_PX, Math.min(0, v))

  const onTouchStart = (e: React.TouchEvent) => {
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

  // The red destructive action sits behind the row; mount it only while the row
  // is actually swiped or being dragged so it can never bleed at the right edge.
  const revealed = dragging || dx < 0

  const handleClick = () => {
    // A swipe that landed open: first tap just closes it.
    if (open) {
      setOpen(false)
      setDx(0)
      return
    }
    // Ignore the click that ends a drag gesture.
    if (moved.current) return
    onSelect()
  }

  return (
    <SidebarMenuItem className="relative overflow-hidden">
      {revealed && (
        <button
          type="button"
          aria-label="Close session"
          tabIndex={open ? 0 : -1}
          onClick={onDelete}
          className="absolute inset-y-0 right-0 flex w-16 items-center justify-center bg-destructive text-white"
        >
          <TrashIcon />
        </button>
      )}
      <div
        className="relative bg-sidebar"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <SidebarMenuButton isActive={isActive} onClick={handleClick}>
          <DynamicIcon name={iconToken} size={16} />
          <span className="truncate">{label}</span>
          <StatusDot status={status} />
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
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
  onWorktreeFired: () => void
}) {
  const convex = useConvex()
  const state = useQuery(anyApi.remote.getRemoteState, { token })

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
      void convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId: '',
        kind: 'createWorktree',
        payload: buildCreateWorktreePayload(workspaceId, branch, selectedActionIds, spinUp),
      })
      onWorktreeFired()
    },
    [convex, token, onWorktreeFired],
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

  return (
    <Sidebar>
      <SidebarHeader className="px-3 py-2 text-sm font-semibold">Orchestra Web</SidebarHeader>
      <SidebarContent>
        {state === undefined && <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>}
        {state === null && (
          <div className="px-3 py-2 text-sm text-muted-foreground">Desktop not connected</div>
        )}
        {workspaces.map((ws) => (
          <SidebarGroup key={ws.id}>
            <SidebarGroupLabel className="gap-1.5">
              <FolderIcon color={ws.color} />
              {ws.emoji ? `${ws.emoji} ` : ''}
              {ws.name}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {ws.trees.flatMap((tree) =>
                  tree.sessionIds.map((sid) => {
                    const s = sessions[sid]
                    if (!s || killed.has(sid)) return null
                    const status = liveStatus[sid]
                    return (
                      <SwipeableSessionRow
                        key={sid}
                        label={status?.label ?? s.label}
                        iconToken={sessionIconToken(s.processStatus, s.actionIcon)}
                        status={status}
                        isActive={sid === selectedId}
                        onSelect={() => onSelect(sid)}
                        onDelete={() => killSession(sid)}
                      />
                    )
                  }),
                )}
              </SidebarMenu>
            </SidebarGroupContent>
            <SidebarGroupContent>
              <button
                type="button"
                onClick={() => setWorktreeFor(ws)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-sidebar-border py-1 text-xs text-muted-foreground transition-opacity hover:opacity-80"
              >
                <span>+</span>
                <span>New worktree</span>
              </button>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {worktreeFor && (
        <WorktreeDialog
          workspaceName={`${worktreeFor.emoji ? `${worktreeFor.emoji} ` : ''}${worktreeFor.name}`}
          actions={worktreeFor.customActions ?? []}
          onConfirm={(result) => submitWorktree(worktreeFor.id, result)}
          onCancel={() => setWorktreeFor(null)}
        />
      )}
    </Sidebar>
  )
}
