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
  if (!res.ok) throw new Error(`LINEAR_API_ERROR:${res.status}`)

  const json = await res.json()
  if (json.errors?.length) throw new Error(`LINEAR_GRAPHQL_ERROR:${json.errors[0].message}`)
  return json.data
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await linearQuery<{ teams: { nodes: LinearTeam[] } }>(apiKey, `
    query { teams { nodes { id name key } } }
  `)
  return data.teams.nodes
}

export async function fetchBoardData(apiKey: string, teamId: string): Promise<LinearBoardData> {
  const data = await linearQuery<{
    team: {
      name: string
      states: { nodes: LinearWorkflowState[] }
      issues: { nodes: LinearIssue[] }
    }
  }>(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        name
        states: workflowStates {
          nodes { id name color position type }
        }
        issues(first: 200, orderBy: updatedAt, filter: { state: { type: { nin: ["cancelled"] } } }) {
          nodes {
            id identifier title description priority priorityLabel url
            state { id name color position type }
            assignee { id name displayName avatarUrl }
            labels { nodes { id name color } }
            createdAt updatedAt
          }
        }
      }
    }
  `, { teamId })

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
