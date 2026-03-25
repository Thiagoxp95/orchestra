import { useState, useCallback, useRef } from 'react'
import { useLinearBoard } from '../hooks/useLinearBoard'
import { updateIssueState } from '../utils/linear-client'
import { useAppStore } from '../store/app-store'
import { LinearTicketCard } from './LinearTicketCard'
import { LinearDetailPanel } from './LinearDetailPanel'
import { isLightColor, textColor } from '../utils/color'
import type { LinearIssue, LinearWorkflowState } from '../../../shared/linear-types'

interface LinearBoardProps {
  workspaceId: string
  linearConfig?: { apiKey: string; teamId: string; teamName: string }
  wsColor: string
  onOpenSettings: () => void
}

export function LinearBoard({ workspaceId, linearConfig, wsColor, onOpenSettings }: LinearBoardProps) {
  const { data, loading, error, errorType, refresh, lastRefreshed, decryptedKey } = useLinearBoard(workspaceId, linearConfig, true)
  const setMutationInflight = useAppStore((s) => s.setLinearMutationInflight)
  const txtColor = textColor(wsColor)
  const isLight = isLightColor(wsColor)

  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'error' | 'info' } | null>(null)
  const dragIssueRef = useRef<LinearIssue | null>(null)

  const showToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, issue: LinearIssue) => {
    dragIssueRef.current = issue
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', issue.id)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    setDragOverColumn(null)
    dragIssueRef.current = null
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(columnId)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetState: LinearWorkflowState) => {
    e.preventDefault()
    setDragOverColumn(null)
    const issue = dragIssueRef.current
    if (!issue || issue.state.id === targetState.id || !data || !decryptedKey) return

    setMutationInflight(workspaceId, true)
    const previousData = data
    const updatedIssues = data.issues.map((i) =>
      i.id === issue.id ? { ...i, state: targetState } : i
    )
    useAppStore.setState((s) => ({
      linearBoardCache: { ...s.linearBoardCache, [workspaceId]: { ...data, issues: updatedIssues } }
    }))
    if (selectedIssue?.id === issue.id) {
      setSelectedIssue({ ...issue, state: targetState })
    }

    try {
      await updateIssueState(decryptedKey, issue.id, targetState.id)
    } catch (err: any) {
      useAppStore.setState((s) => ({
        linearBoardCache: { ...s.linearBoardCache, [workspaceId]: previousData }
      }))
      if (selectedIssue?.id === issue.id) setSelectedIssue(issue)
      if (err?.message === 'LINEAR_FORBIDDEN' || err?.message === 'LINEAR_UNAUTHORIZED') {
        showToast('No permission to update issues')
      } else {
        showToast('Failed to update status')
      }
    } finally {
      setMutationInflight(workspaceId, false)
    }
  }, [data, workspaceId, decryptedKey, selectedIssue, showToast, setMutationInflight])

  const handleStatusChange = useCallback(async (issueId: string, stateId: string) => {
    if (!data || !decryptedKey) return
    const targetState = data.columns.find((c) => c.id === stateId)
    const issue = data.issues.find((i) => i.id === issueId)
    if (!targetState || !issue) return

    setMutationInflight(workspaceId, true)
    const previousData = data
    const updatedIssues = data.issues.map((i) =>
      i.id === issueId ? { ...i, state: targetState } : i
    )
    useAppStore.setState((s) => ({
      linearBoardCache: { ...s.linearBoardCache, [workspaceId]: { ...data, issues: updatedIssues } }
    }))
    if (selectedIssue?.id === issueId) {
      setSelectedIssue({ ...issue, state: targetState })
    }

    try {
      await updateIssueState(decryptedKey, issueId, stateId)
    } catch (err: any) {
      useAppStore.setState((s) => ({
        linearBoardCache: { ...s.linearBoardCache, [workspaceId]: previousData }
      }))
      if (selectedIssue?.id === issueId) setSelectedIssue(issue)
      if (err?.message === 'LINEAR_FORBIDDEN' || err?.message === 'LINEAR_UNAUTHORIZED') {
        showToast('No permission to update issues')
      } else {
        showToast('Failed to update status')
      }
    } finally {
      setMutationInflight(workspaceId, false)
    }
  }, [data, workspaceId, decryptedKey, selectedIssue, showToast, setMutationInflight])

  const handleNavigate = useCallback((direction: 'up' | 'down') => {
    if (!selectedIssue || !data) return
    const columnIssues = data.issues.filter((i) => i.state.id === selectedIssue.state.id)
    const idx = columnIssues.findIndex((i) => i.id === selectedIssue.id)
    if (idx < 0) return
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx >= 0 && nextIdx < columnIssues.length) {
      setSelectedIssue(columnIssues[nextIdx])
    }
  }, [selectedIssue, data])

  const formatLastRefreshed = () => {
    if (!lastRefreshed) return ''
    const ago = Math.round((Date.now() - lastRefreshed) / 1000)
    if (ago < 5) return 'just now'
    if (ago < 60) return `${ago}s ago`
    return `${Math.round(ago / 60)}m ago`
  }

  // Empty state — no Linear config
  if (!linearConfig) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: txtColor }}>
        <span className="text-sm opacity-70">Connect Linear to see your team's board</span>
        <button
          onClick={onOpenSettings}
          className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
          style={{ backgroundColor: `${txtColor}15` }}
        >
          Open Settings
        </button>
      </div>
    )
  }

  // Loading state
  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: txtColor }}>
        <span className="text-sm opacity-50">Loading board...</span>
      </div>
    )
  }

  // Error state with no cached data
  if (error && !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: txtColor }}>
        <span className="text-sm opacity-70">{error}</span>
        <div className="flex gap-2">
          {(errorType === 'auth' || errorType === 'team') && (
            <button
              onClick={onOpenSettings}
              className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
              style={{ backgroundColor: `${txtColor}15` }}
            >
              Open Settings
            </button>
          )}
          <button
            onClick={refresh}
            className="text-xs px-3 py-1.5 rounded-md transition-opacity hover:opacity-80"
            style={{ backgroundColor: `${txtColor}15` }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b" style={{ borderColor: `${txtColor}10` }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: txtColor }}>{data.teamName}</span>
          <span className="text-xs opacity-40" style={{ color: txtColor }}>{data.issues.length} issues</span>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-[10px] opacity-50" style={{ color: '#f76a6a' }}>{error}</span>
          )}
          {lastRefreshed && (
            <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
              Updated {formatLastRefreshed()}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-xs opacity-40 hover:opacity-100 transition-opacity"
            style={{ color: txtColor }}
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v4h4" />
              <path d="M15 12V8h-4" />
              <path d="M2.5 10.5A6 6 0 0 0 14 8" />
              <path d="M13.5 5.5A6 6 0 0 0 2 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
        {data.columns
          .filter((col) => col.type !== 'cancelled')
          .map((column) => {
            const columnIssues = data.issues.filter((i) => i.state.id === column.id)
            const isDragOver = dragOverColumn === column.id

            return (
              <div
                key={column.id}
                className="flex flex-col min-w-[260px] max-w-[320px] flex-1 border-r last:border-r-0"
                style={{ borderColor: `${txtColor}08` }}
                onDragOver={(e) => handleDragOver(e, column.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, column)}
              >
                <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: column.color }}
                  />
                  <span className="text-xs font-medium truncate" style={{ color: txtColor }}>
                    {column.name}
                  </span>
                  <span className="text-[10px] opacity-30" style={{ color: txtColor }}>
                    {columnIssues.length}
                  </span>
                </div>

                <div
                  className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 transition-colors"
                  style={{
                    backgroundColor: isDragOver
                      ? (isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)')
                      : 'transparent',
                  }}
                >
                  {columnIssues.map((issue) => (
                    <div key={issue.id} onDragEnd={handleDragEnd}>
                      <LinearTicketCard
                        issue={issue}
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

        {selectedIssue && (
          <LinearDetailPanel
            issue={selectedIssue}
            columns={data.columns}
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
