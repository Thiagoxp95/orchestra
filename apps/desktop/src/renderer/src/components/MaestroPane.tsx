import { useRef, useEffect, useCallback } from 'react'
import { useMaestroTerminal } from '../hooks/useMaestroTerminal'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

function BranchIcon({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <line x1="4" y1="2" x2="4" y2="10" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="4" r="2" />
      <path d="M12 6c0 3-2 4-6 4" />
    </svg>
  )
}

interface MaestroPaneProps {
  session: TerminalSession
  treeLabel: string
  branchName?: string | null
  termBg: string
  wsColor: string
  isFocused: boolean
  fontSize: number
  onFocus: () => void
}

export function MaestroPane({ session, treeLabel, branchName, termBg, wsColor, isFocused, fontSize, onFocus }: MaestroPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useMaestroTerminal(session.id, containerRef, termBg, fontSize)

  const normalizedState = useAppStore(
    useCallback((s) => s.normalizedAgentState[session.id], [session.id])
  )

  // Legacy fallback
  const legacyWorkState = useAppStore(
    useCallback((s) => {
      if (session.processStatus === 'claude') return s.claudeWorkState[session.id]
      return s.codexWorkState[session.id]
    }, [session.id, session.processStatus])
  )
  const legacyNeedsInput = useAppStore((s) => s.sessionNeedsUserInput[session.id])

  const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
  const isWorking = normalizedState ? normalizedState.state === 'working' : legacyWorkState === 'working'
  const needsInput = normalizedState ? normalizedState.state === 'waitingUserInput' : (legacyNeedsInput || legacyWorkState === 'waitingUserInput')
  const needsApproval = normalizedState ? normalizedState.state === 'waitingApproval' : legacyWorkState === 'waitingApproval'
  const isIdle = isAgent && !isWorking && !needsInput && !needsApproval
  const badgeTxtColor = textColor(wsColor)

  useEffect(() => {
    if (isFocused && termRef.current) {
      termRef.current.focus()
    }
  }, [isFocused])

  const borderColor = needsInput
    ? undefined // handled by CSS animation
    : isFocused
      ? badgeTxtColor
      : `${wsColor}33`

  const borderWidth = needsInput ? 2 : isFocused ? 2 : 1

  // Status label text
  const statusText = needsInput
    ? 'Waiting for input'
    : needsApproval
      ? 'Waiting for approval'
      : isWorking
        ? 'Working...'
        : isAgent
          ? 'Idle'
          : ''

  return (
    <div
      className={`relative flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg${needsInput ? ' animate-border-pulse' : ''}`}
      style={{
        border: needsInput ? undefined : `${borderWidth}px solid ${borderColor}`,
        borderWidth: needsInput ? `${borderWidth}px` : undefined,
        borderStyle: needsInput ? 'solid' : undefined,
        boxShadow: isFocused && !needsInput ? `0 0 0 1px ${badgeTxtColor}, 0 0 8px ${wsColor}66` : 'none',
        backgroundColor: termBg,
        opacity: isIdle ? 0.2 : 1,
        transition: 'opacity 0.3s ease'
      }}
      onClick={onFocus}
    >
      {/* Pane header bar */}
      <div
        className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium shrink-0 min-w-0"
        style={{
          backgroundColor: `${wsColor}cc`,
          color: badgeTxtColor
        }}
      >
        {/* Agent type pill */}
        <span
          className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold"
          style={{ backgroundColor: `${badgeTxtColor}20` }}
        >
          {session.processStatus === 'claude' ? 'C' : 'X'}
        </span>

        {/* Branch / tree label */}
        <BranchIcon color={badgeTxtColor} />
        <span
          className="shrink-0 truncate max-w-[180px] font-semibold"
          title={branchName ?? treeLabel}
        >
          {branchName ?? treeLabel}
        </span>

        {/* Separator */}
        <span className="shrink-0 opacity-30">|</span>

        {/* Session label */}
        <span className="truncate min-w-0 opacity-80" title={session.label}>
          {session.label}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Status indicator + text */}
        <span className="shrink-0 flex items-center gap-1.5">
          {needsInput && (
            <>
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-yellow-300 text-[11px] font-semibold">{statusText}</span>
            </>
          )}
          {isWorking && !needsInput && (
            <>
              <svg width="14" height="14" viewBox="0 0 10 10" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M5 1a4 4 0 0 1 4 4" />
              </svg>
              <span className="text-[11px] opacity-80">{statusText}</span>
            </>
          )}
          {!isWorking && !needsInput && isAgent && (
            <>
              <svg width="14" height="14" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 5 4.5 7.5 8 3" />
              </svg>
              <span className="text-[11px] opacity-60">{statusText}</span>
            </>
          )}
        </span>
      </div>

      {/* Terminal container — absolute positioning guarantees pixel dimensions for xterm fit */}
      <div className="relative min-w-0 min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {/* Click overlay for unfocused panes — xterm swallows clicks so this ensures any click focuses */}
        {!isFocused && (
          <div
            className="absolute inset-0 cursor-pointer"
            onClick={onFocus}
          />
        )}
      </div>
    </div>
  )
}
