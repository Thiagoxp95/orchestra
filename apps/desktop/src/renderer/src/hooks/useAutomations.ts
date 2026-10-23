import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useAutomations(): void {
  const setAutomationNextRunAt = useAppStore((s) => s.setAutomationNextRunAt)

  useEffect(() => {
    const unsubSync = window.electronAPI.onAutomationScheduleSync((data) => {
      setAutomationNextRunAt(data)
    })
    // Pushes are the fast path; a pull on mount and on focus means a missed one
    // (sent before this listener, or while the window slept) can't stick.
    const pull = () => {
      window.electronAPI.getAutomationSchedule().then(setAutomationNextRunAt).catch(() => {})
    }
    pull()
    window.addEventListener('focus', pull)

    const unsubDisabled = window.electronAPI.onAutomationDisabled((actionId) => {
      const state = useAppStore.getState()
      for (const [wsId, ws] of Object.entries(state.workspaces)) {
        const action = ws.customActions.find((a) => a.id === actionId)
        if (action) {
          state.updateCustomAction(wsId, actionId, { automationEnabled: false })
          break
        }
      }
    })

    return () => {
      unsubSync()
      window.removeEventListener('focus', pull)
      unsubDisabled()
    }
  }, [setAutomationNextRunAt])
}
