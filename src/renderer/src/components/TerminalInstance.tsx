import { useRef } from 'react'
import { useTerminal } from '../hooks/useTerminal'

interface TerminalInstanceProps {
  sessionId: string
  cwd: string
  termBg?: string
  initialCommand?: string
}

export function TerminalInstance({ sessionId, cwd, termBg, initialCommand }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(sessionId, cwd, containerRef, termBg, initialCommand)

  return <div ref={containerRef} className="w-full h-full" />
}
