import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

export function useAgentResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setTerminalLastOutput = useAppStore((s) => s.setTerminalLastOutput)
  const setSessionWorkState = useAppStore((s) => s.setSessionWorkState)
  const prevSessionIdsRef = useRef(new Set<string>())

  useEffect(() => {
    const cleanupTerminalOutput = window.electronAPI.onTerminalLastOutput((sessionId, text) => {
      setTerminalLastOutput(sessionId, text)
    })
    const cleanupSessionWorkState = window.electronAPI.onSessionWorkState((sessionId, state) => {
      setSessionWorkState(sessionId, state)
    })

    return () => {
      cleanupTerminalOutput()
      cleanupSessionWorkState()
    }
  }, [
    setTerminalLastOutput,
    setSessionWorkState,
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
