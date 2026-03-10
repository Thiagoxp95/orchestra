import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import type { LiveTerminalSessionStatusInfo, ProcessStatus } from '../../../shared/types'

export function useProcessStatus(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setProcessStatus = useAppStore((s) => s.setProcessStatus)
  const setClaudeWorkState = useAppStore((s) => s.setClaudeWorkState)
  const setCodexWorkState = useAppStore((s) => s.setCodexWorkState)
  const updateSessionLabel = useAppStore((s) => s.updateSessionLabel)
  // Track previous status per session to detect transitions
  const prevStatusRef = useRef<Record<string, ProcessStatus>>({})
  const bootstrappedRef = useRef<Set<string>>(new Set())

  const applyProcessChange = (sessionId: string, status: ProcessStatus, aiPid?: number) => {
    const prevStatus = prevStatusRef.current[sessionId]
    prevStatusRef.current[sessionId] = status

    setProcessStatus(sessionId, status)

    if (status === 'terminal') {
      setClaudeWorkState(sessionId, 'idle')
      setCodexWorkState(sessionId, 'idle')
      window.electronAPI.claudeUnwatchSession(sessionId)
      window.electronAPI.codexUnwatchSession(sessionId)

      // Revert label to "Terminal N" and icon when agent exits
      if (prevStatus === 'claude' || prevStatus === 'codex') {
        const state = useAppStore.getState()
        const session = state.sessions[sessionId]
        if (session) {
          const ws = state.workspaces[session.workspaceId]
          if (ws) {
            const tree = ws.trees[ws.activeTreeIndex] ?? ws.trees[0]
            const terminalCount = tree.sessionIds.filter((sid) => {
              const s = state.sessions[sid]
              return s && sid !== sessionId && s.label.startsWith('Terminal')
            }).length
            updateSessionLabel(sessionId, `Terminal ${terminalCount + 1}`, '__terminal__')
          }
        }
      }
    } else if (status === 'claude' && prevStatus !== 'claude') {
      setCodexWorkState(sessionId, 'idle')
      window.electronAPI.codexUnwatchSession(sessionId)
      window.electronAPI.claudeUnwatchSession(sessionId)
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.claudeWatchSession(sessionId, session.cwd, aiPid)
      }
    } else if (status === 'claude' && aiPid) {
      // Already watching but PID may have changed (e.g., Claude restarted
      // within the same detection cycle). Update the PID.
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.claudeWatchSession(sessionId, session.cwd, aiPid)
      }
    } else if (status === 'codex' && prevStatus !== 'codex') {
      setClaudeWorkState(sessionId, 'idle')
      // Show activity immediately when Codex is detected, then let the main
      // watcher refine back to idle if the session is actually waiting.
      setCodexWorkState(sessionId, 'working')
      // Clear stale response from any previous codex thread
      useAppStore.getState().setCodexLastResponse(sessionId, '')
      window.electronAPI.claudeUnwatchSession(sessionId)
      window.electronAPI.codexUnwatchSession(sessionId)
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.codexWatchSession(sessionId, session.cwd, aiPid)
      }
    } else if (status === 'codex' && aiPid) {
      setCodexWorkState(sessionId, 'working')
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.codexWatchSession(sessionId, session.cwd, aiPid)
      }
    }
  }

  useEffect(() => {
    window.electronAPI.onProcessChange(applyProcessChange)

    return () => {
      // Cleanup handled by removeAllListeners at app level
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const activeIds = new Set(Object.keys(sessions))

    void window.electronAPI.listLiveSessionStatuses().then((liveSessions: LiveTerminalSessionStatusInfo[]) => {
      if (cancelled) return

      const liveById = new Map(liveSessions.filter((session) => session.isAlive).map((session) => [session.sessionId, session]))

      for (const session of Object.values(sessions)) {
        if (bootstrappedRef.current.has(session.id)) continue

        const liveSession = liveById.get(session.id)
        if (!liveSession) continue

        applyProcessChange(session.id, liveSession.status, liveSession.aiPid ?? undefined)
        bootstrappedRef.current.add(session.id)
      }

      for (const sessionId of [...bootstrappedRef.current]) {
        if (!activeIds.has(sessionId)) {
          bootstrappedRef.current.delete(sessionId)
        }
      }
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [sessions])
}
