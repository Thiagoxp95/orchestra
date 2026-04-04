import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

function applyNormalizedStateSideEffects(
  status: NormalizedAgentSessionStatus,
  actions: {
    setClaudeLastResponse: (sessionId: string, text: string) => void
    setClaudeWorkState: (sessionId: string, state: 'idle' | 'working') => void
    setCodexLastResponse: (sessionId: string, text: string) => void
    setCodexWorkState: (sessionId: string, state: 'idle' | 'working' | 'waitingApproval' | 'waitingUserInput') => void
    setSessionNeedsUserInput: (sessionId: string, needsUserInput: boolean) => void
    clearSessionNeedsUserInput: (sessionId: string) => void
    clearAgentLaunch: (sessionId: string) => void
  },
): void {
  const {
    setClaudeLastResponse,
    setClaudeWorkState,
    setCodexLastResponse,
    setCodexWorkState,
    setSessionNeedsUserInput,
    clearSessionNeedsUserInput,
    clearAgentLaunch,
  } = actions

  if (status.agent === 'claude') {
    setClaudeWorkState(status.sessionId, status.state === 'working' ? 'working' : 'idle')
    if (status.lastResponsePreview) {
      setClaudeLastResponse(status.sessionId, status.lastResponsePreview)
    }
  } else {
    const codexState =
      status.state === 'waitingApproval'
        ? 'waitingApproval'
        : status.state === 'waitingUserInput'
          ? 'waitingUserInput'
          : status.state === 'working'
            ? 'working'
            : 'idle'
    setCodexWorkState(status.sessionId, codexState)
    if (status.lastResponsePreview) {
      setCodexLastResponse(status.sessionId, status.lastResponsePreview)
    }
  }

  if (status.state === 'waitingUserInput') {
    setSessionNeedsUserInput(status.sessionId, true)
  } else {
    clearSessionNeedsUserInput(status.sessionId)
  }

  if (status.state === 'idle') {
    clearAgentLaunch(status.sessionId)
  }
}

export function useAgentResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const setClaudeWorkState = useAppStore((s) => s.setClaudeWorkState)
  const setCodexLastResponse = useAppStore((s) => s.setCodexLastResponse)
  const setCodexWorkState = useAppStore((s) => s.setCodexWorkState)
  const setTerminalLastOutput = useAppStore((s) => s.setTerminalLastOutput)
  const setSessionWorkState = useAppStore((s) => s.setSessionWorkState)
  const setSessionNeedsUserInput = useAppStore((s) => s.setSessionNeedsUserInput)
  const clearSessionNeedsUserInput = useAppStore((s) => s.clearSessionNeedsUserInput)
  const clearAgentLaunch = useAppStore((s) => s.clearAgentLaunch)
  const setNormalizedAgentState = useAppStore((s) => s.setNormalizedAgentState)
  const prevSessionIdsRef = useRef(new Set<string>())

  useEffect(() => {
    const cleanupClaudeResponse = window.electronAPI.onClaudeLastResponse((sessionId, text) => {
      setClaudeLastResponse(sessionId, text)
    })
    const cleanupClaudeState = window.electronAPI.onClaudeWorkState((sessionId, state) => {
      setClaudeWorkState(sessionId, state)
      if (state === 'working') {
        clearSessionNeedsUserInput(sessionId)
      } else if (state === 'idle') {
        clearAgentLaunch(sessionId)
      }
    })
    const cleanupCodexResponse = window.electronAPI.onCodexLastResponse((sessionId, text) => {
      setCodexLastResponse(sessionId, text)
    })
    const cleanupCodexState = window.electronAPI.onCodexWorkState((sessionId, state) => {
      setCodexWorkState(sessionId, state)
      if (state === 'waitingUserInput') {
        setSessionNeedsUserInput(sessionId, true)
      } else {
        clearSessionNeedsUserInput(sessionId)
      }
      if (state === 'idle') {
        clearAgentLaunch(sessionId)
      }
    })
    const cleanupTerminalOutput = window.electronAPI.onTerminalLastOutput((sessionId, text) => {
      setTerminalLastOutput(sessionId, text)
    })
    const cleanupSessionWorkState = window.electronAPI.onSessionWorkState((sessionId, state) => {
      setSessionWorkState(sessionId, state)
    })
    const cleanupNormalizedState = window.electronAPI.onAgentSessionState((status) => {
      setNormalizedAgentState(status)
      applyNormalizedStateSideEffects(status, {
        setClaudeLastResponse,
        setClaudeWorkState,
        setCodexLastResponse,
        setCodexWorkState,
        setSessionNeedsUserInput,
        clearSessionNeedsUserInput,
        clearAgentLaunch,
      })
    })

    return () => {
      cleanupClaudeResponse()
      cleanupClaudeState()
      cleanupCodexResponse()
      cleanupCodexState()
      cleanupTerminalOutput()
      cleanupSessionWorkState()
      cleanupNormalizedState()
    }
  }, [
    clearSessionNeedsUserInput,
    clearAgentLaunch,
    setClaudeLastResponse,
    setClaudeWorkState,
    setCodexLastResponse,
    setCodexWorkState,
    setTerminalLastOutput,
    setSessionWorkState,
    setSessionNeedsUserInput,
    setNormalizedAgentState,
  ])

  useEffect(() => {
    const currentIds = new Set(Object.keys(sessions))
    for (const id of prevSessionIdsRef.current) {
      if (!currentIds.has(id)) {
        window.electronAPI.claudeUnwatchSession(id)
        window.electronAPI.codexUnwatchSession(id)
      }
    }
    prevSessionIdsRef.current = currentIds
  }, [sessions])
}
