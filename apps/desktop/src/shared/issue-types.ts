// src/shared/issue-types.ts
//
// Issue-board records, shared by the main process (durable store) and the
// renderer (board UI) so neither imports the other's code. The `_id` /
// `_creationTime` field names are kept from the Convex era: the renderer
// already threads them through, so the data layer swap stays invisible.

export interface IssueBoardRow {
  _id: string
  _creationTime: number
}

export type IssueStatus = 'shaping' | 'todo' | 'up_next' | 'in_progress' | 'in_review' | 'done'

export interface IssueRow extends IssueBoardRow {
  workspaceId: string
  identifier: string
  title: string
  description?: string
  status: IssueStatus
  priority: number
  assigneeName?: string
  assigneeAvatarUrl?: string
  labelIds: string[]
  position: number
  linearId?: string
  linearIdentifier?: string
  linearUrl?: string
  linearViewIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface IssueLabelRow extends IssueBoardRow {
  workspaceId: string
  name: string
  color: string
}

export interface CreateIssueInput {
  workspaceId: string
  title: string
  description?: string
  status: IssueStatus
  priority: number
  assigneeName?: string
  labelIds: string[]
  position: number
  /** Stamped when the board has a Linear view active, so a locally-created
   *  issue stays visible instead of being filtered out by the view scope. */
  linearViewIds?: string[]
}

export interface UpdateIssueInput {
  title?: string
  description?: string
  status?: IssueStatus
  priority?: number
  assigneeName?: string
  assigneeAvatarUrl?: string
  labelIds?: string[]
  position?: number
}

export interface UpsertFromLinearInput {
  workspaceId: string
  linearId: string
  title: string
  description?: string
  priority: number
  assigneeName?: string
  assigneeAvatarUrl?: string
  labelIds: string[]
  linearIdentifier: string
  linearUrl: string
  mappedStatus: IssueStatus
  /** The custom view this import came from. Merged into the issue's membership
   *  set — an issue can belong to several views at once. */
  viewId?: string
}

/** Payload of the `issues:changed` broadcast the main process sends after
 *  every mutation, so open boards for that workspace can refetch. */
export interface IssuesChangedEvent {
  workspaceId: string
}
