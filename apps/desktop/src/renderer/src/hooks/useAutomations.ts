import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useAutomations(): void {
  const setAutomationNextRunAt = useAppStore((s) => s.setAutomationNextRunAt)

  useEffect(() => {
    const unsubSync = window.electronAPI.onAutomationScheduleSync((data) => {
      setAutomationNextRunAt(data)
    })

    return () => {
      unsubSync()
    }
  }, [setAutomationNextRunAt])
}
