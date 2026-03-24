import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

export function useAgentResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const setClaudeWorkState = useAppStore((s) => s.setClaudeWorkState)
  const setCodexLastResponse = useAppStore((s) => s.setCodexLastResponse)
  const setCodexWorkState = useAppStore((s) => s.setCodexWorkState)
  const setTerminalLastOutput = useAppStore((s) => s.setTerminalLastOutput)
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
    const cleanupNormalizedState = window.electronAPI.onAgentSessionState((status) => {
      setNormalizedAgentState(status)
    })

    return () => {
      cleanupClaudeResponse()
      cleanupClaudeState()
      cleanupCodexResponse()
      cleanupCodexState()
      cleanupTerminalOutput()
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
