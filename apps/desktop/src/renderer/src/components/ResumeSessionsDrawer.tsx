import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecentAgentSession } from '../../../shared/types'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import { findTreeForCwd, planResume } from '../utils/resume-agent-session'
import { DynamicIcon } from './DynamicIcon'

const AGENT_COLORS: Record<RecentAgentSession['agent'], string> = {
  claude: '#d4a574',
  codex: '#10a37f',
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

function AgentBadge({ agent }: { agent: RecentAgentSession['agent'] }) {
  const color = AGENT_COLORS[agent]
  return (
    <span
      className="flex items-center justify-center p-0.5 rounded shrink-0"
      style={{ backgroundColor: `${color}18`, border: `1px solid ${color}30` }}
    >
      <DynamicIcon name={agent === 'codex' ? '__openai__' : '__claude__'} size={12} color={color} />
    </span>
  )
}

export function ResumeSessionsDrawer({ wsColor, onClose }: { wsColor: string; onClose: () => void }) {
  const [sessions, setSessions] = useState<RecentAgentSession[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'claude' | 'codex'>('all')

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const txtColor = textColor(wsColor)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSessions(await window.electronAPI.listRecentAgentSessions())
    } catch {
      setSessions([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = useMemo(
    () => (filter === 'all' ? sessions : sessions.filter((s) => s.agent === filter)),
    [sessions, filter],
  )

  /** Where the session lived: the worktree name when we know it, else the path. */
  const describeLocation = (session: RecentAgentSession): string => {
    const match = findTreeForCwd(workspaces, session.cwd, activeWorkspaceId)
    if (match) {
      const workspace = workspaces[match.workspaceId]
      const tree = workspace?.trees[match.treeIndex]
      const treeName = match.treeIndex === 0
        ? 'base'
        : tree?.displayName ?? tree?.rootDir.split('/').pop() ?? 'worktree'
      return `${workspace?.name ?? '?'} · ${treeName}`
    }
    return session.cwd.replace(/^\/Users\/[^/]+/, '~')
  }

  const handleResume = (session: RecentAgentSession) => {
    if (!session.cwdExists) return
    const state = useAppStore.getState()
    const plan = planResume(session, state.workspaces, state.activeWorkspaceId)
    if (!plan) return
    state.setActiveWorkspace(plan.workspaceId)
    state.setActiveTree(plan.workspaceId, plan.treeIndex)
    window.electronAPI.prewarmTerminal({ cwd: plan.cwdOverride ?? session.cwd })
    state.createSession(
      plan.workspaceId,
      plan.command,
      undefined,
      undefined,
      undefined,
      session.agent,
      undefined,
      plan.treeIndex,
      plan.cwdOverride,
    )
    onClose()
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 w-[420px] flex flex-col shadow-2xl"
        style={{ backgroundColor: wsColor, borderLeft: `1px solid ${txtColor}15`, color: txtColor }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b shrink-0"
          style={{ borderColor: `${txtColor}15` }}
        >
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={txtColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
              <polyline points="2 2 2 5 5 5" />
            </svg>
            <span className="text-sm font-medium">Resume a session</span>
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded-md"
              style={{ backgroundColor: `${txtColor}10`, border: `1px solid ${txtColor}18` }}
            >
              {filtered.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              className="p-1.5 rounded transition-colors"
              style={{ color: txtColor }}
              title="Refresh"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8a6 6 0 0 1 10.3-4.1L14 2v4h-4l1.7-1.7A4 4 0 0 0 4 8" />
                <path d="M14 8a6 6 0 0 1-10.3 4.1L2 14v-4h4l-1.7 1.7A4 4 0 0 0 12 8" />
              </svg>
            </button>
            <button onClick={onClose} className="p-1.5 rounded transition-colors" style={{ color: txtColor }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Agent filter */}
        <div className="flex gap-1 px-4 py-2 shrink-0">
          {(['all', 'claude', 'codex'] as const).map((f) => (
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

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10">
              <span className="text-xs" style={{ opacity: 0.5 }}>Reading recent sessions…</span>
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="px-6 py-10 text-center">
              <p className="text-xs" style={{ opacity: 0.5 }}>
                No recent {filter === 'all' ? 'Claude or Codex' : filter} sessions found.
              </p>
            </div>
          )}

          {!loading && filtered.map((session) => {
            const summary = session.lastAssistantMessage ?? session.lastUserMessage
            // Some sessions have no prompt to title them (codex attachment-only
            // turns) — promote the summary rather than showing it twice.
            const headline = session.title ?? summary ?? 'Untitled session'
            const missing = !session.cwdExists
            return (
              <button
                key={`${session.agent}:${session.sessionId}`}
                onClick={() => handleResume(session)}
                disabled={missing}
                title={missing ? `${session.cwd} no longer exists` : `Resume in ${session.cwd}`}
                className="w-full text-left px-4 py-3 border-b transition-colors hover:brightness-110 disabled:cursor-not-allowed"
                style={{ borderColor: `${txtColor}08`, opacity: missing ? 0.4 : 1 }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <AgentBadge agent={session.agent} />
                  <span className="text-xs font-medium truncate flex-1">{headline}</span>
                  <span className="text-[10px] shrink-0 font-mono" style={{ opacity: 0.5 }}>
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                </div>

                {session.title && summary && (
                  <p className="text-[11px] leading-snug line-clamp-2 mb-1.5" style={{ opacity: 0.65 }}>
                    {session.lastAssistantMessage ? '' : 'You: '}{summary}
                  </p>
                )}

                <div className="flex items-center gap-1.5 text-[10px]" style={{ opacity: 0.45 }}>
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" />
                  </svg>
                  <span className="truncate font-mono">{describeLocation(session)}</span>
                  {session.gitBranch && (
                    <>
                      <span>·</span>
                      <span className="truncate font-mono">{session.gitBranch}</span>
                    </>
                  )}
                  {missing && (
                    <>
                      <span>·</span>
                      <span className="shrink-0">folder missing</span>
                    </>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
