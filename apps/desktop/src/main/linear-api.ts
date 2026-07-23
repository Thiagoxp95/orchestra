// Main-process Linear GraphQL client. Mirrors the read helpers in
// renderer/src/utils/linear-client.ts but lives in main (uses global fetch) so
// the bridge/orchestrator can resolve tickets, list options, and create issues
// without a renderer round-trip. The renderer copy stays the source for the UI's
// board features; keep the two in sync when the schema changes.

import type { LinearIssueDetail, LinearProject, LinearLabel } from '../shared/linear-types'

const LINEAR_API = 'https://api.linear.app/graphql'

async function linearQuery<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`LINEAR_API_ERROR:${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(`LINEAR_GRAPHQL_ERROR:${json.errors[0].message}`)
  return json.data as T
}

export async function fetchIssueDetail(apiKey: string, identifier: string): Promise<LinearIssueDetail | null> {
  const data = await linearQuery<{
    issue: {
      identifier: string
      title: string
      url: string
      description: string | null
      priority: number
      state: { name: string; color: string; type: string }
      assignee: { displayName: string; avatarUrl: string | null } | null
      labels: { nodes: LinearLabel[] }
    } | null
  }>(apiKey, `
    query($id: String!) {
      issue(id: $id) {
        identifier title url description priority
        state { name color type }
        assignee { displayName avatarUrl }
        labels { nodes { id name color } }
      }
    }
  `, { id: identifier })
  if (!data.issue) return null
  return {
    identifier: data.issue.identifier,
    title: data.issue.title,
    url: data.issue.url,
    description: data.issue.description ?? null,
    priority: data.issue.priority ?? 0,
    state: { name: data.issue.state.name, color: data.issue.state.color, type: data.issue.state.type },
    labels: data.issue.labels?.nodes ?? [],
    assignee: data.issue.assignee
      ? { displayName: data.issue.assignee.displayName, avatarUrl: data.issue.assignee.avatarUrl ?? null }
      : null,
  }
}

export async function fetchViewer(apiKey: string): Promise<{ id: string; displayName: string } | null> {
  const data = await linearQuery<{ viewer: { id: string; displayName: string } }>(apiKey, `
    query { viewer { id displayName } }
  `)
  return data.viewer ?? null
}

export async function fetchTeamProjects(apiKey: string, teamId: string): Promise<LinearProject[]> {
  const data = await linearQuery<{ team: { projects: { nodes: LinearProject[] } } }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) { projects(first: 100) { nodes { id name } } }
    }
  `, { teamId })
  return data.team.projects.nodes
}

export async function fetchTeamLabels(apiKey: string, teamId: string): Promise<LinearLabel[]> {
  const data = await linearQuery<{ team: { labels: { nodes: LinearLabel[] } } }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) { labels { nodes { id name color } } }
    }
  `, { teamId })
  return data.team.labels.nodes
}

export interface CreateIssueInput {
  teamId: string
  title: string
  description?: string
  labelIds?: string[]
  projectId?: string
  assigneeId?: string
  priority?: number
}

export async function createIssue(apiKey: string, input: CreateIssueInput): Promise<{ identifier: string; url: string }> {
  const data = await linearQuery<{
    issueCreate: { success: boolean; issue: { identifier: string; url: string } | null }
  }>(apiKey, `
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }
  `, { input })
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('LINEAR_ISSUE_CREATE_FAILED')
  return data.issueCreate.issue
}
