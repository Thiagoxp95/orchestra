// src/main/local-server/issues.ts
//
// The issue board, ported off Convex onto the durable store. Read and written
// by the desktop renderer over IPC, and importable from Linear.
//
// Status and position are user-owned: a Linear import updates titles, labels
// and assignees but never moves a card the user has placed.

import { getDurableStore, type IssueRow, type IssueLabelRow, type IssueStatus } from './durable-store'
import type { CreateIssueInput, UpdateIssueInput, UpsertFromLinearInput } from '../../shared/issue-types'

export type { CreateIssueInput, UpdateIssueInput, UpsertFromLinearInput }

export function listIssues(workspaceId: string): IssueRow[] {
  return getDurableStore().issues.filter((row) => row.workspaceId === workspaceId)
}

export function getIssue(id: string): IssueRow | null {
  return getDurableStore().issues.get(id)
}

export function createIssue(input: CreateIssueInput): IssueRow {
  const table = getDurableStore().issues
  // Identifiers are a workspace-scoped counter: ORQ-1, ORQ-2, …
  const maxNumber = listIssues(input.workspaceId).reduce((max, issue) => {
    const match = /^ORQ-(\d+)$/.exec(issue.identifier)
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max
  }, 0)
  const now = Date.now()
  return table.insert({
    ...input,
    identifier: `ORQ-${maxNumber + 1}`,
    createdAt: now,
    updatedAt: now,
  })
}

export function updateIssue(id: string, fields: UpdateIssueInput): void {
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) patch[key] = value
  }
  getDurableStore().issues.patch(id, patch)
}

export function updateIssueStatus(id: string, status: IssueStatus, position: number): void {
  getDurableStore().issues.patch(id, { status, position, updatedAt: Date.now() })
}

export function removeIssue(id: string): void {
  getDurableStore().issues.delete(id)
}

export function upsertIssueFromLinear(input: UpsertFromLinearInput): { id: string; created: boolean } {
  const { mappedStatus, viewId, ...fields } = input
  const table = getDurableStore().issues
  const now = Date.now()
  const existing = table.find((row) => row.linearId === fields.linearId)

  if (existing) {
    const linearViewIds = viewId
      ? [...new Set([...(existing.linearViewIds ?? []), viewId])]
      : existing.linearViewIds
    // Non-Orchestra fields only. Status and position belong to the user.
    table.patch(existing._id, {
      title: fields.title,
      description: fields.description,
      priority: fields.priority,
      assigneeName: fields.assigneeName,
      assigneeAvatarUrl: fields.assigneeAvatarUrl,
      labelIds: fields.labelIds,
      linearIdentifier: fields.linearIdentifier,
      linearUrl: fields.linearUrl,
      linearViewIds,
      updatedAt: now,
    })
    return { id: existing._id, created: false }
  }

  // New issue — append to the end of its target column.
  const maxPosition = table
    .filter((row) => row.workspaceId === fields.workspaceId && row.status === mappedStatus)
    .reduce((max, row) => Math.max(max, row.position), 0)

  const row = table.insert({
    ...fields,
    identifier: fields.linearIdentifier,
    status: mappedStatus,
    linearViewIds: viewId ? [viewId] : undefined,
    position: maxPosition + 1,
    createdAt: now,
    updatedAt: now,
  })
  return { id: row._id, created: true }
}

/**
 * Drop `viewId` from every workspace issue the latest import of that view did
 * NOT return, so the board's view scope reflects Linear rather than growing
 * forever. Issues created in Orchestra while the view was active keep their
 * stamp — they have no linearId, so they are never in `presentLinearIds`.
 */
export function pruneViewMembership(
  workspaceId: string,
  viewId: string,
  presentLinearIds: string[],
): { pruned: number } {
  const present = new Set(presentLinearIds)
  const table = getDurableStore().issues
  let pruned = 0
  for (const issue of listIssues(workspaceId)) {
    if (!issue.linearViewIds?.includes(viewId)) continue
    if (!issue.linearId || present.has(issue.linearId)) continue
    const next = issue.linearViewIds.filter((id) => id !== viewId)
    table.patch(issue._id, {
      linearViewIds: next.length > 0 ? next : undefined,
      updatedAt: Date.now(),
    })
    pruned++
  }
  return { pruned }
}

// ── Labels ───────────────────────────────────────────────────────────────

export function listIssueLabels(workspaceId: string): IssueLabelRow[] {
  return getDurableStore().issueLabels.filter((row) => row.workspaceId === workspaceId)
}

export function createIssueLabel(workspaceId: string, name: string, color: string): string {
  return getDurableStore().issueLabels.insert({ workspaceId, name, color })._id
}

export function findOrCreateIssueLabel(workspaceId: string, name: string, color: string): string {
  const table = getDurableStore().issueLabels
  const existing = table.find((row) => row.workspaceId === workspaceId && row.name === name)
  return existing ? existing._id : table.insert({ workspaceId, name, color })._id
}
