import type { RecentAgentSession } from '../../../shared/types'
import { useAppStore } from '../store/app-store'
import { planResume } from './resume-agent-session'

/**
 * Spawn a terminal that resumes a past agent conversation, in the tree that owns
 * the directory it ran in. The single path behind both entry points — the
 * desktop's own resume drawer and the phone's resume sheet (see
 * useRemoteResumeSession) — so a remote resume behaves exactly like a local one.
 *
 * Returns false when there is nowhere to spawn it (no matching tree and no
 * active workspace).
 */
export function startResumedSession(
  session: Pick<RecentAgentSession, 'agent' | 'sessionId' | 'cwd'>,
): boolean {
  const state = useAppStore.getState()
  const plan = planResume(session, state.workspaces, state.activeWorkspaceId)
  if (!plan) return false
  state.setActiveWorkspace(plan.workspaceId)
  state.setActiveTree(plan.workspaceId, plan.treeIndex)
  window.electronAPI.prewarmTerminal({ cwd: plan.cwdOverride ?? session.cwd })
  state.createSession(
    plan.workspaceId,
    plan.command,
    undefined,
    undefined,
    undefined,
    session.agent,
    undefined,
    plan.treeIndex,
    plan.cwdOverride,
  )
  return true
}
