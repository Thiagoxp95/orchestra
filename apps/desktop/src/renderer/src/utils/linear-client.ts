import type { LinearTeam, LinearWorkflowState, LinearIssue, LinearBoardData, LinearIssueSummary, LinearCustomView } from '../../../shared/linear-types'

const LINEAR_API = 'https://api.linear.app/graphql'

async function linearQuery<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (res.status === 401) throw new Error('LINEAR_UNAUTHORIZED')
  if (res.status === 403) throw new Error('LINEAR_FORBIDDEN')
  if (res.status === 429) throw new Error('LINEAR_RATE_LIMITED')

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.errors?.[0]?.message ?? JSON.stringify(body)
    } catch { /* ignore */ }
    console.error(`[linear-client] ${res.status} response:`, detail)
    throw new Error(`LINEAR_API_ERROR:${res.status}:${detail}`)
  }

  const json = await res.json()
  if (json.errors?.length) throw new Error(`LINEAR_GRAPHQL_ERROR:${json.errors[0].message}`)
  return json.data
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await linearQuery<{ teams: { nodes: LinearTeam[] } }>(apiKey, `
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `)
  return data.teams.nodes
}

export async function fetchTeamMembers(apiKey: string, teamId: string): Promise<{ id: string; name: string; displayName: string; avatarUrl: string | null }[]> {
  const data = await linearQuery<{
    team: { members: { nodes: { id: string; name: string; displayName: string; avatarUrl: string | null }[] } }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        members {
          nodes {
            id
            name
            displayName
            avatarUrl
          }
        }
      }
    }
  `, { teamId })
  return data.team.members.nodes
}

export async function fetchTeamLabels(apiKey: string, teamId: string): Promise<{ id: string; name: string; color: string }[]> {
  const data = await linearQuery<{
    team: { labels: { nodes: { id: string; name: string; color: string }[] } }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
            color
          }
        }
      }
    }
  `, { teamId })
  return data.team.labels.nodes
}

export async function fetchCustomViews(apiKey: string): Promise<LinearCustomView[]> {
  const data = await linearQuery<{ customViews: { nodes: LinearCustomView[] } }>(apiKey, `
    query {
      customViews(first: 100) {
        nodes {
          id
          name
          description
          color
          team {
            id
            key
          }
        }
      }
    }
  `)
  return data.customViews.nodes
}

// Shared issue selection — the board and every view read the same fields.
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  priorityLabel
  url
  state {
    id
    name
    color
    position
    type
  }
  assignee {
    id
    name
    displayName
    avatarUrl
  }
  labels {
    nodes {
      id
      name
      color
    }
  }
  createdAt
  updatedAt
`

const WORKFLOW_STATE_FIELDS = `
  id
  name
  color
  position
  type
`

export type LinearImportFilters = { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] }

function buildIssueFilter(filters?: LinearImportFilters): Record<string, unknown> | undefined {
  const issueFilter: Record<string, unknown> = {}
  if (filters?.assigneeIds?.length) {
    issueFilter.assignee = { id: { in: filters.assigneeIds } }
  }
  if (filters?.labelIds?.length) {
    issueFilter.labels = { some: { id: { in: filters.labelIds } } }
  }
  if (filters?.stateIds?.length) {
    issueFilter.state = { id: { in: filters.stateIds } }
  }
  return Object.keys(issueFilter).length ? issueFilter : undefined
}

/**
 * Apply the same narrowing buildIssueFilter expresses server-side, but locally.
 * `customView.issues` carries the view's own filter and we don't layer an
 * IssueFilter on top of it, so view imports narrow here instead.
 */
export function applyIssueFilters(issues: LinearIssue[], filters?: LinearImportFilters): LinearIssue[] {
  const { assigneeIds, labelIds, stateIds } = filters ?? {}
  if (!assigneeIds?.length && !labelIds?.length && !stateIds?.length) return issues
  return issues.filter((issue) => {
    if (assigneeIds?.length && !(issue.assignee && assigneeIds.includes(issue.assignee.id))) return false
    if (labelIds?.length && !issue.labels.nodes.some((l) => labelIds.includes(l.id))) return false
    if (stateIds?.length && !stateIds.includes(issue.state.id)) return false
    return true
  })
}

export async function fetchBoardData(
  apiKey: string,
  teamId: string,
  filters?: LinearImportFilters,
): Promise<LinearBoardData> {
  const data = await linearQuery<{
    team: {
      name: string
      states: { nodes: LinearWorkflowState[] }
      issues: { nodes: LinearIssue[] }
    }
  }>(apiKey, `
    query($teamId: String!, $filter: IssueFilter) {
      team(id: $teamId) {
        name
        states {
          nodes { ${WORKFLOW_STATE_FIELDS} }
        }
        issues(first: 200, filter: $filter) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }
  `, { teamId, filter: buildIssueFilter(filters) })

  return {
    columns: data.team.states.nodes.sort((a, b) => a.position - b.position),
    issues: data.team.issues.nodes,
    teamName: data.team.name,
  }
}

/**
 * Board data scoped to a Linear custom view: issues come from the view (so the
 * view's own filter decides membership), columns still come from the configured
 * team since that's what status mapping is keyed on.
 */
export async function fetchViewBoardData(
  apiKey: string,
  teamId: string,
  viewId: string,
  filters?: LinearImportFilters,
): Promise<LinearBoardData> {
  const data = await linearQuery<{
    team: { name: string; states: { nodes: LinearWorkflowState[] } }
    customView: { name: string; issues: { nodes: LinearIssue[] } } | null
  }>(apiKey, `
    query($teamId: String!, $viewId: String!) {
      team(id: $teamId) {
        name
        states {
          nodes { ${WORKFLOW_STATE_FIELDS} }
        }
      }
      customView(id: $viewId) {
        name
        issues(first: 200) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }
  `, { teamId, viewId })

  if (!data.customView) throw new Error('LINEAR_VIEW_NOT_FOUND')

  return {
    columns: data.team.states.nodes.sort((a, b) => a.position - b.position),
    issues: applyIssueFilters(data.customView.issues.nodes, filters),
    teamName: data.team.name,
  }
}

export async function fetchIssueByIdentifier(
  apiKey: string,
  identifier: string,
): Promise<LinearIssueSummary | null> {
  try {
    const data = await linearQuery<{
      issue: {
        identifier: string
        title: string
        url: string
        state: { name: string; color: string; type: string }
      } | null
    }>(apiKey, `
      query($id: String!) {
        issue(id: $id) {
          identifier
          title
          url
          state {
            name
            color
            type
          }
        }
      }
    `, { id: identifier })
    if (!data.issue) return null
    return {
      identifier: data.issue.identifier,
      title: data.issue.title,
      url: data.issue.url,
      state: {
        name: data.issue.state.name,
        color: data.issue.state.color,
        type: data.issue.state.type,
      },
    }
  } catch {
    return null
  }
}