import { useRef, useEffect } from 'react'
import { useTerminal } from '../hooks/useTerminal'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  initialCommand?: string
  isActive?: boolean
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand, isActive }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useTerminal(sessionId, cwd, containerRef, termBg, initialCommand)

  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
