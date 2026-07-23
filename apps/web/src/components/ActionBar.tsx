'use client'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { DynamicIcon } from './DynamicIcon'
import { cn } from '@/lib/utils'
import { selectActiveActions, type SafeAction, type SafeWorkspaceLike } from '@/lib/actions'

/**
 * Horizontally-scrollable row of the viewed session's workspace custom actions.
 * Tapping one sends a `runAction` command; the desktop runs it like a NavBar
 * tap and the new session is auto-attached by the page (see page.tsx).
 *
 * The workspace is resolved from the session the phone is *currently viewing*
 * (each session mirrors its own `workspaceId`), NOT the desktop's active
 * workspace — otherwise switching sessions on the phone would keep showing the
 * desktop's last-focused workspace's actions. Falls back to activeWorkspaceId
 * when no session is attached.
 */
export function ActionBar({
  token,
  sessionId,
  onActionFired,
}: {
  token: string
  sessionId: string | null
  onActionFired: (workspaceId: string | null) => void
}) {
  const convex = useConvex()
  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | {
        workspaces?: SafeWorkspaceLike[]
        activeWorkspaceId?: string | null
        sessions?: Record<string, { workspaceId?: string }>
      }
    | null
    | undefined

  const sessionWorkspaceId = sessionId ? state?.sessions?.[sessionId]?.workspaceId ?? null : null
  const workspaceId = sessionWorkspaceId ?? state?.activeWorkspaceId ?? null
  const actions = selectActiveActions(state?.workspaces, workspaceId)

  if (actions.length === 0) return null

  const run = (action: SafeAction) => {
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      // sessionId is unused for runAction; the payload carries the target.
      sessionId: '',
      kind: 'runAction',
      payload: { workspaceId, actionId: action.id },
    })
    onActionFired(workspaceId)
  }

  return (
    <div
      // pb-home-indicator (globals.css): fat bottom padding so the scroll row
      // clears the iOS home indicator and its swipe-up-to-home gesture doesn't
      // collide with tapping the actions — collapsed while the soft keyboard is
      // up, since the keyboard covers the indicator anyway.
      className="pb-home-indicator flex gap-1.5 overflow-x-auto border-t border-border bg-sidebar px-1.5 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-label={action.name}
          title={action.name}
          // Keep the terminal focused so the device keyboard stays open.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(action)}
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md border border-border',
            'bg-background text-foreground transition-colors hover:bg-accent active:bg-accent',
          )}
        >
          <DynamicIcon name={action.icon} size={18} />
        </button>
      ))}
    </div>
  )
}
