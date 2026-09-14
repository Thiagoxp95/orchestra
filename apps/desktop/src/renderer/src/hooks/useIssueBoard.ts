// src/renderer/src/hooks/useIssueBoard.ts
//
// The board's data layer, replacing Convex's reactive queries. Issues and
// labels load over IPC and reload whenever the main process broadcasts
// `issues:changed` for this workspace, so a mutation from any window (or a
// Linear import) shows up the same way a Convex subscription would have.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CreateIssueInput,
  IssueLabelRow,
  IssueRow,
  IssueStatus,
  UpdateIssueInput,
} from '../../../shared/issue-types'

export interface IssueBoardData {
  /** `undefined` until the first load resolves, matching useQuery's contract. */
  issues: IssueRow[] | undefined
  labels: IssueLabelRow[]
  refetch: () => Promise<void>
  createIssue: (input: CreateIssueInput) => Promise<IssueRow>
  updateIssue: (id: string, fields: UpdateIssueInput) => Promise<void>
  updateStatus: (id: string, status: IssueStatus, position: number) => Promise<void>
}

export function useIssueBoard(workspaceId: string): IssueBoardData {
  const [issues, setIssues] = useState<IssueRow[] | undefined>(undefined)
  const [labels, setLabels] = useState<IssueLabelRow[]>([])
  // Only the newest in-flight load may commit, so a slow fetch for a previous
  // workspace (or an older change event) never overwrites fresher rows.
  const loadSeqRef = useRef(0)

  const refetch = useCallback(async () => {
    const seq = ++loadSeqRef.current
    const [nextIssues, nextLabels] = await Promise.all([
      window.electronAPI.issuesList(workspaceId),
      window.electronAPI.issuesLabels(workspaceId),
    ])
    if (seq !== loadSeqRef.current) return
    setIssues(nextIssues)
    setLabels(nextLabels)
  }, [workspaceId])

  useEffect(() => {
    setIssues(undefined)
    setLabels([])
    void refetch().catch(() => {})
    const unsubscribe = window.electronAPI.onIssuesChanged((event) => {
      if (event.workspaceId !== workspaceId) return
      void refetch().catch(() => {})
    })
    return () => {
      loadSeqRef.current++
      unsubscribe()
    }
  }, [workspaceId, refetch])

  const createIssue = useCallback(
    (input: CreateIssueInput) => window.electronAPI.issuesCreate(input),
    [],
  )
  const updateIssue = useCallback(
    (id: string, fields: UpdateIssueInput) => window.electronAPI.issuesUpdate(id, fields),
    [],
  )
  const updateStatus = useCallback(
    (id: string, status: IssueStatus, position: number) =>
      window.electronAPI.issuesUpdateStatus(id, status, position),
    [],
  )

  return { issues, labels, refetch, createIssue, updateIssue, updateStatus }
}
