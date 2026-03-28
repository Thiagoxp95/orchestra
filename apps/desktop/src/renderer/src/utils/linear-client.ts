import type { LinearTeam, LinearWorkflowState, LinearIssue, LinearBoardData } from '../../../shared/linear-types'

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

export async function fetchBoardData(
  apiKey: string,
  teamId: string,
  filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] },
): Promise<LinearBoardData> {
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
  const filterVar = Object.keys(issueFilter).length ? issueFilter : undefined

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
          nodes {
            id
            name
            color
            position
            type
          }
        }
        issues(first: 200, filter: $filter) {
          nodes {
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
          }
        }
      }
    }
  `, { teamId, filter: filterVar })

  return {
    columns: data.team.states.nodes.sort((a, b) => a.position - b.position),
    issues: data.team.issues.nodes,
    teamName: data.team.name,
  }
}

export async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  await linearQuery(apiKey, `
    mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `, { issueId, stateId })
}
