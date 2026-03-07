import { useRef } from 'react'
import { useTerminal } from '../hooks/useTerminal'

interface TerminalInstanceProps {
  sessionId: string
  scrollback?: string
}

export function TerminalInstance({ sessionId, scrollback }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(sessionId, containerRef, scrollback)

  return <div ref={containerRef} className="w-full h-full" />
}
