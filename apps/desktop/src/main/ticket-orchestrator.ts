// Main-side orchestration for the web header's Linear ticket flow. Both entry
// points are triggered by the remote bridge command switch and write progress to
// the Convex `ticketDrafts` row the web polls. Everything runs in main: it has the
// persisted workspaces/sessions, safeStorage to decrypt the Linear key, fetch for
// the Linear API, the headless-agent runner, and the DEVICE_SECRET-authed client.

import { execFile } from 'node:child_process'
import { anyApi } from 'convex/server'
import type { Workspace } from '../shared/types'
import { DEVICE_SECRET } from './convex-config'
import { parseTicketDraft, buildTicketPrompt } from './ticket-draft-parse'
import { decryptStringFromStorage } from './linear-safe-storage'
import { readTreeBranch } from './remote-bridge-sanitize'
import { collectWorktreeGitContext } from './worktree-git-context'
import { getRemoteClient, remoteBridgeForcePush, getMirrorSnapshot } from './remote-bridge'
import { invalidateLinearIssue } from './linear-mirror'
import { runHeadlessAgent } from './run-headless-agent'
import { buildLinkedBranchName, slugifyForBranch } from '../shared/linear-branch'
import { fetchViewer, fetchTeamProjects, fetchTeamLabels, createIssue } from './linear-api'

interface WorktreeContext {
  workspace: Workspace
  rootDir: string
  apiKey: string
  teamId: string
}

/** Resolve a session to its worktree + decrypted Linear config, or a reason string. */
function resolveContext(sessionId: string): WorktreeContext | { error: string } {
  // Read the renderer's live snapshot, not disk: a just-spawned session's tree
  // membership may not have been persisted yet (the disk debounce is starved by
  // the agent-boot update storm), and the web resolves the session from this same
  // mirrored state — so disk would report "Session not found" for a live session.
  const data = getMirrorSnapshot()
  const session = data.sessions[sessionId]
  if (!session) return { error: 'Session not found.' }
  const workspace = data.workspaces[session.workspaceId]
  if (!workspace) return { error: 'Workspace not found.' }
  if (!workspace.linearConfig?.apiKey || !workspace.linearConfig.teamId) {
    return { error: 'Linear is not configured for this workspace.' }
  }
  const tree =
    workspace.trees.find((t) => t.sessionIds.includes(sessionId)) ??
    workspace.trees[workspace.activeTreeIndex] ??
    workspace.trees[0]
  if (!tree) return { error: 'Worktree not found.' }
  let apiKey: string
  try {
    apiKey = decryptStringFromStorage(workspace.linearConfig.apiKey)
  } catch {
    return { error: 'Could not decrypt the Linear API key.' }
  }
  return { workspace, rootDir: tree.rootDir, apiKey, teamId: workspace.linearConfig.teamId }
}

function client() {
  return getRemoteClient()
}

async function setError(requestId: string, error: string): Promise<void> {
  try {
    await client().mutation(anyApi.ticketDrafts.setTicketDraftStatus, {
      secret: DEVICE_SECRET,
      requestId,
      status: 'error',
      error,
    })
  } catch (err) {
    console.error('[ticket-orchestrator] setError failed', err)
  }
}

export async function generateTicketDraft(requestId: string, sessionId: string): Promise<void> {
  if (!requestId) return
  const ctx = resolveContext(sessionId)
  if ('error' in ctx) return void setError(requestId, ctx.error)

  try {
    // Team option lists seed the prompt (so the agent picks valid labels/projects)
    // and the web editor's selectors. The git read rides along in the same
    // Promise.all — it's local and fast, so it costs no extra wall-clock, and it
    // saves the agent several tool-call round-trips once it starts.
    const [viewer, projects, labels, gitContext] = await Promise.all([
      fetchViewer(ctx.apiKey),
      fetchTeamProjects(ctx.apiKey, ctx.teamId),
      fetchTeamLabels(ctx.apiKey, ctx.teamId),
      collectWorktreeGitContext(ctx.rootDir).catch(() => null),
    ])

    const output = await runHeadlessAgent(
      ctx.rootDir,
      buildTicketPrompt(labels.map((l) => l.name), projects.map((p) => p.name), gitContext),
    )
    const draft = parseTicketDraft(output)
    if (!draft) return void setError(requestId, 'The agent did not return a usable ticket draft.')

    await client().mutation(anyApi.ticketDrafts.finalizeTicketDraft, {
      secret: DEVICE_SECRET,
      requestId,
      draft,
      viewer: viewer ?? null,
      projects,
      labels,
    })
  } catch (err) {
    console.error('[ticket-orchestrator] generate failed', err)
    await setError(requestId, err instanceof Error ? err.message : 'Ticket generation failed.')
  }
}

interface CreateFields {
  title?: string
  description?: string
  labelIds?: string[]
  projectId?: string | null
  priority?: number
  assigneeId?: string | null
}

export async function createLinearTicket(requestId: string, sessionId: string, fields: CreateFields): Promise<void> {
  if (!requestId) return
  const ctx = resolveContext(sessionId)
  if ('error' in ctx) return void setError(requestId, ctx.error)
  if (!fields.title?.trim()) return void setError(requestId, 'Ticket title is required.')

  try {
    await client().mutation(anyApi.ticketDrafts.setTicketDraftStatus, {
      secret: DEVICE_SECRET,
      requestId,
      status: 'creating',
    })

    const created = await createIssue(ctx.apiKey, {
      teamId: ctx.teamId,
      title: fields.title.trim(),
      description: fields.description || undefined,
      labelIds: fields.labelIds?.length ? fields.labelIds : undefined,
      projectId: fields.projectId || undefined,
      assigneeId: fields.assigneeId || undefined,
      priority: typeof fields.priority === 'number' ? fields.priority : undefined,
    })

    // Rename the branch to embed the new identifier so branch-based linking picks
    // it up (desktop sidebar + this header alike). Best-effort: a failure here
    // doesn't undo the created ticket.
    const current = readTreeBranch(ctx.rootDir) ?? ''
    const newBranch = buildLinkedBranchName(current, created.identifier, slugifyForBranch(fields.title))
    if (newBranch !== current) {
      await renameBranch(ctx.rootDir, newBranch).catch((err) =>
        console.error('[ticket-orchestrator] branch rename failed', err),
      )
    }

    // Drop any stale cache for this identifier and force an immediate mirror push
    // so the web's icon flips to colored without waiting for the heartbeat.
    invalidateLinearIssue(created.identifier)
    remoteBridgeForcePush()

    await client().mutation(anyApi.ticketDrafts.setTicketDraftStatus, {
      secret: DEVICE_SECRET,
      requestId,
      status: 'created',
      result: created,
    })
  } catch (err) {
    console.error('[ticket-orchestrator] create failed', err)
    await setError(requestId, err instanceof Error ? err.message : 'Creating the Linear ticket failed.')
  }
}

function renameBranch(cwd: string, newName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['branch', '-m', newName], { cwd }, (err) => (err ? reject(err) : resolve()))
  })
}
