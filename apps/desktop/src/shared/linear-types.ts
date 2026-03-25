export interface LinearTeam {
  id: string
  name: string
  key: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  color: string
  position: number
  type: string // 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
}

export interface LinearUser {
  id: string
  name: string
  displayName: string
  avatarUrl: string | null
}

export interface LinearLabel {
  id: string
  name: string
  color: string
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  priorityLabel: string
  url: string
  state: LinearWorkflowState
  assignee: LinearUser | null
  labels: { nodes: LinearLabel[] }
  createdAt: string
  updatedAt: string
}

export interface LinearBoardData {
  columns: LinearWorkflowState[]
  issues: LinearIssue[]
  teamName: string
}
