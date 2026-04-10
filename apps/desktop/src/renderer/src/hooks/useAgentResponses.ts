import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

export function useAgentResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setTerminalLastOutput = useAppStore((s) => s.setTerminalLastOutput)

  useEffect(() => {
    const cleanupTerminalOutput = window.electronAPI.onTerminalLastOutput((sessionId, text) => {
      setTerminalLastOutput(sessionId, text)
    })

    return () => {
      cleanupTerminalOutput()
    }
  }, [
    setTerminalLastOutput,
  ])

  useEffect(() => {
    const currentIds = new Set(Object.keys(sessions))
    for (const id of prevSessionIdsRef.current) {
      if (!currentIds.has(id)) {
        window.electronAPI.codexUnwatchSession(id)
      }
    }
    prevSessionIdsRef.current = currentIds
  }, [sessions])

  const prevSessionIdsRef = useRef(new Set<string>())
}
