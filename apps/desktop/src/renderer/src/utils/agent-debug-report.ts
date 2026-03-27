import type {
  ClaudeWatcherDebugState,
  ClaudeWorkState,
  CodexWatcherDebugState,
  CodexWorkState,
  LiveTerminalSessionStatusInfo,
  TerminalSession,
  WorkStateDebugSnapshot,
  Workspace,
} from '../../../shared/types'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

interface AgentLaunchSnapshot {
  agent: 'claude' | 'codex'
  startedAt: number
  confirmed: boolean
}

export interface AgentDebugReportData {
  generatedAt?: number
  activeWorkspaceId: string | null
  activeSessionId: string | null
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession>
  claudeWorkState: Record<string, ClaudeWorkState>
  codexWorkState: Record<string, CodexWorkState>
  claudeLastResponse: Record<string, string>
  codexLastResponse: Record<string, string>
  terminalLastOutput: Record<string, string>
  sessionNeedsUserInput: Record<string, boolean>
  agentLaunches: Record<string, AgentLaunchSnapshot>
  liveSessions: LiveTerminalSessionStatusInfo[]
  claudeDebug: ClaudeWatcherDebugState[]
  codexDebug: CodexWatcherDebugState[]
  normalizedAgentState: Record<string, NormalizedAgentSessionStatus>
  workStateDebug: WorkStateDebugSnapshot
  isDev?: boolean
}

interface SessionLocation {
  workspaceName: string
  treeIndex: number
}

function describeAge(timestamp: number | null | undefined, now: number): string {
  if (!timestamp) return '-'

  const deltaSeconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (deltaSeconds < 1) return 'now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`

  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`

  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`

  const deltaDays = Math.round(deltaHours / 24)
  return `${deltaDays}d ago`
}

function formatTimestamp(timestamp: number | null | undefined, now: number): string {
  if (!timestamp) return '-'
  return `${new Date(timestamp).toISOString()} (${describeAge(timestamp, now)})`
}

function previewText(text: string | null | undefined, maxLength = 160): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function quote(text: string): string {
  return JSON.stringify(text)
}

function getOrderedSessionIds(
  workspaces: Record<string, Workspace>,
  sessions: Record<string, TerminalSession>,
): { orderedIds: string[]; locations: Map<string, SessionLocation> } {
  const orderedIds: string[] = []
  const seen = new Set<string>()
  const locations = new Map<string, SessionLocation>()

  const orderedWorkspaces = Object.values(workspaces).sort((a, b) => a.createdAt - b.createdAt)
  for (const workspace of orderedWorkspaces) {
    workspace.trees.forEach((tree, treeIndex) => {
      tree.sessionIds.forEach((sessionId) => {
        if (seen.has(sessionId) || !sessions[sessionId]) return
        seen.add(sessionId)
        orderedIds.push(sessionId)
        locations.set(sessionId, { workspaceName: workspace.name, treeIndex })
      })
    })
  }

  const extraIds = Object.keys(sessions)
    .filter((sessionId) => !seen.has(sessionId))
    .sort((left, right) => left.localeCompare(right))
  for (const sessionId of extraIds) {
    orderedIds.push(sessionId)
  }

  return { orderedIds, locations }
}

function buildClaudeWatcherLine(entry: ClaudeWatcherDebugState | undefined, now: number): string {
  if (!entry) return 'claudeWatcher missing'

  return [
    'claudeWatcher',
    `state=${entry.lastWorkState}`,
    `hook=${entry.lastHookEvent ?? '-'} @ ${describeAge(entry.lastHookEventAt, now)}`,
  ].join(' ')
}

function buildCodexWatcherLine(entry: CodexWatcherDebugState | undefined, now: number): string {
  if (!entry) return 'codexWatcher missing'

  return [
    'codexWatcher',
    `state=${entry.lastWorkState}`,
    `hook=${entry.lastHookEvent ?? '-'} @ ${describeAge(entry.lastHookEventAt, now)}`,
  ].join(' ')
}

export function buildAgentDebugReport(data: AgentDebugReportData): string {
  const now = data.generatedAt ?? Date.now()
  const { orderedIds, locations } = getOrderedSessionIds(data.workspaces, data.sessions)
  const liveById = new Map(data.liveSessions.map((entry) => [entry.sessionId, entry]))
  const claudeById = new Map(data.claudeDebug.map((entry) => [entry.sessionId, entry]))
  const codexById = new Map(data.codexDebug.map((entry) => [entry.sessionId, entry]))

  const lines: string[] = [
    'Orchestra agent debug report',
    `generatedAt: ${new Date(now).toISOString()}`,
    `isDev: ${data.isDev ? 'yes' : 'no'}`,
    `activeWorkspaceId: ${data.activeWorkspaceId ?? '-'}`,
    `activeSessionId: ${data.activeSessionId ?? '-'}`,
    `workspaceCount: ${Object.keys(data.workspaces).length}`,
    `sessionCount: ${Object.keys(data.sessions).length}`,
    '',
    'Sessions',
  ]

  if (orderedIds.length === 0) {
    lines.push('- none')
  }

  for (const sessionId of orderedIds) {
    const session = data.sessions[sessionId]
    if (!session) continue

    const location = locations.get(sessionId)
    const live = liveById.get(sessionId)
    const claude = claudeById.get(sessionId)
    const codex = codexById.get(sessionId)
    const launch = data.agentLaunches[sessionId]
    const rendererClaude = data.claudeWorkState[sessionId] ?? 'idle'
    const rendererCodex = data.codexWorkState[sessionId] ?? 'idle'
    const flags: string[] = []
    if (sessionId === data.activeSessionId) flags.push('active-session')
    if (session.workspaceId === data.activeWorkspaceId) flags.push('active-workspace')

    lines.push(
      `- ${sessionId}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''} label=${quote(session.label)} workspace=${quote(location?.workspaceName ?? session.workspaceId)} tree=${location?.treeIndex ?? '-'} cwd=${quote(session.cwd)}`,
    )
    lines.push(
      `  renderer process=${session.processStatus} claude=${rendererClaude} codex=${rendererCodex} needsInput=${data.sessionNeedsUserInput[sessionId] ? 'yes' : 'no'} actionIcon=${session.actionIcon ?? '-'} launch=${launch?.agent ?? '-'} confirmed=${launch ? (launch.confirmed ? 'yes' : 'no') : '-'} launchStarted=${formatTimestamp(launch?.startedAt, now)}`,
    )

    if (live) {
      lines.push(
        `  live alive=${live.isAlive ? 'yes' : 'no'} pid=${live.pid ?? '-'} processSessionId=${live.processSessionId ?? '-'} detected=${live.status} aiPid=${live.aiPid ?? '-'}`,
      )
    } else {
      lines.push('  live missing')
    }

    if (session.processStatus === 'claude' || claude) {
      lines.push(`  ${buildClaudeWatcherLine(claude, now)}`)
    }
    if (session.processStatus === 'codex' || codex) {
      lines.push(`  ${buildCodexWatcherLine(codex, now)}`)
    }

    const normalized = data.normalizedAgentState[sessionId]
    if (normalized) {
      lines.push(`  normalized state=${normalized.state} auth=${normalized.authority} connected=${normalized.connected ? 'yes' : 'no'}${normalized.degradedReason ? ` degraded=${normalized.degradedReason}` : ''}`)
    }

    const claudePreview = previewText(data.claudeLastResponse[sessionId])
    const codexPreview = previewText(data.codexLastResponse[sessionId])
    const terminalPreview = previewText(data.terminalLastOutput[sessionId])
    const previews = [
      claudePreview ? `claude=${quote(claudePreview)}` : '',
      codexPreview ? `codex=${quote(codexPreview)}` : '',
      terminalPreview ? `terminal=${quote(terminalPreview)}` : '',
    ].filter(Boolean)
    if (previews.length > 0) {
      lines.push(`  preview ${previews.join(' ')}`)
    }

    const mismatches: string[] = []
    if (live && live.status !== session.processStatus) {
      mismatches.push(`process renderer=${session.processStatus} live=${live.status}`)
    }
    if (session.processStatus === 'claude') {
      if (!claude && live?.status === 'claude') {
        mismatches.push('claude watcher missing while live status is claude')
      }
      if (claude && claude.lastWorkState !== rendererClaude) {
        mismatches.push(`claude state renderer=${rendererClaude} watcher=${claude.lastWorkState}`)
      }
      if (claude?.lastHookEvent === 'Start' && rendererClaude !== 'working') {
        mismatches.push(`claude hook=Start renderer=${rendererClaude}`)
      }
    }
    if (session.processStatus === 'codex') {
      if (!codex && live?.status === 'codex') {
        mismatches.push('codex watcher missing while live status is codex')
      }
      if (codex && codex.lastWorkState !== rendererCodex) {
        mismatches.push(`codex state renderer=${rendererCodex} watcher=${codex.lastWorkState}`)
      }
    }
    if (data.sessionNeedsUserInput[sessionId] && rendererCodex !== 'waitingUserInput') {
      mismatches.push(`needsInput=yes rendererCodex=${rendererCodex}`)
    }

    if (mismatches.length > 0) {
      lines.push(`  mismatch ${mismatches.join(' | ')}`)
    }
  }

  const orphanLiveSessions = data.liveSessions
    .filter((entry) => !data.sessions[entry.sessionId])
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  lines.push('', 'Orphan live sessions')
  if (orphanLiveSessions.length === 0) {
    lines.push('- none')
  } else {
    orphanLiveSessions.forEach((entry) => {
      lines.push(
        `- ${entry.sessionId} alive=${entry.isAlive ? 'yes' : 'no'} pid=${entry.pid ?? '-'} processSessionId=${entry.processSessionId ?? '-'} detected=${entry.status} aiPid=${entry.aiPid ?? '-'}`,
      )
    })
  }

  const orphanClaudeWatchers = data.claudeDebug
    .filter((entry) => !data.sessions[entry.sessionId])
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  lines.push('', 'Orphan Claude watchers')
  if (orphanClaudeWatchers.length === 0) {
    lines.push('- none')
  } else {
    orphanClaudeWatchers.forEach((entry) => {
      lines.push(`- ${entry.sessionId} ${buildClaudeWatcherLine(entry, now)}`)
    })
  }

  const orphanCodexWatchers = data.codexDebug
    .filter((entry) => !data.sessions[entry.sessionId])
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  lines.push('', 'Orphan Codex watchers')
  if (orphanCodexWatchers.length === 0) {
    lines.push('- none')
  } else {
    orphanCodexWatchers.forEach((entry) => {
      lines.push(`- ${entry.sessionId} ${buildCodexWatcherLine(entry, now)}`)
    })
  }

  lines.push(
    '',
    'Work-state log tail',
    `path: ${data.workStateDebug.path}`,
    `exists: ${data.workStateDebug.exists ? 'yes' : 'no'}`,
    `sizeBytes: ${data.workStateDebug.sizeBytes}`,
    `truncated: ${data.workStateDebug.truncated ? 'yes' : 'no'}`,
  )
  if (data.workStateDebug.tail.length === 0) {
    lines.push('- empty')
  } else {
    data.workStateDebug.tail.forEach((line) => {
      lines.push(line)
    })
  }

  return `${lines.join('\n')}\n`
}
