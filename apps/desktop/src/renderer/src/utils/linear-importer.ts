import { ConvexReactClient } from 'convex/react'
import { api } from '../../../../../backend/convex/_generated/api'
import { fetchBoardData } from './linear-client'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

function mapLinearStatus(stateType: string): IssueStatus | null {
  switch (stateType) {
    case 'backlog':
    case 'unstarted':
    case 'triage':
      return 'todo'
    case 'started':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'cancelled':
      return null
    default:
      return 'todo'
  }
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

export async function importFromLinear(
  convex: ConvexReactClient,
  workspaceId: string,
  apiKey: string,
  teamId: string,
  filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] },
): Promise<ImportResult> {
  const boardData = await fetchBoardData(apiKey, teamId, filters)
  let created = 0
  let updated = 0
  let skipped = 0

  for (const issue of boardData.issues) {
    const mappedStatus = mapLinearStatus(issue.state.type)
    if (!mappedStatus) {
      skipped++
      continue
    }

    const labelIds = await Promise.all(
      issue.labels.nodes.map((label) =>
        convex.mutation(api.issueLabels.findOrCreateByName, {
          workspaceId,
          name: label.name,
          color: label.color,
        })
      )
    )

    const result = await convex.mutation(api.issues.upsertFromLinear, {
      workspaceId,
      linearId: issue.id,
      title: issue.title,
      description: issue.description ?? undefined,
      priority: issue.priority,
      assigneeName: issue.assignee?.displayName ?? undefined,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? undefined,
      labelIds,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      mappedStatus,
    })

    if (result.created) created++
    else updated++
  }

  return { created, updated, skipped }
}
