import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import type { AutomationRun } from '../../../shared/types'

function StatusBadge({ status }: { status: AutomationRun['status'] }) {
  const colors = {
    running: '#3b82f6',
    success: '#3fb950',
    error: '#f85149',
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{ backgroundColor: `${colors[status]}20`, color: colors[status] }}
    >
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: colors[status] }} />
      )}
      {status}
    </span>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(start: number, end?: number): string {
  const duration = (end ?? Date.now()) - start
  const secs = Math.floor(duration / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  if (mins < 60) return `${mins}m ${remainSecs}s`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}

export function AutomationRunsPanel({ onClose }: { onClose: () => void }) {
  const actionId = useAppStore((s) => s.automationRunsPanelActionId)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  const action = activeWorkspace?.customActions.find((a) => a.id === actionId)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [filter, setFilter] = useState<'all' | 'success' | 'error'>('all')
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({})
  const liveOutputRef = useRef(liveOutput)
  liveOutputRef.current = liveOutput

  // Load runs
  useEffect(() => {
    if (!actionId) return
    window.electronAPI.getAutomationRuns(actionId).then(setRuns)
  }, [actionId])

  // Listen for new run results
  useEffect(() => {
    const unsubResult = window.electronAPI.onAutomationRunResult((run) => {
      if (run.actionId !== actionId) return
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = run
          return next
        }
        return [run, ...prev].slice(0, 100)
      })
    })

    const unsubOutput = window.electronAPI.onAutomationRunOutput(({ actionId: aid, chunk }) => {
      if (aid !== actionId) return
      setLiveOutput((prev) => ({ ...prev, [aid]: (prev[aid] ?? '') + chunk }))
    })

    return () => {
      unsubResult()
      unsubOutput()
    }
  }, [actionId])

  const filteredRuns = filter === 'all' ? runs : runs.filter((r) => r.status === filter)
  const sortedRuns = [...filteredRuns].sort((a, b) => b.startedAt - a.startedAt)
  const isRunning = runs.some((r) => r.status === 'running')

  if (!action || !actionId) return null

  return (
    <div
      className="w-80 shrink-0 flex flex-col rounded-xl overflow-hidden ml-2"
      style={{ backgroundColor: panelBg }}
    >
      {/* Header */}
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold truncate" style={{ color: txtColor }}>
            {action.name}
          </span>
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <button
                onClick={() => window.electronAPI.cancelAutomation(actionId)}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ backgroundColor: '#f8514920', color: '#f85149' }}
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => {
                  if (activeWorkspaceId) {
                    window.electronAPI.runAutomationNow(activeWorkspaceId, actionId)
                  }
                }}
                className="px-2 py-0.5 rounded text-[10px] transition-colors"
                style={{ backgroundColor: `${txtColor}15`, color: txtColor }}
              >
                Run Now
              </button>
            )}
            <button
              onClick={onClose}
              className="p-0.5 rounded hover:opacity-80 transition-opacity"
              style={{ color: txtColor, opacity: 0.5 }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Filter */}
        <div className="flex gap-1">
          {(['all', 'success', 'error'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-0.5 rounded text-[10px] capitalize transition-colors"
              style={{
                backgroundColor: filter === f ? `${txtColor}20` : 'transparent',
                color: txtColor,
                opacity: filter === f ? 1 : 0.5,
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto py-1">
        {sortedRuns.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>No runs yet</span>
          </div>
        )}
        {sortedRuns.map((run) => {
          const isExpanded = expandedRun === run.id
          const output = run.status === 'running'
            ? (liveOutput[run.actionId] ?? run.output)
            : run.output
          const preview = output ? output.split('\n').slice(0, 3).join('\n') : ''

          return (
            <div
              key={run.id}
              className="px-3 py-2 cursor-pointer transition-colors"
              style={{ borderBottom: `1px solid ${borderColor}` }}
              onClick={() => setExpandedRun(isExpanded ? null : run.id)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px]" style={{ color: txtColor, opacity: 0.5 }}>
                  {formatRelativeTime(run.startedAt)}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono" style={{ color: txtColor, opacity: 0.4 }}>
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </span>
                  <StatusBadge status={run.status} />
                </div>
              </div>
              {run.errorMessage && (
                <p className="text-[10px] mb-1" style={{ color: '#f85149' }}>
                  {run.errorMessage}
                </p>
              )}
              {(output || preview) && (
                <pre
                  className="text-[10px] font-mono whitespace-pre-wrap break-all overflow-hidden"
                  style={{
                    color: txtColor,
                    opacity: 0.6,
                    maxHeight: isExpanded ? 'none' : '3.6em',
                  }}
                >
                  {isExpanded ? output : preview}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
