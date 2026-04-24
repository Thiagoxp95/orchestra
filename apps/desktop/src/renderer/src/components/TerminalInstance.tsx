import { useRef, useEffect } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import type { TerminalLaunchProfile } from '../../../shared/types'
import { LastMessageBanner } from './LastMessageBanner'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand, launchProfile, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand, launchProfile, isActive)

  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive])

  return (
    <div className="flex flex-col w-full h-full">
      <LastMessageBanner sessionId={sessionId} />
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="w-full h-full p-3" />
      </div>
    </div>
  )
}
