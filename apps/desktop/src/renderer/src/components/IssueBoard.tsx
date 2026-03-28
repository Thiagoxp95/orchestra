import { useState, useCallback, useRef, useEffect } from 'react'
import { useQuery, useMutation, useConvex } from 'convex/react'
import { api } from '../../../../../backend/convex/_generated/api'
import { IssueCard } from './IssueCard'
import { StatusIcon } from './StatusIcon'
import { IssueDetailPanel } from './IssueDetailPanel'
import { IssueCreateForm } from './IssueCreateForm'
import { importFromLinear } from '../utils/linear-importer'
import { fetchTeamMembers, fetchTeamLabels, fetchBoardData } from '../utils/linear-client'
import { isLightColor, textColor } from '../utils/color'
import type { Doc, Id } from '../../../../../backend/convex/_generated/dataModel'

type IssueStatus = 'shaping' | 'todo' | 'in_progress' | 'in_review' | 'done'

const COLUMNS: { status: IssueStatus; label: string; color: string }[] = [
  { status: 'shaping', label: 'Shaping', color: '#a855f7' },
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
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [filterMembers, setFilterMembers] = useState<{ id: string; displayName: string }[]>([])
  const [filterLabelsOptions, setFilterLabelsOptions] = useState<{ id: string; name: string; color: string }[]>([])
  const [filterStates, setFilterStates] = useState<{ id: string; name: string }[]>([])
  const [filtersLoading, setFiltersLoading] = useState(false)
  const [filterAssigneeIds, setFilterAssigneeIds] = useState<string[]>(linearConfig?.filters?.assigneeIds ?? [])
  const [filterLabelIds, setFilterLabelIds] = useState<string[]>(linearConfig?.filters?.labelIds ?? [])
  const [filterStateIds, setFilterStateIds] = useState<string[]>(linearConfig?.filters?.stateIds ?? [])
  const [showMappingPanel, setShowMappingPanel] = useState(false)
  const [statusMapping, setStatusMapping] = useState<Record<string, string>>(linearConfig?.statusMapping ?? {})
  const [mappingStates, setMappingStates] = useState<{ id: string; name: string; type: string }[]>([])
  const [mappingLoading, setMappingLoading] = useState(false)
  const dragIssueRef = useRef<Doc<'issues'> | null>(null)
  const filterPanelRef = useRef<HTMLDivElement>(null)
  const mappingPanelRef = useRef<HTMLDivElement>(null)
  // Refs for values used in callbacks to avoid stale closures
  const statusMappingRef = useRef(statusMapping)
  statusMappingRef.current = statusMapping
  const filterAssigneeIdsRef = useRef(filterAssigneeIds)
  filterAssigneeIdsRef.current = filterAssigneeIds
  const filterLabelIdsRef = useRef(filterLabelIds)
  filterLabelIdsRef.current = filterLabelIds
  const filterStateIdsRef = useRef(filterStateIds)
  filterStateIdsRef.current = filterStateIds

  const activeFilterCount = (filterAssigneeIds.length > 0 ? 1 : 0) + (filterLabelIds.length > 0 ? 1 : 0) + (filterStateIds.length > 0 ? 1 : 0)
  const hasMappingConfig = Object.keys(statusMapping).length > 0

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
  const handleCreateIssue = useCallback(async (data: import('./IssueCreateForm').CreateIssueData) => {
    const columnIssues = (issues ?? []).filter((i) => i.status === data.status)
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0)

    try {
      await createIssue({
        workspaceId,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        labelIds: data.labelIds,
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
      const activeFilters = {
        assigneeIds: filterAssigneeIdsRef.current.length ? filterAssigneeIdsRef.current : undefined,
        labelIds: filterLabelIdsRef.current.length ? filterLabelIdsRef.current : undefined,
        stateIds: filterStateIdsRef.current.length ? filterStateIdsRef.current : undefined,
      }
      const mapping = Object.keys(statusMappingRef.current).length ? statusMappingRef.current : undefined
      const result = await importFromLinear(
        convex,
        workspaceId,
        decryptedKey,
        linearConfig.teamId,
        activeFilters,
        mapping as any,
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

  // ── Filter panel ───────────────────────────────────────────────────
  const loadFilterOptions = useCallback(async () => {
    if (!linearConfig || filtersLoading) return
    setFiltersLoading(true)
    try {
      const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
      const [members, labelsResult, boardData] = await Promise.all([
        fetchTeamMembers(decryptedKey, linearConfig.teamId),
        fetchTeamLabels(decryptedKey, linearConfig.teamId),
        fetchBoardData(decryptedKey, linearConfig.teamId),
      ])
      setFilterMembers(members.map((m) => ({ id: m.id, displayName: m.displayName })))
      setFilterLabelsOptions(labelsResult)
      setFilterStates(boardData.columns.filter((c) => c.type !== 'cancelled').map((c) => ({ id: c.id, name: c.name })))
    } catch {
      showToast('Failed to load filter options')
    } finally {
      setFiltersLoading(false)
    }
  }, [linearConfig, filtersLoading, showToast])

  const handleOpenFilterPanel = useCallback(() => {
    setShowFilterPanel((prev) => {
      if (!prev && filterMembers.length === 0) loadFilterOptions()
      return !prev
    })
  }, [filterMembers.length, loadFilterOptions])

  const toggleFilter = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) => {
    setter((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }, [])

  // Close filter panel on click outside
  useEffect(() => {
    if (!showFilterPanel) return
    const handler = (e: MouseEvent) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        setShowFilterPanel(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFilterPanel])

  // ── Status mapping panel ───────────────────────────────────────────
  const handleOpenMappingPanel = useCallback(async () => {
    const willOpen = !showMappingPanel
    setShowMappingPanel(willOpen)
    if (willOpen && mappingStates.length === 0 && linearConfig) {
      setMappingLoading(true)
      try {
        const decryptedKey = await window.electronAPI.linearDecryptKey(linearConfig.apiKey)
        const boardData = await fetchBoardData(decryptedKey, linearConfig.teamId)
        setMappingStates(boardData.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })))
      } catch {
        showToast('Failed to load Linear statuses')
      } finally {
        setMappingLoading(false)
      }
    }
  }, [showMappingPanel, mappingStates.length, linearConfig, showToast])

  const handleMappingChange = useCallback((linearStateName: string, orchestraStatus: string) => {
    setStatusMapping((prev) => ({ ...prev, [linearStateName]: orchestraStatus }))
  }, [])

  // Close mapping panel on click outside
  useEffect(() => {
    if (!showMappingPanel) return
    const handler = (e: MouseEvent) => {
      if (mappingPanelRef.current && !mappingPanelRef.current.contains(e.target as Node)) {
        setShowMappingPanel(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMappingPanel])

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
        const bgFilters = {
          assigneeIds: filterAssigneeIdsRef.current.length ? filterAssigneeIdsRef.current : undefined,
          labelIds: filterLabelIdsRef.current.length ? filterLabelIdsRef.current : undefined,
          stateIds: filterStateIdsRef.current.length ? filterStateIdsRef.current : undefined,
        }
        const bgMapping = Object.keys(statusMappingRef.current).length ? statusMappingRef.current : undefined
        await importFromLinear(convex, workspaceId, decryptedKey, linearConfig.teamId, bgFilters, bgMapping as any)
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

  // ── Full-page issue detail view ────────────────────────────────────
  if (currentSelected) {
    return (
      <IssueDetailPanel
        issue={currentSelected}
        labels={labels}
        wsColor={wsColor}
        txtColor={txtColor}
        onClose={() => setSelectedIssue(null)}
        onStatusChange={handleStatusChange}
        onNavigate={handleNavigate}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Board header */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b relative" style={{ borderColor: `${txtColor}10` }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: txtColor }}>Issues</span>
          <span className="text-xs opacity-40" style={{ color: txtColor }}>{issues.length}</span>
        </div>
        <div className="flex items-center gap-3">
          {linearConfig && (
            <>
              <button
                onClick={handleOpenFilterPanel}
                className="text-xs transition-opacity flex items-center gap-1"
                style={{ color: txtColor, opacity: showFilterPanel || activeFilterCount > 0 ? 1 : 0.5 }}
                title="Configure import filters"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="1,2 15,2 9,9 9,14 7,15 7,9" />
                </svg>
                {activeFilterCount > 0 && (
                  <span className="text-[10px] px-1 rounded-full" style={{ backgroundColor: `${txtColor}20` }}>
                    {activeFilterCount}
                  </span>
                )}
              </button>
              <button
                onClick={handleOpenMappingPanel}
                className="text-xs transition-opacity flex items-center gap-1"
                style={{ color: txtColor, opacity: showMappingPanel || hasMappingConfig ? 1 : 0.5 }}
                title="Configure status mapping"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 4h14" /><path d="M1 8h14" /><path d="M1 12h14" />
                  <circle cx="4" cy="4" r="1.5" fill="currentColor" /><circle cx="10" cy="8" r="1.5" fill="currentColor" /><circle cx="6" cy="12" r="1.5" fill="currentColor" />
                </svg>
              </button>
              <button
                onClick={handleImport}
                disabled={importing}
                className="text-xs opacity-50 hover:opacity-100 transition-opacity disabled:opacity-30"
                style={{ color: txtColor }}
                title="Import from Linear"
              >
                {importing ? 'Importing...' : 'Import from Linear'}
              </button>
            </>
          )}
        </div>

        {/* Filter dropdown panel */}
        {showFilterPanel && linearConfig && (
          <div
            ref={filterPanelRef}
            className="absolute right-4 top-full mt-1 w-72 rounded-lg shadow-xl border z-50 p-3 space-y-3"
            style={{
              backgroundColor: wsColor,
              borderColor: `${txtColor}20`,
              color: txtColor,
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Import Filters</span>
              {filtersLoading && <span className="text-[10px] opacity-40">Loading...</span>}
            </div>

            {filterMembers.length > 0 ? (
              <>
                <div>
                  <label className="text-[10px] block mb-1 opacity-50">Assignees</label>
                  <div className="flex flex-wrap gap-1">
                    {filterMembers.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => toggleFilter(setFilterAssigneeIds, m.id)}
                        className="text-[11px] px-2 py-0.5 rounded-md border transition-colors"
                        style={{
                          borderColor: filterAssigneeIds.includes(m.id) ? `${txtColor}60` : `${txtColor}15`,
                          backgroundColor: filterAssigneeIds.includes(m.id) ? `${txtColor}15` : 'transparent',
                        }}
                      >
                        {m.displayName}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] block mb-1 opacity-50">Labels</label>
                  <div className="flex flex-wrap gap-1">
                    {filterLabelsOptions.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => toggleFilter(setFilterLabelIds, l.id)}
                        className="text-[11px] px-2 py-0.5 rounded-full border transition-colors"
                        style={{
                          borderColor: filterLabelIds.includes(l.id) ? `${l.color}88` : `${l.color}44`,
                          backgroundColor: filterLabelIds.includes(l.id) ? `${l.color}22` : 'transparent',
                          color: l.color,
                        }}
                      >
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] block mb-1 opacity-50">Statuses</label>
                  <div className="flex flex-wrap gap-1">
                    {filterStates.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => toggleFilter(setFilterStateIds, s.id)}
                        className="text-[11px] px-2 py-0.5 rounded-md border transition-colors"
                        style={{
                          borderColor: filterStateIds.includes(s.id) ? `${txtColor}60` : `${txtColor}15`,
                          backgroundColor: filterStateIds.includes(s.id) ? `${txtColor}15` : 'transparent',
                        }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : !filtersLoading ? (
              <p className="text-[11px] opacity-40">Loading filter options...</p>
            ) : null}
          </div>
        )}

        {/* Status mapping panel */}
        {showMappingPanel && linearConfig && (
          <div
            ref={mappingPanelRef}
            className="absolute right-4 top-full mt-1 w-80 rounded-lg shadow-xl border z-50 p-3 space-y-3"
            style={{
              backgroundColor: wsColor,
              borderColor: `${txtColor}20`,
              color: txtColor,
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Status Mapping</span>
              {mappingLoading && <span className="text-[10px] opacity-40">Loading...</span>}
            </div>

            {mappingStates.length > 0 ? (
              <div className="space-y-2">
                {mappingStates.map((ls) => (
                  <div key={ls.id} className="flex items-center gap-2">
                    <span className="text-[11px] w-24 truncate opacity-70" title={ls.name}>{ls.name}</span>
                    <span className="text-[10px] opacity-30">→</span>
                    <select
                      value={statusMapping[ls.name] ?? ''}
                      onChange={(e) => handleMappingChange(ls.name, e.target.value)}
                      className="flex-1 text-[11px] px-2 py-1 rounded-md border appearance-none"
                      style={{
                        backgroundColor: `${txtColor}08`,
                        borderColor: `${txtColor}15`,
                        color: txtColor,
                      }}
                    >
                      <option value="" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>Default</option>
                      {COLUMNS.map((c) => (
                        <option key={c.status} value={c.status} style={{ backgroundColor: isLight ? '#fff' : '#111' }}>
                          {c.label}
                        </option>
                      ))}
                      <option value="skip" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>Skip (don't import)</option>
                    </select>
                  </div>
                ))}
              </div>
            ) : !mappingLoading ? (
              <p className="text-[11px] opacity-40">Loading Linear statuses...</p>
            ) : null}
          </div>
        )}
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
                <StatusIcon status={column.status} size={14} />
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

      {creatingInColumn && (
        <IssueCreateForm
          defaultStatus={creatingInColumn}
          labels={labels}
          wsColor={wsColor}
          txtColor={txtColor}
          isLight={isLight}
          onSubmit={handleCreateIssue}
          onCancel={() => setCreatingInColumn(null)}
        />
      )}
    </div>
  )
}
