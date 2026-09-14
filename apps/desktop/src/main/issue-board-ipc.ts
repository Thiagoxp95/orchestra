// src/main/issue-board-ipc.ts
//
// The renderer's door into the local issue board. Every channel maps onto one
// function in local-server/issues.ts; every mutation ends with an
// `issues:changed` broadcast so open boards refetch, which is the stand-in for
// the reactive queries the board had while it lived on Convex.

import { BrowserWindow, ipcMain } from 'electron'
import {
  createIssue,
  findOrCreateIssueLabel,
  getIssue,
  listIssueLabels,
  listIssues,
  pruneViewMembership,
  removeIssue,
  updateIssue,
  updateIssueStatus,
  upsertIssueFromLinear,
} from './local-server/issues'
import type {
  CreateIssueInput,
  IssueStatus,
  IssuesChangedEvent,
  UpdateIssueInput,
  UpsertFromLinearInput,
} from '../shared/issue-types'

export const ISSUES_CHANGED_CHANNEL = 'issues:changed'

export function broadcastIssuesChanged(workspaceId: string): void {
  const payload: IssuesChangedEvent = { workspaceId }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(ISSUES_CHANGED_CHANNEL, payload)
  }
}

export function registerIssueBoardIpc(): void {
  ipcMain.handle('issues:list', (_event, workspaceId: string) => listIssues(workspaceId))

  ipcMain.handle('issues:labels', (_event, workspaceId: string) => listIssueLabels(workspaceId))

  ipcMain.handle('issues:create', (_event, input: CreateIssueInput) => {
    const row = createIssue(input)
    broadcastIssuesChanged(input.workspaceId)
    return row
  })

  ipcMain.handle('issues:update', (_event, id: string, fields: UpdateIssueInput) => {
    const workspaceId = workspaceOf(id)
    updateIssue(id, fields)
    if (workspaceId) broadcastIssuesChanged(workspaceId)
  })

  ipcMain.handle(
    'issues:updateStatus',
    (_event, id: string, status: IssueStatus, position: number) => {
      const workspaceId = workspaceOf(id)
      updateIssueStatus(id, status, position)
      if (workspaceId) broadcastIssuesChanged(workspaceId)
    },
  )

  ipcMain.handle('issues:remove', (_event, id: string) => {
    const workspaceId = workspaceOf(id)
    removeIssue(id)
    if (workspaceId) broadcastIssuesChanged(workspaceId)
  })

  ipcMain.handle('issues:upsertFromLinear', (_event, input: UpsertFromLinearInput) => {
    const result = upsertIssueFromLinear(input)
    broadcastIssuesChanged(input.workspaceId)
    return result
  })

  ipcMain.handle(
    'issues:pruneViewMembership',
    (_event, workspaceId: string, viewId: string, presentLinearIds: string[]) => {
      const result = pruneViewMembership(workspaceId, viewId, presentLinearIds)
      broadcastIssuesChanged(workspaceId)
      return result
    },
  )

  ipcMain.handle(
    'issues:findOrCreateLabel',
    (_event, workspaceId: string, name: string, color: string) => {
      const id = findOrCreateIssueLabel(workspaceId, name, color)
      broadcastIssuesChanged(workspaceId)
      return id
    },
  )
}

/** Mutations addressed by issue id need the workspace to know whom to tell. */
function workspaceOf(issueId: string): string | null {
  return getIssue(issueId)?.workspaceId ?? null
}
