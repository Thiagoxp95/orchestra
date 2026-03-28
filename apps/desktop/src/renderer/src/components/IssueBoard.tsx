import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useMutation, useConvex } from 'convex/react'
import { api } from '../../../../../backend/convex/_generated/api'
import { IssueCard } from './IssueCard'
import { IssueDetailPanel } from './IssueDetailPanel'
import { IssueCreateForm } from './IssueCreateForm'
import { importFromLinear } from '../utils/linear-importer'
import { isLightColor, textColor } from '../utils/color'
import type { Doc, Id } from '../../../../../backend/convex/_generated/dataModel'

type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

const COLUMNS: { status: IssueStatus; label: string; color: string }[] = [
  { status: 'todo', label: 'Todo', color: '#8b8b8b' },
  { status: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { status: 'in_review', label: 'In Review', color: '#3b82f6' },
  { status: 'done', label: 'Done', color: '#22c55e' },
]

interface IssueBoardProps {
  workspaceId: string
  linearConfig?: {
    apiKey: string
    teamId: string
    teamName: string
    filters?: { assigneeIds?: string[]; labelIds?: string[]; stateIds?: string[] }
    importIntervalMinutes?: number
  }
  wsColor: string
}

export function IssueBoard({ workspaceId, linearConfig, wsColor }: IssueBoardProps) {
  const convex = useConvex()
  const issues = useQuery(api.issues.listByWorkspace, { workspaceId })
  const labels = useQuery(api.issueLabels.listByWorkspace, { workspaceId }) ?? []
  const createIssue = useMutation(api.issues.create)
  const updateStatus = useMutation(api.issues.updateStatus)

  const txtColor = textColor(wsColor)
  const isLight = isLightColor(wsColor)

  const [selectedIssue, setSelectedIssue] = useState<Doc<'issues'> | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<IssueStatus | null>(null)
  const [creatingInColumn, setCreatingInColumn] = useState<IssueStatus | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null)
  const [importing, setImporting] = useState(false)
  const dragIssueRef = useRef<Doc<'issues'> | null>(null)

  const showToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ── Drag and drop ──────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, issue: Doc<'issues'>) => {
    dragIssueRef.current = issue
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', issue._id)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    setDragOverColumn(null)
    dragIssueRef.current = null
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, status: IssueStatus) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(status)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetStatus: IssueStatus) => {
    e.preventDefault()
    setDragOverColumn(null)
    const issue = dragIssueRef.current
    if (!issue || issue.status === targetStatus) return

    const columnIssues = (issues ?? []).filter((i) => i.status === targetStatus)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await updateStatus({
        id: issue._id,
        status: targetStatus,
        position: maxPosition + 1,
      })
    } catch {
      showToast('Failed to update status')
    }
  }, [issues, updateStatus, showToast])

  // ── Status change from detail panel ────────────────────────────────
  const handleStatusChange = useCallback(async (issueId: string, status: string) => {
    const columnIssues = (issues ?? []).filter((i) => i.status === status)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await updateStatus({
        id: issueId as Id<'issues'>,
        status: status as IssueStatus,
        position: maxPosition + 1,
      })
    } catch {
      showToast('Failed to update status')
    }
  }, [issues, updateStatus, showToast])

  // ── Navigation ─────────────────────────────────────────────────────
  const handleNavigate = useCallback((direction: 'up' | 'down') => {
    if (!selectedIssue || !issues) return
    const columnIssues = issues
      .filter((i) => i.status === selectedIssue.status)
      .sort((a, b) => a.position - b.position)
    const idx = columnIssues.findIndex((i) => i._id === selectedIssue._id)
    if (idx < 0) return
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx >= 0 && nextIdx < columnIssues.length) {
      setSelectedIssue(columnIssues[nextIdx])
    }
  }, [selectedIssue, issues])

  // ── Create issue ───────────────────────────────────────────────────
  const handleCreateIssue = useCallback(async (title: string, status: IssueStatus) => {
    const columnIssues = (issues ?? []).filter((i) => i.status === status)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await createIssue({
        workspaceId,
        title,
        status,
        priority: 0,
        labelIds: [],
        position: maxPosition + 1,
      })
      setCreatingInColumn(null)
    } catch {
      showToast('Failed to create issue')
    }
  }, [workspaceId, issues, createIssue, showToast])

  // ── Import from Linear ─────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!linearConfig || importing) return
    setImporting(true)
    try {
      const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
      const result = await importFromLinear(
        convex,
        workspaceId,
        decryptedKey,
        linearConfig.teamId,
        linearConfig.filters,
      )
      showToast(`Imported: ${result.created} new, ${result.updated} updated`, 'info')
    } catch (err: any) {
      const msg = err?.message ?? 'Import failed'
      if (msg === 'LINEAR_UNAUTHORIZED') {
        showToast('Linear API key is invalid or expired')
      } else if (msg === 'LINEAR_RATE_LIMITED') {
        showToast('Rate limited by Linear — try again later')
      } else {
        showToast('Failed to import from Linear')
      }
    } finally {
      setImporting(false)
    }
  }, [linearConfig, importing, convex, workspaceId, showToast])

  // ── Periodic background import ────────────────────────────────────
  const importingRef = useRef(false)
  importingRef.current = importing

  useEffect(() => {
    if (!linearConfig) return

    const intervalMs = (linearConfig.importIntervalMinutes ?? 30) * 60 * 1000

    const doImport = async () => {
      if (importingRef.current) return
      try {
        const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
        await importFromLinear(convex, workspaceId, decryptedKey, linearConfig.teamId, linearConfig.filters)
      } catch {
        // silent fail for background import
      }
    }

    doImport()
    const id = setInterval(doImport, intervalMs)
    return () => clearInterval(id)
  }, [linearConfig?.teamId, linearConfig?.apiKey, workspaceId, convex])

  // ── Loading state ──────────────────────────────────────────────────
  if (issues === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: txtColor }}>
        <span className="text-sm opacity-50">Loading board...</span>
      </div>
    )
  }

  // Keep selected issue in sync with reactive data
  const currentSelected = selectedIssue
    ? issues.find((i) => i._id === selectedIssue._id) ?? null
    : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b" style={{ borderColor: `${txtColor}10` }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: txtColor }}>Issues</span>
          <span className="text-xs opacity-40" style={{ color: txtColor }}>{issues.length}</span>
        </div>
        <div className="flex items-center gap-3">
          {linearConfig && (
            <button
              onClick={handleImport}
              disabled={importing}
              className="text-xs opacity-50 hover:opacity-100 transition-opacity disabled:opacity-30"
              style={{ color: txtColor }}
              title="Import from Linear"
            >
              {importing ? 'Importing...' : 'Import from Linear'}
            </button>
          )}
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
        {COLUMNS.map((column) => {
          const columnIssues = issues
            .filter((i) => i.status === column.status)
            .sort((a, b) => a.position - b.position)
          const isDragOver = dragOverColumn === column.status

          return (
            <div
              key={column.status}
              className="flex flex-col min-w-[260px] max-w-[320px] flex-1 border-r last:border-r-0"
              style={{ borderColor: `${txtColor}08` }}
              onDragOver={(e) => handleDragOver(e, column.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.status)}
            >
              <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: column.color }}
                />
                <span className="text-xs font-medium truncate" style={{ color: txtColor }}>
                  {column.label}
                </span>
                <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
                  {columnIssues.length}
                </span>
                <button
                  onClick={() => setCreatingInColumn(column.status)}
                  className="ml-auto text-sm opacity-30 hover:opacity-70 transition-opacity"
                  style={{ color: txtColor }}
                  title="Add issue"
                >
                  +
                </button>
              </div>

              <div
                className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 transition-colors"
                style={{
                  backgroundColor: isDragOver
                    ? (isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)')
                    : 'transparent',
                }}
              >
                {creatingInColumn === column.status && (
                  <IssueCreateForm
                    defaultStatus={column.status}
                    txtColor={txtColor}
                    isLight={isLight}
                    onSubmit={handleCreateIssue}
                    onCancel={() => setCreatingInColumn(null)}
                  />
                )}
                {columnIssues.map((issue) => (
                  <div key={issue._id} onDragEnd={handleDragEnd}>
                    <IssueCard
                      issue={issue}
                      labels={labels}
                      txtColor={txtColor}
                      isLight={isLight}
                      onClick={() => setSelectedIssue(issue)}
                      onDragStart={(e) => handleDragStart(e, issue)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {currentSelected && (
          <IssueDetailPanel
            issue={currentSelected}
            labels={labels}
            wsColor={wsColor}
            txtColor={txtColor}
            onClose={() => setSelectedIssue(null)}
            onStatusChange={handleStatusChange}
            onNavigate={handleNavigate}
          />
        )}
      </div>

      {toast && (
        <div
          className="absolute bottom-4 right-4 px-4 py-2 rounded-lg text-sm shadow-lg z-50"
          style={{
            backgroundColor: toast.type === 'error' ? '#dc2626' : `${txtColor}15`,
            color: toast.type === 'error' ? '#fff' : txtColor,
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
