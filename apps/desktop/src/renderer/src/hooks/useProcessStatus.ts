import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import type { LiveTerminalSessionStatusInfo, ProcessStatus } from '../../../shared/types'

const AGENT_LAUNCH_GRACE_MS = 8000

export function useProcessStatus(): void {
  const sessions = useAppStore((s) => s.sessions)
  const agentLaunches = useAppStore((s) => s.agentLaunches)
  const setProcessStatus = useAppStore((s) => s.setProcessStatus)
  const setClaudeWorkState = useAppStore((s) => s.setClaudeWorkState)
  const setCodexWorkState = useAppStore((s) => s.setCodexWorkState)
  const setNormalizedAgentState = useAppStore((s) => s.setNormalizedAgentState)
  const clearSessionNeedsUserInput = useAppStore((s) => s.clearSessionNeedsUserInput)
  const confirmAgentLaunch = useAppStore((s) => s.confirmAgentLaunch)
  const clearAgentLaunch = useAppStore((s) => s.clearAgentLaunch)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const setCodexLastResponse = useAppStore((s) => s.setCodexLastResponse)
  const updateSessionLabel = useAppStore((s) => s.updateSessionLabel)
  // Track previous status per session to detect transitions
  const prevStatusRef = useRef<Record<string, ProcessStatus>>({})
  const bootstrappedRef = useRef<Set<string>>(new Set())
  const applyProcessChangeRef = useRef<(sessionId: string, status: ProcessStatus, aiPid?: number) => void>(() => {})
  const launchTimersRef = useRef<Record<string, { startedAt: number; timer: ReturnType<typeof setTimeout> }>>({})

  const applyProcessChange = (sessionId: string, status: ProcessStatus, aiPid?: number) => {
    const currentLaunch = useAppStore.getState().agentLaunches[sessionId]
    if (
      status === 'terminal'
      && currentLaunch
      && !currentLaunch.confirmed
      && Date.now() - currentLaunch.startedAt < AGENT_LAUNCH_GRACE_MS
    ) {
      return
    }

    // First observation = no entry in prevStatusRef yet. We use this below to
    // force a work-state resync from main, because the transition branches
    // below treat a session that was persisted as 'claude'/'codex' the same
    // as one that's been continuously running — they skip the resync, leaving
    // the renderer stuck at the empty/idle initial state for the agent that
    // main has already been tracking.
    const isFirstObservation = !(sessionId in prevStatusRef.current)
    const prevStatus = prevStatusRef.current[sessionId]
      ?? useAppStore.getState().sessions[sessionId]?.processStatus
    prevStatusRef.current[sessionId] = status

    if (status === 'claude' || status === 'codex') {
      if (currentLaunch && currentLaunch.agent !== status) {
        clearAgentLaunch(sessionId)
      } else {
        confirmAgentLaunch(sessionId, status)
      }
      const existingTimer = launchTimersRef.current[sessionId]
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        delete launchTimersRef.current[sessionId]
      }
    } else {
      clearAgentLaunch(sessionId)
      const existingTimer = launchTimersRef.current[sessionId]
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        delete launchTimersRef.current[sessionId]
      }
    }

    setProcessStatus(sessionId, status)

    if (status === 'terminal') {
      setClaudeWorkState(sessionId, 'idle')
      setCodexWorkState(sessionId, 'idle')
      // Intentionally do NOT clear normalizedAgentState or unmap the codex thread
      // here. process-monitor can briefly flip to 'terminal' when the codex CLI
      // restarts inside the same PTY; tearing down the thread/rollout subscription
      // here means the renderer never gets fresh state after the flap. The codex
      // app-server will authoritatively report 'idle' or disconnected when the
      // thread really ends, and tear-down on true session kill happens via
      // 'terminal-kill' in main.

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
      clearSessionNeedsUserInput(sessionId)
      setCodexWorkState(sessionId, 'idle')
      // A fresh agent run should own the sidebar state for this session.
      setClaudeLastResponse(sessionId, '')
      setCodexLastResponse(sessionId, '')
      window.electronAPI.codexUnwatchSession(sessionId)
      // Resync from main: the renderer's claudeWorkState has just been reset
      // to 'idle' by setProcessStatus, but main may already have observed
      // Claude emitting a 'working' OSC title before process-monitor caught
      // up (main only emits IPC on state *transitions*, so without this pull
      // the renderer would be stuck at 'idle' despite Claude working).
      window.electronAPI.getClaudeWorkState(sessionId).then((state) => {
        if (!state) return
        const session = useAppStore.getState().sessions[sessionId]
        if (!session || session.processStatus !== 'claude') return
        setClaudeWorkState(sessionId, state)
      }).catch(() => {})
    } else if (status === 'codex' && prevStatus !== 'codex') {
      clearSessionNeedsUserInput(sessionId)
      setClaudeWorkState(sessionId, 'idle')
      setClaudeLastResponse(sessionId, '')
      setCodexLastResponse(sessionId, '')
      // codexWatchSession is idempotent, so we don't need to unwatch first —
      // and unwatching here would drop the app-server thread mapping established
      // on PTY creation, leaving the session without authoritative state.
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.codexWatchSession(sessionId, session.cwd, aiPid)
      }
    } else if (status === 'codex' && aiPid) {
      const session = useAppStore.getState().sessions[sessionId]
      if (session) {
        window.electronAPI.codexWatchSession(sessionId, session.cwd, aiPid)
      }
    }

    // First-observation resync: catches sessions that were already running an
    // agent before the renderer mounted (app restart with persisted state, dev
    // hot-reload, etc.). The transition branches above only fire on
    // prevStatus !== status, but a persisted 'claude'/'codex' session has
    // matching prev/current, so without this pull the sidebar stays at the
    // initial 'idle' while main has long since observed 'working' from the
    // OSC title stream / hook events.
    if (isFirstObservation) {
      if (status === 'claude') {
        window.electronAPI.getClaudeWorkState(sessionId).then((workState) => {
          if (!workState) return
          const session = useAppStore.getState().sessions[sessionId]
          if (!session || session.processStatus !== 'claude') return
          setClaudeWorkState(sessionId, workState)
        }).catch(() => {})
      } else if (status === 'codex') {
        window.electronAPI.getNormalizedAgentState(sessionId).then((normalized) => {
          if (!normalized) return
          const session = useAppStore.getState().sessions[sessionId]
          if (!session || session.processStatus !== 'codex') return
          setNormalizedAgentState(normalized)
        }).catch(() => {})
      }
    }
  }
  applyProcessChangeRef.current = applyProcessChange

  useEffect(() => {
    window.electronAPI.onProcessChange(applyProcessChange)

    const unsubscribeWorkState = window.electronAPI.onClaudeWorkStateChange((sessionId, state) => {
      // Don't gate on processStatus === 'claude'. Main emits this IPC on OSC
      // edges, which can fire before process-monitor polls (1s cadence) and
      // marks the session as 'claude' in the store. Gating would silently
      // drop the first 'working' edge, and main never re-emits the same
      // state — leaving the sidebar stuck at 'idle'. Storing the state for a
      // non-claude session is harmless; computeAgentView only consults
      // claudeWorkState when processStatus === 'claude'.
      if (!useAppStore.getState().sessions[sessionId]) return
      setClaudeWorkState(sessionId, state)
    })

    return () => {
      unsubscribeWorkState()
    }
  }, [])

  useEffect(() => {
    for (const [sessionId, launch] of Object.entries(agentLaunches)) {
      if (launch.confirmed) {
        const existingTimer = launchTimersRef.current[sessionId]
        if (existingTimer) {
          clearTimeout(existingTimer.timer)
          delete launchTimersRef.current[sessionId]
        }
        continue
      }

      const existingTimer = launchTimersRef.current[sessionId]
      if (existingTimer?.startedAt === launch.startedAt) continue
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
      }

      const delay = Math.max(AGENT_LAUNCH_GRACE_MS - (Date.now() - launch.startedAt), 0)
      const timer = setTimeout(() => {
        const latestLaunch = useAppStore.getState().agentLaunches[sessionId]
        if (!latestLaunch || latestLaunch.startedAt !== launch.startedAt || latestLaunch.confirmed) {
          delete launchTimersRef.current[sessionId]
          return
        }

        void window.electronAPI.listLiveSessionStatuses().then((liveSessions) => {
          const latest = useAppStore.getState().agentLaunches[sessionId]
          if (!latest || latest.startedAt !== launch.startedAt || latest.confirmed) return

          const liveSession = liveSessions.find((session) => session.sessionId === sessionId && session.isAlive)
          if (liveSession && liveSession.status === latest.agent) {
            applyProcessChangeRef.current(sessionId, liveSession.status, liveSession.aiPid ?? undefined)
            return
          }

          clearAgentLaunch(sessionId)
          applyProcessChangeRef.current(sessionId, liveSession?.status ?? 'terminal', liveSession?.aiPid ?? undefined)
        }).catch(() => {
          const latest = useAppStore.getState().agentLaunches[sessionId]
          if (!latest || latest.startedAt !== launch.startedAt || latest.confirmed) return
          clearAgentLaunch(sessionId)
          applyProcessChangeRef.current(sessionId, 'terminal')
        }).finally(() => {
          delete launchTimersRef.current[sessionId]
        })
      }, delay)

      launchTimersRef.current[sessionId] = { startedAt: launch.startedAt, timer }
    }

    for (const sessionId of Object.keys(launchTimersRef.current)) {
      if (agentLaunches[sessionId]) continue
      clearTimeout(launchTimersRef.current[sessionId].timer)
      delete launchTimersRef.current[sessionId]
    }
  }, [agentLaunches, clearAgentLaunch])

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

  useEffect(() => {
    return () => {
      for (const { timer } of Object.values(launchTimersRef.current)) {
        clearTimeout(timer)
      }
      launchTimersRef.current = {}
    }
  }, [])
}
