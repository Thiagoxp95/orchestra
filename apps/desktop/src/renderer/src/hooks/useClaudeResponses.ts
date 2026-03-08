import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/app-store'

// Debug mode: watch ALL sessions regardless of processStatus
const DEBUG_CLAUDE_WATCHER = true

/** Watch Claude Code JSONL files for sessions running Claude */
export function useClaudeResponses(): void {
  const sessions = useAppStore((s) => s.sessions)
  const setClaudeLastResponse = useAppStore((s) => s.setClaudeLastResponse)
  const watchedRef = useRef(new Set<string>())

  // Listen for responses from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onClaudeLastResponse((sessionId, text) => {
      setClaudeLastResponse(sessionId, text)
    })
    return cleanup
  }, [setClaudeLastResponse])

  // Watch/unwatch sessions based on processStatus (or all in debug mode)
  useEffect(() => {
    const shouldWatch = new Set<string>()
    for (const [id, session] of Object.entries(sessions)) {
      if (DEBUG_CLAUDE_WATCHER || session.processStatus === 'claude') {
        shouldWatch.add(id)
      }
    }

    // Start watching new sessions
    for (const id of shouldWatch) {
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
      if (!shouldWatch.has(id)) {
        window.electronAPI.claudeUnwatchSession(id)
        watchedRef.current.delete(id)
      }
    }
  }, [sessions])
}
