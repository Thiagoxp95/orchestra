import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

export function useAgentResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const setClaudeWorkState = useAppStore((s) => s.setClaudeWorkState)
  const setCodexLastResponse = useAppStore((s) => s.setCodexLastResponse)
  const setCodexWorkState = useAppStore((s) => s.setCodexWorkState)
  const clearSessionNeedsUserInput = useAppStore((s) => s.clearSessionNeedsUserInput)
  const prevSessionIdsRef = useRef(new Set<string>())

  useEffect(() => {
    const cleanupClaudeResponse = window.electronAPI.onClaudeLastResponse((sessionId, text) => {
      setClaudeLastResponse(sessionId, text)
    })
    const cleanupClaudeState = window.electronAPI.onClaudeWorkState((sessionId, state) => {
      setClaudeWorkState(sessionId, state)
      if (state === 'working') {
        clearSessionNeedsUserInput(sessionId)
      }
    })
    const cleanupCodexResponse = window.electronAPI.onCodexLastResponse((sessionId, text) => {
      setCodexLastResponse(sessionId, text)
    })
    const cleanupCodexState = window.electronAPI.onCodexWorkState((sessionId, state) => {
      setCodexWorkState(sessionId, state)
      if (state === 'working') {
        clearSessionNeedsUserInput(sessionId)
      }
    })

    return () => {
      cleanupClaudeResponse()
      cleanupClaudeState()
      cleanupCodexResponse()
      cleanupCodexState()
    }
  }, [clearSessionNeedsUserInput, setClaudeLastResponse, setClaudeWorkState, setCodexLastResponse, setCodexWorkState])

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
