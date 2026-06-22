'use client'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { DynamicIcon } from './DynamicIcon'
import { cn } from '@/lib/utils'
import { selectActiveActions, type SafeAction, type SafeWorkspaceLike } from '@/lib/actions'

/**
 * Horizontally-scrollable row of the active workspace's desktop custom actions.
 * Tapping one sends a `runAction` command; the desktop runs it like a NavBar
 * tap and the new session is auto-attached by the page (see page.tsx).
 */
export function ActionBar({ token, onActionFired }: { token: string; onActionFired: () => void }) {
  const convex = useConvex()
  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | { workspaces?: SafeWorkspaceLike[]; activeWorkspaceId?: string | null }
    | null
    | undefined

  const activeWorkspaceId = state?.activeWorkspaceId ?? null
  const actions = selectActiveActions(state?.workspaces, activeWorkspaceId)

  if (actions.length === 0) return null

  const run = (action: SafeAction) => {
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      // sessionId is unused for runAction; the payload carries the target.
      sessionId: '',
      kind: 'runAction',
      payload: { workspaceId: activeWorkspaceId, actionId: action.id },
    })
    onActionFired()
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto border-t border-border bg-sidebar px-1.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
