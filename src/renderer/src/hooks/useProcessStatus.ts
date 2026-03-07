import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import type { ProcessStatus } from '../../../shared/types'

export function useProcessStatus(): void {
  const setProcessStatus = useAppStore((s) => s.setProcessStatus)

  useEffect(() => {
    const onProcessChange = (sessionId: string, status: ProcessStatus) => {
      setProcessStatus(sessionId, status)
    }
    window.electronAPI.onProcessChange(onProcessChange)

    return () => {
      // Cleanup handled by removeAllListeners at app level
    }
  }, [setProcessStatus])
}
