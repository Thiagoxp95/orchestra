import { marked } from 'marked'
import { fetchBoardData, fetchViewBoardData, type LinearImportFilters } from './linear-client'
import type { ElectronAPI } from '../../../shared/types'
import type { IssueStatus } from '../../../shared/issue-types'

/** The slice of the IPC bridge an import needs. `window.electronAPI` satisfies it. */
export type LinearImportStore = Pick<
  ElectronAPI,
  'issuesFindOrCreateLabel' | 'issuesUpsertFromLinear' | 'issuesPruneViewMembership'
>

const DEFAULT_STATUS_MAP: Record<string, IssueStatus | null> = {
  backlog: 'todo',
  triage: 'todo',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  cancelled: null,
}

// Linear states that share a type with Todo (both `unstarted`) but deserve their
// own column. Matched on state name, since the type can't tell them apart.
const DEFAULT_NAME_MAP: { pattern: RegExp; status: IssueStatus }[] = [
  { pattern: /^up\s*next$/i, status: 'up_next' },
]

function mapLinearStatus(
  stateType: string,
  stateName: string,
  customMapping?: Record<string, IssueStatus | 'skip'>,
): IssueStatus | null {
  // Custom mapping by state name takes priority
  if (customMapping?.[stateName] !== undefined) {
    const mapped = customMapping[stateName]
    return mapped === 'skip' ? null : mapped
  }
  const byName = DEFAULT_NAME_MAP.find((m) => m.pattern.test(stateName.trim()))
  if (byName) return byName.status
  // Fall back to default by state type
  return DEFAULT_STATUS_MAP[stateType] ?? 'todo'
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

/**
 * Pull Linear issues into the workspace board. With `viewId` set the issues come
 * from that custom view and every upsert stamps the view id, so the board can
 * scope itself to the view; issues that dropped out of the view since the last
 * import get their stamp pruned at the end.
 */
export async function importFromLinear(
  store: LinearImportStore,
  workspaceId: string,
  apiKey: string,
  teamId: string,
  filters?: LinearImportFilters,
  statusMapping?: Record<string, IssueStatus | 'skip'>,
  viewId?: string,
): Promise<ImportResult> {
  const boardData = viewId
    ? await fetchViewBoardData(apiKey, teamId, viewId, filters)
    : await fetchBoardData(apiKey, teamId, filters)
  let created = 0
  let updated = 0
  let skipped = 0

  for (const issue of boardData.issues) {
    const mappedStatus = mapLinearStatus(issue.state.type, issue.state.name, statusMapping)
    if (!mappedStatus) {
      skipped++
      continue
    }

    const labelIds = await Promise.all(
      issue.labels.nodes.map((label) =>
        store.issuesFindOrCreateLabel(workspaceId, label.name, label.color)
      )
    )

    const result = await store.issuesUpsertFromLinear({
      workspaceId,
      linearId: issue.id,
      title: issue.title,
      description: issue.description ? await marked.parse(issue.description) : undefined,
      priority: issue.priority,
      assigneeName: issue.assignee?.displayName ?? undefined,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? undefined,
      labelIds,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      mappedStatus,
      viewId,
    })

    if (result.created) created++
    else updated++
  }

  if (viewId) {
    // Membership is "in the view", not "was imported" — pass every issue the
    // view returned, including ones the status mapping skipped, so a skipped
    // issue isn't silently dropped from a view it still belongs to.
    await store.issuesPruneViewMembership(
      workspaceId,
      viewId,
      boardData.issues.map((i) => i.id),
    )
  }

  return { created, updated, skipped }
}
