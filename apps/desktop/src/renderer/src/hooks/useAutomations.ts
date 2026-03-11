import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useAutomations(): void {
  const setAutomationNextRunAt = useAppStore((s) => s.setAutomationNextRunAt)

  useEffect(() => {
    const unsubSync = window.electronAPI.onAutomationScheduleSync((data) => {
      setAutomationNextRunAt(data)
    })

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
      unsubDisabled()
    }
  }, [setAutomationNextRunAt])
}
