'use client'
import { useEffect, useState } from 'react'
import { DynamicIcon } from './DynamicIcon'
import { BranchGlyph } from './BranchGlyph'
import { SPIN_UP_AGENTS, type SafeAction, type SpinUpAgent } from '@/lib/actions'
import type { TreeOption } from '@/lib/session-roll'

/** Where the "+" at the end of the worktree picker points. */
export const NEW_TREE = -1

export type WorkspaceSpawn =
  | { treeIndex: number; target: { agent: SpinUpAgent } | { actionId: string } }
  | { branch: string; target: { agent: SpinUpAgent } | { actionId: string } }

/**
 * The workspace's own action sheet, opened by tapping a workspace header on the
 * sessions screen.
 *
 * Two questions in one sheet, in the order you actually answer them: *where*
 * (which worktree — or a new one) and *what* (an agent, a terminal, or one of
 * the workspace's custom actions). The worktree is a native <select> so the
 * phone gives it a wheel instead of a list competing with the action rows below
 * it, and its last entry is "+ New worktree", which unfolds a branch field and
 * turns every action row into "create that tree, then do this in it" — the
 * sidebar's New Worktree dialog, minus the trip through the drawer.
 *
 * A choice fires on the tap that names it: there is no confirm button, because
 * with the destination already picked the action row IS the confirmation.
 */
export function WorkspaceActionSheet({
  workspaceName,
  trees,
  actions,
  initialTreeIndex,
  onSpawn,
  onCancel,
}: {
  workspaceName: string
  trees: TreeOption[]
  actions: SafeAction[]
  /** Which tree to open on — the one whose card was tapped, when there was one. */
  initialTreeIndex?: number
  onSpawn: (spawn: WorkspaceSpawn) => void
  onCancel: () => void
}) {
  const [treeIndex, setTreeIndex] = useState<number>(
    () => initialTreeIndex ?? trees[0]?.treeIndex ?? NEW_TREE,
  )
  const [branch, setBranch] = useState('')
  const creating = treeIndex === NEW_TREE
  // Nothing to spawn into until a new tree has a name to be created under.
  const ready = !creating || branch.trim().length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const fire = (target: { agent: SpinUpAgent } | { actionId: string }) => {
    if (!ready) return
    onSpawn(creating ? { branch: branch.trim(), target } : { treeIndex, target })
  }

  const Row = ({
    icon,
    label,
    onClick,
  }: {
    icon: React.ReactNode
    label: string
    onClick: () => void
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!ready}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent active:bg-accent disabled:opacity-40"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85svh] w-full overflow-y-auto rounded-t-2xl border border-border bg-sidebar p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-sm sm:rounded-2xl"
      >
        <div className="mb-2 truncate px-3 pt-1 text-xs uppercase tracking-wider text-muted-foreground">
          {workspaceName}
        </div>

        {/* Where. The glyph repeats the one on the cards, so the picker reads as
            "the branch line, but editable". */}
        <div className="mb-2 flex items-center gap-2 px-3">
          <BranchGlyph size={13} />
          <select
            value={treeIndex}
            onChange={(e) => setTreeIndex(Number(e.target.value))}
            aria-label="Worktree"
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
          >
            {trees.map((tree) => (
              <option key={tree.treeIndex} value={tree.treeIndex}>
                {tree.label}
              </option>
            ))}
            <option value={NEW_TREE}>+ New worktree…</option>
          </select>
        </div>

        {creating && (
          <div className="mb-2 px-3">
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Branch name"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}

        {/* What. Same list, same order as the worktree sheet — the only thing that
            changed is which tree it lands in. */}
        <div className="my-1 border-t border-border" />
        {SPIN_UP_AGENTS.map((agent) => (
          <Row
            key={agent.id}
            icon={<DynamicIcon name={agent.icon} size={18} />}
            label={agent.id === 'terminal' ? 'Open Terminal' : agent.label}
            onClick={() => fire({ agent: agent.id })}
          />
        ))}
        {actions.length > 0 && (
          <>
            <div className="my-1 border-t border-border" />
            {actions.map((action) => (
              <Row
                key={action.id}
                icon={<DynamicIcon name={action.icon || '__terminal__'} size={18} />}
                label={action.name}
                onClick={() => fire({ actionId: action.id })}
              />
            ))}
          </>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="mt-1 w-full rounded-lg px-3 py-3 text-center text-sm text-muted-foreground transition-colors hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
