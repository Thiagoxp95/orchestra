import { useRef, useEffect } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import type { TerminalLaunchProfile } from '../../../shared/types'

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
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand, launchProfile)

  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full p-3" />
    </div>
  )
}
