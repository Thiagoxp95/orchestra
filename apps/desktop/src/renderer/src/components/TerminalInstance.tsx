import { useRef, useEffect } from 'react'
import { useTerminal } from '../hooks/useTerminal'
import { TerminalAttachments } from './TerminalAttachments'
import type { TerminalLaunchProfile } from '../../../shared/types'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  workspaceColor?: string
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand, launchProfile, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand, launchProfile, isActive)
  useEffect(() => { if (isActive) termRef.current?.focus() }, [isActive])
  return <div className="h-full w-full p-3">
    <TerminalAttachments active={isActive} paste={text => { termRef.current?.paste(text); termRef.current?.focus() }}>
      <div ref={containerRef} className="h-full w-full" />
    </TerminalAttachments>
  </div>
}
