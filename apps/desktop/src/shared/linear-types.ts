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

export interface LinearIssueSummary {
  identifier: string  // e.g., "ENG-4504"
  title: string
  url: string
  state: {
    name: string   // e.g., "In Progress"
    color: string  // hex, e.g., "#f2c94c"
    type: string   // backlog | unstarted | started | completed | cancelled
  }
}

export interface LinearProject {
  id: string
  name: string
}

// Richer than LinearIssueSummary — everything the web's floating detail card
// renders. This is the shape mirrored per-tree into remoteState so the web can
// show a linked ticket without any Linear access of its own.
export interface LinearIssueDetail {
  identifier: string
  title: string
  url: string
  description: string | null
  priority: number       // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  state: {
    name: string
    color: string
    type: string
  }
  labels: LinearLabel[]
  assignee: { displayName: string; avatarUrl: string | null } | null
}

// The JSON contract the headless Claude agent must emit when generating a ticket
// draft from a worktree's work. Names (not ids) so the agent needn't know Linear
// internals; the desktop maps names → ids against the team's labels/projects.
export interface GeneratedTicketDraft {
  title: string
  description: string
  labelNames: string[]
  projectName: string | null
  priority: number       // 0=none, 1=urgent, 2=high, 3=medium, 4=low
}
