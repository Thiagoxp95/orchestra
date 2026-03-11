import { useRef, useEffect, useCallback } from 'react'
import { useMaestroTerminal } from '../hooks/useMaestroTerminal'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

interface MaestroPaneProps {
  session: TerminalSession
  termBg: string
  wsColor: string
  isFocused: boolean
  fontSize: number
  onFocus: () => void
}

export function MaestroPane({ session, termBg, wsColor, isFocused, fontSize, onFocus }: MaestroPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useMaestroTerminal(session.id, containerRef, termBg, fontSize)

  const workState = useAppStore(
    useCallback((s) => {
      if (session.processStatus === 'claude') return s.claudeWorkState[session.id]
      return s.codexWorkState[session.id]
    }, [session.id, session.processStatus])
  )
  const needsInput = useAppStore((s) => s.sessionNeedsUserInput[session.id])

  const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
  const isWorking = workState === 'working'
  const badgeTxtColor = textColor(wsColor)

  useEffect(() => {
    if (isFocused && termRef.current) {
      termRef.current.focus()
    }
  }, [isFocused])

  const borderColor = isFocused
    ? wsColor
    : `${wsColor}88`

  const borderWidth = isFocused ? 3 : 2

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-lg"
      style={{
        border: `${borderWidth}px solid ${borderColor}`,
        backgroundColor: termBg
      }}
      onClick={onFocus}
    >
      {/* Pane badge */}
      <div
        className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium"
        style={{
          backgroundColor: `${wsColor}bb`,
          color: badgeTxtColor
        }}
      >
        {/* Agent type indicator */}
        <span className="opacity-80">{session.processStatus === 'claude' ? 'C' : 'X'}</span>
        <span className="truncate max-w-[120px]">{session.label}</span>
        {/* Work state indicator */}
        {needsInput && (
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" title="Needs input" />
        )}
        {isWorking && !needsInput && (
          <svg width="10" height="10" viewBox="0 0 10 10" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M5 1a4 4 0 0 1 4 4" />
          </svg>
        )}
        {!isWorking && !needsInput && isAgent && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 5 4.5 7.5 8 3" />
          </svg>
        )}
      </div>

      {/* Terminal container — absolute positioning guarantees pixel dimensions for xterm fit */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  )
}
