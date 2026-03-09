import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

/** Watch Claude Code JSONL files for all sessions to infer activity state */
export function useClaudeResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const setClaudeActivity = useAppStore((s) => s.setClaudeActivity)
  const watchedRef = useRef(new Set<string>())

  // Listen for responses and activity from main process
  useEffect(() => {
    const cleanupResponse = window.electronAPI.onClaudeLastResponse((sessionId, text) => {
      setClaudeLastResponse(sessionId, text)
    })
    const cleanupActivity = window.electronAPI.onClaudeActivity((sessionId, activity) => {
      setClaudeActivity(sessionId, activity)
    })
    return () => {
      cleanupResponse()
      cleanupActivity()
    }
  }, [setClaudeLastResponse, setClaudeActivity])

  // Watch all sessions — activity state is inferred from JSONL, not process monitor
  useEffect(() => {
    const currentIds = new Set(Object.keys(sessions))

    // Start watching new sessions
    for (const id of currentIds) {
      if (!watchedRef.current.has(id)) {
        const session = sessions[id]
        if (session) {
          window.electronAPI.claudeWatchSession(id, session.cwd)
          watchedRef.current.add(id)
        }
      }
    }

    // Stop watching removed sessions
    for (const id of watchedRef.current) {
      if (!currentIds.has(id)) {
        window.electronAPI.claudeUnwatchSession(id)
        watchedRef.current.delete(id)
      }
    }
  }, [sessions])
}
