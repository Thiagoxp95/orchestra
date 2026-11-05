// The phone's PR page, in the desktop's main area for one workspace. The page
// itself lives in apps/web (shared through the `@/` alias); this wrapper hands
// it the workspace, tints the shadcn tokens to the workspace color, and turns
// "open the session on this branch" into a desktop session switch.

import { useEffect, useState } from 'react'
import { PullRequestsView, type PullRequestsTarget } from '@/components/github/PullRequestsView'
import { CHROME_VAR_KEYS, chromeVars } from '@/lib/workspace-color'
import type { Workspace } from '../../../shared/types'
import { useAppStore } from '../store/app-store'

export function PullRequestsPane({ workspace }: { workspace: Workspace }) {
  const rootDir = workspace.trees[0]?.rootDir
  const [target, setTarget] = useState<PullRequestsTarget | null>(rootDir ? { rootDir } : null)

  // A PR's "open session" button needs each worktree's branch; the store keeps
  // only directories, so ask git once per workspace.
  const [branches, setBranches] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      workspace.trees.map(async (t) => [t.rootDir, (await window.electronAPI.getGitBranch(t.rootDir)) ?? ''] as const),
    ).then((pairs) => !cancelled && setBranches(Object.fromEntries(pairs)))
    return () => {
      cancelled = true
    }
  }, [workspace.trees])

  // Tint on :root, as the web app does: the author picker and confirm sheets
  // portal to <body>, outside this pane.
  useEffect(() => {
    const root = document.documentElement
    for (const [k, v] of Object.entries(chromeVars(workspace.color) ?? {})) root.style.setProperty(k, v)
    return () => {
      for (const k of CHROME_VAR_KEYS) root.style.removeProperty(k)
    }
  }, [workspace.color])

  if (!rootDir || !target) {
    return <div className="flex flex-1 items-center justify-center text-sm opacity-60">This workspace has no repository.</div>
  }

  const openSession = (sessionId: string) => {
    const store = useAppStore.getState()
    store.updateWorkspace(workspace.id, { viewMode: 'orchestrator' })
    store.setActiveSession(sessionId)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <PullRequestsView
        // One repository here: the sidebar is what switches workspaces.
        workspaces={[
          {
            id: workspace.id,
            name: workspace.name,
            emoji: workspace.emoji,
            trees: workspace.trees.map((t) => ({ rootDir: t.rootDir, sessionIds: t.sessionIds, branch: branches[t.rootDir] })),
          },
        ]}
        target={target}
        onTarget={setTarget}
        onOpenSession={openSession}
      />
    </div>
  )
}
